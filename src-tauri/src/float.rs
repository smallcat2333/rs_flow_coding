//! 悬浮窗：Flow Coding 的全部窗口都不在前台时，在屏幕角落显示一张毛玻璃信息卡，单击回到程序。
//!
//! - 开关与位置存 `<数据目录>/float.json`，默认开启；关闭时销毁悬浮窗，释放 WebView；
//! - 显示用 `SWP_SHOWWINDOW | SWP_NOACTIVATE`，出现时不抢走当前程序的焦点；显示/隐藏都走 Win32，
//!   不经过 tao 的可见标志，避免两套可见状态不一致；
//! - 焦点在 App 自己的窗口间切换时会先失焦再聚焦，判定延迟 150ms 合并，避免悬浮窗闪现。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition};

/// 悬浮窗的窗口标签；其他窗口（main / pop-*）都算 App 本身。
pub const LABEL: &str = "float";
/// 逻辑尺寸：两组大数字加一行动态，信息量刚好一眼读完。
const WIDTH: f64 = 380.0;
const HEIGHT: f64 = 184.0;
/// 默认放在工作区右下角，离边缘的逻辑像素。
const MARGIN: f64 = 24.0;

/// 本机偏好：是否启用、上次拖到的物理坐标（未拖过为 None，使用默认右下角）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Prefs {
    #[serde(default = "enabled_default")]
    enabled: bool,
    #[serde(default)]
    position: Option<(i32, i32)>,
}

/// 未设置过时默认开启。
fn enabled_default() -> bool { true }

impl Default for Prefs {
    fn default() -> Self { Self { enabled: true, position: None } }
}

/// 运行状态：偏好、焦点判定代次（只执行最后一次）、位置保存代次（拖动结束后才写盘）、
/// 最近获得焦点的 App 窗口（单击悬浮窗时回到它）。
pub struct FloatState {
    prefs: Mutex<Prefs>,
    enabled: AtomicBool,
    check: AtomicU64,
    save: AtomicU64,
    last: Mutex<String>,
}

/// 偏好文件路径。
fn prefs_file() -> Result<std::path::PathBuf, String> {
    Ok(crate::paths::home()?.join("float.json"))
}

/// 读偏好：文件不存在用默认；损坏时也回到默认，悬浮窗不能阻止 App 启动。
fn load() -> Prefs {
    prefs_file().ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// 原子写偏好。
fn store(prefs: &Prefs) -> Result<(), String> {
    crate::write_atomic(&prefs_file()?, &serde_json::to_string_pretty(prefs).unwrap())
}

/// App 启动时调用：注册状态；开启时预先建好隐藏的悬浮窗，失焦时只需显示，不临时创建 WebView。
pub fn init(app: &AppHandle) {
    let prefs = load();
    let enabled = prefs.enabled;
    app.manage(FloatState {
        prefs: Mutex::new(prefs),
        enabled: AtomicBool::new(enabled),
        check: AtomicU64::new(0),
        save: AtomicU64::new(0),
        last: Mutex::new("main".into()),
    });
    if enabled {
        if let Err(e) = create(app) { eprintln!("创建悬浮窗失败: {e}"); }
    }
}

/// 新建隐藏的悬浮窗：无边框、透明、置顶、不进任务栏；位置用上次保存的坐标（仍在某块屏幕内），
/// 否则放到主窗口所在屏幕工作区的右下角。拖动后合并 600ms 再写盘。
fn create(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() { return Ok(()); }
    let window = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("float.html".into()))
        .title("Flow Coding 悬浮窗")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("创建悬浮窗失败: {e}"))?;
    let saved = app.state::<FloatState>().prefs.lock().unwrap().position;
    let position = saved.filter(|&(x, y)| on_screen(app, x, y)).map(|(x, y)| PhysicalPosition::new(x, y))
        .or_else(|| default_position(app));
    if let Some(p) = position { let _ = window.set_position(p); }
    win::style(&window);
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(p) => remember(&handle, p.x, p.y),
        // 悬浮窗只随设置开关或 App 退出销毁；Alt+F4、系统 WM_CLOSE 不单独关掉它（destroy 不经过此事件）
        tauri::WindowEvent::CloseRequested { api, .. } => api.prevent_close(),
        _ => {}
    });
    // 建好后立即按当前前台判定一次：启动时 App 可能本来就不在前台，不会再收到焦点事件。
    on_focus(app, "", false);
    Ok(())
}

/// 坐标左上角附近 40px 落在任一显示器内才算有效（拔掉外接屏后不把窗口放到看不见的地方）。
pub(crate) fn on_screen(app: &AppHandle, x: i32, y: i32) -> bool {
    app.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        x + 40 >= p.x && y + 40 >= p.y && x + 40 <= p.x + s.width as i32 && y + 40 <= p.y + s.height as i32
    })
}

/// 主窗口所在屏幕（取不到用主屏）工作区右下角，按该屏缩放换算尺寸与边距。
fn default_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let monitor = app.get_webview_window("main").and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let (area, scale) = (monitor.work_area(), monitor.scale_factor());
    let x = area.position.x + area.size.width as i32 - ((WIDTH + MARGIN) * scale) as i32;
    let y = area.position.y + area.size.height as i32 - ((HEIGHT + MARGIN) * scale) as i32;
    Some(PhysicalPosition::new(x, y))
}

/// 记下拖动后的位置：内存立即更新，600ms 内没有新位置才写盘，拖动过程不频繁写文件。
/// 被系统最小化时 Windows 报告的 (-32000, -32000) 不是真实位置，不记录。
fn remember(app: &AppHandle, x: i32, y: i32) {
    if (x <= -32000 && y <= -32000) || win::animating() { return; }
    let state = app.state::<FloatState>();
    state.prefs.lock().unwrap().position = Some((x, y));
    let id = state.save.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        let state = handle.state::<FloatState>();
        if state.save.load(Ordering::SeqCst) != id { return; }
        let prefs = state.prefs.lock().unwrap().clone();
        if let Err(e) = store(&prefs) { eprintln!("保存悬浮窗位置失败: {e}"); }
    });
}

/// 任一 App 窗口焦点变化或关闭后调用：记录最近聚焦的窗口，150ms 后按最终焦点决定显示或隐藏。
pub fn on_focus(app: &AppHandle, label: &str, focused: bool) {
    if label == LABEL { return; }
    let Some(state) = app.try_state::<FloatState>() else { return };
    if focused { *state.last.lock().unwrap() = label.to_string(); }
    let id = state.check.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        if handle.state::<FloatState>().check.load(Ordering::SeqCst) != id { return; }
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || apply(&inner));
    });
}

/// 开启且 App 不在前台时显示悬浮窗，否则隐藏。主窗口已不存在（正在退出）时不显示。
fn apply(app: &AppHandle) {
    let Some(float) = app.get_webview_window(LABEL) else { return };
    let enabled = app.state::<FloatState>().enabled.load(Ordering::SeqCst);
    if enabled && !win::app_in_front(app, &float) && app.get_webview_window("main").is_some() { win::show(&float) } else { win::hide(&float) }
}

/// 设置页读取开关。
#[tauri::command]
pub fn get_float_enabled(state: tauri::State<'_, FloatState>) -> bool {
    state.enabled.load(Ordering::SeqCst)
}

/// 设置页切换开关：保存偏好；开启时建窗（设置页正开着，主窗口在前台，不会立刻显示），关闭时销毁。
/// 建 WebView 不能在同步 IPC 线程，所以是 async 命令。
#[tauri::command]
pub async fn set_float_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<FloatState>();
    state.enabled.store(enabled, Ordering::SeqCst);
    let prefs = { let mut p = state.prefs.lock().unwrap(); p.enabled = enabled; p.clone() };
    store(&prefs)?;
    if enabled { create(&app) } else {
        if let Some(w) = app.get_webview_window(LABEL) { w.destroy().map_err(|e| e.to_string())?; }
        Ok(())
    }
}

/// 单击悬浮窗：隐藏悬浮窗，还原并聚焦最近使用的 App 窗口（已关闭则回主窗口）。
#[tauri::command]
pub fn float_activate(app: AppHandle) -> Result<(), String> {
    if let Some(float) = app.get_webview_window(LABEL) { win::hide(&float); }
    let last = app.state::<FloatState>().last.lock().unwrap().clone();
    let window = app.get_webview_window(&last).or_else(|| app.get_webview_window("main")).ok_or("主窗口不存在")?;
    let _ = window.unminimize();
    let _ = window.show();
    window.set_focus().map_err(|e| e.to_string())
}

/// Win32 细节：毛玻璃、圆角、无激活显示。直接声明系统函数，与 `alert` 一样不引入 windows crate。
#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
    use std::sync::Mutex;

    type Hwnd = *mut c_void;

    /// 淡入 / 淡出时长（毫秒）与浮现位移（逻辑像素）：快速，不拖慢切换。
    const FADE_IN_MS: f64 = 140.0;
    const FADE_OUT_MS: f64 = 110.0;
    const RISE: f64 = 8.0;
    const TOPMOST: Hwnd = -1isize as Hwnd;
    const NOSIZE: u32 = 0x0001;
    const NOMOVE: u32 = 0x0002;
    const NOACTIVATE: u32 = 0x0010;
    const SHOWWINDOW: u32 = 0x0040;

    /// 悬浮窗只有一个：目标状态（是否应显示）、动画代次（新动画使旧动画停止）、当前透明度、
    /// 是否正在上浮（主线程 Moved 只读这个原子量，不碰锁）。
    static SHOWN: AtomicBool = AtomicBool::new(false);
    static FADE: AtomicU64 = AtomicU64::new(0);
    static ALPHA: AtomicU8 = AtomicU8::new(0);
    static RISING: AtomicBool = AtomicBool::new(false);
    /// 只由动画线程持有，串行化前后两段动画；内容为上浮被打断时窗口应回到的原位（句柄, x, y）。
    /// 主线程绝不能锁它：动画线程持锁调用 SetWindowPos 会同步等主线程处理移动消息，主线程若也等锁即死锁。
    static ANIM: Mutex<Option<(isize, i32, i32)>> = Mutex::new(None);

    #[repr(C)]
    #[derive(Default)]
    struct Rect { left: i32, top: i32, right: i32, bottom: i32 }

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(hwnd: Hwnd, after: Hwnd, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
        fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
        fn SetLayeredWindowAttributes(hwnd: Hwnd, key: u32, alpha: u8, flags: u32) -> i32;
        fn GetForegroundWindow() -> Hwnd;
        fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: Hwnd, attribute: u32, value: *const c_void, size: u32) -> i32;
    }

    /// SetWindowCompositionAttribute 的参数：Accent 策略与外层数据包。
    #[repr(C)]
    struct AccentPolicy { state: i32, flags: u32, color: u32, animation: u32 }
    #[repr(C)]
    struct CompositionData { attribute: i32, data: *const c_void, size: usize }
    type SetComposition = unsafe extern "system" fn(Hwnd, *const CompositionData) -> i32;

    /// 取窗口句柄；窗口已销毁时为 None。
    fn hwnd(window: &tauri::WebviewWindow) -> Option<Hwnd> {
        window.hwnd().ok().map(|h| h.0 as Hwnd)
    }

    /// 建窗后调用一次：分层窗口（整窗透明度做淡入淡出，初始全透明）+ Win11 圆角 + 桌面合成 Acrylic。
    /// Acrylic 不随失焦退为不透明（悬浮窗永远处于失焦）；合成接口不可用时退回 DWM 的系统 Acrylic 材质。
    /// 染色极低，底色由 CSS 半透明层负责。关闭后重新开启会新建窗口，这里重置动画状态。
    pub fn style(window: &tauri::WebviewWindow) {
        let Some(hwnd) = hwnd(window) else { return };
        let wide: Vec<u16> = "user32.dll".encode_utf16().chain(Some(0)).collect();
        SHOWN.store(false, Ordering::SeqCst);
        FADE.fetch_add(1, Ordering::SeqCst);
        RISING.store(false, Ordering::SeqCst);
        unsafe {
            // GWL_EXSTYLE = -20，WS_EX_LAYERED = 0x80000
            SetWindowLongPtrW(hwnd, -20, GetWindowLongPtrW(hwnd, -20) | 0x80000);
            set_alpha(hwnd, 0);
            let round = 2i32; // DWMWA_WINDOW_CORNER_PREFERENCE = 33，DWMWCP_ROUND = 2
            DwmSetWindowAttribute(hwnd, 33, &round as *const i32 as *const c_void, 4);
            let none = 1i32; // DWMWA_SYSTEMBACKDROP_TYPE = 38，DWMSBT_NONE = 1
            DwmSetWindowAttribute(hwnd, 38, &none as *const i32 as *const c_void, 4);
            let function = GetProcAddress(GetModuleHandleW(wide.as_ptr()), c"SetWindowCompositionAttribute".as_ptr() as *const u8);
            let applied = !function.is_null() && {
                let set: SetComposition = std::mem::transmute(function);
                // ACCENT_ENABLE_ACRYLICBLURBEHIND = 4；颜色 ABGR，近乎透明的染色
                let policy = AccentPolicy { state: 4, flags: 0, color: 0x011e1917, animation: 0 };
                let data = CompositionData { attribute: 19, data: &policy as *const AccentPolicy as *const c_void, size: std::mem::size_of::<AccentPolicy>() };
                set(hwnd, &data) != 0
            };
            if !applied {
                let acrylic = 3i32; // DWMSBT_TRANSIENTWINDOW
                DwmSetWindowAttribute(hwnd, 38, &acrylic as *const i32 as *const c_void, 4);
            }
        }
    }

    /// App 是否在前台：以系统前台窗口为准，属于本进程且不是悬浮窗本身即算（含原生对话框、菜单）。
    /// 不用 tao 的 is_focused：焦点进入 WebView2 子窗口后顶层窗口会报告失焦。
    /// 拖动悬浮窗时它自己成为前台，此时仍算不在前台，悬浮窗保持显示。
    pub fn app_in_front(_: &tauri::AppHandle, float: &tauri::WebviewWindow) -> bool {
        unsafe {
            let front = GetForegroundWindow();
            if front.is_null() || Some(front) == hwnd(float) { return false; }
            let mut pid = 0u32;
            GetWindowThreadProcessId(front, &mut pid);
            pid == std::process::id()
        }
    }

    /// 不激活地显示：淡入并从下方 8px 浮现到原位。已显示（或正在淡入）时只重新置顶。
    /// 正在淡出时从当前透明度接着淡入，不再上浮（窗口还在原位）。
    pub fn show(window: &tauri::WebviewWindow) {
        let Some(hwnd) = hwnd(window) else { return };
        if SHOWN.swap(true, Ordering::SeqCst) {
            unsafe { SetWindowPos(hwnd, TOPMOST, 0, 0, 0, 0, NOSIZE | NOMOVE | NOACTIVATE) };
            return;
        }
        let id = FADE.fetch_add(1, Ordering::SeqCst) + 1;
        let rise = if unsafe { IsWindowVisible(hwnd) } != 0 { 0 } else { (RISE * window.scale_factor().unwrap_or(1.0)) as i32 };
        let handle = hwnd as isize;
        std::thread::spawn(move || fade_in(handle as Hwnd, id, rise));
    }

    /// 淡出后隐藏；淡出期间若又要显示，则由新的淡入接管，不再隐藏。
    pub fn hide(window: &tauri::WebviewWindow) {
        let Some(hwnd) = hwnd(window) else { return };
        if !SHOWN.swap(false, Ordering::SeqCst) { return; }
        let id = FADE.fetch_add(1, Ordering::SeqCst) + 1;
        let handle = hwnd as isize;
        std::thread::spawn(move || fade_out(handle as Hwnd, id));
    }

    /// 浮现动画进行中（窗口位置在变）：此时的 Moved 不是用户拖动，不保存位置。
    pub fn animating() -> bool { RISING.load(Ordering::SeqCst) }

    /// 取得动画锁：等上一段动画线程看到代次变化退出；已被更新的动画取代则返回 None。
    /// 上一段上浮被打断时先把同一窗口归位（新建的窗口不受旧记录影响）。
    fn begin(hwnd: Hwnd, id: u64) -> Option<std::sync::MutexGuard<'static, Option<(isize, i32, i32)>>> {
        let mut anim = ANIM.lock().unwrap();
        if FADE.load(Ordering::SeqCst) != id { return None; }
        if let Some((owner, x, y)) = anim.take() {
            if owner == hwnd as isize { unsafe { SetWindowPos(hwnd, TOPMOST, x, y, 0, 0, NOSIZE | NOACTIVATE) }; }
        }
        RISING.store(false, Ordering::SeqCst);
        Some(anim)
    }

    /// 淡入：透明度从当前值升到 255，同时窗口从原位下方 rise 缓动回原位；被新动画打断时立即停止，
    /// 原位留在锁里由下一段动画归位。
    fn fade_in(hwnd: Hwnd, id: u64, rise: i32) {
        let Some(mut anim) = begin(hwnd, id) else { return };
        let mut r = Rect::default();
        unsafe {
            if rise > 0 {
                GetWindowRect(hwnd, &mut r);
                RISING.store(true, Ordering::SeqCst);
                *anim = Some((hwnd as isize, r.left, r.top));
                set_alpha(hwnd, 0);
                SetWindowPos(hwnd, TOPMOST, r.left, r.top + rise, 0, 0, NOSIZE | NOACTIVATE | SHOWWINDOW);
            } else {
                SetWindowPos(hwnd, TOPMOST, 0, 0, 0, 0, NOSIZE | NOMOVE | NOACTIVATE | SHOWWINDOW);
            }
        }
        let from = ALPHA.load(Ordering::SeqCst) as f64;
        let ok = animate(FADE_IN_MS, id, |t| unsafe {
            set_alpha(hwnd, (from + (255.0 - from) * t) as u8);
            if rise > 0 {
                SetWindowPos(hwnd, TOPMOST, r.left, r.top + (rise as f64 * (1.0 - t)).round() as i32, 0, 0, NOSIZE | NOACTIVATE);
            }
        });
        if ok {
            *anim = None;
            RISING.store(false, Ordering::SeqCst);
        }
    }

    /// 淡出：（begin 已把浮现中的窗口归位）透明度降到 0 后隐藏；被新的淡入打断则不隐藏。
    fn fade_out(hwnd: Hwnd, id: u64) {
        let Some(_anim) = begin(hwnd, id) else { return };
        let from = ALPHA.load(Ordering::SeqCst) as f64;
        if animate(FADE_OUT_MS, id, |t| unsafe { set_alpha(hwnd, (from * (1.0 - t)) as u8) }) {
            unsafe { ShowWindow(hwnd, 0) };
        }
    }

    /// 按缓出曲线（1 - (1-t)³）逐帧回调，约 8ms 一帧；动画代次变化即返回 false。
    fn animate(ms: f64, id: u64, mut frame: impl FnMut(f64)) -> bool {
        let start = std::time::Instant::now();
        loop {
            if FADE.load(Ordering::SeqCst) != id { return false; }
            let t = (start.elapsed().as_secs_f64() * 1000.0 / ms).min(1.0);
            frame(1.0 - (1.0 - t).powi(3));
            if t >= 1.0 { return true; }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
    }

    /// 设置整窗透明度（分层窗口 LWA_ALPHA），同时记下当前值供打断后接续。
    unsafe fn set_alpha(hwnd: Hwnd, alpha: u8) {
        SetLayeredWindowAttributes(hwnd, 0, alpha, 2);
        ALPHA.store(alpha, Ordering::SeqCst);
    }
}

/// 非 Windows：用 Tauri 自带显示/隐藏，不做毛玻璃。
#[cfg(not(windows))]
mod win {
    use tauri::Manager;
    pub fn style(_: &tauri::WebviewWindow) {}
    pub fn animating() -> bool { false }
    /// 非 Windows 按各窗口焦点判断。
    pub fn app_in_front(app: &tauri::AppHandle, _: &tauri::WebviewWindow) -> bool {
        app.webview_windows().iter().any(|(label, w)| label != super::LABEL && w.is_focused().unwrap_or(false))
    }
    pub fn show(window: &tauri::WebviewWindow) { let _ = window.show(); }
    pub fn hide(window: &tauri::WebviewWindow) { let _ = window.hide(); }
}
