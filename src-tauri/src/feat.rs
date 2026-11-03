//! FEAT 档案：扫描 `<app>/docs/feat/Feat_*.md`，解析标题、状态、路线图进度，并按标签汇总流程图节点。
//!
//! 档案格式由 smallcat-feat-* skill 维护：
//! - 首行 `# Feat_<YYMMDD>_<N> <标题>`；
//! - 状态行 `> 状态：xxx` 或 `- 状态：xxx`（取首个）；
//! - §3.1 路线图表格，状态列为最后一列（完成/取消/进行中/待开发）。
//! 节点关联：节点 `tags` 中含 Feat 编号（如 `Feat_260910_1`）即属于该 Feat。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::flow::{self, Counts};

/// 一个 FEAT 档案的摘要。
/// - `id`：编号 `Feat_YYMMDD_N`；`title`：标题；`status`：状态行原文（截 40 字）；
/// - `tasks_done`/`tasks_total`：路线图中完成数（含取消）/总数，无路线图为 0/0；
/// - `counts`：本 APP 流程图中挂了该编号标签的节点状态计数；`closable`：挂了节点且全部为无色。
#[derive(Debug, Clone, Serialize)]
pub struct FeatEntry {
    pub path: String,
    pub id: String,
    pub title: String,
    pub status: String,
    /// 已关闭/已废弃归入收纳区；完成开发、测试完成仍属于开启。
    pub archived: bool,
    pub closed_at: String,
    pub tasks_done: usize,
    pub tasks_total: usize,
    pub counts: Counts,
    pub node_total: usize,
    pub closable: bool,
    pub lock: Option<crate::lock::LockInfo>,
}

/// 挂了某 Feat 标签的节点（跨图）。
#[derive(Debug, Clone, Serialize)]
pub struct TaggedNode {
    pub file: String,
    #[serde(flatten)]
    pub node: flow::Node,
}

/// 由 flow 目录推导同 APP 的 feat 目录（`docs/flow` → `docs/feat`）。
pub fn feat_dir_of(flow_dir: &Path) -> PathBuf {
    flow_dir.parent().map(|d| d.join("feat")).unwrap_or_else(|| flow_dir.join("../feat"))
}

/// 列出目录下 `Feat_*.md`（不递归），按文件名倒序（新编号在前）。
pub fn list_feats(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("md"))
                && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("Feat_"))
        })
        .collect();
    v.sort();
    v.reverse();
    v
}

/// 从文件名取编号：`Feat_260910_1_通用检查.md` → `Feat_260910_1`。不符合格式时取去扩展名的文件名。
pub fn id_from_name(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let parts: Vec<&str> = stem.splitn(4, '_').collect();
    if parts.len() >= 3 && parts[1].chars().all(|c| c.is_ascii_digit()) && parts[2].chars().all(|c| c.is_ascii_digit()) {
        format!("{}_{}_{}", parts[0], parts[1], parts[2])
    } else {
        stem
    }
}

/// 解析档案文本：返回 (标题, 状态, 完成数, 总数)。
/// 标题取首行 `# ` 去掉编号；状态取首个「状态：」行冒号后内容；路线图取 §3.1 小节内首个表格。
pub fn parse_md(text: &str, id: &str) -> (String, String, usize, usize) {
    let mut title = String::new();
    let mut status = String::new();
    for line in text.lines() {
        let l = line.trim();
        if title.is_empty() && l.starts_with("# ") {
            title = l[2..].trim().trim_start_matches(id).trim().to_string();
        }
        if status.is_empty() {
            let body = l.trim_start_matches(['>', '-', ' ']);
            if let Some(rest) = body.strip_prefix("状态：").or_else(|| body.strip_prefix("状态:")) {
                status = rest.trim().chars().take(40).collect();
            }
        }
        if !title.is_empty() && !status.is_empty() {
            break;
        }
    }
    let (done, total) = roadmap_progress(text);
    (title, status, done, total)
}

/// 状态行以「已关闭」或「已废弃」开头时收纳，允许其后附加原因或日期。
pub fn is_archived(status: &str) -> bool {
    let status = status.trim().trim_start_matches('*');
    status.starts_with("已关闭") || status.starts_with("已废弃")
}

/// Flow Coding 只允许写开启阶段；关闭、废弃需同步 §5、CHANGELOG、README 并提交，必须走 skill。
/// 输入：目标状态；归档状态返回带命令提示的错误，其余返回 Ok。
pub fn ensure_ui_status(status: &str) -> Result<(), String> {
    if is_archived(status) {
        return Err("关闭/废弃请在 Agent 会话中运行 /smallcat-feat-5-close 或 /smallcat-feat-drop".into());
    }
    Ok(())
}

/// 从正文前的档案头读取关闭日期；支持与创建日期同一行，缺省返回空串。
pub fn closed_at(text: &str) -> String {
    text.lines().take_while(|l| !l.starts_with("## ")).find_map(|line| {
        let (_, date) = line.split_once("关闭：").or_else(|| line.split_once("关闭:"))?;
        Some(date.trim().split_whitespace().next().unwrap_or("").trim_matches('*').to_string())
    }).unwrap_or_default()
}

/// 只更新档案头的状态和关闭日期，正文、换行风格与创建日期保持原样。
/// 开启可指定需求/开发/测试阶段；字段缺失时在正文前补齐，不改正文中的同名文字。
pub fn with_status(text: &str, status: &str, date: &str) -> Result<String, String> {
    if !["需求整理中", "开发中", "测试中", "已关闭", "已废弃"].contains(&status) {
        return Err(format!("不支持的 Feat 状态: {status}"));
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let date = if is_archived(status) { date } else { "-" };
    let (mut status_seen, mut date_seen, mut in_header) = (false, false, true);
    let mut result = String::new();
    for raw in text.split_inclusive('\n') {
        if in_header && raw.starts_with("## ") {
            if !status_seen { result.push_str(&format!("> 状态：{status}{newline}")); status_seen = true; }
            if !date_seen { result.push_str(&format!("> 关闭：{date}{newline}{newline}")); date_seen = true; }
            in_header = false;
        }
        let body = raw.trim_start_matches(['>', '-', ' ']);
        if in_header && !status_seen && (body.starts_with("状态：") || body.starts_with("状态:")) {
            let colon = raw.find(['：', ':']).unwrap();
            result.push_str(&raw[..colon]);
            result.push_str(&format!("：{status}"));
            if raw.ends_with('\n') { result.push_str(newline); }
            status_seen = true;
        } else if in_header && !date_seen && (raw.contains("关闭：") || raw.contains("关闭:")) {
            let start = raw.find("关闭：").or_else(|| raw.find("关闭:")).unwrap();
            let after = start + if raw[start..].starts_with("关闭：") { "关闭：".len() } else { "关闭:".len() };
            let value = &raw[after..];
            let spaces = value.len() - value.trim_start_matches([' ', '\t']).len();
            let end = value[spaces..].find(char::is_whitespace).map(|i| after + spaces + i).unwrap_or(raw.len());
            result.push_str(&raw[..after]);
            result.push_str(date);
            result.push_str(&raw[end..]);
            date_seen = true;
        } else { result.push_str(raw); }
    }
    if !status_seen || !date_seen {
        if !result.ends_with('\n') { result.push_str(newline); }
        if !status_seen { result.push_str(&format!("> 状态：{status}{newline}")); }
        if !date_seen { result.push_str(&format!("> 关闭：{date}{newline}")); }
    }
    Ok(result)
}

/// 统计 §3.1 路线图：与推进矩阵同一口径（progress::parse），返回 (完成数, 总数)，总数不含暂缓、取消。
fn roadmap_progress(text: &str) -> (usize, usize) {
    let dev = crate::progress::parse(text, "").dev;
    (dev.done, dev.total)
}

/// 汇总一个 APP 的 Feat：读档案摘要，并从该 APP 全部流程图节点中按标签计数。
/// `nodes` 为 (图路径, 节点) 列表，由调用方一次性解析全部流程图后传入。
pub fn summarize(feat_dir: &Path, nodes: &[(String, flow::Node)]) -> Vec<FeatEntry> {
    list_feats(feat_dir)
        .into_iter()
        .map(|p| {
            let id = id_from_name(&p);
            let text = std::fs::read_to_string(&p).unwrap_or_default();
            let (title, status, tasks_done, tasks_total) = parse_md(&text, &id);
            let mine: Vec<flow::Node> = nodes.iter().filter(|(_, n)| n.tags.contains(&id)).map(|(_, n)| n.clone()).collect();
            let counts = flow::count(&mine);
            let node_total = mine.len();
            FeatEntry {
                lock: crate::lock::read(&p).ok().flatten(),
                path: p.to_string_lossy().into_owned(),
                closable: node_total > 0 && counts["none"] == node_total,
                archived: is_archived(&status),
                closed_at: closed_at(&text),
                id,
                title,
                status,
                tasks_done,
                tasks_total,
                counts,
                node_total,
            }
        })
        .collect()
}

/// 解析一组流程图，返回 (图路径, 节点) 列表；解析失败的图跳过。
pub fn collect_nodes(files: &[PathBuf]) -> Vec<(String, flow::Node)> {
    let mut out = Vec::new();
    for f in files {
        let Ok(xml) = std::fs::read_to_string(f) else { continue };
        let Ok(nodes) = flow::parse(&xml) else { continue };
        let fs = f.to_string_lossy().into_owned();
        out.extend(nodes.into_iter().map(|n| (fs.clone(), n)));
    }
    out
}

/// 挂了 tag 的节点（跨图）。
pub fn tagged(nodes: &[(String, flow::Node)], tag: &str) -> Vec<TaggedNode> {
    nodes
        .iter()
        .filter(|(_, n)| n.tags.iter().any(|t| t == tag))
        .map(|(f, n)| TaggedNode { file: f.clone(), node: n.clone() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MD: &str = "# Feat_260910_1 通用检查流程\n\n> 状态：开发中\n> 应用：app_x\n\n## 3. 开发任务\n\n### 3.1 任务路线图\n\n| 编号 | 任务 | 依赖 | 可并行 | 状态 |\n| --- | --- | --- | --- | --- |\n| T1 | a | - | - | 完成 |\n| T2 | b | T1 | - | 进行中 |\n| T3 | c | - | - | 取消 |\n\n### 3.2 开发记录\n| x | y |\n| --- | --- |\n| 1 | 完成 |\n";

    #[test]
    fn parse_md_fields() {
        let (t, s, d, n) = parse_md(MD, "Feat_260910_1");
        assert_eq!(t, "通用检查流程");
        assert_eq!(s, "开发中");
        assert_eq!((d, n), (1, 2), "取消不计入总数");
        let (_, s2, _, n2) = parse_md("# X\n- 状态：已完成\n", "X");
        assert_eq!((s2.as_str(), n2), ("已完成", 0));
    }

    /// 关闭/重开只更改档案头，保留创建时间、正文与 CRLF；缺失字段可补齐。
    #[test]
    fn lifecycle_header_roundtrip() {
        let source = "# Feat_261102_1 测试\r\n\r\n> 状态：开发中\r\n> 创建：2026-10-30　　关闭：-\r\n\r\n## 1. 需求\r\n状态：正文不能改\r\n关闭：正文不能改\r\n";
        let closed = with_status(source, "已关闭", "2026-11-02").unwrap();
        assert!(closed.contains("> 状态：已关闭\r\n"));
        assert!(closed.contains("创建：2026-10-30　　关闭：2026-11-02\r\n"));
        assert!(closed.ends_with("状态：正文不能改\r\n关闭：正文不能改\r\n"));
        assert_eq!(closed_at(&closed), "2026-11-02");
        assert_eq!(with_status(&closed, "开发中", "unused").unwrap(), source);
        assert!(is_archived("已关闭（已发布）"));
        assert!(ensure_ui_status("已关闭").is_err() && ensure_ui_status("已废弃").is_err());
        assert!(ensure_ui_status("开发中").is_ok());
        assert!(is_archived("已废弃"));
        assert!(!is_archived("开发完成，待测试"));
        let minimal = with_status("# Feat\n\n## 1. 需求\nbody\n", "已废弃", "2026-11-02").unwrap();
        assert!(minimal.contains("> 状态：已废弃\n> 关闭：2026-11-02\n\n## 1. 需求"));
        assert!(with_status(source, "typo", "2026-11-02").is_err());
    }

    #[test]
    fn id_and_summary() {
        assert_eq!(id_from_name(Path::new("Feat_260910_1_通用检查.md")), "Feat_260910_1");
        assert_eq!(id_from_name(Path::new("Feat_misc.md")), "Feat_misc");
        let tmp = crate::paths::test_home().join("feat_sum");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Feat_260910_1_通用检查.md"), MD).unwrap();
        let node = |id: &str, st: &str, tags: &[&str]| {
            ("a.drawio".to_string(), flow::Node {
                page_id: "p".into(), page_name: "p".into(), id: id.into(), label: id.into(),
                status: st.into(), fill: String::new(), tags: tags.iter().map(|s| s.to_string()).collect(),
            })
        };
        let nodes = vec![node("a", "confirmed", &["Feat_260910_1"]), node("b", "none", &["Feat_260910_1", "T2"]), node("c", "review", &[])];
        let f = summarize(&tmp, &nodes);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].node_total, 2);
        assert_eq!(f[0].counts["confirmed"], 1);
        assert!(!f[0].closable);
        assert_eq!(tagged(&nodes, "T2").len(), 1);
    }
}
