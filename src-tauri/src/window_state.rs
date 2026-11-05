//! 主窗口启动位置与尺寸记忆：复用本机数据目录、原子写入和屏幕边界检查。
//! 普通窗口矩形单独缓存，最大化仅更新状态；最小化、流程图全屏不覆盖普通矩形。

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Window, WindowEvent};

/// 本机主窗口偏好：物理坐标与内容尺寸；首次启动未保存时沿用 Tauri 配置。
#[derive(Clone, Default, Deserialize, Serialize)]
struct Prefs {
    position: Option<(i32, i32)>,
    size: Option<(u32, u32)>,
    maximized: bool,
}

/// 运行期间缓存正常窗口矩形；只在关闭/销毁时写盘，移动与缩放不反复读写文件。
struct WindowState(Mutex<Prefs>);

/// 读取本机偏好；文件不存在沿用默认配置，其他文件/格式错误直接报告。
fn load() -> Result<Prefs, String> {
    let path = crate::paths::home()?.join("main-window.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("读取主窗口状态失败 {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Prefs::default()),
        Err(e) => Err(format!("读取主窗口状态失败 {}: {e}", path.display())),
    }
}

/// 初始化主窗口状态并恢复后显示；旧屏幕已移除时不恢复不可见坐标，使用系统初始位置。
pub fn init(app: &AppHandle) -> Result<(), String> {
    let prefs = load()?;
    app.manage(WindowState(Mutex::new(prefs.clone())));
    let main = app.get_webview_window("main").ok_or("主窗口 main 不存在")?;
    if let Some((width, height)) = prefs.size {
        main.set_size(PhysicalSize::new(width, height)).map_err(|e| e.to_string())?;
    }
    if let Some((x, y)) = prefs.position {
        if crate::float::on_screen(app, x, y) {
            main.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        }
    }
    if prefs.maximized { main.maximize().map_err(|e| e.to_string())?; }
    main.show().map_err(|e| e.to_string())
}

/// 捕获当前正常矩形与最大化状态；最小化与全屏沿用此前状态，不把临时尺寸写回偏好。
fn capture(window: &Window, prefs: &mut Prefs) -> Result<(), String> {
    if window.is_fullscreen().map_err(|e| e.to_string())? || window.is_minimized().map_err(|e| e.to_string())? {
        return Ok(());
    }
    // Windows 的 Moved 早于 WM_SIZE 更新框架缓存，必须读取原生状态来排除最大化过渡矩形。
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn IsZoomed(hwnd: *mut std::ffi::c_void) -> i32;
        }
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        prefs.maximized = unsafe { IsZoomed(hwnd.0 as *mut std::ffi::c_void) != 0 };
    }
    #[cfg(not(windows))]
    { prefs.maximized = window.is_maximized().map_err(|e| e.to_string())?; }
    if !prefs.maximized {
        let p = window.outer_position().map_err(|e| e.to_string())?;
        let s = window.inner_size().map_err(|e| e.to_string())?;
        prefs.position = Some((p.x, p.y));
        prefs.size = Some((s.width, s.height));
    }
    Ok(())
}

/// 只接收 main 的窗口事件；销毁时使用缓存，兼容前端保存后直接 destroy 的关闭链路。
pub fn on_event(window: &Window, event: &WindowEvent) -> Result<(), String> {
    if window.label() != "main" { return Ok(()); }
    // Tauri 创建配置窗口时可能先发送事件，此时 setup 尚未装入状态。
    let Some(state) = window.app_handle().try_state::<WindowState>() else { return Ok(()); };
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. } => {
            capture(window, &mut state.0.lock().unwrap())?;
        }
        _ => {}
    }
    if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
        let text = serde_json::to_string_pretty(&*state.0.lock().unwrap()).map_err(|e| e.to_string())?;
        crate::write_atomic(&crate::paths::home()?.join("main-window.json"), &text)?;
    }
    Ok(())
}
