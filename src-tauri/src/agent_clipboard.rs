//! Agent 终端剪贴板桥接：识别 Windows 原生文件列表和图像，文字仍走浏览器粘贴。
//! 图像由 Claude Code 的 Alt+V 原生附件入口读取，不复制文件或转换图片内容。

use serde::Serialize;

/// 一次粘贴的原生类型；文件保留绝对路径，图像仅通知前端转发原生粘贴快捷键。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "paths", rename_all = "lowercase")]
pub enum ClipboardContent {
    Text,
    Image,
    Files(Vec<String>),
}

/// 仅在 Agent 窗口主动粘贴时读取剪贴板格式；读取失败直接报告，不丢弃为普通文字。
#[tauri::command]
pub fn agent_clipboard(window: tauri::WebviewWindow) -> Result<ClipboardContent, String> {
    if window.label() != crate::agent::LABEL {
        return Err("仅 Agent 窗口可读取会话剪贴板".into());
    }
    read_clipboard()
}

/// 读取 Windows 文件拖放列表或图像类型；非 Windows 沿用浏览器粘贴数据。
fn read_clipboard() -> Result<ClipboardContent, String> {
    #[cfg(windows)]
    { windows::read() }
    #[cfg(not(windows))]
    { Ok(ClipboardContent::Text) }
}

#[cfg(windows)]
mod windows {
    use super::ClipboardContent;
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(owner: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(drop: *mut c_void, index: u32, path: *mut u16, count: u32) -> u32;
    }

    /// 剪贴板只在读取格式和路径期间持锁，提前返回或报错时也必须释放。
    struct Clipboard;

    impl Drop for Clipboard {
        /// 释放本次打开的剪贴板；句柄由系统拥有，不释放文件列表数据。
        fn drop(&mut self) { unsafe { CloseClipboard(); } }
    }

    /// 从系统拥有的 HDROP 读取全部路径；调用方必须保证句柄在读取期间有效。
    unsafe fn file_paths(drop: *mut c_void) -> Result<Vec<String>, String> {
        let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
        if count == 0 { return Err("剪贴板文件列表为空".into()); }
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let len = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
            if len == 0 { return Err("剪贴板含有空文件路径".into()); }
            let mut path = vec![0u16; len as usize + 1];
            if DragQueryFileW(drop, index, path.as_mut_ptr(), len + 1) != len {
                return Err("读取剪贴板文件路径失败".into());
            }
            paths.push(String::from_utf16(&path[..len as usize])
                .map_err(|e| format!("剪贴板文件路径编码无效：{e}"))?);
        }
        Ok(paths)
    }

    /// 文件优先于图像，避免资源管理器同时提供缩略图时把文件误当成截图。
    /// 路径以 UTF-16 原样读取，支持中文、空格及多文件，不读取文件内容。
    pub(super) fn read() -> Result<ClipboardContent, String> {
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return Err(format!("无法读取剪贴板：{}", std::io::Error::last_os_error()));
            }
            let _clipboard = Clipboard;
            if IsClipboardFormatAvailable(15) != 0 { // CF_HDROP：资源管理器复制的文件列表。
                let drop = GetClipboardData(15);
                if drop.is_null() {
                    return Err(format!("读取剪贴板文件列表失败：{}", std::io::Error::last_os_error()));
                }
                return Ok(ClipboardContent::Files(file_paths(drop)?));
            }
            let png: Vec<u16> = "PNG\0".encode_utf16().collect();
            let png_format = RegisterClipboardFormatW(png.as_ptr());
            if png_format == 0 {
                return Err(format!("识别剪贴板图像格式失败：{}", std::io::Error::last_os_error()));
            }
            // CF_BITMAP、CF_DIB、CF_DIBV5 及 PNG 覆盖截图和浏览器复制的图像。
            if [2, 8, 17, png_format].iter().any(|format| IsClipboardFormatAvailable(*format) != 0) {
                return Ok(ClipboardContent::Image);
            }
            Ok(ClipboardContent::Text)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
            fn GlobalLock(handle: *mut c_void) -> *mut c_void;
            fn GlobalUnlock(handle: *mut c_void) -> i32;
            fn GlobalFree(handle: *mut c_void) -> *mut c_void;
        }

        /// 构造独立 HDROP 验证真实 Windows API，不改动用户当前剪贴板。
        #[test]
        fn explorer_files_preserve_unicode_and_spaces() {
            let expected = [r"E:\资料\截图 1.png", r"E:\文档\说明.txt"];
            let names: Vec<u16> = expected.iter().flat_map(|p| p.encode_utf16().chain([0])).chain([0]).collect();
            unsafe {
                let handle = GlobalAlloc(0x42, 20 + names.len() * 2); // GMEM_MOVEABLE | GMEM_ZEROINIT。
                assert!(!handle.is_null());
                let memory = GlobalLock(handle).cast::<u8>();
                assert!(!memory.is_null());
                std::ptr::write_unaligned(memory.cast::<u32>(), 20); // DROPFILES.pFiles。
                std::ptr::write_unaligned(memory.add(16).cast::<i32>(), 1); // DROPFILES.fWide。
                std::ptr::copy_nonoverlapping(names.as_ptr(), memory.add(20).cast::<u16>(), names.len());
                GlobalUnlock(handle);
                let result = file_paths(handle);
                GlobalFree(handle);
                assert_eq!(result.unwrap(), expected);
            }
        }
    }
}
