//! Agent 窗口后端：托管 Claude Code CLI 会话（ConPTY 内运行真实的 claude TUI），汇总 hooks 回报的状态，
//! 供 Agent 窗口（会话列表、终端页签）和主窗口画布（节点上的 Agent 图标）使用。
//!
//! - 会话元数据存 `<数据目录>/agent/sessions.json`；Flow Coding 的会话 id 是稳定 id（首次启动用
//!   `--session-id` 下发，也是 FLOW_AGENT_ID）；Claude Code 在 /clear、compact、/resume 后会换新
//!   session id，由 SessionStart 回报记入 meta.cli_session_id，续接时用 `--resume` 指到最新对话；
//! - 进程由 App 后台持有：关闭 Agent 窗口不中断会话，主窗口退出时结束全部会话；
//!   连续空闲超过 idle_hours（设置页可调，默认 1 小时，0 不启用）的会话由后台清扫线程自动结束；
//! - 状态来源：启动时用 `--settings` 挂 hooks，hook 调 `flowctl agent-hook <事件>`，经本机 TCP
//!   （只监听 127.0.0.1，请求必须带启动时下发的随机令牌）回报；同一通道提供 `flowctl focus / peers / send`；
//! - 协作消息写入对方终端：对方空闲时立即写入并回车；运行中或在等确认时排队，等它本轮结束（Stop）再写入，
//!   避免消息被当成确认框的按键。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

#[path = "agent_probe.rs"]
mod probe;

/// 使用设置页当前输入检查 Claude CLI 启动和实际回复，不保存配置。
#[tauri::command]
pub async fn agent_test_settings(claude_path: String, extra_args: String) -> Result<Value, String> {
    probe::test(claude_path, extra_args).await
}

/// Agent 窗口的窗口标签。
pub const LABEL: &str = "agent";
/// 每个会话保留的终端输出（重新打开页签时回放），超出后从头部裁掉四分之一。
const BUF_MAX: usize = 1 << 20;
/// 每个会话保留的最近活动条数（泳道、节点热度、冲突判断用）。
const ACTS_MAX: usize = 300;
/// 每个会话保留的 worker（subagent）条数。
const WORKERS_MAX: usize = 20;

/// 流程图节点引用：图文件绝对路径 + 节点 id（node 为空表示整张图）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeRef {
    pub flow: String,
    pub node: String,
}

/// Feat 任务引用：Feat 档案绝对路径 + 任务编号（T3，或子任务 T3.1）。
/// 由 `flowctl focus <Feat档案>#T<n>` 标记，Feat 控件页据此在对应任务卡片上显示会话。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskRef {
    pub feat: String,
    pub task: String,
}

/// 持久化的会话元数据。feat 为空表示未关联 Feat；links 为关联的流程图节点。
/// 名称来源：feat 非空时为该 Feat 的主会话（title 取档案一级标题），否则第一个 link 为图主
/// （title 取图文件名）；其余 link 都是客串关联，不参与命名。无任何关联的会话名可自由修改。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub app: String,
    #[serde(default)]
    pub feat: String,
    #[serde(default)]
    pub feat_code: String,
    #[serde(default)]
    pub links: Vec<NodeRef>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub pin_at: i64,
    pub created: i64,
    /// 是否启动过（启动过且 Claude Code 有对话记录时用 --resume）。
    #[serde(default)]
    pub started: bool,
    /// Claude Code 当前实际使用的会话 id（启动时等于 id；/clear、compact、/resume 换新 id 后由
    /// SessionStart 回报更新）。Flow Coding 的会话 id（id 字段，FLOW_AGENT_ID）始终不变，
    /// 续接时用 cli_session_id 指到最新对话记录。
    #[serde(default)]
    pub cli_session_id: String,
    /// 归档时间（毫秒）；0 为活跃记录，归档满 180 天后清理 Flow Coding 记录。
    #[serde(default)]
    pub archived_at: i64,
}

/// 一条活动：时间、类型（prompt/read/edit/cmd/commit/worker/tool/msg/note/compact）、简述、
/// 涉及的文件、当时所在的流程图节点、归属的 worker。
#[derive(Debug, Clone, Serialize)]
pub struct Act {
    pub t: i64,
    pub kind: String,
    pub text: String,
    pub path: String,
    pub flow: String,
    pub node: String,
    pub worker: String,
    /// 协作消息的对方会话 ID；其他活动为空，不通过显示名称推断关系。
    pub peer: String,
}

/// worker：Claude Code 通过 Task / Agent 工具派出的 subagent。
#[derive(Debug, Clone, Serialize)]
pub struct Worker {
    pub id: String,
    pub desc: String,
    pub running: bool,
    pub t0: i64,
    pub t1: i64,
    pub uses: u32,
}

/// CLI 状态行上报的模型、推理档位、当前上下文和工作目录；Git 分支由 hook 在该目录只读查询。
#[derive(Debug, Clone, Serialize)]
pub struct Metrics {
    pub current_dir: Option<String>,
    pub git_branch: Option<String>,
    pub model_id: Option<String>,
    pub model_name: Option<String>,
    pub effort: Option<String>,
    pub input_tokens: Option<u64>,
    pub cache_creation_input_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub used_tokens: Option<u64>,
    pub capacity: Option<u64>,
    pub used_percentage: Option<f64>,
    pub updated_at: i64,
}

impl Metrics {
    /// 从 CLI 状态行 JSON 读取当前输入（含缓存读写），不含输出；尚未调用 API 或压缩后为未知。
    fn from_statusline(p: &Value, t: i64) -> Self {
        let context = &p["context_window"];
        let usage = &context["current_usage"];
        let used_tokens = usage["input_tokens"].as_u64()
            .and_then(|n| n.checked_add(usage["cache_creation_input_tokens"].as_u64()?))
            .and_then(|n| n.checked_add(usage["cache_read_input_tokens"].as_u64()?));
        let capacity = context["context_window_size"].as_u64().filter(|n| *n > 0);
        Self {
            current_dir: p["workspace"]["current_dir"].as_str().or_else(|| p["cwd"].as_str())
                .filter(|s| !s.is_empty()).map(str::to_string),
            git_branch: p["flow_coding_git_branch"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            model_id: p["model"]["id"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            model_name: p["model"]["display_name"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            effort: p["effort"]["level"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            input_tokens: usage["input_tokens"].as_u64(),
            cache_creation_input_tokens: usage["cache_creation_input_tokens"].as_u64(),
            cache_read_input_tokens: usage["cache_read_input_tokens"].as_u64(),
            used_tokens,
            capacity,
            used_percentage: used_tokens.zip(capacity).map(|(used, size)| used as f64 / size as f64 * 100.0),
            updated_at: t,
        }
    }
}

/// 在 flowctl 状态行子进程中按 CLI 实际目录只读查询分支，避免在 App 的会话锁内执行 Git。
/// 非仓库或 Git 不可用时保留未知；游离 HEAD 单独标明，不改动工作区或活动计时。
pub fn enrich_statusline(p: &mut Value) {
    let Some(dir) = p["workspace"]["current_dir"].as_str().or_else(|| p["cwd"].as_str())
        .filter(|s| !s.is_empty()) else { return };
    let mut cmd = std::process::Command::new("git");
    cmd.args(["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"])
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW：状态行刷新不闪出控制台。
    }
    let branch = match cmd.output() {
        Ok(out) if out.status.success() => String::from_utf8(out.stdout).ok()
            .map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        Ok(out) if out.status.code() == Some(1) => Some("HEAD（游离）".to_string()),
        _ => None,
    };
    p["flow_coding_git_branch"] = json!(branch);
}

/// 运行状态（不持久化）。status：off 未运行 | boot 启动中 | idle 空闲 | run 运行中 | wait 等你确认 | err 异常退出。
/// 停滞由前端按 beat 推导：run 且没有执行中的工具、60 秒没有 hook 活动。
#[derive(Debug, Clone, Serialize)]
pub struct Live {
    pub status: String,
    pub since: i64,
    pub turn: i64,
    /// 本轮完整提问，供会话列表提取首句并提供完整 tooltip；不随活动队列截断。
    pub turn_prompt: String,
    pub beat: i64,
    pub tool: String,
    pub tool_since: i64,
    pub wait_text: String,
    pub focus: Option<NodeRef>,
    /// 正在处理的 Feat 任务（进程退出时清除）。
    pub task: Option<TaskRef>,
    pub workers: Vec<Worker>,
    /// 最近一次结构化状态上报；重启、清空或压缩上下文时失效，下一次状态上报恢复。
    pub metrics: Option<Metrics>,
    pub exit_code: Option<u32>,
    /// 最近一轮结束（Stop）的时间；大于 seen 表示「运行完成、你还没看」。
    pub done: i64,
    /// 最近一次在 Agent 窗口打开该会话页签的时间。
    pub seen: i64,
}

/// 运行中的 PTY 进程句柄。
struct Proc {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// 一个会话的全部状态；gen 区分同一会话前后几次启动，旧进程的读线程不会改到新进程的状态。
struct Entry {
    meta: Meta,
    live: Live,
    acts: VecDeque<Act>,
    queue: VecDeque<String>,
    proc: Option<Proc>,
    buf: String,
    seq: u64,
    gen: u64,
    /// 用户点了停止：进程随后的退出算正常结束（TerminateProcess 的退出码是 1）。
    stopping: bool,
    /// 持续空闲的起算点：进入 idle 的时间，或 idle 状态下最后一次用户终端输入的时间；
    /// /clear 等 SessionStart 也重算。空闲回收只认它，终端输出不动它（TUI 重绘不算活跃）。
    idle_since: i64,
    /// PreCompact 之后、下一轮 hook 活动之前为 true：压缩进行中不得被空闲回收。
    compacting: bool,
}

/// 全局会话表与 hooks 通道参数；idle_hours 缓存空闲超时设置（f64 位表示，小时，0 = 不回收），
/// 供后台回收线程读，避免每次检查都读盘。
struct Hub {
    entries: Mutex<HashMap<String, Entry>>,
    port: u16,
    token: String,
    idle_hours: AtomicU64,
}

static HUB: OnceLock<Hub> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
/// 服务启动等待上限；仅在阻塞线程池等待，不占用窗口线程或异步运行时工作线程。
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
static STARTUP: Startup = Startup::new();

/// 服务初始化的一次性结果：None 为正在启动，Some 保存成功或具体失败原因；通知所有等待者。
struct Startup {
    result: Mutex<Option<Result<(), String>>>,
    changed: Condvar,
}

impl Startup {
    /// 创建“正在启动”的信号；不读取文件或等待线程，可用于静态初始化和隔离测试。
    const fn new() -> Self {
        Self { result: Mutex::new(None), changed: Condvar::new() }
    }

    /// 发布最终启动结果并唤醒等待者；错误原样保留，后续读取也会立即得到同一结果。
    fn finish(&self, result: Result<(), String>) {
        *self.result.lock().unwrap() = Some(result);
        self.changed.notify_all();
    }

    /// 在后台等待指定时限；超时只结束本次等待，不强制终止文件读取，晚到的成功仍可供后续请求使用。
    fn wait(&self, timeout: Duration) -> Result<(), String> {
        let (result, _) = self.changed.wait_timeout_while(
            self.result.lock().unwrap(), timeout, |result| result.is_none(),
        ).unwrap();
        result.clone().unwrap_or_else(|| Err(format!("Agent 服务启动超时（{} 秒），请稍后重试", timeout.as_secs())))
    }
}
/// 两个设置面板共享 settings.json，串行读改写以免并发保存覆盖另一项。
static SETTINGS_WRITE: Mutex<()> = Mutex::new(());
/// Agent 窗口最近一次的位置与尺寸（物理像素），关闭时写盘。
static GEOM: Mutex<Option<Geom>> = Mutex::new(None);

/// Agent 窗口几何信息：物理坐标、物理尺寸、是否最大化。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
struct Geom {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    #[serde(default)]
    max: bool,
}

/// 当前毫秒时间戳。
fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 生成 UUID v4 字符串（随机源：时间、进程号、计数器与系统随机哈希种子，经 SHA-256 混合）。
fn new_uuid() -> String {
    use sha2::{Digest, Sha256};
    use std::hash::{BuildHasher, Hasher};
    static N: AtomicU64 = AtomicU64::new(0);
    let mut h = Sha256::new();
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    h.update(nanos.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    h.update(N.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    h.update(std::collections::hash_map::RandomState::new().build_hasher().finish().to_le_bytes());
    let d = h.finalize();
    let mut b = [0u8; 16];
    b.copy_from_slice(&d[..16]);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let s = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &s[0..8], &s[8..12], &s[12..16], &s[16..20], &s[20..32])
}

/// Agent 数据目录 `<数据目录>/agent`。
fn dir() -> Result<PathBuf, String> {
    let d = crate::paths::home()?.join("agent");
    std::fs::create_dir_all(&d).map_err(|e| format!("创建目录失败 {}: {e}", d.display()))?;
    Ok(d)
}

/// 取全局会话表；init 之前调用直接报错。
fn hub() -> Result<&'static Hub, String> {
    HUB.get().ok_or_else(|| "Agent 服务未初始化".to_string())
}

/// 未运行状态的初始 Live。
fn idle_live() -> Live {
    Live { status: "off".into(), since: now(), turn: 0, turn_prompt: String::new(), beat: 0, tool: String::new(), tool_since: 0, wait_text: String::new(), focus: None, task: None, workers: Vec::new(), metrics: None, exit_code: None, done: 0, seen: 0 }
}

/// 读会话元数据文件；不存在返回空表，损坏直接报错（不覆盖用户数据）。
fn load_metas() -> Result<Vec<Meta>, String> {
    let f = dir()?.join("sessions.json");
    match std::fs::read_to_string(&f) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("读取 {} 失败: {e}", f.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取 {} 失败: {e}", f.display())),
    }
}

/// 把当前会话表的元数据按创建时间写盘。
fn save_metas(map: &HashMap<String, Entry>) -> Result<(), String> {
    let mut list: Vec<&Meta> = map.values().map(|e| &e.meta).collect();
    list.sort_by_key(|m| m.created);
    let text = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    crate::write_atomic(&dir()?.join("sessions.json"), &text)
}

/// 会话视图（前端用）：元数据 + 运行状态 + 排队消息数；with_acts 时附带最近活动。
fn view(e: &Entry, with_acts: bool) -> Value {
    let mut v = serde_json::to_value(&e.meta).unwrap();
    let live = serde_json::to_value(&e.live).unwrap();
    if let (Some(o), Value::Object(l)) = (v.as_object_mut(), live) {
        o.extend(l);
        let (kind, source) = source_of(&e.meta);
        o.insert("title_locked".into(), json!(!kind.is_empty()));
        o.insert("source_kind".into(), json!(kind));
        o.insert("source_path".into(), json!(source));
        o.insert("queued".into(), json!(e.queue.len()));
        o.insert("running".into(), json!(e.proc.is_some()));
        o.insert("compacting".into(), json!(e.compacting));
        if with_acts {
            o.insert("acts".into(), serde_json::to_value(&e.acts).unwrap());
        }
    }
    v
}

/// 广播单个会话的最新视图（不含活动），所有窗口都收得到。
fn emit_update(e: &Entry) {
    if let Some(app) = APP.get() {
        let _ = app.emit("agent-update", view(e, false));
    }
}

/// 广播一条新活动。
fn emit_act(id: &str, a: &Act) {
    if let Some(app) = APP.get() {
        let _ = app.emit("agent-act", json!({ "id": id, "act": a }));
    }
}

/// 主窗口可先显示；后台读会话与创建 hooks 监听，前端通过 agent_list 异步等待启动结果。
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    std::thread::spawn(start_hub);
}

/// 完成初始化后发布就绪或错误；不依赖窗口，真实 CLI 测试也复用这一入口。
fn start_hub() {
    let result = build_hub();
    if let Err(error) = &result { eprintln!("Agent 服务启动失败: {error}"); }
    STARTUP.finish(result);
}

/// 建会话表并开监听线程；会话文件损坏或端口绑定失败直接返回具体错误，不以空列表覆盖数据。
fn build_hub() -> Result<(), String> {
    let metas = load_metas()?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Agent 端口监听失败: {e}"))?;
    let port = listener.local_addr().map_err(|e| format!("读取 Agent 监听地址失败: {e}"))?.port();
    let mut map = HashMap::new();
    let mut renamed = false;
    for m in metas {
        let mut e = Entry { meta: m, live: idle_live(), acts: VecDeque::new(), queue: VecDeque::new(), proc: None, buf: String::new(), seq: 0, gen: 0, stopping: false, idle_since: 0, compacting: false };
        renamed |= normalize(&mut e);
        map.insert(e.meta.id.clone(), e);
    }
    let expired = expired_archives(&map, now());
    if let Err(error) = remove_entries(&mut map, &expired) {
        eprintln!("清理归档 Agent 失败: {error}");
    }
    if renamed {
        if let Err(e) = save_metas(&map) {
            eprintln!("同步会话名写盘失败: {e}");
        }
    }
    // 空闲超时缓存进 Hub，清扫线程不用每轮读盘；文件值非法时回落默认 1 小时。
    let idle_hours = load_settings().ok().and_then(|s| valid_idle_hours(s.idle_hours).ok()).unwrap_or_else(default_idle_hours);
    let _ = HUB.set(Hub { entries: Mutex::new(map), port, token: new_uuid(), idle_hours: AtomicU64::new(idle_hours.to_bits()) });
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            std::thread::spawn(move || handle_conn(s));
        }
    });
    std::thread::spawn(idle_sweeper);
    Ok(())
}

/// 主窗口关闭、App 退出前保存 Agent 窗口位置并结束全部会话进程；对话历史由 Claude Code 保存，下次可续接。
pub fn shutdown() {
    if let Err(error) = save_window_geometry() {
        eprintln!("保存 Agent 窗口状态失败: {error}");
    }
    let Ok(h) = hub() else { return };
    for e in h.entries.lock().unwrap().values_mut() {
        if let Some(p) = e.proc.as_mut() {
            let _ = p.killer.kill();
        }
    }
}

// ---------------- 进程 ----------------

/// claude 可执行文件：直接启动的 exe，或需经 cmd.exe 启动的 .cmd 包装脚本。
enum Exe {
    Direct(PathBuf),
    Cmd(PathBuf),
}

impl Exe {
    /// 实际启动的文件路径（设置页展示用）。
    fn path(&self) -> &Path {
        match self {
            Exe::Direct(p) | Exe::Cmd(p) => p,
        }
    }
}

/// 空闲超时默认值：1 小时。
fn default_idle_hours() -> f64 {
    1.0
}

/// 设置页「Claude Code」的启动项，存 `<数据目录>/agent/settings.json`。
/// - `claude_path`：claude 可执行文件，空 = 自动查找；`.cmd` 结尾经 cmd.exe 启动；
/// - `extra_args`：追加到每次启动（新建与续接）的命令行参数，空格分隔，含空格的值用双引号括起；
/// - `idle_hours`：CLI 连续空闲该小时数后自动结束进程（0 = 不自动结束），由后台清扫线程执行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSettings {
    #[serde(default)]
    pub claude_path: String,
    #[serde(default)]
    pub extra_args: String,
    /// 缺省 1 小时；旧版 settings.json 没有该字段时也按 1 小时处理。
    #[serde(default = "default_idle_hours")]
    pub idle_hours: f64,
}

impl Default for ClaudeSettings {
    fn default() -> Self {
        Self { claude_path: String::new(), extra_args: String::new(), idle_hours: default_idle_hours() }
    }
}

/// 校验空闲小时数：必须是有限数值，0–8760（0 = 不自动结束），允许小数。
fn valid_idle_hours(h: f64) -> Result<f64, String> {
    if !h.is_finite() {
        return Err("空闲小时数必须是有限数值".into());
    }
    if !(0.0..=8760.0).contains(&h) {
        return Err("空闲小时数应在 0 - 8760 之间（0 表示不自动结束）".into());
    }
    Ok(h)
}

/// 读启动项：文件不存在用默认（自动查找、无额外参数）；文件损坏直接报错，避免带着错误配置静默启动。
fn load_settings() -> Result<ClaudeSettings, String> {
    let f = dir()?.join("settings.json");
    match std::fs::read_to_string(&f) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("Agent 设置文件损坏 {}: {e}", f.display())),
        Err(_) => Ok(ClaudeSettings::default()),
    }
}

/// 把额外参数文本拆成参数列表：空白分隔，双引号内的空白保留，引号本身去掉；引号未闭合报错。
fn split_args(text: &str) -> Result<Vec<String>, String> {
    let (mut out, mut cur, mut quoted, mut has) = (Vec::new(), String::new(), false, false);
    for ch in text.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if quoted {
        return Err("额外参数中的双引号没有闭合".into());
    }
    if has {
        out.push(cur);
    }
    Ok(out)
}

/// 查找 claude：设置页指定的路径优先（不存在报错，不回退）；其次环境变量 FLOW_CLAUDE；再次 PATH 中的
/// claude.exe；npm 安装的 claude.cmd 优先换成包内的 claude.exe（参数不经 cmd.exe 二次解析）；
/// 最后是 ~/.local/bin/claude.exe。都没有则报错。
fn find_claude(set: &ClaudeSettings) -> Result<Exe, String> {
    let custom = set.claude_path.trim();
    if !custom.is_empty() {
        let p = PathBuf::from(custom);
        if !p.is_file() {
            return Err(format!("设置中的 Claude Code 路径不存在：{custom}"));
        }
        let cmd = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
        return Ok(if cmd { Exe::Cmd(p) } else { Exe::Direct(p) });
    }
    if let Some(p) = std::env::var_os("FLOW_CLAUDE") {
        return Ok(Exe::Direct(PathBuf::from(p)));
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    for d in &dirs {
        let exe = d.join("claude.exe");
        if exe.is_file() {
            return Ok(Exe::Direct(exe));
        }
    }
    for d in &dirs {
        let cmd = d.join("claude.cmd");
        if cmd.is_file() {
            let inner = d.join("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join("claude.exe");
            return Ok(if inner.is_file() { Exe::Direct(inner) } else { Exe::Cmd(cmd) });
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let exe = PathBuf::from(home).join(".local").join("bin").join("claude.exe");
        if exe.is_file() {
            return Ok(Exe::Direct(exe));
        }
    }
    Err("找不到 Claude Code（claude.exe），请先安装，或在设置 → Claude Code 中指定路径".into())
}

/// 与 App 同目录的 flowctl.exe（hooks 回报和系统提示里的命令都用它），环境变量 FLOW_CTL 可指定（测试用）；
/// 路径统一用正斜杠，bash 与 cmd 都能用。
fn flowctl_path() -> Result<String, String> {
    let f = match std::env::var_os("FLOW_CTL") {
        Some(p) => PathBuf::from(p),
        None => std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("程序目录无效")?.join("flowctl.exe"),
    };
    if !f.is_file() {
        return Err(format!("找不到 {}，Agent 状态无法回报", f.display()));
    }
    Ok(f.to_string_lossy().replace('\\', "/"))
}

/// Claude Code 配置目录下是否已有该会话的对话记录（决定 --resume 还是 --session-id）。
fn transcript_exists(id: &str) -> bool {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".claude")));
    let Some(base) = base else { return false };
    let name = format!("{id}.jsonl");
    std::fs::read_dir(base.join("projects")).into_iter().flatten().flatten().any(|d| d.path().join(&name).is_file())
}

/// 写 hooks 配置文件：各事件都调 `flowctl agent-hook <事件>`，5 秒超时；hook 失败不影响 Claude Code。
fn hooks_file(flowctl: &str) -> Result<PathBuf, String> {
    let mut hooks = serde_json::Map::new();
    for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop", "PreCompact", "SessionEnd"] {
        let mut item = json!({ "hooks": [{ "type": "command", "command": format!("\"{flowctl}\" agent-hook {ev}"), "timeout": 5 }] });
        if ev == "PreToolUse" || ev == "PostToolUse" {
            item["matcher"] = json!("*");
        }
        hooks.insert(ev.into(), json!([item]));
    }
    let f = dir()?.join("hooks.json");
    crate::write_atomic(&f, &serde_json::to_string_pretty(&json!({
        "hooks": hooks,
        "statusLine": { "type": "command", "command": format!("\"{flowctl}\" agent-hook StatusLine") }
    })).unwrap())?;
    Ok(f)
}

/// 追加给 Claude Code 的系统提示：会话身份、关联的 Feat 与节点、flowctl 协作命令。
/// 只用单引号，避免 Windows 命令行转义问题。
fn system_prompt(m: &Meta, flowctl: &str) -> String {
    let mut s = format!("你运行在 Flow Coding 的 Agent 窗口中，会话名「{}」，APP {}。", m.title, m.app);
    if !m.feat.is_empty() {
        s += &format!("本会话负责 {}，档案 {}；先读档案确认当前阶段再动手，关键决定写回档案。", m.feat_code, m.feat);
    }
    if !m.links.is_empty() {
        let list: Vec<String> = m.links.iter().map(|l| format!("{}#{}", l.flow, l.node)).collect();
        s += &format!("关联的流程图节点：{}。", list.join("、"));
    }
    s += &format!(
        "开始处理某个流程图节点对应的业务时，运行 '{f}' focus <图文件路径>#<节点id> 标记位置，主窗口会在该节点上显示你；\
         开始做 Feat 路线图中的某个任务时，运行 '{f}' focus <Feat档案路径>#T<编号>（子任务如 #T3.1），Feat 控件页会在该任务卡片上显示你，换任务时重新运行；\
         '{f}' peers 列出同 APP 的其他会话；'{f}' send <会话名> <消息> 给对方发协作消息（对方运行中会排队到它本轮结束）。\
         和同 APP 的会话改同一个文件前先用 send 协调。",
        f = flowctl
    );
    s
}

/// 内嵌终端始终支持彩色：仅覆盖本次子进程，避免宿主的无色管道配置泄漏到 ConPTY。
fn terminal_color_env(cmd: &mut CommandBuilder) {
    cmd.env_remove("NO_COLOR");
    cmd.env("FORCE_COLOR", "3");
    cmd.env("CLICOLOR", "1");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
}

/// 把新建表单的可选流程转为首条技能指令，并带入工作目录和关联档案；未知流程在创建前报错。
fn workflow_prompt(workflow: Option<&str>, cwd: &str, feat: &str) -> Result<Option<String>, String> {
    let skill = match workflow {
        None => return Ok(None),
        Some("feat") => "smallcat-feat-1-new",
        Some("fix") => "smallcat-fix",
        Some("perf") => "smallcat-perf",
        Some(other) => return Err(format!("未知启动流程：{other}")),
    };
    let mut prompt = format!("/{skill} 工作目录：\"{}\"", cwd.replace('\\', "/"));
    if !feat.is_empty() {
        prompt += &format!("；关联档案：\"{}\"", feat.replace('\\', "/"));
    }
    Ok(Some(prompt))
}

/// 启动（或续接）会话进程。已在运行则直接返回；首条提示仅由新建入口传入，续接不重复触发流程。
fn spawn(id: &str, initial_prompt: Option<&str>) -> Result<(), String> {
    #[cfg(test)]
    let started_at = std::time::Instant::now();
    let h = hub()?;
    let (meta, start_gen) = {
        let mut map = h.entries.lock().unwrap();
        let e = map.get_mut(id).ok_or("会话不存在")?;
        if e.meta.archived_at > 0 {
            return Err("会话已归档，请先取消归档".into());
        }
        if e.proc.is_some() {
            return Ok(());
        }
        sync_title(e);
        (e.meta.clone(), e.gen)
    };
    if !Path::new(&meta.cwd).is_dir() {
        return Err(format!("工作目录不存在：{}", meta.cwd));
    }
    let flowctl = flowctl_path()?;
    let settings = hooks_file(&flowctl)?;
    let set = load_settings()?;
    let extra = split_args(&set.extra_args)?;
    let mut cmd = match find_claude(&set)? {
        Exe::Direct(p) => CommandBuilder::new(p),
        Exe::Cmd(p) => {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(["/d", "/c"]);
            c.arg(p);
            c
        }
    };
    // 续接用 meta.cli_session_id（/clear 等之后 CLI 实际使用的最新 id），没有记录时用稳定 id；
    // 找不到对话记录仍退化为 --session-id 新开会话（与原来一致）。
    let resume = resume_target(&meta).to_string();
    if meta.started && transcript_exists(&resume) {
        cmd.args(["--resume", &resume]);
    } else {
        cmd.args(["--session-id", &meta.id]);
    }
    cmd.args(["-n", &meta.title]);
    cmd.arg("--settings");
    cmd.arg(&settings);
    cmd.arg("--append-system-prompt");
    cmd.arg(system_prompt(&meta, &flowctl));
    cmd.args(&extra);
    if let Some(prompt) = initial_prompt {
        cmd.arg(prompt);
    }
    cmd.cwd(&meta.cwd);
    // 从另一个 Claude Code 会话（含 Claude Desktop）里启动 App 时，会继承宿主注入的变量，子 CLI 会按宿主托管认证、
    // 以子会话身份运行而登录失败。检测到 CLAUDECODE 时去掉这批宿主变量；用户自己配置的 Git Bash 路径保留。
    for key in probe::host_env_keys() {
        cmd.env_remove(&key);
    }
    cmd.env("FLOW_AGENT_ID", &meta.id);
    cmd.env("FLOW_AGENT_PORT", h.port.to_string());
    cmd.env("FLOW_AGENT_TOKEN", &h.token);
    terminal_color_env(&mut cmd);
    #[cfg(test)]
    eprintln!("startup prepare_ms={}", started_at.elapsed().as_millis());

    let pty = portable_pty::native_pty_system()
        .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("创建终端失败: {e}"))?;
    #[cfg(test)]
    eprintln!("startup pty_ms={}", started_at.elapsed().as_millis());
    let mut child = pty.slave.spawn_command(cmd).map_err(|e| format!("启动 Claude Code 失败: {e}"))?;
    #[cfg(test)]
    eprintln!("startup process_ms={}", started_at.elapsed().as_millis());
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let gen = {
        let mut map = h.entries.lock().unwrap();
        let Some(e) = map.get_mut(id) else {
            let _ = child.kill();
            return Err("会话已删除，已取消启动".into());
        };
        // 启动期间被归档、删除，或已有另一次启动完成时，销毁本次新进程，避免后台残留。
        if e.meta.archived_at > 0 || e.gen != start_gen {
            let _ = child.kill();
            return Err("会话状态已变化，已取消本次启动".into());
        }
        e.proc = Some(Proc { master: pty.master, writer, killer });
        e.gen += 1;
        e.stopping = false;
        e.compacting = false;
        e.idle_since = 0;
        e.meta.started = true;
        e.buf.clear();
        e.live.metrics = None;
        e.live.status = "boot".into();
        e.live.since = now();
        e.live.beat = now();
        e.live.tool.clear();
        e.live.exit_code = None;
        e.queue.clear();
        save_metas(&map)?;
        let e = &map[id];
        emit_update(e);
        if let Some(app) = APP.get() {
            let _ = app.emit_to(LABEL, "agent-reset", json!({ "id": id, "seq": e.seq }));
        }
        e.gen
    };

    let rid = id.to_string();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 16384];
        let mut pend: Vec<u8> = Vec::new();
        // ConPTY 启动时先发光标位置查询（ESC[6n），收到回复前子进程不会开始运行。
        // 终端页签不一定打开，由后端回复这一次握手，并且不转发给前端，避免 xterm 再回复一次变成输入。
        let mut handshake = true;
        loop {
            let n = match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pend.extend_from_slice(&chunk[..n]);
            let mut text = take_utf8(&mut pend);
            let Ok(h) = hub() else { break };
            let mut reply = false;
            if handshake && text.contains("\x1b[6n") {
                text = text.replacen("\x1b[6n", "", 1);
                reply = true;
                handshake = false;
            } else if !text.is_empty() {
                handshake = false;
            }
            if text.is_empty() && !reply {
                continue;
            }
            let seq = {
                let mut map = h.entries.lock().unwrap();
                let Some(e) = map.get_mut(&rid) else { break };
                if e.gen != gen {
                    break;
                }
                if reply {
                    let _ = write_proc(e, "\x1b[1;1R");
                }
                if text.is_empty() {
                    continue;
                }
                e.buf.push_str(&text);
                e.seq += text.len() as u64;
                if e.buf.len() > BUF_MAX {
                    let mut cut = e.buf.len() - BUF_MAX * 3 / 4;
                    while !e.buf.is_char_boundary(cut) {
                        cut += 1;
                    }
                    e.buf.drain(..cut);
                }
                e.seq
            };
            if let Some(app) = APP.get() {
                let _ = app.emit_to(LABEL, "agent-output", json!({ "id": rid, "data": text, "seq": seq }));
            }
        }
    });

    let wid = id.to_string();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let Ok(h) = hub() else { return };
        let mut map = h.entries.lock().unwrap();
        let Some(e) = map.get_mut(&wid) else { return };
        if e.gen != gen {
            return;
        }
        e.proc = None;
        e.live.status = if code == 0 || e.stopping { "off" } else { "err" }.into();
        e.live.since = now();
        e.live.exit_code = Some(code);
        e.live.tool.clear();
        e.live.task = None;
        e.queue.clear();
        e.compacting = false;
        e.idle_since = 0;
        let t = now();
        for w in e.live.workers.iter_mut().filter(|w| w.running) {
            w.running = false;
            w.t1 = t;
        }
        emit_update(e);
    });
    Ok(())
}

/// 从待解码字节中取出完整的 UTF-8 文本；末尾不完整的多字节字符留到下一次。
fn take_utf8(pend: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pend) {
        Ok(s) => {
            let s = s.to_string();
            pend.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let n = e.valid_up_to();
            let s = String::from_utf8_lossy(&pend[..n]).into_owned();
            pend.drain(..n);
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(pend).into_owned();
            pend.clear();
            s
        }
    }
}

/// 向会话终端写入数据（调用方持有会话表锁）。
fn write_proc(e: &mut Entry, data: &str) -> Result<(), String> {
    let p = e.proc.as_mut().ok_or("会话未运行")?;
    p.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    p.writer.flush().map_err(|e| e.to_string())
}

/// 把一条协作消息当作用户输入提交：先写文字，稍等再回车，避免 TUI 把整段当成粘贴里的换行。
fn submit_later(id: String, text: String) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        let Ok(h) = hub() else { return };
        if let Some(e) = h.entries.lock().unwrap().get_mut(&id) {
            if write_proc(e, &text).is_ok() && e.live.status == "idle" {
                e.idle_since = now();
            }
        }
        std::thread::sleep(Duration::from_millis(250));
        if let Some(e) = h.entries.lock().unwrap().get_mut(&id) {
            if write_proc(e, "\r").is_ok() && e.live.status == "idle" {
                e.idle_since = now();
            }
        }
    });
}

// ---------------- hooks 与协作通道 ----------------

/// 处理一个 TCP 连接：读一行 JSON 请求，校验令牌，回一行 JSON 结果。
fn handle_conn(s: TcpStream) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    let mut r = BufReader::new(s.try_clone().unwrap());
    if r.by_ref().take(4 << 20).read_line(&mut line).is_err() {
        return;
    }
    let reply = match serde_json::from_str::<Value>(&line) {
        Ok(req) => dispatch(&req).unwrap_or_else(|e| json!({ "error": e })),
        Err(e) => json!({ "error": format!("请求格式错误: {e}") }),
    };
    let mut s = s;
    let _ = writeln!(s, "{reply}");
}

/// 分发请求：hook 回报 / focus 标记位置 / peers 列同 APP 会话 / send 发协作消息。
fn dispatch(req: &Value) -> Result<Value, String> {
    let h = hub()?;
    if req["token"].as_str() != Some(h.token.as_str()) {
        return Err("令牌无效".into());
    }
    let id = req["id"].as_str().ok_or("缺少会话 id")?.to_string();
    match req["op"].as_str().unwrap_or("") {
        "hook" => {
            let event = req["event"].as_str().unwrap_or("");
            if event == "StatusLine" { on_statusline(&id, &req["payload"]); }
            else { on_hook(&id, event, &req["payload"]); }
            Ok(json!({ "ok": true }))
        }
        "focus" => focus(&id, req["ref"].as_str().unwrap_or(""), req["cwd"].as_str().unwrap_or("")),
        "peers" => peers(&id),
        "send" => send(&id, req["to"].as_str().unwrap_or(""), req["text"].as_str().unwrap_or("")),
        op => Err(format!("未知操作 {op}")),
    }
}

/// 文件名（不含目录）。
fn base(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// 截断到 n 个字符。
fn cut(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n { s.chars().take(n).collect::<String>() + "…" } else { s }
}

/// 记一条活动：归到当前位置（focus，否则第一个关联节点）和正在运行的最后一个 worker，刷新心跳。
fn push_act(e: &mut Entry, kind: &str, text: String, path: String) -> Act {
    let t = now();
    let pos = e.live.focus.clone().or_else(|| e.meta.links.first().cloned());
    let mut worker = String::new();
    if kind != "worker" {
        if let Some(w) = e.live.workers.iter_mut().rev().find(|w| w.running) {
            w.uses += 1;
            worker = w.id.clone();
        }
    }
    let a = Act {
        t,
        kind: kind.into(),
        text,
        path,
        flow: pos.as_ref().map(|p| p.flow.clone()).unwrap_or_default(),
        node: pos.map(|p| p.node).unwrap_or_default(),
        worker,
        peer: String::new(),
    };
    e.acts.push_back(a.clone());
    while e.acts.len() > ACTS_MAX {
        e.acts.pop_front();
    }
    e.live.beat = t;
    a
}

/// 记录协作消息并保留对方的会话 ID；更新活动队列中的同一条记录，供重开窗口回放关系。
fn push_message(e: &mut Entry, peer: &str, text: String) -> Act {
    let mut a = push_act(e, "msg", text, String::new());
    a.peer = peer.to_string();
    *e.acts.back_mut().unwrap() = a.clone();
    a
}

/// 本轮提问独立于活动队列保留；长任务挤掉 prompt 活动后仍能显示摘要与完整提示。
fn start_turn(e: &mut Entry, prompt: &str, t: i64) -> Act {
    set_status(e, "run");
    e.live.turn = t;
    e.live.turn_prompt = prompt.trim().to_string();
    e.live.wait_text.clear();
    push_act(e, "prompt", cut(prompt, 60), String::new())
}

/// 切换状态（相同状态不改 since）。进入 idle 时重算持续空闲起点，供后台空闲回收判定。
fn set_status(e: &mut Entry, st: &str) {
    if e.live.status != st {
        e.live.status = st.into();
        e.live.since = now();
        if st == "idle" {
            e.idle_since = e.live.since;
        }
    }
}

/// 是否标准 UUID 文本（8-4-4-4-12 十六进制）；采信 hook 回报的 session_id 前必须过这道校验。
fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// SessionStart 时决定是否把 payload 的 session_id 记为 meta.cli_session_id，返回是否有改动。
/// - 总是先校验 UUID 形态；与 id 或现 cli_session_id 相同的直接采信（首次启动、--resume 回报）；
/// - 陌生 id 只在 source 为 clear / compact / resume 时采信（CLI 在会话内换新 id / 用户 /resume 别的对话）；
/// - source 为 startup 或缺失却带来陌生 id 的回报不采信——那只能是 subagent 等非主会话的回报，
///   不能把父会话的续接目标改成 subagent 的 session id。
fn adopt_cli_id(e: &mut Entry, p: &Value) -> bool {
    let sid = p["session_id"].as_str().unwrap_or("");
    if !is_uuid(sid) || e.meta.cli_session_id == sid {
        return false;
    }
    let known = sid == e.meta.id || sid == e.meta.cli_session_id;
    let src = p["source"].as_str().unwrap_or("");
    if !known && !matches!(src, "clear" | "compact" | "resume") {
        return false;
    }
    e.meta.cli_session_id = sid.to_string();
    true
}

/// SessionStart：boot 转 idle；/clear、compact、/resume 换新 CLI 会话 id 时记入 meta（下次续接用最新
/// 对话记录）。无论状态是否变化都重算空闲基线——/clear 后状态仍是 idle，但对话已经重开，应从零计时。
/// 返回是否需要把元数据写盘。
fn on_session_start(e: &mut Entry, p: &Value, t: i64) -> bool {
    if matches!(p["source"].as_str(), Some("clear" | "compact" | "resume")) { e.live.metrics = None; }
    if e.live.status == "boot" || p["source"].as_str() == Some("clear") {
        set_status(e, "idle");
    }
    if p["source"].as_str() == Some("clear") {
        e.live.turn = 0;
        e.live.turn_prompt.clear();
        e.live.done = 0;
        e.live.tool.clear();
        e.live.wait_text.clear();
        e.live.task = None;
        for w in e.live.workers.iter_mut().filter(|w| w.running) {
            w.running = false;
            w.t1 = t;
        }
    }
    e.live.beat = t;
    e.idle_since = t;
    adopt_cli_id(e, p)
}

/// 续接时使用的 CLI 会话 id：有记录的用最新的（/clear 等之后），否则用 Flow Coding 的稳定 id。
fn resume_target(m: &Meta) -> &str {
    if m.cli_session_id.is_empty() { &m.id } else { &m.cli_session_id }
}

/// 只接收当前 CLI 对话的状态数据；压缩期间和其他对话的迟到回报不会覆盖当前值。
/// 不修改运行状态、工具、活动心跳或空闲计时，状态行刷新不能让进程永不回收。
fn apply_metrics(e: &mut Entry, p: &Value, t: i64) -> bool {
    if e.compacting || p["session_id"].as_str() != Some(resume_target(&e.meta)) { return false; }
    e.live.metrics = Some(Metrics::from_statusline(p, t));
    true
}

/// 状态行走独立分支，只更新遥测并广播；终端输出仍完全由真实 TUI 负责。
fn on_statusline(id: &str, p: &Value) {
    let Ok(h) = hub() else { return };
    let mut map = h.entries.lock().unwrap();
    let Some(e) = map.get_mut(id) else { return };
    if e.proc.is_some() && !e.stopping && apply_metrics(e, p, now()) { emit_update(e); }
}

/// 处理一次 hook 回报，更新状态与活动并广播。
fn on_hook(id: &str, event: &str, p: &Value) {
    let Ok(h) = hub() else { return };
    let mut map = h.entries.lock().unwrap();
    let Some(e) = map.get_mut(id) else { return };
    let t = now();
    let mut act = None;
    // PreCompact 之后到新活动为止处于压缩中，空闲回收不得介入；其它任何事件都表示压缩已结束。
    if event != "PreCompact" {
        e.compacting = false;
    }
    let mut persist = false;
    match event {
        "SessionStart" => {
            persist = on_session_start(e, p, t);
        }
        "UserPromptSubmit" => {
            act = Some(start_turn(e, p["prompt"].as_str().unwrap_or(""), t));
        }
        "PreToolUse" => {
            if e.live.status != "run" {
                set_status(e, "run");
                if e.live.turn == 0 {
                    e.live.turn = t;
                }
            }
            let tool = p["tool_name"].as_str().unwrap_or("").to_string();
            let inp = &p["tool_input"];
            let path = ["file_path", "notebook_path", "path"].iter().find_map(|k| inp[*k].as_str()).unwrap_or("").to_string();
            let cmd = inp["command"].as_str().unwrap_or("");
            let (kind, text) = match tool.as_str() {
                "Read" | "Grep" | "Glob" | "LS" | "WebFetch" | "WebSearch" => {
                    ("read", if path.is_empty() { cut(inp["pattern"].as_str().or(inp["url"].as_str()).or(inp["query"].as_str()).unwrap_or(&tool), 40) } else { base(&path) })
                }
                "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => ("edit", base(&path)),
                "Bash" | "PowerShell" => (if cmd.contains("git commit") { "commit" } else { "cmd" }, cut(cmd, 100)),
                "Task" | "Agent" => ("worker", cut(inp["description"].as_str().unwrap_or("worker"), 40)),
                _ => ("tool", tool.clone()),
            };
            if kind == "worker" {
                let wid = p["tool_use_id"].as_str().map(str::to_string).unwrap_or_else(|| format!("w{t}"));
                e.live.workers.push(Worker { id: wid, desc: text.clone(), running: true, t0: t, t1: 0, uses: 0 });
                let n = e.live.workers.len();
                if n > WORKERS_MAX {
                    e.live.workers.drain(..n - WORKERS_MAX);
                }
            } else {
                e.live.tool = tool;
                e.live.tool_since = t;
            }
            act = Some(push_act(e, kind, text, path));
        }
        "PostToolUse" => {
            let tool = p["tool_name"].as_str().unwrap_or("");
            if tool == "Task" || tool == "Agent" {
                let uid = p["tool_use_id"].as_str().unwrap_or("");
                let desc = cut(p["tool_input"]["description"].as_str().unwrap_or(""), 40);
                let i = e.live.workers.iter().position(|w| w.running && (w.id == uid || w.desc == desc))
                    .or_else(|| e.live.workers.iter().position(|w| w.running));
                if let Some(i) = i {
                    e.live.workers[i].running = false;
                    e.live.workers[i].t1 = t;
                }
            } else {
                e.live.tool.clear();
            }
            if e.live.status == "wait" {
                set_status(e, "run");
                e.live.wait_text.clear();
            }
            e.live.beat = t;
        }
        "Notification" => {
            let msg = p["message"].as_str().unwrap_or("").to_string();
            let ty = p["notification_type"].as_str().unwrap_or("");
            if ty == "permission_prompt" || msg.to_lowercase().contains("permission") {
                set_status(e, "wait");
                e.live.wait_text = msg;
            } else if !(ty == "idle_prompt" || msg.contains("waiting for your input")) {
                act = Some(push_act(e, "note", cut(&msg, 80), String::new()));
            }
        }
        "Stop" => {
            set_status(e, "idle");
            e.live.done = t;
            e.live.tool.clear();
            e.live.wait_text.clear();
            e.live.beat = t;
            for w in e.live.workers.iter_mut().filter(|w| w.running) {
                w.running = false;
                w.t1 = t;
            }
            // 本轮结束：把排队的协作消息合并成一条提交
            if !e.queue.is_empty() {
                let text: Vec<String> = e.queue.drain(..).collect();
                submit_later(id.to_string(), text.join(" ｜ "));
            }
        }
        "SubagentStop" => e.live.beat = t,
        "PreCompact" => {
            e.compacting = true;
            e.live.metrics = None;
            act = Some(push_act(e, "compact", "压缩上下文".into(), String::new()));
        }
        "SessionEnd" => e.live.beat = t,
        _ => return,
    }
    if let Some(a) = act {
        emit_act(id, &a);
    }
    emit_update(e);
    if persist {
        let _ = save_metas(&map);
    }
}

/// 解析 focus 的图文件：绝对路径、flowctl 当前目录、会话目录下的 docs/flow、已关联的同名图，取第一个存在的。
fn resolve_flow(e: &Entry, file: &str, cwd: &str) -> Option<PathBuf> {
    let f = Path::new(file);
    let mut cands: Vec<PathBuf> = Vec::new();
    if f.is_absolute() {
        cands.push(f.to_path_buf());
    } else {
        if !cwd.is_empty() {
            cands.push(Path::new(cwd).join(f));
        }
        cands.push(Path::new(&e.meta.cwd).join("docs").join("flow").join(f));
        cands.push(Path::new(&e.meta.cwd).join(f));
        let name = base(file).to_lowercase();
        cands.extend(e.meta.links.iter().filter(|l| base(&l.flow).to_lowercase() == name).map(|l| PathBuf::from(&l.flow)));
    }
    cands.into_iter().find(|p| p.is_file()).and_then(|p| crate::paths::norm(&p).ok())
}

/// 任务编号是否合法：T 加数字，可带一级子号（T3、T3.1）。
fn is_task_id(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('T') else { return false };
    let mut parts = rest.split('.');
    let num = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let ok = num(parts.next());
    match (parts.next(), parts.next()) {
        (None, _) => ok,
        (Some(sub), None) => ok && num(Some(sub)),
        _ => false,
    }
}

/// 档案正文中是否出现该任务编号（前后不是数字或「.数字」，避免 T1 误中 T12、T1.2）。
fn doc_has_task(text: &str, task: &str) -> bool {
    text.match_indices(task).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = &text[i + task.len()..];
        let mut it = after.chars();
        let next = it.next();
        let sub = next == Some('.') && it.next().is_some_and(|c| c.is_ascii_digit());
        !before.is_some_and(|c| c.is_ascii_alphanumeric()) && !next.is_some_and(|c| c.is_ascii_digit()) && !sub
    })
}

/// 解析 focus 里的 Feat 档案：绝对路径或相对 cwd 的路径；只写文件名时按会话关联的 Feat 匹配。
fn resolve_feat(e: &Entry, file: &str, cwd: &str) -> Option<PathBuf> {
    let p = PathBuf::from(file);
    let mut cands = vec![if p.is_absolute() { p } else { Path::new(cwd).join(file) }];
    if !e.meta.feat.is_empty() && base(&e.meta.feat).eq_ignore_ascii_case(&base(file)) {
        cands.push(PathBuf::from(&e.meta.feat));
    }
    cands.into_iter().find(|p| p.is_file()).and_then(|p| crate::paths::norm(&p).ok())
}

/// flowctl focus：`<图文件>#<节点id>` 标记当前处理的流程图节点（节点必须存在于该图）；
/// `<Feat档案.md>#T<n>` 标记当前处理的 Feat 任务（编号必须出现在档案中）；`--clear` 两者都清除。
fn focus(id: &str, r: &str, cwd: &str) -> Result<Value, String> {
    let h = hub()?;
    let mut map = h.entries.lock().unwrap();
    let e = map.get_mut(id).ok_or("会话不存在")?;
    if r == "--clear" {
        e.live.focus = None;
        e.live.task = None;
        emit_update(e);
        return Ok(json!({ "focus": null, "task": null }));
    }
    let (file, node) = r.rsplit_once('#').ok_or("格式应为 <图文件>#<节点id> 或 <Feat档案>#T<编号>")?;
    if file.to_lowercase().ends_with(".md") {
        if !is_task_id(node) {
            return Err(format!("任务编号应为 T<数字>，如 T3、T3.1：{node}"));
        }
        let path = resolve_feat(e, file, cwd).ok_or_else(|| format!("找不到 Feat 档案 {file}"))?;
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if !doc_has_task(&text, node) {
            return Err(format!("{} 中没有任务 {node}", base(&path.to_string_lossy())));
        }
        let tr = TaskRef { feat: path.to_string_lossy().into_owned(), task: node.to_string() };
        e.live.task = Some(tr.clone());
        let a = push_act(e, "tool", format!("开始 {node}"), String::new());
        emit_act(id, &a);
        emit_update(e);
        return Ok(json!({ "task": tr }));
    }
    let path = resolve_flow(e, file, cwd).ok_or_else(|| format!("找不到流程图 {file}"))?;
    let xml = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let nodes = crate::flow::parse(&xml)?;
    if !nodes.iter().any(|n| n.id == node) {
        return Err(format!("{} 中没有节点 {node}", base(&path.to_string_lossy())));
    }
    let nr = NodeRef { flow: path.to_string_lossy().into_owned(), node: node.to_string() };
    e.live.focus = Some(nr.clone());
    let a = push_act(e, "tool", format!("定位 {}#{node}", base(&nr.flow)), String::new());
    emit_act(id, &a);
    emit_update(e);
    Ok(json!({ "focus": nr }))
}

/// flowctl peers：同 APP 的其他会话（名称、状态、关联 Feat、当前位置）。
fn peers(id: &str) -> Result<Value, String> {
    let h = hub()?;
    let map = h.entries.lock().unwrap();
    let me = map.get(id).ok_or("会话不存在")?;
    let list: Vec<Value> = map
        .values()
        .filter(|e| e.meta.id != id && e.meta.app == me.meta.app)
        .map(|e| json!({ "title": e.meta.title, "status": e.live.status, "feat": e.meta.feat_code, "focus": e.live.focus }))
        .collect();
    Ok(json!(list))
}

/// flowctl send：按会话名（或 id 前缀）找到对方，空闲则立即提交，运行中 / 等确认则排队到本轮结束。
fn send(id: &str, to: &str, text: &str) -> Result<Value, String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if to.is_empty() || text.is_empty() {
        return Err("用法：send <会话名> <消息>".into());
    }
    let h = hub()?;
    let mut map = h.entries.lock().unwrap();
    let from = map.get(id).ok_or("会话不存在")?.meta.title.clone();
    let target = map
        .values()
        .find(|e| e.meta.id != id && e.meta.title == to)
        .or_else(|| map.values().find(|e| e.meta.id != id && e.meta.id.starts_with(to)))
        .map(|e| e.meta.id.clone())
        .ok_or_else(|| format!("没有名为「{to}」的会话"))?;
    let msg = format!("[来自「{from}」的协作消息] {text}");
    let e = map.get_mut(&target).unwrap();
    let state = match e.live.status.as_str() {
        _ if e.proc.is_none() => return Err(format!("「{to}」未运行")),
        "idle" => {
            submit_later(target.clone(), msg);
            "已送达"
        }
        _ => {
            e.queue.push_back(msg);
            "对方正忙，已排队，本轮结束后送达"
        }
    };
    let to_title = e.meta.title.clone();
    let b = push_message(e, id, cut(&format!("来自「{from}」：{text}"), 80));
    emit_act(&target, &b);
    emit_update(e);
    let a = push_message(map.get_mut(id).unwrap(), &target, cut(&format!("发给「{to_title}」：{text}"), 80));
    emit_act(id, &a);
    emit_update(&map[id]);
    Ok(json!({ "result": state }))
}

/// flowctl 侧：把请求发给 App（读取 FLOW_AGENT_ID / PORT / TOKEN 环境变量），返回结果 JSON。
/// 环境变量缺失说明不是在 Flow Coding 的 Agent 窗口里运行。
pub fn client(mut req: Value) -> Result<Value, String> {
    let env = |k: &str| std::env::var(k).map_err(|_| "当前不在 Flow Coding 的 Agent 会话中（缺少 FLOW_AGENT_* 环境变量）".to_string());
    let port: u16 = env("FLOW_AGENT_PORT")?.parse().map_err(|_| "FLOW_AGENT_PORT 无效")?;
    req["id"] = json!(env("FLOW_AGENT_ID")?);
    req["token"] = json!(env("FLOW_AGENT_TOKEN")?);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| format!("连接 Flow Coding 失败: {e}"))?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    writeln!(s, "{req}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&line).map_err(|e| format!("回复格式错误: {e}"))?;
    match v["error"].as_str() {
        Some(e) => Err(e.to_string()),
        None => Ok(v),
    }
}

// ---------------- Tauri 命令 ----------------

/// 全部会话按创建时间排序；启动中异步等待最多 30 秒，成功后一次返回列表，失败返回具体原因。
/// 来源名称同步和磁盘访问也在后台执行，不影响主窗口显示与操作。
#[tauri::command]
pub async fn agent_list() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        STARTUP.wait(STARTUP_TIMEOUT)?;
        let mut map = hub()?.entries.lock().unwrap();
        let mut dirty = false;
        for e in map.values_mut() {
            dirty |= sync_title(e);
        }
        if dirty {
            let _ = save_metas(&map);
        }
        let mut list: Vec<&Entry> = map.values().collect();
        list.sort_by_key(|e| e.meta.created);
        Ok(list.into_iter().map(|e| view(e, true)).collect())
    }).await.map_err(|e| format!("读取 Agent 任务失败: {e}"))?
}

/// 路径比较用的归一形式：反斜杠统一为正斜杠、不区分大小写（Windows 路径）。
fn path_key(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

// ---------------- 名称来源与主会话归属 ----------------

/// 会话的名称来源：返回 (kind, path)。
/// - `feat`：关联了 Feat 档案，是该 Feat 的主会话，名称取档案一级标题；
/// - `flow`：没有 Feat 时以第一个关联流程图为图主会话，名称取图文件名；
/// - `""`：两者皆无的独立会话，名称可改。其余关联节点都是客串，不参与命名与互斥。
fn source_of(m: &Meta) -> (&'static str, &str) {
    if !m.feat.is_empty() {
        ("feat", m.feat.as_str())
    } else if let Some(l) = m.links.first() {
        ("flow", l.flow.as_str())
    } else {
        ("", "")
    }
}

/// 绑定来源时应显示的名称：Feat 主取档案一级标题（与侧栏汇总同口径 `feat::parse_md`），
/// 图主取文件名（不含扩展名）。文件读不到或无标题时返回 None，调用方保留现名。
fn expected_title(m: &Meta) -> Option<String> {
    match source_of(m) {
        ("feat", p) => {
            let text = std::fs::read_to_string(p).ok()?;
            let t = crate::feat::parse_md(&text, &crate::feat::id_from_name(Path::new(p))).0;
            (!t.is_empty()).then_some(t)
        }
        ("flow", p) => Path::new(p).file_stem().map(|s| s.to_string_lossy().into_owned()).filter(|s| !s.is_empty()),
        _ => None,
    }
}

/// 名称跟随来源：绑定来源的会话把标题同步为来源的当前名。返回是否有改动。
fn sync_title(e: &mut Entry) -> bool {
    if source_of(&e.meta).0.is_empty() {
        return false;
    }
    match expected_title(&e.meta) {
        Some(t) if e.meta.title != t => {
            e.meta.title = t;
            true
        }
        _ => false,
    }
}

/// 载入时规范化元数据：独立会话补默认名，绑定会话与来源同步。返回是否有改动。
fn normalize(e: &mut Entry) -> bool {
    if source_of(&e.meta).0.is_empty() {
        if e.meta.title.trim().is_empty() {
            e.meta.title = "新会话".into();
            return true;
        }
        return false;
    }
    sync_title(e)
}

/// 把以 path 为名称来源的会话名与来源同步（Feat 档案就地改标题等）；返回有改动的会话 id。
fn resync_source(map: &mut HashMap<String, Entry>, path: &Path) -> Vec<String> {
    let k = path_key(&path.to_string_lossy());
    let mut ids = Vec::new();
    for e in map.values_mut() {
        let (kind, sp) = source_of(&e.meta);
        if !kind.is_empty() && path_key(sp) == k && sync_title(e) {
            ids.push(e.meta.id.clone());
        }
    }
    ids
}

/// 文件变化时同步会话名（由文件监听在通知前端后调用）：Feat 档案就地改名落到主会话名。
/// Hub 未启动（测试、启动失败）时不动。
pub fn source_changed(path: &Path) {
    let Ok(h) = hub() else { return };
    let mut map = h.entries.lock().unwrap();
    let ids = resync_source(&mut map, path);
    if ids.is_empty() {
        return;
    }
    for id in &ids {
        emit_update(&map[id]);
    }
    if let Err(e) = save_metas(&map) {
        eprintln!("同步会话名写盘失败: {e}");
    }
}

/// 重命名引用重映射（纯内存，测试可直接用）：会话的 feat、关联节点、当前位置与当前任务
/// 全部指向新路径，并重算主会话名；返回被改动的会话 id。
fn remap_renamed(map: &mut HashMap<String, Entry>, old: &Path, new: &Path) -> Vec<String> {
    let old_key = crate::paths::key(old);
    let new_s = new.to_string_lossy().into_owned();
    let hits = |p: &str| !p.is_empty() && crate::paths::key(Path::new(p)) == old_key;
    let mut ids = Vec::new();
    for e in map.values_mut() {
        let mut touched = false;
        if hits(&e.meta.feat) {
            e.meta.feat = new_s.clone();
            touched = true;
        }
        for l in e.meta.links.iter_mut() {
            if hits(&l.flow) {
                l.flow = new_s.clone();
                touched = true;
            }
        }
        if let Some(f) = e.live.focus.as_mut() {
            if hits(&f.flow) {
                f.flow = new_s.clone();
                touched = true;
            }
        }
        if let Some(t) = e.live.task.as_mut() {
            if hits(&t.feat) {
                t.feat = new_s.clone();
                touched = true;
            }
        }
        let synced = sync_title(e);
        if touched || synced {
            ids.push(e.meta.id.clone());
        }
    }
    ids
}

/// 文件树重命名成功后调用（rename::rename_entry）：同步会话引用的路径与主会话名，
/// 只改元数据指针，会话 id、终端输出与进程不变。改名事务失败时不会走到这里，不会留悬挂引用。
pub fn on_renamed(old: &Path, new: &Path) {
    let Ok(h) = hub() else { return };
    let mut map = h.entries.lock().unwrap();
    let ids = remap_renamed(&mut map, old, new);
    if ids.is_empty() {
        return;
    }
    for id in &ids {
        emit_update(&map[id]);
    }
    if let Err(e) = save_metas(&map) {
        eprintln!("重命名后保存会话引用失败: {e}");
    }
}

/// 主会话唯一：同一来源只能有一个主会话——关联了 Feat 的会话按 Feat 档案去重，
/// 没有 Feat 的会话按它的第一个关联流程图（图主）去重；其余关联节点只是客串，不参与互斥。
/// 与其他会话冲突时返回 `DUP:<已有会话 id>:<说明>`，前端据此提示并切到已有会话。
fn main_conflict(map: &HashMap<String, Entry>, me: &str, feat: &str, links: &[NodeRef]) -> Result<(), String> {
    let (kind, path) = if !feat.is_empty() {
        ("feat", feat)
    } else if let Some(l) = links.first() {
        ("flow", l.flow.as_str())
    } else {
        ("", "")
    };
    if kind.is_empty() {
        return Ok(());
    }
    let k = path_key(path);
    if let Some(o) = map.values().find(|e| {
        e.meta.id != me && e.meta.archived_at == 0 && {
            let (ek, ep) = source_of(&e.meta);
            ek == kind && !ep.is_empty() && path_key(ep) == k
        }
    }) {
        let what = if kind == "feat" { "这个 Feat".to_string() } else { base(path) };
        return Err(format!("DUP:{}:{what} 已由会话「{}」负责", o.meta.id, o.meta.title));
    }
    Ok(())
}

/// 新建并启动会话；磁盘、ConPTY 和进程创建在阻塞线程池执行，不能占用窗口 IPC 线程。
/// title 为空时叫「新会话」；cwd 必须存在；Feat / 流程图已有主会话时拒绝（见 main_conflict）。
/// workflow 可选 feat/fix/perf，仅作为此次启动的首条技能指令，不写入持久化元数据；错误原样返回前端重试。
#[tauri::command]
pub async fn agent_create(title: String, cwd: String, app: String, feat: String, feat_code: String, links: Vec<NodeRef>, pinned: bool, workflow: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        STARTUP.wait(STARTUP_TIMEOUT)?;
        let initial_prompt = workflow_prompt(workflow.as_deref(), &cwd, &feat)?;
        if !Path::new(&cwd).is_dir() {
            return Err(format!("目录不存在：{cwd}"));
        }
        let h = hub()?;
        let id = new_uuid();
        let t = now();
        let title = if title.trim().is_empty() { "新会话".to_string() } else { title.trim().to_string() };
        let meta = Meta { id: id.clone(), title, cwd, app, feat, feat_code, links, pinned, pin_at: if pinned { t } else { 0 }, created: t, started: false, cli_session_id: String::new(), archived_at: 0 };
        {
            let mut map = h.entries.lock().unwrap();
            main_conflict(&map, &id, &meta.feat, &meta.links)?;
            let mut entry = Entry { meta, live: idle_live(), acts: VecDeque::new(), queue: VecDeque::new(), proc: None, buf: String::new(), seq: 0, gen: 0, stopping: false, idle_since: 0, compacting: false };
            normalize(&mut entry);
            map.insert(id.clone(), entry);
            save_metas(&map)?;
        }
        spawn(&id, initial_prompt.as_deref())?;
        let map = h.entries.lock().unwrap();
        Ok(view(&map[&id], true))
    }).await.map_err(|e| format!("创建 Agent 任务失败: {e}"))?
}

/// 启动或续接已有会话；终端和进程创建离开窗口 IPC 线程，等待期间窗口仍可绘制和响应。
#[tauri::command]
pub async fn agent_start(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        STARTUP.wait(STARTUP_TIMEOUT)?;
        spawn(&id, None)
    }).await.map_err(|e| format!("启动 Agent 任务失败: {e}"))?
}

/// 结束会话进程（对话历史保留，可再续接）。
#[tauri::command]
pub fn agent_stop(id: String) -> Result<(), String> {
    let mut map = hub()?.entries.lock().unwrap();
    let e = map.get_mut(&id).ok_or("会话不存在")?;
    // portable-pty 0.9 的 Windows 实现把 TerminateProcess 成功当成错误返回，结果不可信；
    // 是否已结束以等待线程收到的进程退出为准（状态变为 off / err）。
    if let Some(p) = e.proc.as_mut() {
        e.stopping = true;
        let _ = p.killer.kill();
    }
    Ok(())
}

/// 键盘输入写入终端。idle 状态下用户的每次输入都重算持续空闲起点（终端输出重绘不算活跃）。
#[tauri::command]
pub fn agent_write(id: String, data: String) -> Result<(), String> {
    let mut map = hub()?.entries.lock().unwrap();
    let e = map.get_mut(&id).ok_or("会话不存在")?;
    write_proc(e, &data)?;
    if e.live.status == "idle" {
        e.idle_since = now();
    }
    Ok(())
}

/// 终端尺寸变化。
#[tauri::command]
pub fn agent_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = hub()?.entries.lock().unwrap();
    let e = map.get(&id).ok_or("会话不存在")?;
    if let Some(p) = e.proc.as_ref() {
        p.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Agent 窗口打开了该会话的页签：记为已查看，主窗口机器人的「运行完成」绿色随之恢复为白色。
#[tauri::command]
pub fn agent_seen(id: String) -> Result<(), String> {
    let mut map = hub()?.entries.lock().unwrap();
    let e = map.get_mut(&id).ok_or("会话不存在")?;
    if e.live.done > e.live.seen {
        e.live.seen = now();
        emit_update(e);
    }
    Ok(())
}

/// 当前保留的终端输出与序号（页签打开时回放，之后只接序号更大的输出）。
#[tauri::command]
pub fn agent_buffer(id: String) -> Result<Value, String> {
    let map = hub()?.entries.lock().unwrap();
    let e = map.get(&id).ok_or("会话不存在")?;
    Ok(json!({ "data": e.buf, "seq": e.seq }))
}

/// 应用会话修改到会话表（纯内存，测试可直接用）：先在候选元数据上做完关联互斥与名称校验，
/// 全部通过才提交，任何一步失败都不留半改的 patch。
/// - 关联（feat/links）变化会重算名称归属，绑定来源的会话名随来源同步；
/// - 绑定来源的会话名锁定：title patch 只能提交与来源一致的名字，否则整个 patch 拒绝；
/// - 独立会话（无 Feat、无关联节点）名称可自由修改。
fn apply_patch(map: &mut HashMap<String, Entry>, id: &str, patch: &Value) -> Result<(), String> {
    let assoc = patch.get("feat").is_some() || patch.get("links").is_some();
    let mut next = {
        let cur = &map.get(id).ok_or("会话不存在")?.meta;
        let mut next = cur.clone();
        if let Some(f) = patch["feat"].as_str() {
            next.feat = f.to_string();
            next.feat_code = patch["feat_code"].as_str().unwrap_or("").to_string();
        }
        if patch.get("links").is_some() {
            next.links = serde_json::from_value(patch["links"].clone()).map_err(|e| e.to_string())?;
        }
        next
    };
    if assoc && next.archived_at == 0 {
        main_conflict(map, id, &next.feat, &next.links)?;
    }
    // 绑定来源的会话名随来源同步（来源文件读不到时保留现名）。
    if let Some(t) = expected_title(&next) {
        next.title = t;
    }
    if let Some(t) = patch["title"].as_str().map(str::trim) {
        if source_of(&next).0.is_empty() {
            if !t.is_empty() {
                next.title = t.to_string();
            }
        } else if t != next.title {
            return Err(format!("名称跟随来源「{}」，请在文件树重命名来源文件", next.title));
        }
    }
    let e = map.get_mut(id).unwrap();
    e.meta = next;
    if let Some(p) = patch["pinned"].as_bool() {
        e.meta.pinned = p;
        e.meta.pin_at = if p { now() } else { 0 };
    }
    Ok(())
}

/// 修改会话：名称、置顶、关联 Feat 与节点（patch 中出现的字段才改）。
/// 改关联后与其他会话争同一个 Feat / 图的主会话时拒绝；绑定来源的会话名跟随来源不可单改。
/// 任何校验失败整个 patch 都不生效。
#[tauri::command]
pub fn agent_update(id: String, patch: Value) -> Result<Value, String> {
    let mut map = hub()?.entries.lock().unwrap();
    apply_patch(&mut map, &id, &patch)?;
    let v = view(&map[&id], false);
    emit_update(&map[&id]);
    save_metas(&map)?;
    Ok(v)
}

/// 归档保留 180 天；仅以归档时间计算，创建时间和普通空闲时间不会触发记录删除。
const ARCHIVE_RETENTION_MS: i64 = 180 * 24 * 60 * 60 * 1000;

/// 在内存中切换归档状态；重复归档不延长保留期，恢复前校验主会话唯一，失败不修改元数据。
fn archive_entry(map: &mut HashMap<String, Entry>, id: &str, archived: bool, at: i64) -> Result<(), String> {
    let e = map.get(id).ok_or("会话不存在")?;
    if !archived {
        main_conflict(map, id, &e.meta.feat, &e.meta.links)?;
    }
    let e = map.get_mut(id).unwrap();
    if archived {
        if e.meta.archived_at == 0 { e.meta.archived_at = at; }
    } else {
        e.meta.archived_at = 0;
    }
    Ok(())
}

/// 归档结束托管进程并保留关联与历史；取消归档只恢复列表，不自动启动 CLI。
/// 写盘失败回退归档状态，保证不会显示一次未保存的归档结果。
#[tauri::command]
pub fn agent_archive(id: String, archived: bool) -> Result<Value, String> {
    let mut map = hub()?.entries.lock().unwrap();
    let previous = map.get(&id).ok_or("会话不存在")?.meta.archived_at;
    archive_entry(&mut map, &id, archived, now())?;
    if let Err(error) = save_metas(&map) {
        map.get_mut(&id).unwrap().meta.archived_at = previous;
        return Err(error);
    }
    let e = map.get_mut(&id).unwrap();
    if archived {
        e.stopping = true;
        if let Some(p) = e.proc.as_mut() { let _ = p.killer.kill(); }
        else { e.gen += 1; } // 失效尚未装入会话表的启动；立即取消归档也不会复活旧启动。
    }
    emit_update(e);
    Ok(view(e, false))
}

/// 删除记录的共用路径：先保存，失败则完整恢复内存；成功后结束进程并广播删除，CLI 原始历史保留。
fn remove_entries(map: &mut HashMap<String, Entry>, ids: &[String]) -> Result<(), String> {
    let removed: Vec<Entry> = ids.iter().filter_map(|id| map.remove(id)).collect();
    if removed.is_empty() { return Ok(()); }
    if let Err(error) = save_metas(map) {
        for e in removed { map.insert(e.meta.id.clone(), e); }
        return Err(error);
    }
    for mut e in removed {
        if let Some(p) = e.proc.as_mut() { let _ = p.killer.kill(); }
        if let Some(app) = APP.get() {
            let _ = app.emit("agent-removed", json!({ "id": e.meta.id }));
        }
    }
    Ok(())
}

/// 取已归档满 180 天的记录 ID；未归档和归档时间晚于当前时间的记录均保留。
fn expired_archives(map: &HashMap<String, Entry>, at: i64) -> Vec<String> {
    map.values().filter(|e| e.meta.archived_at > 0 && at - e.meta.archived_at >= ARCHIVE_RETENTION_MS).map(|e| e.meta.id.clone()).collect()
}

/// 从列表直接删除会话（运行中先结束进程）；Claude Code 的对话记录保留在它自己的目录。
#[tauri::command]
pub fn agent_remove(id: String) -> Result<(), String> {
    remove_entries(&mut hub()?.entries.lock().unwrap(), &[id])
}

/// 设置页展示用：当前启动项，以及按它实际会用的 claude 路径（找不到时为错误文本）。
fn settings_view(set: &ClaudeSettings) -> Value {
    let (found, error) = match find_claude(set) {
        Ok(e) => (e.path().to_string_lossy().into_owned(), String::new()),
        Err(e) => (String::new(), e),
    };
    json!({ "claudePath": set.claude_path, "extraArgs": set.extra_args, "idleHours": set.idle_hours, "found": found, "error": error })
}

/// 读取 Claude Code 启动项（设置页打开时调用）。
#[tauri::command]
pub fn agent_get_settings() -> Result<Value, String> {
    Ok(settings_view(&load_settings()?))
}

/// 保存 Claude Code 启动项：路径非空时必须是存在的文件，额外参数必须能拆分；校验不过不写盘。
/// 只影响之后启动或续接的会话，正在运行的会话不变；idle_hours 保留现状（由 agent_set_lifecycle 维护）。
#[tauri::command]
pub fn agent_set_settings(claude_path: String, extra_args: String) -> Result<Value, String> {
    let _guard = SETTINGS_WRITE.lock().unwrap();
    let mut set = load_settings().unwrap_or_default();
    set.claude_path = claude_path.trim().to_string();
    set.extra_args = extra_args.trim().to_string();
    if !set.claude_path.is_empty() && !Path::new(&set.claude_path).is_file() {
        return Err(format!("文件不存在：{}", set.claude_path));
    }
    split_args(&set.extra_args)?;
    crate::write_atomic(&dir()?.join("settings.json"), &serde_json::to_string_pretty(&set).unwrap())?;
    Ok(settings_view(&set))
}

/// 空闲自动结束策略：读取当前的 idle_hours（0 = 不自动结束）。
#[tauri::command]
pub fn agent_get_lifecycle() -> Result<Value, String> {
    Ok(json!({ "idleHours": load_settings()?.idle_hours }))
}

/// 设置 CLI 连续空闲多少小时后自动结束进程：0 关闭，上限 8760 小时（约一年），允许小数。
/// 由后端清扫线程按各会话持续空闲起点（进入 idle / idle 中最后一次输入）判定，Agent 窗口关闭后仍生效。
#[tauri::command]
pub fn agent_set_lifecycle(idle_hours: f64) -> Result<Value, String> {
    let idle_hours = valid_idle_hours(idle_hours)?;
    let _guard = SETTINGS_WRITE.lock().unwrap();
    let mut set = load_settings()?;
    set.idle_hours = idle_hours;
    crate::write_atomic(&dir()?.join("settings.json"), &serde_json::to_string_pretty(&set).unwrap())?;
    if let Ok(h) = hub() {
        h.idle_hours.store(idle_hours.to_bits(), Ordering::Relaxed);
    }
    Ok(json!({ "idleHours": set.idle_hours }))
}

/// 空闲到期判定：必须是持续 idle 满阈值的会话。
/// 不算空闲：boot/run/wait（含正在执行工具）、有子任务在跑、有排队协作消息、压缩中、已标记停止。
/// 空闲起点只看进入 idle 的时间与 idle 中的用户终端输入；终端输出（TUI 重绘）不算活跃。
fn idle_expired(e: &Entry, now_ms: i64, limit_ms: i64) -> bool {
    e.live.status == "idle"
        && !e.stopping
        && !e.compacting
        && e.live.tool.is_empty()
        && e.queue.is_empty()
        && !e.live.workers.iter().any(|w| w.running)
        && now_ms - e.idle_since >= limit_ms
}

/// 回收持续空闲超阈值的会话：置 stopping 后走 killer，与手动停止同口径
/// （等待线程收到退出后记 off 而非 err，对话历史保留可续接）。调用方持有会话表锁。
/// 只动持有进程且通过 idle_expired 的会话；返回被回收的会话 id。
fn reap_idle(map: &mut HashMap<String, Entry>, now_ms: i64, limit_ms: i64) -> Vec<String> {
    let mut hit = Vec::new();
    for e in map.values_mut() {
        if e.proc.is_none() || !idle_expired(e, now_ms, limit_ms) {
            continue;
        }
        e.stopping = true;
        if let Some(p) = e.proc.as_mut() {
            let _ = p.killer.kill();
        }
        hit.push(e.meta.id.clone());
    }
    hit
}

/// 后台每 30 秒回收超时空闲进程，并清理归档满 180 天的记录；关闭空闲回收不影响归档清理。
fn idle_sweeper() {
    loop {
        std::thread::sleep(Duration::from_secs(30));
        let Ok(h) = hub() else { return };
        let hours = f64::from_bits(h.idle_hours.load(Ordering::Relaxed));
        let mut map = h.entries.lock().unwrap();
        let at = now();
        if hours > 0.0 {
            reap_idle(&mut map, at, (hours * 3_600_000.0) as i64);
        }
        let expired = expired_archives(&map, at);
        if let Err(error) = remove_entries(&mut map, &expired) {
            eprintln!("清理归档 Agent 失败: {error}");
        }
    }
}

/// 打开（或置前）Agent 窗口；focus 为要切到的会话 id；prefill 为新建面板的预填内容
/// （`{root, feat, links}`，主窗口机器人在 Feat / 流程图还没有会话时传入）。
/// 窗口已开时经事件转交，未开时放进 URL 参数，由页面启动时读取。
/// 窗口位置、尺寸记在 `<数据目录>/agent/window.json`，副屏上的位置下次照旧。
/// Windows 的 WebView2 创建必须离开同步 IPC 线程，所以是 async 命令。
#[tauri::command]
pub async fn open_agent_window(app: AppHandle, focus: Option<String>, prefill: Option<Value>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(id) = focus {
            let _ = app.emit_to(LABEL, "agent-focus", json!({ "id": id }));
        }
        if let Some(p) = prefill {
            let _ = app.emit_to(LABEL, "agent-prefill", p);
        }
        return Ok(());
    }
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let mut q = Vec::new();
    if let Some(f) = focus {
        q.push(format!("focus={}", utf8_percent_encode(&f, NON_ALPHANUMERIC)));
    }
    if let Some(p) = prefill {
        q.push(format!("new={}", utf8_percent_encode(&p.to_string(), NON_ALPHANUMERIC)));
    }
    let q = if q.is_empty() { String::new() } else { format!("?{}", q.join("&")) };
    let w = tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App(format!("agent.html{q}").into()))
        .title("Agent")
        .icon(tauri::include_image!("icons/agent.png"))
        .map_err(|e| format!("设置 Agent 窗口图标失败: {e}"))?
        .inner_size(1500.0, 940.0)
        .min_inner_size(820.0, 520.0)
        .visible(false)
        .build()
        .map_err(|e| format!("打开 Agent 窗口失败: {e}"))?;
    // 首次打开也建立普通矩形缓存，避免直接最大化后关闭时没有可恢复的位置。
    let p = w.outer_position().map_err(|e| e.to_string())?;
    let s = w.inner_size().map_err(|e| e.to_string())?;
    *GEOM.lock().unwrap() = Some(Geom { x: p.x, y: p.y, w: s.width, h: s.height, max: false });
    let saved = dir().ok().and_then(|d| std::fs::read_to_string(d.join("window.json")).ok()).and_then(|t| serde_json::from_str::<Geom>(&t).ok());
    if let Some(g) = saved {
        // 只在保存的位置仍落在某块屏幕上时恢复，拔掉副屏后不会开到看不见的地方
        let on_screen = w.available_monitors().unwrap_or_default().iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            g.x + 40 >= p.x && g.x + 40 < p.x + s.width as i32 && g.y + 20 >= p.y && g.y + 20 < p.y + s.height as i32
        });
        if on_screen {
            let _ = w.set_size(tauri::PhysicalSize::new(g.w, g.h));
            let _ = w.set_position(tauri::PhysicalPosition::new(g.x, g.y));
            *GEOM.lock().unwrap() = Some(g);
            if g.max {
                let _ = w.maximize();
            }
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

/// 将最近缓存的 Agent 普通矩形与最大化标志原子写入本机偏好；窗口未开过时不创建记录。
/// 关闭 Agent 和退出主程序共用，避免主程序先退出而丢失尚未销毁的 Agent 窗口位置。
fn save_window_geometry() -> Result<(), String> {
    if let Some(g) = *GEOM.lock().unwrap() {
        let text = serde_json::to_string(&g).map_err(|e| e.to_string())?;
        crate::write_atomic(&dir()?.join("window.json"), &text)?;
    }
    Ok(())
}

/// Agent 窗口事件：缓存普通位置与尺寸，最大化只改标志，最小化与全屏不覆盖普通矩形。
/// 关闭请求先保存，销毁时再使用缓存保存；文件或窗口查询失败返回错误供统一窗口事件入口记录。
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) -> Result<(), String> {
    if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::CloseRequested { .. })
        && !window.is_minimized().map_err(|e| e.to_string())?
        && !window.is_fullscreen().map_err(|e| e.to_string())?
    {
        let max = crate::window_state::is_maximized(window)?;
        let mut geom = GEOM.lock().unwrap();
        if max {
            if let Some(g) = geom.as_mut() { g.max = true; }
        } else {
            let p = window.outer_position().map_err(|e| e.to_string())?;
            let s = window.inner_size().map_err(|e| e.to_string())?;
            *geom = Some(Geom { x: p.x, y: p.y, w: s.width, h: s.height, max: false });
        }
    }
    if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
        save_window_geometry()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 窗口偏好独立于会话进程保存：负坐标副屏、普通尺寸和最大化标志原样落盘；没有窗口缓存时不覆盖已有记录。
    #[test]
    fn window_geometry_persists_without_agent_process() {
        crate::paths::test_home();
        let expected = Geom { x: -1440, y: 120, w: 1100, h: 780, max: true };
        let previous = GEOM.lock().unwrap().replace(expected);
        save_window_geometry().unwrap();
        let path = dir().unwrap().join("window.json");
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(serde_json::from_str::<Geom>(&text).unwrap(), expected);
        *GEOM.lock().unwrap() = None;
        save_window_geometry().unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        *GEOM.lock().unwrap() = previous;
    }

    /// 启动信号：未完成时超时报具体原因；晚到的成功唤醒等待方；失败原因原样传给所有等待方。
    #[test]
    fn startup_wait_reports_timeout_success_and_error() {
        let s = Startup::new();
        assert_eq!(s.wait(Duration::from_millis(20)).unwrap_err(), "Agent 服务启动超时（0 秒），请稍后重试");
        let s = std::sync::Arc::new(Startup::new());
        let late = s.clone();
        let t = std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(30)); late.finish(Ok(())); });
        assert_eq!(s.wait(Duration::from_secs(5)), Ok(()));
        t.join().unwrap();
        let s = Startup::new();
        s.finish(Err("端口被占用".into()));
        assert_eq!(s.wait(Duration::from_secs(1)).unwrap_err(), "端口被占用");
        assert_eq!(s.wait(Duration::from_secs(1)).unwrap_err(), "端口被占用");
    }

    /// 三个流程映射到各自技能；中文与带空格路径作为完整首条提示传给 CLI。
    #[test]
    fn workflow_prompt_routes_skills_and_context() {
        for (workflow, skill) in [("feat", "smallcat-feat-1-new"), ("fix", "smallcat-fix"), ("perf", "smallcat-perf")] {
            let prompt = workflow_prompt(Some(workflow), r"E:\My App\应用", r"E:\My App\docs\feat\Feat_261106_1_测试.md").unwrap().unwrap();
            assert_eq!(prompt, format!("/{skill} 工作目录：\"E:/My App/应用\"；关联档案：\"E:/My App/docs/feat/Feat_261106_1_测试.md\""));
            let mut cmd = CommandBuilder::new("claude.exe");
            cmd.arg(&prompt);
            assert_eq!(cmd.get_argv().len(), 2, "首条提示不能按路径空格拆成多个参数");
            assert_eq!(cmd.get_argv()[1], std::ffi::OsStr::new(&prompt));
        }
    }

    /// 未选流程保持普通会话；无关联时不编造档案，非法外部参数立即报错。
    #[test]
    fn workflow_prompt_optional_and_validated() {
        assert_eq!(workflow_prompt(None, "E:/App", "").unwrap(), None);
        assert_eq!(workflow_prompt(Some("fix"), "E:/App", "").unwrap(), Some("/smallcat-fix 工作目录：\"E:/App\"".into()));
        assert!(workflow_prompt(Some("pref"), "E:/App", "").unwrap_err().contains("未知启动流程"));
    }

    /// 归档保留关联并释放主会话名额；恢复冲突须保持原归档时间，重复归档不延长 180 天保留期。
    #[test]
    fn archive_binding_restore_and_roundtrip() {
        let link = NodeRef { flow: "E:/app/docs/flow/业务.drawio".into(), node: String::new() };
        let mut map = HashMap::from([("old".into(), entry("old", "业务", String::new(), vec![link.clone()]))]);
        archive_entry(&mut map, "old", true, 1000).unwrap();
        archive_entry(&mut map, "old", true, 2000).unwrap();
        assert_eq!(map["old"].meta.archived_at, 1000);
        assert_eq!(map["old"].meta.links, vec![link.clone()]);
        let stored: Meta = serde_json::from_value(serde_json::to_value(&map["old"].meta).unwrap()).unwrap();
        assert_eq!(stored.archived_at, 1000);
        main_conflict(&map, "new", "", &[link.clone()]).unwrap();
        map.insert("new".into(), entry("new", "业务", String::new(), vec![link]));
        assert!(archive_entry(&mut map, "old", false, 3000).unwrap_err().starts_with("DUP:"));
        assert_eq!(map["old"].meta.archived_at, 1000);
        map.remove("new");
        archive_entry(&mut map, "old", false, 3000).unwrap();
        assert_eq!(map["old"].meta.archived_at, 0);
        assert!(archive_entry(&mut map, "missing", true, 3000).is_err());
    }

    /// 180 天边界按归档时间计算：未归档、刚归档、未来时间与差 1 毫秒的记录均不清理。
    #[test]
    fn archived_retention_boundary() {
        let at = ARCHIVE_RETENTION_MS + 1000;
        let mut map = HashMap::new();
        for (id, archived_at) in [("expired", 1000), ("recent", 1001), ("active", 0), ("future", at + 1)] {
            let mut e = entry(id, id, String::new(), Vec::new());
            e.meta.archived_at = archived_at;
            map.insert(id.into(), e);
        }
        assert_eq!(expired_archives(&map, at), vec!["expired".to_string()]);
        assert!(expired_archives(&map, 1000).is_empty());
    }

    /// 当前上下文只统计输入及缓存读写；输出和累计值不参与占用，模型/档位保持 CLI 原值。
    #[test]
    fn metrics_parse_current_context() {
        let p = json!({"model":{"id":"configured-model","display_name":"测试模型"}, "effort":{"level":"high"},
            "context_window":{"context_window_size":200000,"total_input_tokens":999999,"current_usage":{
                "input_tokens":20000,"cache_creation_input_tokens":5000,"cache_read_input_tokens":51000,"output_tokens":9999}}});
        let m = Metrics::from_statusline(&p, 1234);
        assert_eq!(m.model_id.as_deref(), Some("configured-model"));
        assert_eq!(m.model_name.as_deref(), Some("测试模型"));
        assert_eq!(m.effort.as_deref(), Some("high"));
        assert_eq!(m.input_tokens, Some(20000));
        assert_eq!(m.cache_creation_input_tokens, Some(5000));
        assert_eq!(m.cache_read_input_tokens, Some(51000));
        assert_eq!(m.used_tokens, Some(76000));
        assert_eq!(m.capacity, Some(200000));
        assert_eq!(m.used_percentage, Some(38.0));
        assert_eq!(m.updated_at, 1234);
        let unknown = Metrics::from_statusline(&json!({"context_window":{"context_window_size":200000,"current_usage":null}}), 2);
        assert!(unknown.used_tokens.is_none() && unknown.used_percentage.is_none());
        assert!(unknown.input_tokens.is_none() && unknown.cache_creation_input_tokens.is_none() && unknown.cache_read_input_tokens.is_none());
        let zero = Metrics::from_statusline(&json!({"context_window":{"context_window_size":200000,"current_usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}), 3);
        assert_eq!(zero.used_tokens, Some(0));
        assert_eq!((zero.input_tokens, zero.cache_creation_input_tokens, zero.cache_read_input_tokens), (Some(0), Some(0), Some(0)));
        let invalid = Metrics::from_statusline(&json!({"context_window":{"context_window_size":0,"current_usage":{"input_tokens":u64::MAX,"cache_creation_input_tokens":1,"cache_read_input_tokens":0}}}), 3);
        assert!(invalid.used_tokens.is_none() && invalid.capacity.is_none());
    }

    /// 目录取 CLI 实际位置而非启动位置，分支取该次 hook 的查询结果；缺失字段保持未知。
    #[test]
    fn metrics_parse_workspace() {
        let p = json!({"cwd":"E:/旧目录","workspace":{"current_dir":"E:/实际目录"},"flow_coding_git_branch":"feature/中文分支"});
        let m = Metrics::from_statusline(&p, 1000);
        assert_eq!(m.current_dir.as_deref(), Some("E:/实际目录"));
        assert_eq!(m.git_branch.as_deref(), Some("feature/中文分支"));
        let m = Metrics::from_statusline(&json!({"cwd":"E:/CLI目录"}), 1000);
        assert_eq!(m.current_dir.as_deref(), Some("E:/CLI目录"));
        assert!(m.git_branch.is_none());
        let m = Metrics::from_statusline(&json!({}), 1000);
        assert!(m.current_dir.is_none() && m.git_branch.is_none());
    }

    /// 使用临时 Git 元数据验证中文空格路径、子目录分支、游离 HEAD 和非仓库，不改真实仓库。
    #[test]
    fn statusline_reads_git_at_actual_directory() {
        let root = std::env::temp_dir().join(format!("flow_metrics_{}", new_uuid()));
        let repo = root.join("工作 副本");
        let dir = repo.join("子目录");
        std::fs::create_dir_all(repo.join(".git/objects")).unwrap();
        std::fs::create_dir_all(repo.join(".git/refs")).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(repo.join(".git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n").unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/topic/metrics\n").unwrap();
        let mut p = json!({"workspace":{"current_dir":dir.to_string_lossy()}});
        enrich_statusline(&mut p);
        assert_eq!(p["flow_coding_git_branch"], "topic/metrics");
        std::fs::write(repo.join(".git/HEAD"), "0123456789012345678901234567890123456789\n").unwrap();
        enrich_statusline(&mut p);
        assert_eq!(p["flow_coding_git_branch"], "HEAD（游离）");
        p["workspace"]["current_dir"] = json!(root.to_string_lossy());
        enrich_statusline(&mut p);
        assert!(p["flow_coding_git_branch"].is_null());
        assert!(Metrics::from_statusline(&p, 1).git_branch.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 遥测不能刷新空闲计时或打断压缩；换对话后的旧回报被拒绝，clear 清除旧占用与本轮计时。
    #[test]
    fn metrics_do_not_change_lifecycle() {
        let mut e = entry("stable", "状态", String::new(), Vec::new());
        e.live.beat = 100; e.idle_since = 200; e.live.turn = 300; e.live.done = 400;
        let p = json!({"session_id":"stable","model":{"id":"m"}});
        assert!(apply_metrics(&mut e, &p, 1000));
        assert_eq!((e.live.beat, e.idle_since, e.live.turn, e.live.done), (100, 200, 300, 400));
        e.meta.cli_session_id = "new".into();
        assert!(!apply_metrics(&mut e, &p, 2000));
        assert_eq!(e.live.metrics.as_ref().unwrap().updated_at, 1000);
        e.compacting = true;
        assert!(!apply_metrics(&mut e, &json!({"session_id":"new"}), 3000));
        assert!(e.compacting);
        on_session_start(&mut e, &json!({"source":"clear"}), 4000);
        assert!(e.live.metrics.is_none());
        assert_eq!((e.live.turn, e.live.done), (0, 0));
    }

    #[test]
    fn turn_prompt_survives_activity_pruning() {
        let mut e = entry("turn", "摘要", String::new(), Vec::new());
        let prompt = "请调整订单导出功能，并验证分页与编码。".repeat(10);
        let act = start_turn(&mut e, &prompt, 1000);
        assert_eq!(act.text, cut(&prompt, 60));
        for _ in 0..=ACTS_MAX {
            push_act(&mut e, "read", "配置文件".into(), String::new());
        }
        assert!(!e.acts.iter().any(|a| a.kind == "prompt"));
        set_status(&mut e, "idle");
        assert_eq!(view(&e, false)["turn_prompt"], prompt);
    }

    #[test]
    fn turn_prompt_replaced_each_turn_and_cleared_with_conversation() {
        let mut e = entry("turn", "摘要", String::new(), Vec::new());
        start_turn(&mut e, "上一轮任务", 1000);
        start_turn(&mut e, "本轮任务\n补充要求", 2000);
        assert_eq!(e.live.turn_prompt, "本轮任务\n补充要求");
        assert_eq!(e.live.turn, 2000);
        on_session_start(&mut e, &json!({"source":"clear"}), 3000);
        assert!(e.live.turn_prompt.is_empty());
        assert_eq!(e.live.turn, 0);
    }

    /// 状态行使用会话私有设置和已有本地通道，原有 hooks 全部保留，不额外请求模型。
    #[test]
    fn hooks_include_statusline_metrics() {
        crate::paths::test_home();
        let path = hooks_file("E:/Flow App/flowctl.exe").unwrap();
        let p: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(p["statusLine"]["command"], "\"E:/Flow App/flowctl.exe\" agent-hook StatusLine");
        assert!(p["hooks"]["SessionStart"].is_array());
        assert!(p["hooks"]["PreCompact"].is_array());
    }

    /// 无色管道宿主启动嵌入式 CLI 时，禁色变量不得盖过 ConPTY 的彩色能力。
    #[test]
    fn terminal_colors_override_inherited_disabling() {
        let mut cmd = CommandBuilder::new("claude.exe");
        cmd.env("NO_COLOR", "1");
        cmd.env("FORCE_COLOR", "0");
        cmd.env("CLICOLOR", "0");
        cmd.env("TERM", "dumb");
        cmd.env("FLOW_AGENT_ID", "keep-session");
        terminal_color_env(&mut cmd);
        assert!(cmd.get_env("NO_COLOR").is_none());
        for (key, value) in [("FORCE_COLOR", "3"), ("CLICOLOR", "1"), ("TERM", "xterm-256color"), ("COLORTERM", "truecolor"), ("FLOW_AGENT_ID", "keep-session")] {
            assert_eq!(cmd.get_env(key), Some(std::ffi::OsStr::new(value)));
        }
    }

    /// 额外参数拆分：空白分隔、双引号保留空白、空引号得到空参数、未闭合报错。
    #[test]
    fn split_args_rules() {
        assert_eq!(split_args("").unwrap(), Vec::<String>::new());
        assert_eq!(split_args("  --model opus   --permission-mode acceptEdits ").unwrap(), ["--model", "opus", "--permission-mode", "acceptEdits"]);
        assert_eq!(split_args(r#"--add-dir "E:\My Dir" -x"#).unwrap(), ["--add-dir", r"E:\My Dir", "-x"]);
        assert_eq!(split_args(r#"--a "" b"#).unwrap(), ["--a", "", "b"]);
        assert!(split_args(r#"--a "b"#).is_err());
    }

    /// Feat 任务编号：格式只认 T<数字>[.<数字>]；正文匹配有边界，T1 不会命中 T12、T1.2。
    #[test]
    fn task_focus_rules() {
        for ok in ["T1", "T12", "T3.1"] {
            assert!(is_task_id(ok), "{ok}");
        }
        for bad in ["", "T", "t1", "T1.", "T1.2.3", "TA", "3"] {
            assert!(!is_task_id(bad), "{bad}");
        }
        let doc = "| T12 | 甲 |\n| T1.2 | 乙 |\n依赖 T3、T4";
        assert!(!doc_has_task(doc, "T1"));
        assert!(doc_has_task(doc, "T12") && doc_has_task(doc, "T1.2") && doc_has_task(doc, "T3") && doc_has_task(doc, "T4"));
        assert!(!doc_has_task("ST3 说明", "T3"));
    }

    /// 构造一个会话条目（测试用；不经过全局 Hub，避免并行测试冲突）。
    fn entry(id: &str, title: &str, feat: String, links: Vec<NodeRef>) -> Entry {
        Entry { meta: Meta { id: id.into(), title: title.into(), cwd: String::new(), app: String::new(), feat, feat_code: String::new(), links, pinned: false, pin_at: 0, created: 0, started: false, cli_session_id: String::new(), archived_at: 0 }, live: idle_live(), acts: VecDeque::new(), queue: VecDeque::new(), proc: None, buf: String::new(), seq: 0, gen: 0, stopping: false, idle_since: 0, compacting: false }
    }

    /// 独立的临时 APP 目录（docs/flow + docs/feat），避免并行测试互相覆盖。
    fn fixture(tag: &str) -> PathBuf {
        let p = crate::paths::test_home().join(format!("agent_{tag}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(p.join("docs/flow")).unwrap();
        std::fs::create_dir_all(p.join("docs/feat")).unwrap();
        p
    }

    /// 主会话唯一：同一来源只能一个主会话——Feat 按档案互斥，无 Feat 的会话按第一个关联
    /// 流程图互斥（路径不分大小写和斜杠）；第一个之后的关联只是客串，不参与互斥；排除自己。
    #[test]
    fn main_session_is_unique() {
        let link = |f: &str| vec![NodeRef { flow: f.into(), node: String::new() }];
        let map: HashMap<String, Entry> = [
            entry("a", "a", r"E:\p\Feat_1.md".into(), link(r"E:\p\flow\x.drawio")),
            entry("b", "b", String::new(), link(r"E:\p\flow\y.drawio")),
            // c 的第二个关联 y.drawio 是客串，仍与 b 共存
            entry("c", "c", String::new(), [link(r"E:\p\flow\z.drawio"), link(r"E:\p\flow\y.drawio")].concat()),
        ]
        .into_iter()
        .map(|e| (e.meta.id.clone(), e))
        .collect();
        let err = main_conflict(&map, "new", "e:/P/feat_1.md", &[]).unwrap_err();
        assert!(err.starts_with("DUP:a:"), "{err}");
        // Feat 主会话关联图是客串：不占用 y.drawio
        assert!(main_conflict(&map, "new", r"E:\p\Feat_2.md", &link(r"E:\p\flow\y.drawio")).is_ok());
        // 图主按第一个关联判定：b 占 y.drawio，a 的 x.drawio 只是 Feat 的客串
        assert!(main_conflict(&map, "new", "", &link("e:/p/flow/Y.drawio")).unwrap_err().starts_with("DUP:b:"));
        assert!(main_conflict(&map, "new", "", &link(r"E:\p\flow\x.drawio")).is_ok());
        assert!(main_conflict(&map, "new", "", &link(r"E:\p\flow\z.drawio")).unwrap_err().starts_with("DUP:c:"));
        // 新会话把已占用的 y.drawio 放在第二位（客串）不冲突
        let links = [link(r"E:\p\flow\w.drawio"), link(r"E:\p\flow\y.drawio")].concat();
        assert!(main_conflict(&map, "new", "", &links).is_ok());
        assert!(main_conflict(&map, "b", "", &link(r"E:\p\flow\y.drawio")).is_ok());
        assert!(main_conflict(&map, "a", r"E:\p\Feat_1.md", &[]).is_ok());
    }

    /// 名称精确跟随来源：Feat 主取档案一级标题（parse_md 口径，不是文件名），图主取文件名；
    /// 就地改档案一级标题经 resync_source 落到会话名；视图暴露 title_locked / source_kind / source_path。
    #[test]
    fn bound_title_follows_source() {
        let app = fixture("title");
        let feat = app.join("docs/feat/Feat_261106_1_随便起的文件名.md");
        std::fs::write(&feat, "# Feat_261106_1 真正的标题\n\n> 状态：开发中\n").unwrap();
        let flow = app.join("docs/flow/条件组管理.drawio");
        std::fs::write(&flow, "<mxfile/>").unwrap();
        let mut fe = entry("f", "别的名", feat.to_string_lossy().into_owned(), vec![]);
        assert!(sync_title(&mut fe));
        assert_eq!(fe.meta.title, "真正的标题", "Feat 主会话名取档案一级标题");
        let mut ge = entry("g", "别的名", String::new(), vec![NodeRef { flow: flow.to_string_lossy().into_owned(), node: "n1".into() }]);
        assert!(sync_title(&mut ge));
        assert_eq!(ge.meta.title, "条件组管理", "图主会话名取文件名");
        let v = view(&fe, false);
        assert_eq!((v["title_locked"].as_bool().unwrap(), v["source_kind"].as_str().unwrap(), v["source_path"].as_str().unwrap()), (true, "feat", feat.to_string_lossy().as_ref()));
        let vg = view(&ge, false);
        assert_eq!((vg["title_locked"].as_bool().unwrap(), vg["source_kind"].as_str().unwrap(), vg["source_path"].as_str().unwrap()), (true, "flow", flow.to_string_lossy().as_ref()));
        // 就地改一级标题 → resync_source 只同步以它为来源的会话
        std::fs::write(&feat, "# Feat_261106_1 改名后\n\n> 状态：开发中\n").unwrap();
        let mut map: HashMap<String, Entry> = [fe, ge].into_iter().map(|e| (e.meta.id.clone(), e)).collect();
        assert_eq!(resync_source(&mut map, &feat), vec!["f".to_string()]);
        assert_eq!(map["f"].meta.title, "改名后");
        assert_eq!(map["g"].meta.title, "条件组管理");
    }

    /// 绑定来源的名称锁定：改成别的名被拒且整个 patch 不生效；只能提交与来源一致的名字。
    /// 关联变化即时重算归属与名称；解除关联后恢复独立会话，可自由改名。
    #[test]
    fn source_bound_title_lock() {
        let app = fixture("lock");
        let feat = app.join("docs/feat/Feat_261106_2_甲.md");
        std::fs::write(&feat, "# Feat_261106_2 甲\n").unwrap();
        let flow = app.join("docs/flow/乙.drawio");
        std::fs::write(&flow, "<mxfile/>").unwrap();
        let mut map: HashMap<String, Entry> = [entry("s", "随便", feat.to_string_lossy().into_owned(), vec![])].into_iter().map(|e| (e.meta.id.clone(), e)).collect();
        assert!(apply_patch(&mut map, "s", &json!({"title": "想改名", "pinned": true})).is_err());
        assert!(!map["s"].meta.pinned && map["s"].meta.title == "随便", "失败的 patch 不得部分生效");
        apply_patch(&mut map, "s", &json!({"title": "甲", "pinned": true})).unwrap();
        assert!(map["s"].meta.pinned);
        // 换成关联图 → 成为图主，名字跟随图文件名
        apply_patch(&mut map, "s", &json!({"feat": "", "links": [{"flow": flow.to_string_lossy(), "node": "n1"}]})).unwrap();
        assert_eq!(map["s"].meta.title, "乙");
        assert!(apply_patch(&mut map, "s", &json!({"title": "丙"})).is_err());
        // 清掉关联 → 独立会话，恢复自由改名
        apply_patch(&mut map, "s", &json!({"links": [], "title": "自定义"})).unwrap();
        assert_eq!(map["s"].meta.title, "自定义");
        apply_patch(&mut map, "s", &json!({"title": "另一个"})).unwrap();
        assert_eq!(map["s"].meta.title, "另一个");
    }

    /// 冲突校验先于任何修改：争已占用 Feat 的 patch 被拒，元数据原样保留。
    #[test]
    fn patch_rejects_without_partial_apply() {
        let app = fixture("atomic");
        let fa = app.join("docs/feat/Feat_261106_4_甲.md");
        let fb = app.join("docs/feat/Feat_261106_5_乙.md");
        std::fs::write(&fa, "# Feat_261106_4 甲\n").unwrap();
        std::fs::write(&fb, "# Feat_261106_5 乙\n").unwrap();
        let (fa_s, fb_s) = (fa.to_string_lossy().into_owned(), fb.to_string_lossy().into_owned());
        let mut map: HashMap<String, Entry> = [
            entry("a", "甲", fa_s.clone(), vec![]),
            entry("b", "自定义", String::new(), vec![]),
        ]
        .into_iter()
        .map(|e| (e.meta.id.clone(), e))
        .collect();
        assert!(apply_patch(&mut map, "b", &json!({"feat": fa_s, "title": "x", "pinned": true})).unwrap_err().starts_with("DUP:a:"));
        assert!(map["b"].meta.feat.is_empty() && map["b"].meta.title == "自定义" && !map["b"].meta.pinned);
        apply_patch(&mut map, "b", &json!({"feat": fb_s})).unwrap();
        assert_eq!((map["b"].meta.feat.as_str(), map["b"].meta.title.as_str()), (fb_s.as_str(), "乙"));
    }

    /// 重命名：Meta.feat、关联 links、当前 focus / task 与主会话名全部指向新路径；
    /// 只把同一文件当客串引用的会话改引用不动名字；未引用的会话不受影响。
    #[test]
    fn rename_remaps_session_references() {
        let app = fixture("ren");
        let old_flow = app.join("docs/flow/旧图.drawio");
        let new_flow = app.join("docs/flow/新图.drawio");
        let feat_other = app.join("docs/feat/Feat_261106_6_别的.md");
        std::fs::write(&feat_other, "# Feat_261106_6 别的\n").unwrap();
        let feat_old = app.join("docs/feat/Feat_261106_3_旧名.md");
        let feat_new = app.join("docs/feat/Feat_261106_3_新名.md");
        // 改名事务成功后的磁盘状态：新文件已就位、旧路径已消失
        std::fs::write(&new_flow, "<mxfile/>").unwrap();
        std::fs::write(&feat_new, "# Feat_261106_3 新名\n").unwrap();
        let (os, fs_o, fs_n) = (old_flow.to_string_lossy().into_owned(), feat_old.to_string_lossy().into_owned(), feat_new.to_string_lossy().into_owned());
        let mut owner = entry("o", "旧图", String::new(), vec![NodeRef { flow: os.clone(), node: "n1".into() }, NodeRef { flow: "other.drawio".into(), node: String::new() }]);
        owner.live.focus = Some(NodeRef { flow: os.clone(), node: "n1".into() });
        let mut fowner = entry("f", "旧名", fs_o.clone(), vec![]);
        fowner.live.task = Some(TaskRef { feat: fs_o.clone(), task: "T1".into() });
        let mut guest = entry("g", "别的", feat_other.to_string_lossy().into_owned(), vec![NodeRef { flow: os.clone(), node: "n9".into() }]);
        guest.live.focus = Some(NodeRef { flow: os.clone(), node: "n9".into() });
        let mut map: HashMap<String, Entry> = [owner, fowner, guest, entry("x", "无关", String::new(), vec![])]
            .into_iter()
            .map(|e| (e.meta.id.clone(), e))
            .collect();
        // 流程图改名
        let mut ids = remap_renamed(&mut map, &old_flow, &new_flow);
        ids.sort();
        assert_eq!(ids, ["g", "o"]);
        assert_eq!(map["o"].meta.title, "新图");
        assert_eq!(map["o"].meta.links[0].flow, new_flow.to_string_lossy());
        assert_eq!(map["o"].live.focus.as_ref().unwrap().flow, new_flow.to_string_lossy());
        assert_eq!(map["g"].meta.links[0].flow, new_flow.to_string_lossy());
        assert_eq!(map["g"].meta.title, "别的", "客串引用只改路径，名称仍跟随自己的 Feat");
        assert_eq!(map["x"].meta.title, "无关");
        // Feat 改名：feat 指针、当前任务与主会话名一起换新
        let ids = remap_renamed(&mut map, &feat_old, &feat_new);
        assert_eq!(ids, ["f"]);
        assert_eq!(map["f"].meta.feat, fs_n);
        assert_eq!(map["f"].live.task.as_ref().unwrap().feat, fs_n);
        assert_eq!(map["f"].meta.title, "新名");
    }

    /// 旧版 sessions.json（缺 feat/links/pinned/started 字段）能反序列化；
    /// 载入规范化给独立会话补默认名、绑定会话与来源同步；读不到来源文件时保留现名。
    #[test]
    fn legacy_sessions_normalize_and_view() {
        let raw = r#"[
            {"id":"a","title":"","cwd":"","app":"","created":1},
            {"id":"b","title":"旧名字","cwd":"","app":"","created":2,"feat":"FEAT_MISSING","started":true}
        ]"#;
        let metas: Vec<Meta> = serde_json::from_str(raw).unwrap();
        assert_eq!(metas.len(), 2);
        assert!(metas[0].links.is_empty() && !metas[0].pinned && !metas[0].started);
        let mut map: HashMap<String, Entry> = metas
            .into_iter()
            .map(|m| (m.id.clone(), Entry { meta: m, live: idle_live(), acts: VecDeque::new(), queue: VecDeque::new(), proc: None, buf: String::new(), seq: 0, gen: 0, stopping: false, idle_since: 0, compacting: false }))
            .collect();
        assert!(normalize(map.get_mut("a").unwrap()));
        assert_eq!(map["a"].meta.title, "新会话");
        // 来源文件读不到：规范化不丢现名
        assert!(!normalize(map.get_mut("b").unwrap()));
        assert_eq!(map["b"].meta.title, "旧名字");
        let va = view(&map["a"], false);
        assert_eq!((va["title_locked"].as_bool().unwrap(), va["source_kind"].as_str().unwrap(), va["source_path"].as_str().unwrap()), (false, "", ""));
        let vb = view(&map["b"], false);
        assert_eq!((vb["title_locked"].as_bool().unwrap(), vb["source_kind"].as_str().unwrap(), vb["source_path"].as_str().unwrap()), (true, "feat", "FEAT_MISSING"));
        // 持久化往返：序列化写盘后能原样读回
        let text = serde_json::to_string_pretty(&vec![&map["a"].meta, &map["b"].meta]).unwrap();
        let back: Vec<Meta> = serde_json::from_str(&text).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!((back[0].title.as_str(), back[1].feat.as_str(), back[1].started), ("新会话", "FEAT_MISSING", true));
    }

    /// 协作活动在即时事件和缓冲回放中保留相同 peer，普通活动不携带对方身份。
    #[test]
    fn message_peer_survives_buffer() {
        let meta = Meta { id: "sender".into(), title: "同名".into(), cwd: String::new(), app: String::new(), feat: String::new(), feat_code: String::new(), links: vec![], pinned: false, pin_at: 0, created: 0, started: false, cli_session_id: String::new(), archived_at: 0 };
        let mut e = Entry { meta, live: idle_live(), acts: VecDeque::new(), queue: VecDeque::new(), proc: None, buf: String::new(), seq: 0, gen: 0, stopping: false, idle_since: 0, compacting: false };
        let a = push_message(&mut e, "exact-peer-id", "协作消息".into());
        assert_eq!(a.peer, "exact-peer-id");
        assert_eq!(e.acts.back().unwrap().peer, a.peer);
        assert_eq!(serde_json::to_value(&a).unwrap()["peer"], "exact-peer-id");
        assert!(push_act(&mut e, "read", "file".into(), String::new()).peer.is_empty());
    }

    /// 空闲超时设置：默认 1 小时；旧版 settings.json 缺字段按 1 小时；set_lifecycle 校验范围并写盘；
    /// set_settings 只改启动项，保留现有 idle_hours。文件级测试集中在这里，避免并行测试抢同一个 settings.json。
    #[test]
    fn lifecycle_settings_defaults_and_merge() {
        let _ = crate::paths::test_home();
        let f = dir().unwrap().join("settings.json");
        let backup = std::fs::read_to_string(&f).ok();
        // 文件不存在 → 默认 1 小时
        let _ = std::fs::remove_file(&f);
        assert_eq!(ClaudeSettings::default().idle_hours, 1.0);
        assert_eq!(agent_get_lifecycle().unwrap()["idleHours"], 1.0);
        // 旧版文件缺 idle_hours → 迁移默认 1 小时
        std::fs::write(&f, r#"{"claude_path":"","extra_args":"--model opus"}"#).unwrap();
        let set = load_settings().unwrap();
        assert_eq!((set.idle_hours, set.extra_args.as_str()), (1.0, "--model opus"));
        // set_lifecycle：接受 0（关闭）、小数、上限；拒绝负值、超上限、非有限值
        assert_eq!(agent_set_lifecycle(2.5).unwrap()["idleHours"], 2.5);
        assert_eq!(agent_set_lifecycle(0.0).unwrap()["idleHours"], 0.0);
        assert!(agent_set_lifecycle(8760.0).is_ok());
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.5, 8760.5] {
            assert!(agent_set_lifecycle(bad).is_err(), "{bad}");
        }
        assert_eq!(load_settings().unwrap().idle_hours, 8760.0, "失败的 set_lifecycle 不得写盘");
        // set_settings 只改启动项，保留 idle_hours
        agent_set_settings(String::new(), "--model opus".into()).unwrap();
        let set = load_settings().unwrap();
        assert_eq!((set.idle_hours, set.extra_args.as_str()), (8760.0, "--model opus"));
        match backup {
            Some(t) => std::fs::write(&f, t).unwrap(),
            None => drop(std::fs::remove_file(&f)),
        }
    }

    /// UUID 校验：标准形态才采信。
    #[test]
    fn uuid_shape() {
        assert!(is_uuid("123e4567-e89b-12d3-a456-426614174000"));
        assert!(is_uuid("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"));
        for bad in ["", "not-a-uuid", "123e4567e89b12d3a456426614174000", "123e4567-e89b-12d3-a456-42661417400g", "123e4567-e89b-12d3-a456-4266141740000"] {
            assert!(!is_uuid(bad), "{bad}");
        }
    }

    /// SessionStart：稳定 id 的 startup/resume 回报记为 cli id；/clear、compact、/resume 换新 id 时采信；
    /// 陌生 id 配 startup / 缺 source / 非 UUID 一律拒绝——subagent 的 session id 不得改写父会话续接目标；
    /// 且无论状态是否变化都重算空闲基线。
    #[test]
    fn session_start_tracks_latest_cli_id() {
        let id = "11111111-2222-3333-4444-555555555555";
        let new = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let rogue = "99999999-8888-7777-6666-555555555555";
        let mut e = entry(id, "s", String::new(), vec![]);
        e.live.status = "idle".into();
        e.idle_since = 1;
        // 首次启动回报自身 id（source=startup）→ 记录
        assert!(on_session_start(&mut e, &json!({"session_id": id, "source": "startup"}), 2000));
        assert_eq!(e.meta.cli_session_id, id);
        assert_eq!(e.idle_since, 2000, "SessionStart 重算空闲基线");
        assert_eq!(resume_target(&e.meta), id);
        // /clear 换新 id → 采信，cli id 跟随最新，稳定 id 不变
        e.idle_since = 1;
        e.live.status = "wait".into();
        e.live.tool = "Bash".into();
        e.live.wait_text = "permission".into();
        assert!(on_session_start(&mut e, &json!({"session_id": new, "source": "clear"}), 3000));
        assert_eq!(e.live.status, "idle", "clear 结束上一段对话的忙碌状态");
        assert!(e.live.tool.is_empty() && e.live.wait_text.is_empty());
        assert_eq!(e.meta.cli_session_id, new);
        assert_eq!(e.meta.id, id);
        assert_eq!(resume_target(&e.meta), new);
        // compact 换 id → 采信
        assert!(on_session_start(&mut e, &json!({"session_id": rogue, "source": "compact"}), 4000));
        assert_eq!(e.meta.cli_session_id, rogue);
        // 陌生 id + startup / 缺 source / 非 UUID → 拒绝（subagent 回报不得改写续接目标）
        let foreign = "123e4567-e89b-12d3-a456-426614174000";
        assert!(!on_session_start(&mut e, &json!({"session_id": foreign, "source": "startup"}), 5000));
        assert!(!on_session_start(&mut e, &json!({"session_id": foreign}), 5000));
        assert!(!on_session_start(&mut e, &json!({"session_id": "bogus", "source": "clear"}), 5000));
        assert_eq!(e.meta.cli_session_id, rogue);
        // /resume 别的对话 → 新 id + resume 可采信
        assert!(on_session_start(&mut e, &json!({"session_id": foreign, "source": "resume"}), 6000));
        assert_eq!(e.meta.cli_session_id, foreign);
    }

    /// cli_session_id 持久化：写入 sessions.json 后能读回；旧档案没有该字段时为空。
    #[test]
    fn cli_session_id_persist_roundtrip() {
        let legacy: Vec<Meta> = serde_json::from_str(r#"[{"id":"a","title":"t","cwd":"","app":"","created":1}]"#).unwrap();
        assert_eq!(legacy[0].cli_session_id, "");
        let mut m = legacy[0].clone();
        m.cli_session_id = "123e4567-e89b-12d3-a456-426614174000".into();
        let text = serde_json::to_string_pretty(&vec![m]).unwrap();
        assert!(text.contains("cli_session_id"));
        let back: Vec<Meta> = serde_json::from_str(&text).unwrap();
        assert_eq!(back[0].cli_session_id, "123e4567-e89b-12d3-a456-426614174000");
    }

    /// 进入 idle 记空闲起点；空闲到期判定只放行持续 idle 满阈值者：
    /// run/wait/boot、排队消息、子任务在跑、压缩中、已停止标记都不回收；阈值差 1ms 不回收。
    #[test]
    fn idle_expiry_rules() {
        let limit = 3_600_000i64;
        let mut e = entry("i", "i", String::new(), vec![]);
        // off → idle 转换记起点
        set_status(&mut e, "idle");
        assert!(e.idle_since > 0);
        e.idle_since = 1_000;
        assert!(idle_expired(&e, 1_000 + limit, limit));
        assert!(!idle_expired(&e, 1_000 + limit - 1, limit), "差 1ms 不到阈值不回收");
        // 非 idle 状态不回收
        for st in ["run", "wait", "boot", "off", "err"] {
            e.live.status = st.into();
            assert!(!idle_expired(&e, i64::MAX / 2, limit), "{st}");
        }
        e.live.status = "idle".into();
        e.stopping = true;
        assert!(!idle_expired(&e, i64::MAX / 2, limit));
        e.stopping = false;
        e.compacting = true;
        assert!(!idle_expired(&e, i64::MAX / 2, limit), "压缩中不回收");
        e.compacting = false;
        e.live.tool = "Bash".into();
        assert!(!idle_expired(&e, i64::MAX / 2, limit), "工具尚未结束不回收");
        e.live.tool.clear();
        e.queue.push_back("msg".into());
        assert!(!idle_expired(&e, i64::MAX / 2, limit), "有排队消息不回收");
        e.queue.clear();
        e.live.workers.push(Worker { id: "w".into(), desc: String::new(), running: true, t0: 0, t1: 0, uses: 0 });
        assert!(!idle_expired(&e, i64::MAX / 2, limit), "子任务在跑不回收");
        e.live.workers.clear();
        assert!(idle_expired(&e, i64::MAX / 2, limit));
        // 没有进程条目不进入回收（reap_idle 另要求 proc.is_some）
        let mut map: HashMap<String, Entry> = [e].into_iter().map(|e| (e.meta.id.clone(), e)).collect();
        assert!(reap_idle(&mut map, i64::MAX / 2, limit).is_empty());
    }

    /// 用独立的 cmd /c pause 验证 ConPTY 真实回收路径，不启动 Claude，也不等待真实一小时。
    #[cfg(windows)]
    #[test]
    fn idle_reaper_stops_expired_native_process() {
        let pty = portable_pty::native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/d", "/c", "pause"]);
        let mut child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);
        let killer = child.clone_killer();
        let writer = pty.master.take_writer().unwrap();
        let mut e = entry("idle-native", "idle-native", String::new(), vec![]);
        e.proc = Some(Proc { master: pty.master, writer, killer });
        e.live.status = "idle".into();
        e.idle_since = 1_000;
        let mut map: HashMap<String, Entry> = [(e.meta.id.clone(), e)].into_iter().collect();
        let limit = 3_600_000;
        assert!(reap_idle(&mut map, 1_000 + limit - 1, limit).is_empty());
        assert_eq!(reap_idle(&mut map, 1_000 + limit, limit), vec!["idle-native"]);
        assert!(map["idle-native"].stopping, "自动回收按正常停止处理");
        assert!(reap_idle(&mut map, 1_001 + limit, limit).is_empty(), "停止中不重复回收");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || { let _ = tx.send(child.wait().is_ok()); });
        assert!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), "原生进程确已退出");
    }

    /// 等到会话状态满足条件或超时，返回最后一次看到的状态。
    fn wait_for(id: &str, secs: u64, f: impl Fn(&Entry) -> bool) -> String {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            {
                let map = hub().unwrap().entries.lock().unwrap();
                let e = &map[id];
                if f(e) {
                    return e.live.status.clone();
                }
                if std::time::Instant::now() > deadline {
                    let tail: String = e.buf.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
                    panic!("超时：status={} tool={} 输出尾部：\n{}", e.live.status, e.live.tool, strip_ansi(&tail));
                }
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    /// 去掉 ANSI 控制序列，便于在失败信息里看终端内容。
    fn strip_ansi(s: &str) -> String {
        let mut out = String::new();
        let mut it = s.chars().peekable();
        while let Some(c) = it.next() {
            if c == '\x1b' {
                if it.peek() == Some(&'[') {
                    it.next();
                    while let Some(&n) = it.peek() { it.next(); if n.is_ascii_alphabetic() || n == '~' { break; } }
                } else if it.peek() == Some(&']') {
                    while let Some(n) = it.next() { if n == '\x07' { break; } }
                } else { it.next(); }
            } else { out.push(c); }
        }
        out
    }

    /// 测量真实 CLI 的终端创建、首屏输出及 SessionStart 就绪耗时；不发送提示，不调用模型。
    /// 使用独立 Flow Coding 数据目录；工作目录由 FLOW_AGENT_TEST_CWD 明确指定，每轮仅回收本次新建进程。
    #[test]
    #[ignore = "需要本机 Claude CLI；只启动终端，不发送模型请求"]
    fn startup_timing_no_prompt() {
        crate::paths::test_home();
        start_hub();
        let cwd = std::env::var("FLOW_AGENT_TEST_CWD").expect("需要 FLOW_AGENT_TEST_CWD");
        for run in 1..=3 {
            let start = std::time::Instant::now();
            let mut creation = Box::pin(agent_create(format!("启动测量{run}"), cwd.clone(), "startup-probe".into(), String::new(), String::new(), Vec::new(), false, None));
            // 首次 poll 相当于 IPC 调度：只能派发后台任务，不能在此执行终端创建。
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(std::future::Future::poll(creation.as_mut(), &mut context).is_pending());
            let dispatch = start.elapsed().as_millis();
            assert!(dispatch < 1000, "启动调度不得阻塞一秒：{dispatch}ms");
            let v = tauri::async_runtime::block_on(creation).unwrap();
            let id = v["id"].as_str().unwrap().to_string();
            let created = start.elapsed().as_millis();
            wait_for(&id, 30, |e| !e.buf.is_empty());
            let output = start.elapsed().as_millis();
            wait_for(&id, 30, |e| e.live.status == "idle" || e.live.status == "wait");
            eprintln!("startup run={run} dispatch_ms={dispatch} create_ms={created} output_ms={output} ready_ms={}", start.elapsed().as_millis());
            agent_stop(id.clone()).unwrap();
            wait_for(&id, 10, |e| e.proc.is_none());
        }
    }

    /// 真实联调（需要已登录的 Claude Code，会消耗少量额度，默认不跑）：
    /// FLOW_CTL=<target/debug/flowctl.exe> FLOW_AGENT_TEST_CWD=<含 docs/flow/条件组管理.drawio 的 APP 目录> cargo test live_session -- --ignored --nocapture
    /// 覆盖：ConPTY 启动 TUI → 提交提示 → hooks 回报 run → Bash 权限确认 wait → 批准 → flowctl focus 定位节点 → Stop 回到 idle → 结束进程。
    #[test]
    #[ignore]
    fn live_session() {
        crate::paths::test_home();
        start_hub();
        let cwd = std::env::var("FLOW_AGENT_TEST_CWD").expect("需要 FLOW_AGENT_TEST_CWD");
        let v = tauri::async_runtime::block_on(agent_create("联调".into(), cwd, "app_mes_tool".into(), String::new(), String::new(), Vec::new(), false, None)).unwrap();
        let id = v["id"].as_str().unwrap().to_string();
        let _ = agent_resize(id.clone(), 140, 40);
        // TUI 就绪：SessionStart 回报后变为 idle
        wait_for(&id, 60, |e| e.live.status == "idle");
        std::thread::sleep(Duration::from_secs(2));
        agent_write(id.clone(), "用 Bash 运行你系统提示里给的 flowctl focus 命令，把位置标到 docs/flow/条件组管理.drawio#n7，然后只回复 OK".into()).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        agent_write(id.clone(), "\r".into()).unwrap();
        wait_for(&id, 60, |e| e.live.status == "run");
        // 等 focus 生效；途中遇到 Bash 权限确认（status=wait）或 Claude Code 的一次性提示框（Enter to continue）就按 Enter
        let deadline = std::time::Instant::now() + Duration::from_secs(180);
        let mut pressed = std::time::Instant::now() - Duration::from_secs(60);
        loop {
            let (done, ask) = {
                let map = hub().unwrap().entries.lock().unwrap();
                let e = &map[&id];
                let tail: String = e.buf.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
                (e.live.focus.as_ref().is_some_and(|f| f.node == "n7"), e.live.status == "wait" || strip_ansi(&tail).contains("Entertocontinue") || tail.contains("Enter to continue"))
            };
            if done {
                break;
            }
            if ask && pressed.elapsed() > Duration::from_secs(5) {
                println!("确认框，按 Enter");
                agent_write(id.clone(), "\r".into()).unwrap();
                pressed = std::time::Instant::now();
            }
            assert!(std::time::Instant::now() < deadline, "等 focus 超时");
            std::thread::sleep(Duration::from_millis(500));
        }
        wait_for(&id, 120, |e| e.live.status == "idle");
        {
            let map = hub().unwrap().entries.lock().unwrap();
            let e = &map[&id];
            let kinds: Vec<&str> = e.acts.iter().map(|a| a.kind.as_str()).collect();
            println!("活动：{kinds:?}\nfocus：{:?}", e.live.focus);
            assert!(kinds.contains(&"prompt") && kinds.contains(&"cmd"));
        }
        agent_stop(id.clone()).unwrap();
        wait_for(&id, 30, |e| e.proc.is_none());
        let map = hub().unwrap().entries.lock().unwrap();
        println!("退出：status={} code={:?}", map[&id].live.status, map[&id].live.exit_code);
    assert_eq!(map[&id].live.status, "off");
    }
}

