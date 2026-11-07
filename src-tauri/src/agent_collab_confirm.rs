//! 停用模块负责人的实际用户确认：后台弹出原生 YES/NO 窗口，不开放 Agent 可调用的同意协议。
//! 等待期间不持有会话表/账本锁；确认结果先落盘，再由既有队列按空闲状态启动和投递。

use super::*;

/// 后台执行一个已持久化的确认占位；同负责人等待请求共享此窗口，迟到或退出后的选择不生效。
pub(super) fn owner(target: &str, key: &str) {
    let answer = prompt_text(target, key).and_then(|text| ask_user(&text));
    if STOPPED.load(Ordering::SeqCst) { return; }
    if let Err(error) = finish(target, key, answer) { eprintln!("保存协作启用确认失败：{error}"); }
}

/// 复制窗口所需的真实请求和负责人信息后释放锁，不把用户等待变成会话或 TCP 阻塞。
fn prompt_text(target: &str, key: &str) -> Result<String, String> {
    let map = hub()?.entries.lock().unwrap();
    let store = STORE.get().ok_or("协作服务未初始化")?.lock().unwrap();
    store.book.approvals.get(target).filter(|a| a.id == key).ok_or("启用确认已失效")?;
    let e = map.get(target).ok_or("负责人不存在")?;
    let request = store.book.requests.iter().find(|r| r.to == target && r.phase == Phase::AwaitingApproval).ok_or("待确认协作请求不存在")?;
    Ok(format!("模块负责人「{}」已{}。\n\n「{}」提出协作：{}\n模块：{}\n\n是否重新启用该负责人并继续此模块的排队请求？\n选择“是（YES）”将恢复原会话；选择“否（NO）”保持停用并反馈请求方。",
        e.meta.title, if e.meta.archived_at > 0 { "归档" } else { "收纳" }, request.from_title, cut(&request.goal, 240), request.module))
}

/// 仅接受实际 Windows 原生对话框的按钮结果；默认按钮为 NO，窗口错误作为拒绝原因回传。
#[cfg(windows)]
fn ask_user(message: &str) -> Result<bool, String> {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut std::ffi::c_void, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }
    APP.get().ok_or("应用未初始化，无法请求用户确认")?;
    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let caption: Vec<u16> = "Flow Coding · 重新启用 Agent".encode_utf16().chain(Some(0)).collect();
    // MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2；只在当前后台线程等待，不处理任何来自 CLI 的答复。
    let choice = unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x4 | 0x20 | 0x100) };
    match choice {
        6 => Ok(true),
        7 => Ok(false),
        _ => Err(format!("用户确认窗口未完成：{}", std::io::Error::last_os_error())),
    }
}

/// 当前原生确认只支持 Windows；其他平台明确受阻，不假造用户同意或自动启用。
#[cfg(not(windows))]
fn ask_user(_message: &str) -> Result<bool, String> { Err("当前平台尚未接入原生启用确认".into()) }

/// 在一致锁顺序内保存用户选择；会话元数据或账本写入失败时恢复原元数据，不留下半启用记录。
fn finish(target: &str, key: &str, answer: Result<bool, String>) -> Result<(), String> {
    let mut map = hub()?.entries.lock().unwrap();
    let mut store = STORE.get().ok_or("协作服务未初始化")?.lock().unwrap();
    if !store.book.approvals.get(target).is_some_and(|a| a.id == key) { return Ok(()); }
    let previous = map.get(target).map(|e| e.meta.clone());
    let mut next = store.book.clone();
    let mut changed = next.decide_approval(&mut map, target, key, answer, now());
    if changed {
        if let Err(error) = save_metas(&map) {
            if let Some(meta) = &previous { map.get_mut(target).unwrap().meta = meta.clone(); }
            next = store.book.clone();
            next.decide_approval(&mut map, target, key, Err(format!("保存负责人启用状态失败：{error}")), now());
            changed = false;
        }
    }
    if let Err(error) = save(&store.path, &next) {
        if changed {
            if let Some(meta) = previous { map.get_mut(target).unwrap().meta = meta; }
            save_metas(&map).map_err(|rollback| format!("{error}；回滚负责人状态失败：{rollback}"))?;
        }
        return Err(error);
    }
    store.book = next;
    drop(store);
    if let Some(e) = map.get(target) { emit_update(e); }
    Ok(())
}
