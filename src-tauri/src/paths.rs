//! 路径与数据目录：统一 App 与 flowctl 的数据目录、路径归一化和键生成。

use std::path::{Path, PathBuf};

/// 数据目录：优先环境变量 `FLOW_CODING_HOME`（测试用），否则 `%APPDATA%\rs_flow_coding`。
/// 目录不存在时创建；APPDATA 缺失直接报错（fail fast）。
pub fn home() -> Result<PathBuf, String> {
    let dir = match std::env::var_os("FLOW_CODING_HOME") {
        Some(v) => PathBuf::from(v),
        None => {
            let appdata = std::env::var_os("APPDATA").ok_or("环境变量 APPDATA 缺失")?;
            PathBuf::from(appdata).join("rs_flow_coding")
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败 {}: {e}", dir.display()))?;
    Ok(dir)
}

/// 把文件路径归一为绝对规范路径（去掉 `\\?\` 前缀），文件必须存在。
pub fn norm(p: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(p).map_err(|e| format!("路径无效 {}: {e}", p.display()))
}

/// 路径比较键：规范路径的小写字符串（Windows 路径大小写不敏感）。
pub fn key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// 测试专用：全部单测共用一个按进程隔离的数据目录，只设置一次环境变量，避免并行测试互相覆盖。
#[cfg(test)]
pub fn test_home() -> PathBuf {
    static HOME: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    HOME.get_or_init(|| {
        let d = std::env::temp_dir().join(format!("flow_coding_test_{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::env::set_var("FLOW_CODING_HOME", &d);
        d
    })
    .clone()
}
