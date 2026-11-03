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

/// 本机侧栏偏好：折叠区的键、显式展开的收纳区、是否搜索历史；搜索词不持久化。
/// 排序与置顶只影响本机显示，不改项目文件；缺省字段按 `Default` 补齐（自动置顶默认开启）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SidebarPrefs {
    pub collapsed: Vec<String>,
    pub expanded_archives: Vec<String>,
    pub include_archived: bool,
    /// APP 显示别名，以 flow_dir 为键；不修改原目录名或项目文件。
    pub app_aliases: std::collections::BTreeMap<String, String>,
    /// 分组显示别名，以分组目录路径为键（未分组为空串）。
    pub group_aliases: std::collections::BTreeMap<String, String>,
    /// 分组显示顺序（分组键）；未列出的分组按扫描顺序排在后面。
    pub group_order: Vec<String>,
    /// APP 显示顺序（flow_dir）；只在同一分组内比较，未列出的排在后面。
    pub app_order: Vec<String>,
    /// Agent 或外部改动流程图/Feat 时自动置顶并标记未查看。
    pub auto_top: bool,
    /// 条目最近一次被置顶的时间（毫秒），键为规范化路径；列表内按时间倒序排在前面。
    pub bumped: std::collections::BTreeMap<String, i64>,
    /// 更新后尚未点开的条目（规范化路径），侧栏以淡蓝底色提示。
    pub unseen: Vec<String>,
    /// 侧栏排布：`tree` 为 分组 → APP → Chart/Feat，`flat` 为不分层直接列出 Chart 与 Feat。
    pub layout: String,
}

impl Default for SidebarPrefs {
    /// 新配置与旧配置缺字段时：全部展开、不搜历史、无别名与自定义顺序，自动置顶开启。
    fn default() -> Self {
        Self {
            collapsed: Vec::new(),
            expanded_archives: Vec::new(),
            include_archived: false,
            app_aliases: Default::default(),
            group_aliases: Default::default(),
            group_order: Vec::new(),
            app_order: Vec::new(),
            auto_top: true,
            bumped: Default::default(),
            unseen: Vec::new(),
            layout: "tree".into(),
        }
    }
}

/// 用户配置，存于 `<数据目录>/config.json`。
/// - `roots`：项目根目录列表；
/// - `flow_dirs`：上次全量扫描发现的 flow 目录缓存，启动与常规刷新直接用它，避免遍历大仓库。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    pub roots: Vec<String>,
    #[serde(default)]
    pub flow_dirs: Vec<String>,
    /// 从目录列表移除的 APP / 分组；重扫时仍排除，磁盘文件保留。
    #[serde(default)]
    pub excluded_dirs: Vec<String>,
    #[serde(default)]
    pub sidebar: SidebarPrefs,
}

/// 路径边界匹配，避免移除 app_a 时连带排除 app_ab。
pub fn within(path: &Path, directory: &Path) -> bool {
    let path = crate::paths::key(path);
    let directory = crate::paths::key(directory).trim_end_matches('\\').to_string();
    path == directory || path.starts_with(&(directory + "\\"))
}

impl Config {
    pub fn excludes(&self, path: &Path) -> bool {
        self.excluded_dirs.iter().any(|dir| within(path, Path::new(dir)))
    }
}

/// 读取配置；文件不存在返回空配置，内容损坏报错。
pub fn load_config() -> Result<Config, String> {
    let f = crate::paths::home()?.join("config.json");
    match std::fs::read_to_string(&f) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("配置文件损坏 {}: {e}", f.display())),
        Err(_) => Ok(Config::default()),
    }
}

/// 串行更新配置的互斥锁，防止全量扫描完成时覆盖刚保存的侧栏偏好。
static CONFIG_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 基于最新配置更新指定字段并原子写盘；其他字段保留，避免扫描与界面设置相互覆盖。
pub fn update_config(change: impl FnOnce(&mut Config)) -> Result<Config, String> {
    let _guard = CONFIG_WRITE.lock().unwrap();
    let mut config = load_config()?;
    change(&mut config);
    let f = crate::paths::home()?.join("config.json");
    crate::write_atomic(&f, &serde_json::to_string_pretty(&config).unwrap())?;
    Ok(config)
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

    /// 旧配置缺省为空别名；往返持久化保留别名和其他侧栏偏好。
    #[test]
    fn sidebar_aliases_roundtrip() {
        let mut prefs: SidebarPrefs = serde_json::from_str(r#"{"collapsed":["app"],"expanded_archives":[],"include_archived":true}"#).unwrap();
        assert!(prefs.app_aliases.is_empty());
        assert!(prefs.auto_top, "旧配置缺字段时自动置顶默认开启");
        assert_eq!(prefs.layout, "tree", "旧配置缺字段时按分层排布");
        prefs.layout = "flat".into();
        prefs.app_aliases.insert("/project/app_sever/docs/flow".into(), "服务端".into());
        prefs.group_aliases.insert("/project/group_sever".into(), "服务".into());
        prefs.group_order = vec!["/project/group_sever".into(), String::new()];
        prefs.auto_top = false;
        let restored: SidebarPrefs = serde_json::from_str(&serde_json::to_string(&prefs).unwrap()).unwrap();
        assert_eq!(restored.app_aliases["/project/app_sever/docs/flow"], "服务端");
        assert_eq!(restored.group_aliases["/project/group_sever"], "服务");
        assert_eq!(restored.group_order, ["/project/group_sever", ""]);
        assert!(!restored.auto_top);
        assert_eq!(restored.layout, "flat");
        assert_eq!(restored.collapsed, ["app"]);
        assert!(restored.include_archived);
    }

    #[test]
    fn directory_exclusions_are_boundary_aware_and_persisted() {
        let mut cfg: Config = serde_json::from_str(r#"{"roots":[]}"#).unwrap();
        assert!(cfg.excluded_dirs.is_empty());
        cfg.excluded_dirs = vec!["C:\\project\\group_a\\app_x".into()];
        assert!(cfg.excludes(Path::new("c:/project/group_a/app_x/docs/flow")));
        assert!(!cfg.excludes(Path::new("C:/project/group_a/app_xy/docs/flow")));
        cfg.excluded_dirs = vec!["C:/project/group_a/".into()];
        assert!(cfg.excludes(Path::new("C:/project/group_a/app_x/docs/flow")));
        assert!(!cfg.excludes(Path::new("C:/project/group_ab/app_x/docs/flow")));
        let restored: Config = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(restored.excluded_dirs, cfg.excluded_dirs);
    }

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
