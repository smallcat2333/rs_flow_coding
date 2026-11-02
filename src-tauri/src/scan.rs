//! 流程图扫描：在配置的项目根下查找 `<app>/docs/flow/*.drawio`，按 分组 → APP 归类。
//!
//! 为避免大仓库（node_modules、target、虚拟环境等）拖慢扫描，遍历时剪掉常见的大目录。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 遍历时跳过的目录名（小写比较）。
const SKIP_DIRS: [&str; 16] = [
    ".git", "node_modules", "target", "__pycache__", ".venv", "venv", "dist", "build_output",
    "_app_log", ".idea", ".codegraph", ".cache", ".pytest_cache", "site-packages", "out", ".claude",
];

/// 用户配置，存于 `<数据目录>/config.json`。
/// - `roots`：项目根目录列表；
/// - `flow_dirs`：上次全量扫描发现的 flow 目录缓存，启动与常规刷新直接用它，避免遍历大仓库。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    pub roots: Vec<String>,
    #[serde(default)]
    pub flow_dirs: Vec<String>,
}

/// 读取配置；文件不存在返回空配置，内容损坏报错。
pub fn load_config() -> Result<Config, String> {
    let f = crate::paths::home()?.join("config.json");
    match std::fs::read_to_string(&f) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("配置文件损坏 {}: {e}", f.display())),
        Err(_) => Ok(Config::default()),
    }
}

/// 保存配置。
pub fn save_config(c: &Config) -> Result<(), String> {
    let f = crate::paths::home()?.join("config.json");
    std::fs::write(&f, serde_json::to_string_pretty(c).unwrap()).map_err(|e| format!("保存配置失败: {e}"))
}

/// 一个 APP 的流程图目录。`group` 为上级 `group_*` 目录名（没有则为空），`app` 为 APP 目录名。
#[derive(Debug, Clone, Serialize)]
pub struct FlowDir {
    pub root: String,
    pub group: String,
    pub app: String,
    pub app_dir: String,
    pub flow_dir: String,
    pub files: Vec<String>,
}

/// 由 APP 目录推导 (分组, APP 名)：父目录名以 `group_` 开头时作为分组。
pub fn app_of(app_dir: &Path) -> (String, String) {
    let app = app_dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let group = app_dir
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|g| g.starts_with("group_"))
        .unwrap_or_default();
    (group, app)
}

/// 由流程图文件路径推导所属 APP 显示名 `group/app`；不在 `docs/flow` 下时用父目录名。
pub fn app_label(file: &Path) -> String {
    let flow = file.parent();
    let app_dir = flow
        .filter(|f| f.file_name().is_some_and(|n| n == "flow"))
        .and_then(Path::parent)
        .filter(|d| d.file_name().is_some_and(|n| n == "docs"))
        .and_then(Path::parent);
    match app_dir {
        Some(d) => {
            let (g, a) = app_of(d);
            if g.is_empty() { a } else { format!("{g}/{a}") }
        }
        None => flow.and_then(|f| f.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

/// 列出目录下的 `.drawio` 文件（不递归），按文件名排序。
pub fn list_drawio(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("drawio")))
        .collect();
    v.sort();
    v
}

/// 扫描一个根目录，返回所有含 `docs/flow` 或 `docs/feat` 的 APP（目录里暂无文件也列出，以便新建）。
/// `flow_dir` 统一为 `<app>/docs/flow`，该目录可能尚不存在（只有 feat 时）。
pub fn scan_root(root: &Path) -> Vec<FlowDir> {
    let mut out: Vec<FlowDir> = Vec::new();
    let walker = walkdir::WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        !(e.file_type().is_dir()
            && SKIP_DIRS.contains(&e.file_name().to_string_lossy().to_lowercase().as_str()))
    });
    for entry in walker.flatten() {
        if !entry.file_type().is_dir() || !(entry.file_name() == "flow" || entry.file_name() == "feat") {
            continue;
        }
        let Some(docs) = entry.path().parent().filter(|d| d.file_name().is_some_and(|n| n == "docs")) else { continue };
        let Some(app_dir) = docs.parent() else { continue };
        let flow = docs.join("flow");
        let flow_s = flow.to_string_lossy().into_owned();
        if out.iter().any(|d| d.flow_dir == flow_s) {
            continue;
        }
        let (group, app) = app_of(app_dir);
        out.push(FlowDir {
            root: root.to_string_lossy().into_owned(),
            group,
            app,
            app_dir: app_dir.to_string_lossy().into_owned(),
            flow_dir: flow_s,
            files: list_drawio(&flow).iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        });
    }
    out.sort_by(|a, b| (&a.group, &a.app).cmp(&(&b.group, &b.app)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_finds_app_flow() {
        let tmp = std::env::temp_dir().join(format!("flow_scan_test_{}", std::process::id()));
        let flow = tmp.join("apps/group_x/app_y/docs/flow");
        std::fs::create_dir_all(&flow).unwrap();
        std::fs::create_dir_all(tmp.join("node_modules/a/docs/flow")).unwrap();
        std::fs::write(flow.join("b.drawio"), "<mxfile/>").unwrap();
        std::fs::write(flow.join("a.drawio"), "<mxfile/>").unwrap();
        std::fs::write(flow.join("note.md"), "").unwrap();
        std::fs::create_dir_all(tmp.join("apps/app_z/docs/feat")).unwrap();
        let r = scan_root(&tmp);
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].group.as_str(), r[0].app.as_str()), ("", "app_z"));
        assert!(r[0].files.is_empty());
        assert_eq!((r[1].group.as_str(), r[1].app.as_str()), ("group_x", "app_y"));
        assert_eq!(r[1].files.len(), 2);
        assert!(r[1].files[0].ends_with("a.drawio"));
        assert_eq!(app_label(&flow.join("a.drawio")), "group_x/app_y");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
