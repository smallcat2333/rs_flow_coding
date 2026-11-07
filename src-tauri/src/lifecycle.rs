//! Feat 生命周期与 Chart 启停：状态随项目文件保存，侧栏偏好保存在本机配置。
//! 元数据写入串行化并复用编辑锁；Feat 用内容哈希防止确认期间的外部改动被覆盖。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::{agent, db, feat, lock, scan, write_atomic};

/// 状态变更串行锁，避免多个窗口同时读改写同一份 Chart 元数据。
static STATUS_WRITE: Mutex<()> = Mutex::new(());

/// 停用图记录；启用图不写条目，时间使用带时区的 RFC3339 格式。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartState {
    pub status: String,
    pub disabled_at: String,
}

/// 每个 APP 的 `docs/flow/.flow-coding.json`，键为包含扩展名的图文件名。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ChartStates {
    pub charts: BTreeMap<String, ChartState>,
}

/// 读取项目 Chart 状态；只有文件不存在才视为全部启用，坏 JSON 或未知状态直接报错。
pub fn chart_states(dir: &Path) -> Result<ChartStates, String> {
    let path = dir.join(".flow-coding.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ChartStates::default()),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path.display())),
    };
    let states: ChartStates = serde_json::from_str(&text).map_err(|e| format!("状态文件损坏 {}: {e}", path.display()))?;
    if states.charts.values().any(|s| s.status != "disabled") {
        return Err(format!("状态文件含未知 Chart 状态: {}", path.display()));
    }
    Ok(states)
}

/// 在已取得互斥锁的范围内执行写入，无论成功或失败都释放本次获得的用户锁。
fn write_locked<T>(path: &Path, change: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if let Some(holder) = lock::read(path)? {
        return Err(format!("LOCKED:{} 正在编辑，请停止编辑后重试", holder.owner));
    }
    if let Err(holder) = lock::acquire(path, "user", lock::USER_TTL)? {
        return Err(format!("LOCKED:{} 正在编辑", holder.owner));
    }
    let result = change();
    let released = lock::release(path, "user");
    match result {
        Ok(value) => { released?; Ok(value) }
        Err(error) => { let _ = released; Err(error) }
    }
}

/// 启用/停用一张图；只修改同目录元数据，原图与 Feat 标签不动。图不存在或扩展名不符时报错。
#[tauri::command]
pub fn set_chart_enabled(app: tauri::AppHandle, path: String, enabled: bool) -> Result<(), String> {
    let _guard = STATUS_WRITE.lock().unwrap();
    let path = Path::new(&path);
    if !path.is_file() || !path.extension().is_some_and(|s| s.eq_ignore_ascii_case("drawio")) {
        return Err("流程图不存在或不是 .drawio 文件".into());
    }
    let dir = path.parent().ok_or("流程图缺少父目录")?;
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    let meta = dir.join(".flow-coding.json");
    write_locked(&meta, || {
        let mut states = chart_states(dir)?;
        if enabled { states.charts.remove(&name); }
        else {
            states.charts.entry(name).or_insert_with(|| ChartState {
                status: "disabled".into(), disabled_at: chrono::Local::now().to_rfc3339(),
            });
        }
        write_atomic(&meta, &serde_json::to_string_pretty(&states).map_err(|e| e.to_string())?)
    })?;
    app.emit("catalog-changed", ()).map_err(|e| e.to_string())
}

/// 更新 Feat 状态与关闭日期；只接受开启阶段（关闭/废弃走 skill），校验确认时的哈希，文件被编辑或加锁时拒绝覆盖。
#[tauri::command]
pub fn set_feat_status(app: tauri::AppHandle, path: String, status: String, expected_hash: String) -> Result<(), String> {
    feat::ensure_ui_status(&status)?;
    let _guard = STATUS_WRITE.lock().unwrap();
    let path = Path::new(&path);
    if !path.is_file() || !path.extension().is_some_and(|s| s.eq_ignore_ascii_case("md")) {
        return Err("Feat 档案不存在或不是 Markdown 文件".into());
    }
    let result = write_locked(path, || {
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        if db::hash(&text) != expected_hash { return Err("档案已变化，请刷新后重试".into()); }
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let text = feat::with_status(&text, &status, &date)?;
        write_atomic(path, &text)?;
        app.emit("md-changed", crate::ChangeEvent {
            path: path.to_string_lossy().into_owned(), hash: db::hash(&text), source: "user".into(),
        }).map_err(|e| e.to_string())
    });
    if result.is_ok() {
        // 状态行变化可能改变关联 Agent 会话的自动收纳（已关闭收纳、重开恢复），不依赖文件监听时序。
        agent::source_changed(path);
    }
    result
}

/// 保存本机侧栏折叠与历史筛选，保留项目根目录及扫描缓存。
#[tauri::command]
pub fn save_sidebar(sidebar: scan::SidebarPrefs) -> Result<(), String> {
    let _guard = STATUS_WRITE.lock().unwrap();
    scan::update_config(|config| config.sidebar = sidebar)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验证缺省启用、停用元数据往返及损坏配置不静默恢复。
    #[test]
    fn chart_metadata_roundtrip() {
        let dir = crate::paths::test_home().join("chart_lifecycle");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".flow-coding.json");
        if file.exists() { std::fs::remove_file(&file).unwrap(); }
        assert!(chart_states(&dir).unwrap().charts.is_empty());
        write_atomic(&file, r#"{"charts":{"旧图.drawio":{"status":"disabled","disabled_at":"2026-11-02T11:00:00+08:00"}}}"#).unwrap();
        assert_eq!(chart_states(&dir).unwrap().charts["旧图.drawio"].status, "disabled");
        write_atomic(&file, "broken").unwrap();
        assert!(chart_states(&dir).is_err());
        std::fs::remove_file(file).unwrap();
    }

    /// Agent 持锁时不得改档案；写入失败也必须释放本次用户锁。
    #[test]
    fn mutation_respects_lock() {
        let path = crate::paths::test_home().join("lifecycle_lock.md");
        assert!(lock::acquire(&path, "agent", lock::AGENT_TTL).unwrap().is_ok());
        assert!(write_locked(&path, || Ok(())).unwrap_err().starts_with("LOCKED:"));
        lock::release(&path, "agent").unwrap();
        assert!(write_locked::<()>(&path, || Err("write failed".into())).is_err());
        assert!(lock::read(&path).unwrap().is_none());
    }
}
