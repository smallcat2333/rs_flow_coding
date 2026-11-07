//! 模块协作：图主会话声明职责，持久化请求、结果和待投递通知，后台按需续接并串行投递。
//! 本模块作为 agent 的子模块复用会话表、ConPTY 和活动通知；锁顺序始终为会话表 → 协作表。

use super::*;
use std::collections::HashSet;

/// 模块职责及代码边界；owner 对应图主会话稳定 ID，根路径均为已存在的规范路径。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct Scope {
    pub description: String,
    pub paths: Vec<String>,
}

/// 任务送达与业务完成分开；waiting 表示等待已派发的下游任务，不释放模块处理名额。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase { Queued, AwaitingApproval, Starting, Delivered, Accepted, Running, Waiting, Completed, Blocked }

impl Phase {
    /// 终态只允许完成或受阻；后续状态回报不能复活已经结束的请求。
    fn terminal(self) -> bool { matches!(self, Self::Completed | Self::Blocked) }
    /// 已投递的未结束请求独占模块，避免多个 Feat 同时驱动同一个负责人。
    fn active(self) -> bool { matches!(self, Self::Delivered | Self::Accepted | Self::Running | Self::Waiting) }
}

/// 一次跨模块请求，保留来源 Feat/任务、目标模块和验收约定，不复制双方完整对话。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Request {
    id: String,
    from: String,
    to: String,
    from_title: String,
    module: String,
    feat: String,
    task: Option<TaskRef>,
    goal: String,
    contract: String,
    acceptance: String,
    phase: Phase,
    detail: String,
    files: Vec<String>,
    verification: String,
    created_at: i64,
    updated_at: i64,
}

/// 完成/受阻的单向结果通知；接收方无需回复确认，避免 Agent 相互自动回复形成循环。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Notice {
    request: String,
    from: String,
    to: String,
    text: String,
    phase: Phase,
    error: String,
    updated_at: i64,
}

/// 接收方的结构化回报；文件由运行时归一后交给账本校验，完成必须包含验证结果。
#[derive(Clone, Deserialize)]
struct Report { request: String, state: String, text: String, files: Vec<String>, verification: String }

/// 一次负责人重新启用确认；停用时间戳用于拒绝用户等待期间产生的另一轮停用状态。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Approval { id: String, archived_at: i64, stored_at: i64 }

/// 本地协作账本；与会话元数据分开原子保存，进程退出或重启不丢请求和结果。
#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq)]
struct Book {
    scopes: HashMap<String, Scope>,
    requests: Vec<Request>,
    notices: Vec<Notice>,
    #[serde(default)]
    approvals: HashMap<String, Approval>,
}

/// 协作表及其固定存储位置；只在初始化时读取磁盘，变更提交成功后替换内存副本。
struct Store { path: PathBuf, book: Book }
static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static DRAFTS: std::sync::LazyLock<Mutex<HashSet<String>>> = std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

/// 记录人工输入草稿，避免协作正文拼进未发送的内容；Enter/中断或提示提交后解除占用。
/// 光标位置和设备状态回包属于终端协议，不视为人工草稿。
pub(super) fn on_input(id: &str, data: &str) {
    let mut drafts = DRAFTS.lock().unwrap();
    if data == "\r" || data == "\x03" { drafts.remove(id); }
    else if !data.is_empty() && !(data.starts_with("\x1b[") && (data.ends_with('R') || data.ends_with('c') || data.ends_with('n'))) { drafts.insert(id.into()); }
}

/// CLI 确认提交或新会话初始化后，原输入已消费，不再阻止排队协作。
pub(super) fn input_submitted(id: &str) { DRAFTS.lock().unwrap().remove(id); }

/// 判断是否有用户尚未发送的终端输入；只在会话锁内读取，不跨锁修改账本。
fn has_draft(id: &str) -> bool { DRAFTS.lock().unwrap().contains(id) }

/// 应用退出前先停止新调度，避免关闭窗口杀进程时又后台拉起负责人。
pub(super) fn stop() { STOPPED.store(true, Ordering::SeqCst); }

/// 前端沿用原有排队数展示；尚未初始化时没有协作队列。
pub(super) fn queued(id: &str) -> usize {
    let Some(store) = STORE.get() else { return 0 };
    let store = store.lock().unwrap();
    store.book.requests.iter().filter(|r| r.to == id && matches!(r.phase, Phase::Queued | Phase::AwaitingApproval | Phase::Starting)).count()
        + store.book.notices.iter().filter(|n| n.to == id && matches!(n.phase, Phase::Queued | Phase::Starting)).count()
}

/// 调度所需的会话快照，便于用纯状态测试验证后台续接、权限等待和串行投递。
#[derive(Clone)]
struct Endpoint { running: bool, idle: bool, unavailable: Option<String>, disabled: Option<Approval> }

/// 调度动作先持久化占位再执行；启动、用户确认和 PTY 写入在账本锁外完成。
#[derive(Debug, PartialEq)]
enum Action { Start { target: String, key: String, notice: bool }, Deliver { target: String, key: String, notice: bool, text: String }, Confirm { target: String, key: String } }

/// 原子写入协作账本；写盘失败保留此前内存状态，调用方报告具体错误。
fn save(path: &Path, book: &Book) -> Result<(), String> {
    crate::write_atomic(path, &serde_json::to_string_pretty(book).map_err(|e| e.to_string())?)
}

/// 初始化持久化协议；重启前已投递任务改为受阻，禁止猜测之前是否已改代码而重复执行。
pub(super) fn init() -> Result<(), String> {
    let path = dir()?.join("collaboration.json");
    let mut book: Book = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("协作记录损坏 {}：{e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Book::default(),
        Err(e) => return Err(format!("读取协作记录失败：{e}")),
    };
    book.recover(now());
    save(&path, &book)?;
    STORE.set(Mutex::new(Store { path, book })).map_err(|_| "协作服务重复初始化".to_string())
}

/// 从会话表生成调度快照；收纳、归档、停止中和压缩中均不会被后台当作空闲目标。
fn endpoints(map: &HashMap<String, Entry>) -> HashMap<String, Endpoint> {
    map.iter().map(|(id, e)| (id.clone(), Endpoint {
        running: e.proc.is_some(),
        idle: e.live.status == "idle" && !e.compacting && !e.stopping && !has_draft(id),
        unavailable: if e.meta.archived_at > 0 { Some("会话已归档".into()) }
            else if e.meta.stored_at > 0 { Some("会话已收纳".into()) }
            else if e.stopping && e.proc.is_some() { Some("会话正在停止".into()) } else { None },
        disabled: (e.meta.archived_at > 0 || e.meta.stored_at > 0).then(|| Approval {
            id: String::new(), archived_at: e.meta.archived_at, stored_at: e.meta.stored_at,
        }),
    })).collect()
}

impl Book {
    /// 重启后只保留尚未投递的任务可继续调度；结果通知可重送，但不会再次执行任务。
    fn recover(&mut self, at: i64) {
        let ids: Vec<String> = self.requests.iter().filter(|r| r.phase.active() || matches!(r.phase, Phase::Starting | Phase::AwaitingApproval)).map(|r| r.id.clone()).collect();
        for id in ids { self.block(&id, "应用已重启，原处理或启用确认结果未确认，请核对后重新提出请求", at); }
        self.approvals.clear();
        for notice in &mut self.notices {
            if notice.phase == Phase::Starting { notice.phase = Phase::Queued; notice.updated_at = at; }
        }
    }

    /// 终态只生成一次结果通知；完成报告是单向通知，不要求接收方自动回信。
    fn result_notice(&mut self, index: usize, at: i64) {
        let r = &self.requests[index];
        self.notices.push(Notice {
            request: r.id.clone(), from: r.to.clone(), to: r.from.clone(),
            text: format!("[协作结果 {}；{:?}] 模块：{}；来源 Feat：{}；目标：{}；结果：{}；文件：{}；验证：{}。这是已派发请求的结果通知，请核对后继续原任务；无需回复确认，不要把它作为新请求转发。",
                r.id, r.phase, r.module, r.feat, r.goal, r.detail, r.files.join("、"), r.verification),
            phase: Phase::Queued, error: String::new(), updated_at: at,
        });
    }

    /// 失败必须进入可查询终态并通知请求方；不自动重启或无限重试有副作用的任务。
    fn block(&mut self, id: &str, reason: &str, at: i64) {
        if let Some(index) = self.requests.iter().position(|r| r.id == id && !r.phase.terminal()) {
            let r = &mut self.requests[index];
            r.phase = Phase::Blocked; r.detail = reason.into(); r.updated_at = at;
            self.result_notice(index, at);
        }
    }

    /// 检查未结束的依赖边；A 等 B、B 再请求 A 时明确拒绝，避免双方相互等待。
    fn cycle(&self, from: &str, to: &str) -> bool {
        let mut pending = vec![to.to_string()];
        let mut visited = HashSet::new();
        while let Some(id) = pending.pop() {
            if id == from { return true; }
            if visited.insert(id.clone()) {
                pending.extend(self.requests.iter().filter(|r| r.from == id && !r.phase.terminal()).map(|r| r.to.clone()));
            }
        }
        false
    }

    /// 一次轮询对每个目标最多保留一个动作；结果通知优先，不与普通任务合并成一条输入。
    fn plan(&mut self, eps: &HashMap<String, Endpoint>, at: i64) -> Vec<Action> {
        let mut actions = Vec::new();
        let mut reserved = HashSet::new();
        // 停用的排队请求先等真实用户确认；同负责人只持久化一个确认占位，不重复弹窗。
        for r in &mut self.requests {
            if r.phase != Phase::Queued { continue; }
            let Some(disabled) = eps.get(&r.to).and_then(|ep| ep.disabled.as_ref()) else { continue };
            if !self.approvals.contains_key(&r.to) {
                let approval = Approval { id: new_uuid(), ..disabled.clone() };
                actions.push(Action::Confirm { target: r.to.clone(), key: approval.id.clone() });
                self.approvals.insert(r.to.clone(), approval);
            }
            r.phase = Phase::AwaitingApproval; r.detail = "等待用户确认是否重新启用负责人".into(); r.updated_at = at;
        }
        // 已投递后进程退出、目标停用或启动超时均受阻，不能自动执行下一次相同请求。
        let failed: Vec<(String, String)> = self.requests.iter().filter(|r| !r.phase.terminal()).filter_map(|r| {
            let ep = eps.get(&r.to);
            let error = match ep {
                None => Some("模块负责人不存在".into()),
                Some(_) if r.phase == Phase::AwaitingApproval => None,
                Some(ep) if r.phase == Phase::Queued && ep.running && ep.disabled.is_none() && ep.unavailable.is_some() => None,
                Some(ep) if ep.unavailable.is_some() => ep.unavailable.clone(),
                Some(ep) if r.phase.active() && !ep.running => Some("负责人进程已退出，任务结果未确认".into()),
                Some(_) if r.phase == Phase::Starting && at - r.updated_at > 30_000 => Some("负责人启动或就绪超时（30 秒）".into()),
                _ => None,
            };
            error.map(|e| (r.id.clone(), e))
        }).collect();
        for (id, error) in failed { self.block(&id, &error, at); }
        for notice in &mut self.notices {
            if !matches!(notice.phase, Phase::Queued | Phase::Starting) { continue; }
            let Some(ep) = eps.get(&notice.to) else { notice.phase = Phase::Blocked; notice.error = "请求方不存在".into(); continue };
            if let Some(error) = &ep.unavailable { notice.phase = Phase::Blocked; notice.error = error.clone(); continue; }
            if notice.phase == Phase::Starting && at - notice.updated_at > 30_000 {
                notice.phase = Phase::Blocked; notice.error = "请求方启动或就绪超时（30 秒）".into(); continue;
            }
            if reserved.contains(&notice.to) { continue; }
            if !ep.running && notice.phase == Phase::Queued {
                notice.phase = Phase::Starting; notice.updated_at = at; reserved.insert(notice.to.clone());
                actions.push(Action::Start { target: notice.to.clone(), key: notice.request.clone(), notice: true });
            } else if ep.idle {
                notice.phase = Phase::Delivered; notice.updated_at = at; reserved.insert(notice.to.clone());
                actions.push(Action::Deliver { target: notice.to.clone(), key: notice.request.clone(), notice: true, text: notice.text.clone() });
            }
        }
        for index in 0..self.requests.len() {
            let r = &self.requests[index];
            if !matches!(r.phase, Phase::Queued | Phase::Starting) || reserved.contains(&r.to) { continue; }
            if self.notices.iter().any(|n| n.to == r.to && n.phase == Phase::Starting) { continue; }
            if self.requests.iter().any(|other| other.to == r.to && other.id != r.id && (other.phase.active() || other.phase == Phase::Starting)) { continue; }
            let Some(ep) = eps.get(&r.to) else { continue };
            let r = &mut self.requests[index];
            if !ep.running && r.phase == Phase::Queued {
                r.phase = Phase::Starting; r.updated_at = at; reserved.insert(r.to.clone());
                actions.push(Action::Start { target: r.to.clone(), key: r.id.clone(), notice: false });
            } else if ep.idle {
                r.phase = Phase::Delivered; r.updated_at = at; reserved.insert(r.to.clone());
                let scope_step = if r.module.is_empty() { "你是需求协调会话，无需声明图主代码范围" } else { "先读取本模块流程图及代码，通过 flowctl scope 声明职责及负责目录/文件" };
                let text = format!("[模块协作请求 {}] 来自「{}」；来源 Feat：{}；来源任务：{}；负责模块：{}；目标：{}；接口约定：{}；验收条件：{}。{}，再用 flowctl reply {} accept <接单说明> 接单、run <进展> 标记处理；建议优先修改自己负责的部分，跨模块先发 request 协调，公共文件先明确唯一负责人；职责是分工建议，不是文件写入权限限制。完成必须用 reply {} done <结果> --verify <验证结果> [--file <改动文件>]；受阻用 reply {} blocked <原因>。本请求仅承接来源需求已授权范围，不替代用户的提交、发布或其他审批。",
                    r.id, r.from_title, r.feat, r.task.as_ref().map(|t| t.task.as_str()).unwrap_or("无"), r.module, r.goal, r.contract, r.acceptance, scope_step, r.id, r.id, r.id);
                actions.push(Action::Deliver { target: r.to.clone(), key: r.id.clone(), notice: false, text });
            }
        }
        actions
    }

    /// 仅由原生用户确认线程提交选择；NO/异常保持停用，YES 先检查恢复冲突再沿用手动启用规则。
    /// 原请求及同负责人等待请求保留 ID 和正文回到队列，返回是否改了负责人元数据；迟到选择不生效。
    fn decide_approval(&mut self, map: &mut HashMap<String, Entry>, target: &str, key: &str, answer: Result<bool, String>, at: i64) -> bool {
        let Some(approval) = self.approvals.get(target).filter(|a| a.id == key).cloned() else { return false };
        let enabled = answer.and_then(|yes| {
            if !yes { return Err("用户取消重新启用负责人，原会话保持停用".into()); }
            let e = map.get(target).ok_or("负责人不存在")?;
            if (e.meta.archived_at > 0 || e.meta.stored_at > 0)
                && (e.meta.archived_at != approval.archived_at || e.meta.stored_at != approval.stored_at) {
                return Err("确认期间负责人停用状态已变化，请重新提出请求".into());
            }
            archive_entry(map, target, false, at)?;
            set_manual_storage(map.get_mut(target).unwrap(), false, at);
            Ok(())
        });
        self.approvals.remove(target);
        let waiting: Vec<String> = self.requests.iter().filter(|r| r.to == target && matches!(r.phase, Phase::AwaitingApproval | Phase::Queued)).map(|r| r.id.clone()).collect();
        for id in waiting {
            match &enabled {
                Ok(()) => {
                    let r = self.requests.iter_mut().find(|r| r.id == id).unwrap();
                    r.phase = Phase::Queued; r.detail = "用户已确认重新启用，等待负责人空闲后投递".into(); r.updated_at = at;
                }
                Err(error) => self.block(&id, error, at),
            }
        }
        enabled.is_ok()
    }

    /// 校验接收方身份、接单顺序、职责声明和完成证据；分工是协作建议，不拦截跨模块文件回报。
    fn report(&mut self, id: &str, report: &Report, at: i64) -> Result<Request, String> {
        let phase = match report.state.as_str() { "accept" => Phase::Accepted, "run" => Phase::Running, "done" => Phase::Completed, "blocked" => Phase::Blocked, _ => return Err("状态应为 accept/run/done/blocked".into()) };
        if report.text.trim().is_empty() { return Err("回报说明不能为空".into()); }
        let index = self.requests.iter().position(|r| r.id == report.request).ok_or("协作请求不存在")?;
        let current = &self.requests[index];
        if current.to != id { return Err("只有任务接收方可以回报处理状态".into()); }
        if !current.phase.active() { return Err("请求尚未投递或已经结束，不能回报".into()); }
        if phase == Phase::Accepted && current.phase != Phase::Delivered { return Err("只有新送达的任务可以接单".into()); }
        if matches!(phase, Phase::Running | Phase::Completed) && current.phase == Phase::Delivered { return Err("请先用 reply accept 接单".into()); }
        if !current.module.is_empty() && phase != Phase::Blocked {
            self.scopes.get(id).ok_or("图主 Agent 须先用 flowctl scope 声明业务及代码职责")?;
        }
        if phase == Phase::Completed && report.verification.trim().is_empty() { return Err("完成回报必须提供 --verify 验证结果".into()); }
        let r = &mut self.requests[index]; r.phase = phase; r.detail = report.text.trim().into(); r.files = report.files.clone(); r.verification = report.verification.clone(); r.updated_at = at;
        let value = r.clone();
        if phase.terminal() { self.result_notice(index, at); }
        Ok(value)
    }

    /// 一轮结束仍未回报时区分等待下游与遗漏回报；Stop 事件绝不推断任务成功。
    fn stopped(&mut self, id: &str, at: i64) {
        let waiting = self.requests.iter().any(|r| r.from == id && !r.phase.terminal())
            || self.notices.iter().any(|n| n.to == id && matches!(n.phase, Phase::Queued | Phase::Starting));
        let ids: Vec<String> = self.requests.iter().filter(|r| r.to == id && r.phase.active()).map(|r| r.id.clone()).collect();
        for request in ids {
            if waiting {
                let r = self.requests.iter_mut().find(|r| r.id == request).unwrap();
                r.phase = Phase::Waiting; r.updated_at = at;
            } else { self.block(&request, "本轮已结束但未显式回报完成或受阻，请核对实际结果", at); }
        }
    }
}

/// 比较规范路径的包含关系，保留目录边界；不把 src/a 当作 src/ab 的父路径。
fn contains(root: &str, path: &str) -> bool {
    let root = path_key(root).trim_end_matches('/').to_string();
    let path = path_key(path);
    path == root || path.starts_with(&(root + "/"))
}

/// 检查现有负责人之间的路径重叠；归档释放职责，收纳仍保留原模块的负责范围。
fn check_scope(book: &Book, map: &HashMap<String, Entry>, id: &str, paths: &[String]) -> Result<(), String> {
    for (owner, other) in &book.scopes {
        if owner == id || !map.get(owner).is_some_and(|e| e.meta.archived_at == 0) { continue; }
        if paths.iter().any(|p| other.paths.iter().any(|q| contains(p, q) || contains(q, p))) {
            return Err(format!("职责路径与「{}」重叠，请先协调唯一负责人", map[owner].meta.title));
        }
    }
    Ok(())
}

/// 稳定 ID 优先；按图路径选当前非归档图主，归档历史不遮挡后来接任的负责人。
/// 名称及 ID 前缀仍要求唯一，收纳会话继续保留主职责并明确报告停用原因。
fn target(map: &HashMap<String, Entry>, me: &str, to: &str, module_only: bool) -> Result<String, String> {
    let from = map.get(me).ok_or("会话不存在")?;
    let absolute = resolve_flow(from, to.split('#').next().unwrap_or(to), &from.meta.cwd).map(|p| p.to_string_lossy().into_owned());
    let exact: Vec<_> = if let Some(e) = map.get(to).filter(|e| e.meta.id != me) { vec![e] } else {
        let graphs: Vec<_> = map.values().filter(|e| e.meta.id != me && absolute.as_ref().is_some_and(|p| source_of(&e.meta).0 == "flow"
            && crate::paths::norm(Path::new(source_of(&e.meta).1)).ok().is_some_and(|q| path_key(&q.to_string_lossy()) == path_key(p)))).collect();
        if graphs.is_empty() { map.values().filter(|e| e.meta.id != me && e.meta.title == to).collect() }
        else {
            let current: Vec<_> = graphs.iter().copied().filter(|e| e.meta.archived_at == 0).collect();
            if current.is_empty() { graphs } else { current }
        }
    };
    let hits: Vec<_> = if exact.is_empty() { map.values().filter(|e| e.meta.id != me && e.meta.id.starts_with(to)).collect() } else { exact };
    if hits.is_empty() { return Err(format!("未找到模块负责人或会话：{to}")); }
    if hits.len() != 1 { return Err(format!("负责人名称或 ID 前缀有歧义：{to}；请使用完整会话 ID 或图路径")); }
    let e = hits[0];
    if module_only && source_of(&e.meta).0 != "flow" { return Err("模块请求必须发给对应流程图的主 Agent".into()); }
    Ok(e.meta.id.clone())
}

/// 仅有效的显式流程图可自动创建负责人；先按既有路由查找，歧义、未知名称和自请求不能猜测创建。
/// 在同一会话表锁内复用来源唯一性；这里只建记录，调用方保存成功后由原调度器启动、排队。
fn ensure_target(map: &mut HashMap<String, Entry>, me: &str, to: &str, module_only: bool) -> Result<(String, bool), String> {
    let error = match target(map, me, to, module_only) {
        Ok(id) => return Ok((id, false)),
        Err(error) => error,
    };
    if !module_only || map.values().any(|e| e.meta.id != me && (e.meta.id == to || e.meta.title == to || e.meta.id.starts_with(to))) { return Err(error); }
    let from = map.get(me).ok_or("会话不存在")?;
    let file = to.split('#').next().unwrap_or(to);
    if !Path::new(file).extension().is_some_and(|e| e.eq_ignore_ascii_case("drawio")) { return Err(error); }
    let Some(flow) = resolve_flow(from, file, &from.meta.cwd) else { return Err(error) };
    // 有绑定历史或自己就是该图主时不能把路由错误变成第二个图主。
    if map.values().any(|e| source_of(&e.meta).0 == "flow" && crate::paths::norm(Path::new(source_of(&e.meta).1)).ok().is_some_and(|p| path_key(&p.to_string_lossy()) == path_key(&flow.to_string_lossy()))) { return Err(error); }
    let text = std::fs::read_to_string(&flow).map_err(|e| format!("读取目标流程图失败：{e}"))?;
    crate::flow::parse(&text).map_err(|e| format!("目标流程图无效：{e}"))?;
    let document = roxmltree::Document::parse(&text).map_err(|e| format!("目标流程图无效：{e}"))?;
    if !matches!(document.root_element().tag_name().name(), "mxfile" | "mxGraphModel") { return Err("目标文件不是 draw.io 流程图".into()); }
    let directory = flow.parent().ok_or("流程图目录缺失")?;
    let cwd = directory.parent().filter(|docs| directory.file_name().is_some_and(|n| n == "flow") && docs.file_name().is_some_and(|n| n == "docs"))
        .and_then(Path::parent).unwrap_or(directory);
    let at = now();
    let meta = Meta { id: new_uuid(), title: String::new(), cwd: cwd.to_string_lossy().into_owned(), app: crate::scan::app_of(cwd).1,
        feat: String::new(), feat_code: String::new(), links: vec![NodeRef { flow: flow.to_string_lossy().into_owned(), node: String::new() }],
        pinned: false, pin_at: 0, created: at, started: false, cli_session_id: String::new(), archived_at: 0, stored_at: 0, storage_override: None };
    Ok((insert_session(map, meta)?, true))
}

/// 列表附带稳定身份、来源、运行情况和职责，供调用者精确选择负责人而非按显示名称猜测。
pub(super) fn peers(id: &str) -> Result<Value, String> {
    let map = hub()?.entries.lock().unwrap();
    let me = map.get(id).ok_or("会话不存在")?;
    let store = STORE.get().ok_or("协作服务未初始化")?.lock().unwrap();
    Ok(json!(map.values().filter(|e| e.meta.id != id && e.meta.app == me.meta.app).map(|e| {
        let (kind, path) = source_of(&e.meta);
        json!({ "id": e.meta.id, "title": e.meta.title, "status": e.live.status, "running": e.proc.is_some(),
            "feat": e.meta.feat_code, "focus": e.live.focus, "source_kind": kind, "source_path": path,
            "archived_at": e.meta.archived_at, "stored_at": e.meta.stored_at, "scope": store.book.scopes.get(&e.meta.id) })
    }).collect::<Vec<_>>()))
}

/// 声明模块职责，只允许图主会话；路径必须存在且在其工作目录内，重叠路径先协调唯一写入者。
fn scope(id: &str, req: &Value) -> Result<Value, String> {
    let map = hub()?.entries.lock().unwrap();
    let me = map.get(id).ok_or("会话不存在")?;
    if source_of(&me.meta).0 != "flow" { return Err("只有图主 Agent 可声明模块职责".into()); }
    let description = req["description"].as_str().ok_or("缺少职责说明")?.trim();
    let input: Vec<String> = serde_json::from_value(req["paths"].clone()).map_err(|_| "职责路径应为列表")?;
    if description.is_empty() || input.is_empty() { return Err("必须声明业务职责和至少一个现有目录/文件".into()); }
    let cwd = crate::paths::norm(Path::new(&me.meta.cwd))?.to_string_lossy().into_owned();
    let paths: Vec<String> = input.iter().map(|p| crate::paths::norm(&Path::new(&cwd).join(p)).map(|p| p.to_string_lossy().into_owned())).collect::<Result<_, _>>()?;
    if paths.iter().any(|p| !contains(&cwd, p)) { return Err("职责路径必须位于模块工作目录内".into()); }
    let mut store = STORE.get().ok_or("协作服务未初始化")?.lock().unwrap();
    check_scope(&store.book, &map, id, &paths)?;
    let value = Scope { description: description.into(), paths };
    let mut next = store.book.clone(); next.scopes.insert(id.into(), value.clone());
    save(&store.path, &next)?; store.book = next;
    Ok(json!(value))
}

/// 新建持久化协作任务；普通 send 复用任务投递但允许发给协调会话，request 必须指定模块负责人。
fn request(id: &str, req: &Value, module_only: bool) -> Result<Value, String> {
    let to = req["to"].as_str().ok_or("缺少接收方")?.trim();
    let goal = req["text"].as_str().ok_or("缺少任务目标")?.trim();
    if to.is_empty() || goal.is_empty() { return Err("接收方和目标不能为空".into()); }
    let contract = if module_only { req["contract"].as_str().ok_or("缺少 --contract 接口约定")? } else { "按消息明确协商，职责不清时回报受阻" };
    let acceptance = if module_only { req["acceptance"].as_str().ok_or("缺少 --acceptance 验收条件")? } else { "明确回报处理结论" };
    if contract.trim().is_empty() || acceptance.trim().is_empty() { return Err("接口约定和验收条件不能为空".into()); }
    let mut map = hub()?.entries.lock().unwrap();
    let (target, created) = ensure_target(&mut map, id, to, module_only)?;
    if created {
        if let Err(error) = save_metas(&map) { map.remove(&target); return Err(error); }
    }
    let from = &map[id];
    let mut store = STORE.get().ok_or("协作服务未初始化")?.lock().unwrap();
    if store.book.cycle(id, &target) { return Err("协作请求形成循环等待，请由 Feat 主 Agent 调整分工".into()); }
    let parent = store.book.requests.iter().find(|r| r.to == id && r.phase.active());
    let origin_task = from.live.task.clone().or_else(|| parent.and_then(|r| r.task.clone()));
    let origin_feat = if !from.meta.feat.is_empty() { from.meta.feat.clone() }
        else { origin_task.as_ref().map(|t| t.feat.clone()).or_else(|| parent.map(|r| r.feat.clone())).unwrap_or_default() };
    let awaiting = store.book.approvals.contains_key(&target);
    let phase = if awaiting { Phase::AwaitingApproval } else { Phase::Queued };
    let r = Request { id: new_uuid(), from: id.into(), to: target.clone(), from_title: from.meta.title.clone(), module: source_of(&map[&target].meta).1.into(),
        feat: origin_feat, task: origin_task, goal: goal.into(), contract: contract.into(), acceptance: acceptance.into(), phase,
        detail: if awaiting { "等待用户确认是否重新启用负责人".into() } else { String::new() }, files: Vec::new(), verification: String::new(), created_at: now(), updated_at: now() };
    let mut next = store.book.clone(); next.requests.push(r.clone());
    save(&store.path, &next)?; store.book = next;
    drop(store);
    let a = push_message(map.get_mut(id).unwrap(), &target, format!("已提出协作 {}：{}", &r.id[..8], cut(goal, 60))); emit_act(id, &a);
    let a = push_message(map.get_mut(&target).unwrap(), id, format!("待处理协作 {}：{}", &r.id[..8], cut(goal, 60))); emit_act(&target, &a);
    emit_update(&map[id]); emit_update(&map[&target]);
    let disabled = map[&target].meta.archived_at > 0 || map[&target].meta.stored_at > 0;
    Ok(json!({ "result": if disabled { "负责人已停用，等待用户确认重新启用；Agent 不能代替用户确认" } else { "已排队，负责人未运行时将自动续接" }, "created": created, "request": r }))
}

/// 回报允许包含已删除文件；通过最近存在的父目录规范化路径，保持真实文件信息而不设置写入权限。
fn report_path(path: &Path) -> Result<String, String> {
    let mut base = path.to_path_buf();
    let mut suffix = Vec::new();
    while !base.exists() {
        suffix.push(base.file_name().ok_or("文件路径无效")?.to_os_string());
        base = base.parent().ok_or("文件路径没有有效父目录")?.to_path_buf();
    }
    let mut normalized = crate::paths::norm(&base)?;
    for part in suffix.into_iter().rev() { normalized.push(part); }
    Ok(normalized.to_string_lossy().into_owned())
}

/// 接收方显式回报状态，终态不可回写；完成需验证说明，改动文件如实保存，职责作为分工建议。
fn reply(id: &str, req: &Value) -> Result<Value, String> {
    let mut report: Report = serde_json::from_value(req.clone()).map_err(|e| format!("协作回报字段错误：{e}"))?;
    let mut map = hub()?.entries.lock().unwrap();
    let me = map.get(id).ok_or("会话不存在")?;
    report.files = report.files.iter().map(|p| report_path(&Path::new(&me.meta.cwd).join(p))).collect::<Result<_, _>>()?;
    let mut store = STORE.get().ok_or("协作服务未初始化")?.lock().unwrap();
    if report.state != "blocked" {
        if let Some(scope) = store.book.scopes.get(id) { check_scope(&store.book, &map, id, &scope.paths)?; }
    }
    let mut next = store.book.clone();
    let value = next.report(id, &report, now())?;
    save(&store.path, &next)?; store.book = next; drop(store);
    let a = push_message(map.get_mut(id).unwrap(), &value.from, format!("协作 {} {:?}：{}", &value.id[..8], value.phase, cut(&value.detail, 60))); emit_act(id, &a); emit_update(&map[id]);
    Ok(json!(value))
}

/// 协作命令统一分发，复用现有 TCP 身份认证；查询仅返回自己的收发任务和通知。
pub(super) fn dispatch(id: &str, req: &Value) -> Result<Value, String> {
    match req["op"].as_str().unwrap_or("") {
        "scope" => scope(id, req),
        "request" => request(id, req, true),
        "send" => request(id, req, false),
        "reply" => reply(id, req),
        "requests" => {
            let store = STORE.get().ok_or("协作服务未初始化")?.lock().unwrap();
            Ok(json!({ "scope": store.book.scopes.get(id),
                "requests": store.book.requests.iter().filter(|r| r.from == id || r.to == id).collect::<Vec<_>>(),
                "notices": store.book.notices.iter().filter(|n| n.to == id).collect::<Vec<_>>() }))
        }
        _ => Err("未知协作命令".into()),
    }
}

/// hook 在会话锁内通知轮次结束；保存失败显式记录，绝不把未回报任务写成完成。
pub(super) fn on_stop(id: &str) {
    let Some(store) = STORE.get() else { return };
    let mut store = store.lock().unwrap();
    if !store.book.requests.iter().any(|r| r.to == id && r.phase.active()) { return; }
    let mut next = store.book.clone(); next.stopped(id, now());
    match save(&store.path, &next) { Ok(()) => store.book = next, Err(error) => eprintln!("保存协作轮次结果失败：{error}") }
}

/// 有未完成的收发任务或结果通知时不被空闲清扫；终态及已送达通知不阻止正常回收。
pub(super) fn pending(id: &str) -> bool {
    let Some(store) = STORE.get() else { return false };
    let store = store.lock().unwrap();
    store.book.requests.iter().any(|r| (r.from == id || r.to == id) && !r.phase.terminal())
        || store.book.notices.iter().any(|n| n.to == id && matches!(n.phase, Phase::Queued | Phase::Starting))
}

/// 启动独立调度线程；不打开窗口或切换页签，不轮询磁盘，也不在账本锁中启动子进程。
pub(super) fn start() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(250));
        if STOPPED.load(Ordering::SeqCst) { break; }
        if let Err(error) = pump() { eprintln!("协作调度失败：{error}"); }
    });
}

/// 保留动作后释放两把锁，再执行启动或投递；写盘失败不执行未被记录的副作用。
fn pump() -> Result<(), String> {
    let h = hub()?;
    let map = h.entries.lock().unwrap();
    let mut store = STORE.get().ok_or("协作服务未初始化")?.lock().unwrap();
    if !store.book.requests.iter().any(|r| !r.phase.terminal()) && !store.book.notices.iter().any(|n| matches!(n.phase, Phase::Queued | Phase::Starting)) { return Ok(()); }
    let mut next = store.book.clone();
    let actions = next.plan(&endpoints(&map), now());
    // 账本无变化时不反复写盘；仅动作或失败状态变化需要提交。
    if next != store.book { save(&store.path, &next)?; store.book = next; }
    drop(store); drop(map);
    for action in actions {
        std::thread::spawn(move || {
            if STOPPED.load(Ordering::SeqCst) { return; }
            match &action {
                Action::Start { target, .. } => {
                    if let Err(error) = spawn(target, None) { failed(&action, &error); }
                    if STOPPED.load(Ordering::SeqCst) {
                        if let Ok(h) = hub() {
                            if let Some(e) = h.entries.lock().unwrap().get_mut(target) {
                                e.stopping = true;
                                if let Some(p) = e.proc.as_mut() { let _ = p.killer.kill(); }
                            }
                        }
                    }
                }
                Action::Confirm { target, key } => confirm::owner(target, key),
                Action::Deliver { .. } => { if let Err(error) = deliver(&action) { failed(&action, &error); } }
            }
        });
    }
    Ok(())
}

/// PTY 投递前重新核对空闲和停用状态；括号粘贴隔离任务正文中的换行及控制字符。
fn deliver(action: &Action) -> Result<(), String> {
    let Action::Deliver { target, text, key, notice } = action else { unreachable!() };
    let mut map = hub()?.entries.lock().unwrap();
    {
        let store = STORE.get().unwrap().lock().unwrap();
        let still_reserved = if *notice { store.book.notices.iter().any(|n| n.request == *key && n.phase == Phase::Delivered) }
            else { store.book.requests.iter().any(|r| r.id == *key && r.phase == Phase::Delivered) };
        if !still_reserved { return Ok(()); }
    }
    let e = map.get_mut(target).ok_or("接收方不存在")?;
    if e.meta.archived_at > 0 || e.meta.stored_at > 0 || e.stopping { return Err("接收方已停用或正在停止".into()); }
    if e.live.status != "idle" || e.compacting || e.proc.is_none() || has_draft(target) {
        // 预留后用户开始了新一轮，撤回投递占位，保持队列顺序，不向权限确认框输入任务。
        let mut store = STORE.get().unwrap().lock().unwrap();
        let mut next = store.book.clone();
        if *notice { next.notices.iter_mut().find(|n| n.request == *key).ok_or("通知不存在")?.phase = Phase::Queued; }
        else { next.requests.iter_mut().find(|r| r.id == *key).ok_or("任务不存在")?.phase = Phase::Queued; }
        save(&store.path, &next)?; store.book = next;
        return Ok(());
    }
    let text: String = text.chars().map(|c| if c.is_control() && c != '\n' && c != '\t' { ' ' } else { c }).collect();
    write_proc(e, &format!("\x1b[200~{text}\x1b[201~"))?;
    // 保持会话锁到提交完成，避免多个投递或用户输入夹在正文与 Enter 之间。
    std::thread::sleep(Duration::from_millis(100));
    write_proc(e, "\r")?;
    set_status(e, "run"); e.idle_since = 0;
    let a = push_act(e, "msg", format!("{} {} 已送达", if *notice { "协作结果" } else { "协作请求" }, &key[..8]), String::new());
    emit_act(target, &a); emit_update(e);
    Ok(())
}

/// 启动/投递失败保留具体原因；一次失败进入终态，不自动循环重试或掩盖部分写入。
fn failed(action: &Action, error: &str) {
    let (key, notice) = match action { Action::Start { key, notice, .. } | Action::Deliver { key, notice, .. } => (key, notice), Action::Confirm { .. } => return };
    let Some(store) = STORE.get() else { return };
    let mut store = store.lock().unwrap();
    let mut next = store.book.clone();
    if *notice {
        if let Some(n) = next.notices.iter_mut().find(|n| n.request == *key) { n.phase = Phase::Blocked; n.error = error.into(); }
    } else { next.block(key, error, now()); }
    match save(&store.path, &next) { Ok(()) => store.book = next, Err(e) => eprintln!("保存协作失败结果失败：{e}；原错误：{error}") }
}

#[path = "agent_collab_confirm.rs"]
mod confirm;

#[cfg(test)]
#[path = "agent_collab_tests.rs"]
mod tests;
