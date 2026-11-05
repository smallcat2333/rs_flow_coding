//! Agent 窗口后端：托管 Claude Code CLI 会话（ConPTY 内运行真实的 claude TUI），汇总 hooks 回报的状态，
//! 供 Agent 窗口（会话列表、终端页签）和主窗口画布（节点上的 Agent 图标）使用。
//!
//! - 会话元数据存 `<数据目录>/agent/sessions.json`；会话 id 就是 Claude Code 的 session id，
//!   首次启动用 `--session-id`，已有对话记录时用 `--resume` 续接，对话历史由 Claude Code 自己保存；
//! - 进程由 App 后台持有：关闭 Agent 窗口不中断会话，主窗口退出时结束全部会话；
//! - 状态来源：启动时用 `--settings` 挂 hooks，hook 调 `flowctl agent-hook <事件>`，经本机 TCP
//!   （只监听 127.0.0.1，请求必须带启动时下发的随机令牌）回报；同一通道提供 `flowctl focus / peers / send`；
//! - 协作消息写入对方终端：对方空闲时立即写入并回车；运行中或在等确认时排队，等它本轮结束（Stop）再写入，
//!   避免消息被当成确认框的按键。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

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

/// 持久化的会话元数据。feat 为空表示未关联 Feat；links 为关联的流程图节点。
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

/// 运行状态（不持久化）。status：off 未运行 | boot 启动中 | idle 空闲 | run 运行中 | wait 等你确认 | err 异常退出。
/// 停滞由前端按 beat 推导：run 且没有执行中的工具、60 秒没有 hook 活动。
#[derive(Debug, Clone, Serialize)]
pub struct Live {
    pub status: String,
    pub since: i64,
    pub turn: i64,
    pub beat: i64,
    pub tool: String,
    pub tool_since: i64,
    pub wait_text: String,
    pub focus: Option<NodeRef>,
    pub workers: Vec<Worker>,
    pub exit_code: Option<u32>,
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
}

/// 全局会话表与 hooks 通道参数。
struct Hub {
    entries: Mutex<HashMap<String, Entry>>,
    port: u16,
    token: String,
}

static HUB: OnceLock<Hub> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Agent 窗口最近一次的位置与尺寸（物理像素），关闭时写盘。
static GEOM: Mutex<Option<Geom>> = Mutex::new(None);

/// Agent 窗口几何信息：物理坐标、物理尺寸、是否最大化。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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
    Live { status: "off".into(), since: now(), turn: 0, beat: 0, tool: String::new(), tool_since: 0, wait_text: String::new(), focus: None, workers: Vec::new(), exit_code: None }
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
        o.insert("queued".into(), json!(e.queue.len()));
        o.insert("running".into(), json!(e.proc.is_some()));
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

/// 启动 Agent 服务：读入会话元数据、开 hooks 监听端口。启动失败不影响 App 其他功能，只打印原因。
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    start_hub();
}

/// 建会话表并开 hooks 监听线程（不依赖窗口，测试可直接调用）。
fn start_hub() {
    let metas = match load_metas() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Agent 会话读取失败: {e}");
            Vec::new()
        }
    };
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Agent 端口监听失败: {e}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let mut map = HashMap::new();
    for m in metas {
        map.insert(m.id.clone(), Entry { meta: m, live: idle_live(), acts: VecDeque::new(), queue: VecDeque::new(), proc: None, buf: String::new(), seq: 0, gen: 0, stopping: false });
    }
    let _ = HUB.set(Hub { entries: Mutex::new(map), port, token: new_uuid() });
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            std::thread::spawn(move || handle_conn(s));
        }
    });
}

/// 主窗口关闭、App 退出前结束全部会话进程（对话历史已由 Claude Code 保存，下次可续接）。
pub fn shutdown() {
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

/// 查找 claude：环境变量 FLOW_CLAUDE 优先；其次 PATH 中的 claude.exe；npm 安装的 claude.cmd 优先换成
/// 包内的 claude.exe（参数不经 cmd.exe 二次解析）；最后是 ~/.local/bin/claude.exe。都没有则报错。
fn find_claude() -> Result<Exe, String> {
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
    Err("找不到 Claude Code（claude.exe），请先安装，或用环境变量 FLOW_CLAUDE 指定路径".into())
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
    crate::write_atomic(&f, &serde_json::to_string_pretty(&json!({ "hooks": hooks })).unwrap())?;
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
         '{f}' peers 列出同 APP 的其他会话；'{f}' send <会话名> <消息> 给对方发协作消息（对方运行中会排队到它本轮结束）。\
         和同 APP 的会话改同一个文件前先用 send 协调。",
        f = flowctl
    );
    s
}

/// 启动（或续接）会话进程。已在运行则直接返回。
fn spawn(id: &str) -> Result<(), String> {
    let h = hub()?;
    let meta = {
        let map = h.entries.lock().unwrap();
        let e = map.get(id).ok_or("会话不存在")?;
        if e.proc.is_some() {
            return Ok(());
        }
        e.meta.clone()
    };
    if !Path::new(&meta.cwd).is_dir() {
        return Err(format!("工作目录不存在：{}", meta.cwd));
    }
    let flowctl = flowctl_path()?;
    let settings = hooks_file(&flowctl)?;
    let mut cmd = match find_claude()? {
        Exe::Direct(p) => CommandBuilder::new(p),
        Exe::Cmd(p) => {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(["/d", "/c"]);
            c.arg(p);
            c
        }
    };
    if meta.started && transcript_exists(&meta.id) {
        cmd.args(["--resume", &meta.id]);
    } else {
        cmd.args(["--session-id", &meta.id]);
    }
    cmd.args(["-n", &meta.title]);
    cmd.arg("--settings");
    cmd.arg(&settings);
    cmd.arg("--append-system-prompt");
    cmd.arg(system_prompt(&meta, &flowctl));
    cmd.cwd(&meta.cwd);
    // 从另一个 Claude Code 会话（含 Claude Desktop）里启动 App 时，会继承宿主注入的变量，子 CLI 会按宿主托管认证、
    // 以子会话身份运行而登录失败。检测到 CLAUDECODE 时去掉这批宿主变量；用户自己配置的 Git Bash 路径保留。
    if std::env::var_os("CLAUDECODE").is_some() {
        for (k, _) in std::env::vars_os() {
            let k = k.to_string_lossy().into_owned();
            let host = k == "CLAUDECODE" || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT" || k.starts_with("CLAUDE_CODE_") || k.starts_with("CLAUDE_AGENT_SDK_");
            if host && k != "CLAUDE_CODE_GIT_BASH_PATH" {
                cmd.env_remove(&k);
            }
        }
    }
    cmd.env("FLOW_AGENT_ID", &meta.id);
    cmd.env("FLOW_AGENT_PORT", h.port.to_string());
    cmd.env("FLOW_AGENT_TOKEN", &h.token);
    cmd.env("COLORTERM", "truecolor");

    let pty = portable_pty::native_pty_system()
        .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("创建终端失败: {e}"))?;
    let mut child = pty.slave.spawn_command(cmd).map_err(|e| format!("启动 Claude Code 失败: {e}"))?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let gen = {
        let mut map = h.entries.lock().unwrap();
        let e = map.get_mut(id).ok_or("会话不存在")?;
        e.proc = Some(Proc { master: pty.master, writer, killer });
        e.gen += 1;
        e.stopping = false;
        e.meta.started = true;
        e.buf.clear();
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
        e.queue.clear();
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
            let _ = write_proc(e, &text);
        }
        std::thread::sleep(Duration::from_millis(250));
        if let Some(e) = h.entries.lock().unwrap().get_mut(&id) {
            let _ = write_proc(e, "\r");
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
            on_hook(&id, req["event"].as_str().unwrap_or(""), &req["payload"]);
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
    };
    e.acts.push_back(a.clone());
    while e.acts.len() > ACTS_MAX {
        e.acts.pop_front();
    }
    e.live.beat = t;
    a
}

/// 切换状态（相同状态不改 since）。
fn set_status(e: &mut Entry, st: &str) {
    if e.live.status != st {
        e.live.status = st.into();
        e.live.since = now();
    }
}

/// 处理一次 hook 回报，更新状态与活动并广播。
fn on_hook(id: &str, event: &str, p: &Value) {
    let Ok(h) = hub() else { return };
    let mut map = h.entries.lock().unwrap();
    let Some(e) = map.get_mut(id) else { return };
    let t = now();
    let mut act = None;
    match event {
        "SessionStart" => {
            if e.live.status == "boot" {
                set_status(e, "idle");
            }
            e.live.beat = t;
        }
        "UserPromptSubmit" => {
            set_status(e, "run");
            e.live.turn = t;
            e.live.wait_text.clear();
            act = Some(push_act(e, "prompt", cut(p["prompt"].as_str().unwrap_or(""), 60), String::new()));
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
        "PreCompact" => act = Some(push_act(e, "compact", "压缩上下文".into(), String::new())),
        "SessionEnd" => e.live.beat = t,
        _ => return,
    }
    if let Some(a) = act {
        emit_act(id, &a);
    }
    emit_update(e);
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

/// flowctl focus：标记会话当前处理的节点（`--clear` 清除）。节点必须存在于该图。
fn focus(id: &str, r: &str, cwd: &str) -> Result<Value, String> {
    let h = hub()?;
    let mut map = h.entries.lock().unwrap();
    let e = map.get_mut(id).ok_or("会话不存在")?;
    if r == "--clear" {
        e.live.focus = None;
        emit_update(e);
        return Ok(json!({ "focus": null }));
    }
    let (file, node) = r.rsplit_once('#').ok_or("格式应为 <图文件>#<节点id>")?;
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
    let b = push_act(e, "msg", cut(&format!("来自「{from}」：{text}"), 80), String::new());
    emit_act(&target, &b);
    emit_update(e);
    let a = push_act(map.get_mut(id).unwrap(), "msg", cut(&format!("发给「{to_title}」：{text}"), 80), String::new());
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

/// 全部会话（含最近活动），按创建时间排序。
#[tauri::command]
pub fn agent_list() -> Result<Vec<Value>, String> {
    let map = hub()?.entries.lock().unwrap();
    let mut list: Vec<&Entry> = map.values().collect();
    list.sort_by_key(|e| e.meta.created);
    Ok(list.into_iter().map(|e| view(e, true)).collect())
}

/// 新建会话并立即启动。title 为空时叫「新会话」；cwd 必须存在。
#[tauri::command]
pub fn agent_create(title: String, cwd: String, app: String, feat: String, feat_code: String, links: Vec<NodeRef>, pinned: bool) -> Result<Value, String> {
    if !Path::new(&cwd).is_dir() {
        return Err(format!("目录不存在：{cwd}"));
    }
    let h = hub()?;
    let id = new_uuid();
    let t = now();
    let title = if title.trim().is_empty() { "新会话".to_string() } else { title.trim().to_string() };
    let meta = Meta { id: id.clone(), title, cwd, app, feat, feat_code, links, pinned, pin_at: if pinned { t } else { 0 }, created: t, started: false };
    {
        let mut map = h.entries.lock().unwrap();
        map.insert(id.clone(), Entry { meta, live: idle_live(), acts: VecDeque::new(), queue: VecDeque::new(), proc: None, buf: String::new(), seq: 0, gen: 0, stopping: false });
        save_metas(&map)?;
    }
    spawn(&id)?;
    let map = h.entries.lock().unwrap();
    Ok(view(&map[&id], true))
}

/// 启动或续接已有会话。
#[tauri::command]
pub fn agent_start(id: String) -> Result<(), String> {
    spawn(&id)
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

/// 键盘输入写入终端。
#[tauri::command]
pub fn agent_write(id: String, data: String) -> Result<(), String> {
    let mut map = hub()?.entries.lock().unwrap();
    write_proc(map.get_mut(&id).ok_or("会话不存在")?, &data)
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

/// 当前保留的终端输出与序号（页签打开时回放，之后只接序号更大的输出）。
#[tauri::command]
pub fn agent_buffer(id: String) -> Result<Value, String> {
    let map = hub()?.entries.lock().unwrap();
    let e = map.get(&id).ok_or("会话不存在")?;
    Ok(json!({ "data": e.buf, "seq": e.seq }))
}

/// 修改会话：名称、置顶、关联 Feat 与节点（patch 中出现的字段才改）。
#[tauri::command]
pub fn agent_update(id: String, patch: Value) -> Result<Value, String> {
    let mut map = hub()?.entries.lock().unwrap();
    let e = map.get_mut(&id).ok_or("会话不存在")?;
    if let Some(t) = patch["title"].as_str() {
        if !t.trim().is_empty() {
            e.meta.title = t.trim().to_string();
        }
    }
    if let Some(p) = patch["pinned"].as_bool() {
        e.meta.pinned = p;
        e.meta.pin_at = if p { now() } else { 0 };
    }
    if let Some(f) = patch["feat"].as_str() {
        e.meta.feat = f.to_string();
        e.meta.feat_code = patch["feat_code"].as_str().unwrap_or("").to_string();
    }
    if patch.get("links").is_some() {
        e.meta.links = serde_json::from_value(patch["links"].clone()).map_err(|e| e.to_string())?;
    }
    let v = view(e, false);
    emit_update(e);
    save_metas(&map)?;
    Ok(v)
}

/// 从列表移除会话（运行中先结束进程）；Claude Code 的对话记录保留在它自己的目录。
#[tauri::command]
pub fn agent_remove(id: String) -> Result<(), String> {
    let mut map = hub()?.entries.lock().unwrap();
    if let Some(mut e) = map.remove(&id) {
        if let Some(p) = e.proc.as_mut() {
            let _ = p.killer.kill();
        }
    }
    save_metas(&map)?;
    if let Some(app) = APP.get() {
        let _ = app.emit("agent-removed", json!({ "id": id }));
    }
    Ok(())
}

/// 打开（或置前）Agent 窗口；focus 为要切到的会话 id。
/// 窗口位置、尺寸记在 `<数据目录>/agent/window.json`，副屏上的位置下次照旧。
/// Windows 的 WebView2 创建必须离开同步 IPC 线程，所以是 async 命令。
#[tauri::command]
pub async fn open_agent_window(app: AppHandle, focus: Option<String>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(id) = focus {
            let _ = app.emit_to(LABEL, "agent-focus", json!({ "id": id }));
        }
        return Ok(());
    }
    let q = focus.map(|f| format!("?focus={f}")).unwrap_or_default();
    let w = tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App(format!("agent.html{q}").into()))
        .title("Agent - Flow Coding")
        .inner_size(1500.0, 940.0)
        .min_inner_size(820.0, 520.0)
        .visible(false)
        .build()
        .map_err(|e| format!("打开 Agent 窗口失败: {e}"))?;
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
            if g.max {
                let _ = w.maximize();
            }
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

/// Agent 窗口事件：移动 / 改尺寸时记下几何信息（最小化、最大化时只记最大化标志），销毁时写盘。
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            if window.is_minimized().unwrap_or(false) {
                return;
            }
            let max = window.is_maximized().unwrap_or(false);
            let mut g = GEOM.lock().unwrap();
            if max {
                if let Some(g) = g.as_mut() {
                    g.max = true;
                }
                return;
            }
            if let (Ok(p), Ok(s)) = (window.outer_position(), window.inner_size()) {
                *g = Some(Geom { x: p.x, y: p.y, w: s.width, h: s.height, max: false });
            }
        }
        tauri::WindowEvent::Destroyed => {
            if let (Some(g), Ok(d)) = (*GEOM.lock().unwrap(), dir()) {
                let _ = crate::write_atomic(&d.join("window.json"), &serde_json::to_string(&g).unwrap());
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// 真实联调（需要已登录的 Claude Code，会消耗少量额度，默认不跑）：
    /// FLOW_CTL=<target/debug/flowctl.exe> FLOW_AGENT_TEST_CWD=<含 docs/flow/条件组管理.drawio 的 APP 目录> cargo test live_session -- --ignored --nocapture
    /// 覆盖：ConPTY 启动 TUI → 提交提示 → hooks 回报 run → Bash 权限确认 wait → 批准 → flowctl focus 定位节点 → Stop 回到 idle → 结束进程。
    #[test]
    #[ignore]
    fn live_session() {
        crate::paths::test_home();
        start_hub();
        let cwd = std::env::var("FLOW_AGENT_TEST_CWD").expect("需要 FLOW_AGENT_TEST_CWD");
        let v = agent_create("联调".into(), cwd, "app_mes_tool".into(), String::new(), String::new(), Vec::new(), false).unwrap();
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

