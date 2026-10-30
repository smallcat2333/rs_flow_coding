//! rs_flow_coding 库：Tauri App 与 flowctl CLI 共用的流程图解析、加锁、历史与扫描能力，
//! 以及 App 的 Tauri 命令与文件监听。

pub mod db;
pub mod flow;
pub mod lock;
pub mod paths;
pub mod scan;

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
}

/// 一个 APP 的汇总：分组、APP 名、流程图目录、各图信息、APP 合计计数。
#[derive(Debug, Clone, Serialize)]
pub struct AppEntry {
    pub group: String,
    pub app: String,
    pub root: String,
    pub flow_dir: String,
    pub files: Vec<FileEntry>,
    pub counts: flow::Counts,
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
            FileEntry { path: path.to_string_lossy().into_owned(), name, counts: flow::count(&nodes), lock, error }
        }
        Err(e) => FileEntry { path: path.to_string_lossy().into_owned(), name, counts: flow::empty_counts(), lock, error: Some(e) },
    }
}

/// 把若干 flow 目录汇总成 APP 列表（按分组、APP 排序）。
fn build_apps(dirs: &[scan::FlowDir]) -> Result<Vec<AppEntry>, String> {
    let mut conn = db::open()?;
    let mut apps = Vec::with_capacity(dirs.len());
    for d in dirs {
        let files: Vec<FileEntry> = scan::list_drawio(Path::new(&d.flow_dir))
            .iter()
            .map(|p| file_entry(&mut conn, p, "scan"))
            .collect();
        let mut counts = flow::empty_counts();
        for f in &files {
            for (k, v) in &f.counts {
                *counts.get_mut(k).unwrap() += v;
            }
        }
        apps.push(AppEntry { group: d.group.clone(), app: d.app.clone(), root: d.root.clone(), flow_dir: d.flow_dir.clone(), files, counts });
    }
    Ok(apps)
}

/// 由缓存的 flow 目录列表还原 FlowDir（不遍历项目，启动快）。
fn cached_dirs(cfg: &scan::Config) -> Vec<scan::FlowDir> {
    cfg.flow_dirs
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
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

/// 按 flow 目录集合重建文件监听；目录集合未变化时不重建。
fn rewatch(app: &tauri::AppHandle, dirs: &[scan::FlowDir]) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut want: Vec<PathBuf> = dirs.iter().map(|d| PathBuf::from(&d.flow_dir)).collect();
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
            if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("drawio")) {
                on_file_event(&handle, &p);
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

/// 处理单个流程图文件事件：入库快照并通知前端。
/// 来源判定：文件当前被 agent 加锁 → agent，否则 external（App 自身写入在保存时已入库，此处哈希去重）。
/// 文件被删除或正在写入导致解析失败时，仍通知前端刷新列表。
fn on_file_event(app: &tauri::AppHandle, path: &Path) {
    let source = match lock::read(path).ok().flatten() {
        Some(l) if l.owner == "agent" => "agent",
        _ => "external",
    };
    let mut hash = String::new();
    if let Ok(xml) = std::fs::read_to_string(path) {
        hash = db::hash(&xml);
        if let Ok(mut conn) = db::open() {
            let _ = db::record(&mut conn, path, &scan::app_label(path), &xml, source);
        }
    }
    let _ = app.emit("flow-changed", ChangeEvent { path: path.to_string_lossy().into_owned(), hash, source: source.into() });
}

/// 原子写文件：先写同目录临时文件再替换，避免监听方读到半截内容。
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("drawio.tmp");
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
fn set_roots(roots: Vec<String>) -> Result<scan::Config, String> {
    let mut cfg = scan::load_config()?;
    cfg.roots = roots
        .iter()
        .filter(|r| !r.trim().is_empty())
        .map(|r| paths::norm(Path::new(r.trim())).map(|p| p.to_string_lossy().into_owned()))
        .collect::<Result<_, _>>()?;
    cfg.flow_dirs.retain(|f| cfg.roots.iter().any(|r| paths::key(Path::new(f)).starts_with(&paths::key(Path::new(r)))));
    scan::save_config(&cfg)?;
    Ok(cfg)
}

/// 汇总全部 APP。`full=true` 时遍历项目根重新发现 flow 目录并更新缓存；否则用缓存目录（启动快）。
/// 缓存为空时自动做一次全量扫描。完成后按目录集合重建文件监听。
#[tauri::command]
async fn summary(app: tauri::AppHandle, full: bool) -> Result<Vec<AppEntry>, String> {
    let dirs = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<scan::FlowDir>, String> {
        let mut cfg = scan::load_config()?;
        if full || cfg.flow_dirs.is_empty() {
            let dirs: Vec<scan::FlowDir> = cfg.roots.iter().flat_map(|r| scan::scan_root(Path::new(r))).collect();
            cfg.flow_dirs = dirs.iter().map(|d| d.flow_dir.clone()).collect();
            scan::save_config(&cfg)?;
            Ok(dirs)
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
    let mut cfg = scan::load_config()?;
    let dk = paths::key(&paths::norm(&d)?);
    if !cfg.flow_dirs.iter().any(|x| paths::key(Path::new(x)) == dk) {
        cfg.flow_dirs.push(paths::norm(&d)?.to_string_lossy().into_owned());
        scan::save_config(&cfg)?;
    }
    Ok(f.to_string_lossy().into_owned())
}

/// 启动 Tauri App。
pub fn run() {
    tauri::Builder::default()
        .manage(AppState { watcher: Mutex::new(None), watched: Mutex::new(Vec::new()) })
        .invoke_handler(tauri::generate_handler![
            get_config, set_roots, summary, read_diagram, save_diagram, release_lock,
            lock_status, history, diff, snapshot_xml, restore, create_diagram
        ])
        .on_window_event(|window, event| {
            // 窗口关闭时释放本 App 持有的全部用户锁
            if let tauri::WindowEvent::Destroyed = event {
                let _ = window;
                release_all_user_locks();
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 rs_flow_coding 失败");
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
