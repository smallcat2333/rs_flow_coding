//! flow_coding 库：Tauri App 与 flowctl CLI 共用的流程图解析、加锁、历史与扫描能力，
//! 以及 App 的 Tauri 命令与文件监听。

pub mod agent;
pub mod db;
pub mod feat;
pub mod float;
pub mod flow;
pub mod links;
pub mod lock;
pub mod lifecycle;
pub mod maintenance;
pub mod paths;
pub mod progress;
pub mod scan;
pub mod rename;
mod window_state;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{Emitter, Manager};

/// 单张流程图的展示信息：路径、文件名、状态计数、当前锁（无锁为 None）、解析错误。
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub counts: flow::Counts,
    pub lock: Option<lock::LockInfo>,
    pub error: Option<String>,
    /// 启停来自项目元数据；历史与原图始终保留。
    pub enabled: bool,
    pub disabled_at: String,
}

/// 一个 APP 的汇总：分组、APP 名、流程图目录、Feat 目录、各图信息、Feat 列表、APP 合计计数。
#[derive(Debug, Clone, Serialize)]
pub struct AppEntry {
    pub group: String,
    pub app: String,
    pub root: String,
    pub flow_dir: String,
    pub feat_dir: String,
    pub files: Vec<FileEntry>,
    pub feats: Vec<feat::FeatEntry>,
    pub counts: flow::Counts,
}

/// 读 Markdown 返回：内容与哈希。
#[derive(Debug, Clone, Serialize)]
pub struct MdDoc {
    pub path: String,
    pub text: String,
    pub hash: String,
}

/// 读图返回：XML 内容与哈希（前端用哈希识别自己写入引起的变更通知）。
#[derive(Debug, Clone, Serialize)]
pub struct Diagram {
    pub path: String,
    pub xml: String,
    pub hash: String,
}

/// 文件变化通知负载：路径、新哈希、来源（agent/external）。
#[derive(Debug, Clone, Serialize)]
pub struct ChangeEvent {
    pub path: String,
    pub hash: String,
    pub source: String,
}

/// App 运行状态：文件监听器（随 flow 目录集合重建）、当前监听的目录集合。
struct AppState {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    watched: Mutex<Vec<PathBuf>>,
}

/// 读取并统计单张图；同时把当前内容记入历史（内容未变则不新增快照）。
/// 解析失败时计数为空、error 写原因，不中断整体汇总。
pub fn file_entry(conn: &mut rusqlite::Connection, path: &Path, source: &str) -> FileEntry {
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let lock = lock::read(path).ok().flatten();
    let parsed = std::fs::read_to_string(path)
        .map_err(|e| format!("读取失败: {e}"))
        .and_then(|xml| flow::parse(&xml).map(|n| (xml, n)));
    match parsed {
        Ok((xml, nodes)) => {
            let error = db::record(conn, path, &scan::app_label(path), &xml, source).err();
            FileEntry { enabled: true, disabled_at: String::new(), path: path.to_string_lossy().into_owned(), name, counts: flow::count(&nodes), lock, error }
        }
        Err(e) => FileEntry { enabled: true, disabled_at: String::new(), path: path.to_string_lossy().into_owned(), name, counts: flow::empty_counts(), lock, error: Some(e) },
    }
}

/// 把若干 APP 目录汇总成 APP 列表（按分组、APP 排序）：流程图计数 + Feat 摘要（按标签统计节点）。
fn build_apps(dirs: &[scan::FlowDir]) -> Result<Vec<AppEntry>, String> {
    let mut conn = db::open()?;
    let mut apps = Vec::with_capacity(dirs.len());
    for d in dirs {
        let paths_ = scan::list_drawio(Path::new(&d.flow_dir));
        let states = lifecycle::chart_states(Path::new(&d.flow_dir))?;
        let files: Vec<FileEntry> = paths_.iter().map(|p| {
            let mut file = file_entry(&mut conn, p, "scan");
            if let Some(state) = states.charts.get(&file.name) {
                file.enabled = false;
                file.disabled_at = state.disabled_at.clone();
            }
            file
        }).collect();
        let mut counts = flow::empty_counts();
        for f in files.iter().filter(|f| f.enabled) {
            for (k, v) in &f.counts {
                *counts.get_mut(k).unwrap() += v;
            }
        }
        let feat_dir = feat::feat_dir_of(Path::new(&d.flow_dir));
        let feats = feat::summarize(&feat_dir, &feat::collect_nodes(&paths_));
        apps.push(AppEntry {
            group: d.group.clone(),
            app: d.app.clone(),
            root: d.root.clone(),
            flow_dir: d.flow_dir.clone(),
            feat_dir: feat_dir.to_string_lossy().into_owned(),
            files,
            feats,
            counts,
        });
    }
    Ok(apps)
}

/// 由缓存的 flow 目录列表还原 FlowDir（不遍历项目，启动快）。flow 目录可不存在，只要 `docs` 存在即保留。
fn cached_dirs(cfg: &scan::Config) -> Vec<scan::FlowDir> {
    cfg.flow_dirs
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.parent().is_some_and(Path::is_dir) && !cfg.excludes(p))
        .filter_map(|flow| {
            let app_dir = flow.parent()?.parent()?.to_path_buf();
            let (group, app) = scan::app_of(&app_dir);
            let root = cfg
                .roots
                .iter()
                .find(|r| paths::key(&flow).starts_with(&paths::key(Path::new(r))))
                .cloned()
                .unwrap_or_default();
            Some(scan::FlowDir {
                root,
                group,
                app,
                app_dir: app_dir.to_string_lossy().into_owned(),
                flow_dir: flow.to_string_lossy().into_owned(),
                files: Vec::new(),
            })
        })
        .collect()
}

/// 按 APP 的 flow / feat 目录集合重建文件监听；集合未变化时不重建，不存在的目录跳过。
fn rewatch(app: &tauri::AppHandle, dirs: &[scan::FlowDir]) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut want: Vec<PathBuf> = dirs
        .iter()
        .flat_map(|d| [PathBuf::from(&d.flow_dir), feat::feat_dir_of(Path::new(&d.flow_dir))])
        .filter(|p| p.is_dir())
        .collect();
    want.sort();
    if *state.watched.lock().unwrap() == want && state.watcher.lock().unwrap().is_some() {
        return Ok(());
    }
    let handle = app.clone();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if matches!(ev.kind, notify::EventKind::Access(_)) {
            return;
        }
        for p in ev.paths {
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if p.file_name().is_some_and(|n| n == ".flow-coding.json") {
                let _ = handle.emit("catalog-changed", ());
            } else if ext == "drawio" {
                on_file_event(&handle, &p);
            } else if ext == "md" {
                on_md_event(&handle, &p);
            }
        }
    })
    .map_err(|e| format!("创建文件监听失败: {e}"))?;
    for d in &want {
        w.watch(d, RecursiveMode::NonRecursive).map_err(|e| format!("监听 {} 失败: {e}", d.display()))?;
    }
    *state.watcher.lock().unwrap() = Some(w);
    *state.watched.lock().unwrap() = want;
    Ok(())
}

/// 文件事件来源：按当前锁持有者判定。App 自身写盘时持用户锁 → user；Agent 锁 → agent；无锁 → external。
/// 前端据此只对 Agent / 外部改动做侧栏自动置顶。
fn event_source(path: &Path) -> &'static str {
    match lock::read(path).ok().flatten() {
        Some(l) if l.owner == "agent" => "agent",
        Some(l) if l.owner == "user" => "user",
        _ => "external",
    }
}

/// 处理单个流程图文件事件：入库快照并通知前端。
/// 来源见 `event_source`（App 自身写入在保存时已入库，此处哈希去重）。
/// 文件被删除或正在写入导致解析失败时，仍通知前端刷新列表。
fn on_file_event(app: &tauri::AppHandle, path: &Path) {
    let source = event_source(path);
    let mut hash = String::new();
    if let Ok(xml) = std::fs::read_to_string(path) {
        hash = db::hash(&xml);
        if let Ok(mut conn) = db::open() {
            let _ = db::record(&mut conn, path, &scan::app_label(path), &xml, source);
        }
    }
    let _ = app.emit("flow-changed", ChangeEvent { path: path.to_string_lossy().into_owned(), hash, source: source.into() });
}

/// 处理 Feat 档案变化：只通知前端（Markdown 不入历史库）。来源判定同流程图。
fn on_md_event(app: &tauri::AppHandle, path: &Path) {
    let source = event_source(path);
    let hash = std::fs::read_to_string(path).map(|t| db::hash(&t)).unwrap_or_default();
    let _ = app.emit("md-changed", ChangeEvent { path: path.to_string_lossy().into_owned(), hash, source: source.into() });
}

/// 原子写文件：先写同目录临时文件再替换，避免监听方读到半截内容。
/// 临时文件扩展名为 `.fctmp`，不会被 .drawio / .md 监听误判。
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".fctmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text).map_err(|e| format!("写临时文件失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换文件失败: {e}"))
}

// ---------------- Tauri 命令 ----------------

/// 读取配置（项目根与缓存的 flow 目录）。
#[tauri::command]
fn get_config() -> Result<scan::Config, String> {
    scan::load_config()
}

/// 设置项目根目录列表（规范化后保存）；不存在的目录报错。
#[tauri::command]
fn set_roots(roots: Vec<String>, excluded_dirs: Option<Vec<String>>) -> Result<scan::Config, String> {
    let roots: Vec<String> = roots
        .iter()
        .filter(|r| !r.trim().is_empty())
        .map(|r| paths::norm(Path::new(r.trim())).map(|p| p.to_string_lossy().into_owned()))
        .collect::<Result<_, _>>()?;
    let excluded = excluded_dirs.map(|dirs| dirs.iter()
        .filter(|d| !d.trim().is_empty())
        .map(|d| paths::norm(Path::new(d.trim())).map(|p| p.to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()).transpose()?;
    if let Some(dirs) = &excluded {
        for dir in dirs {
            if !roots.iter().any(|r| scan::within(Path::new(dir), Path::new(r))) {
                return Err(format!("排除路径必须位于增加路径内：{dir}"));
            }
        }
    }
    scan::update_config(|cfg| {
        cfg.roots = roots;
        if let Some(dirs) = excluded { cfg.excluded_dirs = dirs; }
        cfg.excluded_dirs.retain(|d| cfg.roots.iter().any(|r| scan::within(Path::new(d), Path::new(r))));
        let exclusions = cfg.excluded_dirs.clone();
        cfg.flow_dirs.retain(|f| cfg.roots.iter().any(|r| scan::within(Path::new(f), Path::new(r)))
            && !exclusions.iter().any(|d| scan::within(Path::new(f), Path::new(d))));
    })
}

/// 仅从本机扫描列表移除目录；不删除项目文件。
#[tauri::command]
fn remove_directory(path: String) -> Result<scan::Config, String> {
    let directory = paths::norm(Path::new(&path))?;
    if !directory.is_dir() { return Err("请选择目录".into()); }
    scan::update_config(|cfg| {
        if !cfg.excludes(&directory) {
            cfg.excluded_dirs.retain(|d| !scan::within(Path::new(d), &directory));
            cfg.excluded_dirs.push(directory.to_string_lossy().into_owned());
        }
        let excluded = cfg.excluded_dirs.clone();
        cfg.flow_dirs.retain(|f| !excluded.iter().any(|d| scan::within(Path::new(f), Path::new(d))));
    })
}

/// 汇总全部 APP。`full=true` 时遍历项目根重新发现 flow 目录并更新缓存；否则用缓存目录（启动快）。
/// 缓存为空时自动做一次全量扫描。完成后按目录集合重建文件监听。
#[tauri::command]
async fn summary(app: tauri::AppHandle, full: bool) -> Result<Vec<AppEntry>, String> {
    let dirs = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<scan::FlowDir>, String> {
        let cfg = scan::load_config()?;
        if full || cfg.flow_dirs.is_empty() {
            let dirs: Vec<scan::FlowDir> = cfg.roots.iter().flat_map(|r| scan::scan_root(Path::new(r))).collect();
            let latest = scan::update_config(|latest| {
                latest.flow_dirs = dirs.iter().filter(|d| !latest.excludes(Path::new(&d.app_dir))).map(|d| d.flow_dir.clone()).collect();
            })?;
            Ok(dirs.into_iter().filter(|d| !latest.excludes(Path::new(&d.app_dir))).collect())
        } else {
            Ok(cached_dirs(&cfg))
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    rewatch(&app, &dirs)?;
    let apps = tauri::async_runtime::spawn_blocking(move || build_apps(&dirs)).await.map_err(|e| e.to_string())??;
    Ok(apps)
}

/// 读取一张图的 XML 与哈希。
#[tauri::command]
fn read_diagram(path: String) -> Result<Diagram, String> {
    let xml = std::fs::read_to_string(&path).map_err(|e| format!("读取 {path} 失败: {e}"))?;
    Ok(Diagram { hash: db::hash(&xml), path, xml })
}

/// 用户保存：加/刷新用户锁 → 原子写盘 → 记快照（source=user）。
/// Agent 持锁时拒绝，返回「Agent 正在编辑」错误，前端据此转只读。返回新哈希。
#[tauri::command]
fn save_diagram(path: String, xml: String) -> Result<String, String> {
    flow::parse(&xml)?;
    let p = PathBuf::from(&path);
    if let Err(holder) = lock::acquire(&p, "user", lock::USER_TTL)? {
        return Err(format!("LOCKED:{} 正在编辑（pid {}）", holder.owner, holder.pid));
    }
    write_atomic(&p, &xml)?;
    let mut conn = db::open()?;
    db::record(&mut conn, &p, &scan::app_label(&p), &xml, "user")?;
    Ok(db::hash(&xml))
}

/// 释放用户锁（空闲后由前端调用）。
#[tauri::command]
fn release_lock(path: String) -> Result<bool, String> {
    lock::release(Path::new(&path), "user")
}

/// 查询当前锁（失效视为无锁）。
#[tauri::command]
fn lock_status(path: String) -> Result<Option<lock::LockInfo>, String> {
    lock::read(Path::new(&path))
}

/// 历史快照列表（新→旧）。
#[tauri::command]
fn history(path: String) -> Result<Vec<db::SnapshotInfo>, String> {
    db::list(&db::open()?, Path::new(&path))
}

/// 两个快照的节点差异（old → new）。
#[tauri::command]
fn diff(old: i64, new: i64) -> Result<Vec<db::NodeChange>, String> {
    db::diff(&db::open()?, old, new)
}

/// 取快照 XML（前端用于只读查看旧版本）。
#[tauri::command]
fn snapshot_xml(id: i64) -> Result<String, String> {
    db::xml_of(&db::open()?, id)
}

/// 回滚到某快照：按用户保存流程写盘（需能拿到用户锁），快照来源记 restore。
#[tauri::command]
fn restore(path: String, id: i64) -> Result<String, String> {
    let conn = db::open()?;
    let xml = db::xml_of(&conn, id)?;
    drop(conn);
    let p = PathBuf::from(&path);
    if let Err(holder) = lock::acquire(&p, "user", lock::USER_TTL)? {
        return Err(format!("LOCKED:{} 正在编辑", holder.owner));
    }
    write_atomic(&p, &xml)?;
    let mut conn = db::open()?;
    db::record(&mut conn, &p, &scan::app_label(&p), &xml, "restore")?;
    lock::release(&p, "user")?;
    Ok(db::hash(&xml))
}

/// 在指定目录新建空白流程图；目录不存在则创建，同名文件已存在报错。返回新文件路径。
/// 新目录不在缓存里时加入缓存，下次汇总即可出现。
#[tauri::command]
fn create_diagram(dir: String, name: String) -> Result<String, String> {
    let name = name.trim().trim_end_matches(".drawio").to_string();
    if name.is_empty() || name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(format!("文件名不合法: {name}"));
    }
    let d = PathBuf::from(&dir);
    std::fs::create_dir_all(&d).map_err(|e| format!("创建目录失败: {e}"))?;
    let f = d.join(format!("{name}.drawio"));
    if f.exists() {
        return Err(format!("文件已存在: {}", f.display()));
    }
    let xml = flow::blank_diagram(&name);
    write_atomic(&f, &xml)?;
    let mut conn = db::open()?;
    db::record(&mut conn, &f, &scan::app_label(&f), &xml, "user")?;
    let dir = paths::norm(&d)?;
    let dk = paths::key(&dir);
    scan::update_config(|cfg| {
        if !cfg.flow_dirs.iter().any(|x| paths::key(Path::new(x)) == dk) {
            cfg.flow_dirs.push(dir.to_string_lossy().into_owned());
        }
    })?;
    Ok(f.to_string_lossy().into_owned())
}

/// 读取 Feat 档案 Markdown 与哈希。
#[tauri::command]
fn read_md(path: String) -> Result<MdDoc, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取 {path} 失败: {e}"))?;
    Ok(MdDoc { hash: db::hash(&text), path, text })
}

/// 保存 Feat 档案：与流程图同口径加用户锁后原子写盘；Agent 持锁时返回 LOCKED 错误。返回新哈希。
#[tauri::command]
fn save_md(path: String, text: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if let Err(holder) = lock::acquire(&p, "user", lock::USER_TTL)? {
        return Err(format!("LOCKED:{} 正在编辑（pid {}）", holder.owner, holder.pid));
    }
    write_atomic(&p, &text)?;
    Ok(db::hash(&text))
}

/// 列出挂了某标签的节点（跨该 APP 全部流程图）。
#[tauri::command]
fn tagged_nodes(flow_dir: String, tag: String) -> Result<Vec<feat::TaggedNode>, String> {
    let files = scan::list_drawio(Path::new(&flow_dir));
    Ok(feat::tagged(&feat::collect_nodes(&files), &tag))
}

/// 推进矩阵数据：解析该 APP 全部 Feat 档案的阶段、T 与子 T（`docs/flow` 同级的 `docs/feat`）。
#[tauri::command]
fn feat_progress(flow_dir: String) -> Vec<progress::Progress> {
    progress::of_dir(&feat::feat_dir_of(Path::new(&flow_dir)))
}

/// 新建 Feat 档案：编号按今天日期 + 当天最大序号 +1，内容为最小骨架（完整模板由 /smallcat-feat-1-new 生成）。
/// 返回新文件路径。标题不能含文件名非法字符。
#[tauri::command]
fn create_feat(dir: String, title: String) -> Result<String, String> {
    let title = title.trim().to_string();
    if title.is_empty() || title.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(format!("标题不合法: {title}"));
    }
    let d = PathBuf::from(&dir);
    std::fs::create_dir_all(&d).map_err(|e| format!("创建目录失败: {e}"))?;
    let day = chrono::Local::now().format("%y%m%d").to_string();
    let prefix = format!("Feat_{day}_");
    let n = feat::list_feats(&d)
        .iter()
        .filter_map(|p| feat::id_from_name(p).strip_prefix(&prefix).and_then(|s| s.parse::<u32>().ok()))
        .max()
        .unwrap_or(0)
        + 1;
    let id = format!("{prefix}{n}");
    let f = d.join(format!("{id}_{title}.md"));
    let today = chrono::Local::now().format("%Y-%m-%d");
    let app = d.parent().and_then(Path::parent).and_then(|a| a.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let text = format!(
        "# {id} {title}\n\n> 状态：需求整理中\n> 应用：{app}\n> 创建：{today}　　关闭：-\n\n## 1. 需求\n\n### 1.1 背景\n\n### 1.2 目标\n\n### 1.3 验收标准\n- [ ] \n\n### 1.4 初步路线\n\n**影响的流程图**：无\n\n## 2. 原型\n\n## 3. 开发任务\n\n### 3.1 任务路线图\n\n### 3.2 开发记录\n\n## 4. 测试记录\n\n## 5. 发布说明\n"
    );
    write_atomic(&f, &text)?;
    Ok(f.to_string_lossy().into_owned())
}

/// 解析图间链接：前端在桥接层捕获 draw.io 节点链接点击后调用。
/// 校验目标 .drawio 存在、且 `#` 指定的节点为目标图中的顶点（含泳道等导航目标）。
/// 非本地链接（http/data/file 等 scheme）与非 .drawio 目标报错；返回路径与节点 id。
#[tauri::command]
fn resolve_flow_link(source: String, link: String) -> Result<links::ResolvedLink, String> {
    let src = paths::norm(Path::new(&source))?;
    links::resolve(&src, &link)
}

/// 把流程图栏或 Feat 栏弹到独立窗口（每种最多一个，标签 `pop-flow` / `pop-feat`）。
/// 输入：kind = "flow" | "feat"；path = 要打开的文件；node = 打开后定位的节点 id（可空）；
/// line = Feat 档案打开后定位的源文件行号（可空，推进矩阵使用）。
/// 窗口已存在：改标题、置前，并发 `popout-open` 事件让该窗口切换文件；不存在：以
/// `index.html?solo=<kind>&path=..&node=..` 新建，前端按 solo 参数只显示这一栏。
/// Windows 的 WebView2 创建必须离开同步 IPC 处理线程，否则事件循环死锁，窗口白屏且无法关闭。
#[tauri::command]
async fn open_popout(app: tauri::AppHandle, kind: String, path: String, node: Option<String>, line: Option<u32>) -> Result<(), String> {
    if kind != "flow" && kind != "feat" {
        return Err(format!("未知窗口类型: {kind}"));
    }
    let label = format!("pop-{kind}");
    let name = Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let title = format!("{name} - Flow Coding");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_title(&title);
        let _ = w.unminimize();
        let _ = w.set_focus();
        return app
            .emit_to(&label, "popout-open", serde_json::json!({ "kind": kind, "path": path, "node": node, "line": line }))
            .map_err(|e| e.to_string());
    }
    let enc = |s: &str| percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string();
    let url = format!("index.html?solo={kind}&path={}&node={}&line={}", enc(&path), enc(node.as_deref().unwrap_or("")), line.unwrap_or(0));
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1100.0, 820.0)
        .min_inner_size(600.0, 400.0)
        .build()
        .map_err(|e| format!("打开窗口失败: {e}"))?;
    Ok(())
}

/// 启动 Tauri App。
///
/// - 单实例：重复启动时由插件通知已有实例，已有窗口还原并置前，新进程直接退出（不会再去抢 WebView2 数据目录）；
/// - 启动失败：发布版没有控制台，panic 信息改用系统消息框显示，不再静默退出。
pub fn run() {
    std::panic::set_hook(Box::new(|info| alert(&format!("Flow Coding 出错退出：\n\n{info}"))));
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(AppState { watcher: Mutex::new(None), watched: Mutex::new(Vec::new()) })
        .setup(|app| {
            window_state::init(app.handle())?;
            float::init(app.handle());
            agent::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config, set_roots, remove_directory, summary, read_diagram, save_diagram, release_lock,
            lock_status, history, diff, snapshot_xml, restore, create_diagram,
            read_md, save_md, tagged_nodes, feat_progress, create_feat, open_popout, resolve_flow_link,
            rename::rename_entry,
            lifecycle::set_chart_enabled, lifecycle::set_feat_status, lifecycle::save_sidebar,
            maintenance::get_storage_stats, maintenance::clean_database, maintenance::clear_scan_cache,
            float::get_float_enabled, float::set_float_enabled, float::float_activate,
            agent::agent_list, agent::agent_create, agent::agent_start, agent::agent_stop, agent::agent_write,
            agent::agent_resize, agent::agent_buffer, agent::agent_update, agent::agent_remove, agent::open_agent_window
        ])
        .on_window_event(|window, event| {
            if window.label() == agent::LABEL { agent::on_window_event(window, event); }
            if let Err(e) = window_state::on_event(window, event) { eprintln!("保存主窗口状态失败: {e}"); }
            // 悬浮窗：App 窗口焦点变化或弹出窗口关闭后，重新判定 App 是否还在前台
            match event {
                tauri::WindowEvent::Focused(focused) => float::on_focus(window.app_handle(), window.label(), *focused),
                tauri::WindowEvent::Destroyed => float::on_focus(window.app_handle(), window.label(), false),
                _ => {}
            }
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label();
                if label == "main" {
                    // 主窗口关闭即退出：释放本 App 持有的全部用户锁，弹出窗口一并关闭
                    release_all_user_locks();
                    agent::shutdown();
                    window.app_handle().exit(0);
                } else if let Some(kind) = label.strip_prefix("pop-") {
                    // 弹出窗口关闭：通知主窗口恢复该栏的路由（弹出窗口自己的锁已在关闭前由前端释放）
                    let _ = window.app_handle().emit("popout-closed", serde_json::json!({ "kind": kind }));
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 flow_coding 失败");
}

/// 弹出系统错误消息框（Windows 直接调 user32 的 MessageBoxW，不引入额外依赖）；其他平台打印到 stderr。
/// 输入：消息文本；阻塞到用户点「确定」。
fn alert(msg: &str) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(hwnd: *mut std::ffi::c_void, text: *const u16, caption: *const u16, utype: u32) -> i32;
        }
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (text, caption) = (wide(msg), wide("Flow Coding"));
        // MB_OK | MB_ICONERROR = 0x10
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x10) };
    }
    #[cfg(not(windows))]
    eprintln!("{msg}");
}

/// 释放锁目录中 owner=user 且 pid 为本进程的锁。
fn release_all_user_locks() {
    let Ok(dir) = lock::lock_dir() else { return };
    let pid = std::process::id();
    let mut seen = HashMap::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if let Ok(t) = std::fs::read_to_string(e.path()) {
            if let Ok(l) = serde_json::from_str::<lock::LockInfo>(&t) {
                if l.owner == "user" && l.pid == pid {
                    seen.insert(e.path(), ());
                }
            }
        }
    }
    for p in seen.keys() {
        let _ = std::fs::remove_file(p);
    }
}
