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

/// 统计 §3.1 路线图：小节标题以 `### 3.1` 开头，到下一个 `##`/`###` 为止；
/// 跳过表头与分隔行，状态列为末列，「完成」「取消」计为已完成。
fn roadmap_progress(text: &str) -> (usize, usize) {
    let mut in_sec = false;
    let (mut done, mut total) = (0, 0);
    let mut header_seen = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with("### 3.1") {
            in_sec = true;
            continue;
        }
        if in_sec && (l.starts_with("## ") || l.starts_with("### ")) {
            break;
        }
        if !in_sec || !l.starts_with('|') {
            continue;
        }
        if !header_seen {
            header_seen = true;
            continue;
        }
        if l.trim_matches(['|', '-', ' ', ':']).is_empty() {
            continue;
        }
        let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
        let Some(st) = cells.last() else { continue };
        total += 1;
        if st.contains("完成") || st.contains("取消") {
            done += 1;
        }
    }
    (done, total)
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
        assert_eq!((d, n), (2, 3));
        let (_, s2, _, n2) = parse_md("# X\n- 状态：已完成\n", "X");
        assert_eq!((s2.as_str(), n2), ("已完成", 0));
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
