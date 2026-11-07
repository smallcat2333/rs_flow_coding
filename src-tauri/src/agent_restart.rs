//! 设置页重新开启单个会话：先确认旧进程已退出，再复用原会话及最新启动配置。

use super::*;

/// 旧进程退出由原等待线程确认；超时或会话被停用时不再启动，避免同时占用同一份对话。
pub(super) fn restart_session(id: &str) -> Result<(), String> {
    let h = hub()?;
    // 在结束旧进程前检查可执行文件、参数及 hooks，配置错误时保留原进程。
    let settings = load_settings()?;
    find_claude(&settings)?;
    session_extra_args(&settings)?;
    hooks_file(&flowctl_path()?, &settings.view_mode)?;
    let gen = {
        let mut map = h.entries.lock().unwrap();
        let e = map.get_mut(id).ok_or("会话不存在")?;
        if e.meta.archived_at > 0 { return Err("会话已归档，请先取消归档".into()); }
        if e.meta.stored_at > 0 { return Err("会话已收纳，请先启用".into()); }
        if !Path::new(&e.meta.cwd).is_dir() { return Err("会话工作目录不存在".into()); }
        if e.proc.is_some() && e.stopping { return Err("会话正在停止，请稍后重试".into()); }
        if e.proc.is_some() && e.live.status == "boot" { return Err("会话正在启动，请等待就绪后再重新开启".into()); }
        if let Some(p) = e.proc.as_mut() {
            e.stopping = true;
            // portable-pty 的 Windows kill 返回值不可靠，以原等待线程清除 proc 为准。
            let _ = p.killer.kill();
        }
        e.gen
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let map = h.entries.lock().unwrap();
        let e = map.get(id).ok_or("会话已删除，已取消重新开启")?;
        if e.meta.archived_at > 0 || e.meta.stored_at > 0 || e.gen != gen {
            return Err("会话状态已变化，已取消重新开启".into());
        }
        if e.proc.is_none() { break; }
        drop(map);
        if std::time::Instant::now() >= deadline {
            return Err("旧会话进程尚未退出，未启动新进程，请稍后重试".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    spawn(id, None)?;
    if let Some(app) = APP.get() {
        let _ = app.emit_to(LABEL, "agent-focus", json!({ "id": id }));
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_restart_tests.rs"]
mod tests;
