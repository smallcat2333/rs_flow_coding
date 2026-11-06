//! Feat 推进进度：从档案正文解析 需求 / UI / 开发 / 测试 / 关闭 五个阶段的完成情况，
//! 以及 §3.1 路线图的 T 与 §3.2 执行表的子 T，供推进矩阵显示。
//!
//! 口径与 smallcat-feat-* skill 的档案模板一致：
//! - 先把 `<!-- -->` 注释换成空白（保留换行），模板里注释中的示例表不计入；
//! - T 状态列以 feat-3-dev「路线图状态词」开头：待开发 / 进行中 / 待用户确认 / 完成 / 暂缓 / 取消，其他开头为未识别；
//! - 返回的行号均为 1 起的源文件行号，前端据此在档案中定位。

use std::path::Path;

use serde::Serialize;

/// T / 子 T 的归一化状态。`Paused`、`Cancelled` 不计入总数。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Todo,
    Doing,
    Waiting,
    Done,
    Paused,
    Cancelled,
    Unknown,
}

/// 按开头词归一化状态列原文；允许前导 `*`（加粗）与空白。顺序上先判「待用户确认」，避免被「待开发」之外的前缀误配。
pub fn task_state(raw: &str) -> TaskState {
    let s = raw.trim().trim_start_matches('*').trim_start();
    const WORDS: [(&str, TaskState); 6] = [
        ("待用户确认", TaskState::Waiting),
        ("待开发", TaskState::Todo),
        ("进行中", TaskState::Doing),
        ("完成", TaskState::Done),
        ("暂缓", TaskState::Paused),
        ("取消", TaskState::Cancelled),
    ];
    WORDS.iter().find(|(w, _)| s.starts_with(w)).map(|(_, st)| *st).unwrap_or(TaskState::Unknown)
}

/// 子 T：§3.2 执行表中首列形如 `T4.1` 的行。`title` 取第 3 列（目标与产物），`line` 为表格行号。
#[derive(Debug, Clone, Serialize)]
pub struct SubTask {
    pub id: String,
    pub title: String,
    pub status: String,
    pub state: TaskState,
    pub line: usize,
}

/// 路线图中的一个 T。
/// - `line`：§3.1 表格行号；`record_line`：§3.2 中首条 `### 日期 [T<N>]` 记录的行号（无记录为 0）；
/// - `first_date` / `last_date`：§3.2 记录标题中的最早与最晚日期，`records` 为记录条数；
/// - `dup`：同一编号在路线图中出现多次（违反「T 编号不复用」）。
#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub deps: String,
    pub status: String,
    pub state: TaskState,
    pub line: usize,
    pub record_line: usize,
    pub first_date: String,
    pub last_date: String,
    pub records: usize,
    pub dup: bool,
    pub subs: Vec<SubTask>,
}

/// 计数类阶段：`done` / `total`，`line` 为该阶段在档案中的章节行号（无章节为 0）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct Tally {
    pub done: usize,
    pub total: usize,
    pub line: usize,
}

/// UI 阶段：§2.1 是否已有总纲、§2.2 控件行数、§2.4 变更日志条数。
#[derive(Debug, Clone, Default, Serialize)]
pub struct UiStage {
    pub has: bool,
    pub controls: usize,
    pub logs: usize,
    pub line: usize,
}

/// 开发阶段：按状态计数的 T（不含子 T）。`total` 不含暂缓、取消。
#[derive(Debug, Clone, Default, Serialize)]
pub struct DevStage {
    pub todo: usize,
    pub doing: usize,
    pub waiting: usize,
    pub done: usize,
    pub paused: usize,
    pub cancelled: usize,
    pub unknown: usize,
    pub total: usize,
    pub line: usize,
}

/// 测试阶段：按表格行统计自测/人工的通过、不通过、未识别与总数；不累加子用例数。
#[derive(Debug, Clone, Default, Serialize)]
pub struct TestStage {
    pub auto_pass: usize,
    pub auto_fail: usize,
    pub auto_unknown: usize,
    pub auto_total: usize,
    pub manual_pass: usize,
    pub manual_fail: usize,
    pub manual_unknown: usize,
    pub manual_total: usize,
    pub issues_open: usize,
    pub issues_total: usize,
    pub line: usize,
}

/// 关闭阶段：§5 发布说明是否已写。
#[derive(Debug, Clone, Default, Serialize)]
pub struct CloseStage {
    pub release: bool,
    pub line: usize,
}

/// 档案正文解析结果（与文件无关的部分）。
/// - `stage`：当前阶段 `req` / `ui` / `dev` / `test` / `close`；
/// - `flag`：`paused`（已暂停）、`dropped`（已废弃），其余为空串。
#[derive(Debug, Clone, Serialize)]
pub struct Parsed {
    pub stage: &'static str,
    pub flag: &'static str,
    pub req: Tally,
    pub ui: UiStage,
    pub dev: DevStage,
    pub test: TestStage,
    pub close: CloseStage,
    pub tasks: Vec<Task>,
}

/// 一份 Feat 档案的推进进度：档案标识 + 正文解析结果（序列化时展开）。
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub path: String,
    pub id: String,
    pub title: String,
    pub status: String,
    pub archived: bool,
    pub closed_at: String,
    #[serde(flatten)]
    pub parsed: Parsed,
}

/// 把 HTML 注释替换为空格，保留换行，使行号与源文件一致。未闭合的注释视为延续到文末。
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail.find("-->").map(|i| i + 3).unwrap_or(tail.len());
        out.extend(tail[..end].chars().map(|c| if c == '\n' { '\n' } else { ' ' }));
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// 章节区间：返回 (标题行号, 区间内 (行号, 行) 列表)。区间从以 `head` 开头的标题下一行开始，
/// 到 `stop` 判定为真的标题为止；`##` 二级章节总是终止区间。找不到标题时行号为 0、列表为空。
fn region<'a>(lines: &[&'a str], head: &str, stop: fn(&str) -> bool) -> (usize, Vec<(usize, &'a str)>) {
    let Some(start) = lines.iter().position(|l| l.trim_start().starts_with(head)) else { return (0, Vec::new()) };
    let body = lines[start + 1..]
        .iter()
        .enumerate()
        .take_while(|(_, l)| {
            let t = l.trim_start();
            !(t.starts_with("## ") || stop(t))
        })
        .map(|(i, l)| (start + 2 + i, *l))
        .collect();
    (start + 1, body)
}

/// 在三级小节处停止（用于 §1.3、§2.x、§3.1、§4.x）。
fn stop_h3(t: &str) -> bool {
    t.starts_with("### ")
}

/// 不在三级小节处停止（§3.2 的记录本身是三级标题，§5 内部可有小节）。
fn stop_never(_: &str) -> bool {
    false
}

/// 区间内的表格数据行：(行号, 单元格)。跳过每张表的表头与分隔行；单元格去首尾空白。
fn table_rows(body: &[(usize, &str)]) -> Vec<(usize, Vec<String>)> {
    let mut out = Vec::new();
    let mut in_table = false;
    for (n, line) in body {
        let l = line.trim();
        if !l.starts_with('|') {
            in_table = false;
            continue;
        }
        if !in_table {
            in_table = true; // 表头
            continue;
        }
        if l.trim_matches(['|', '-', ' ', ':']).is_empty() {
            continue;
        }
        out.push((*n, l.trim_matches('|').split('|').map(|c| c.trim().to_string()).collect()));
    }
    out
}

/// 区间内有实际内容的行数：去掉空行和模板占位（以 `<` 开头）。
fn meaningful(body: &[(usize, &str)]) -> usize {
    body.iter().filter(|(_, l)| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with('<')
    }).count()
}

/// 判断 `T<数字>` 或 `T<数字>.<数字>` 形式的编号；`sub` 为 true 时要求带点号子编号。
fn is_task_id(s: &str, sub: bool) -> bool {
    let Some(rest) = s.strip_prefix('T') else { return false };
    let mut parts = rest.split('.');
    let digits = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    let ok = digits(parts.next());
    if sub { ok && digits(parts.next()) && parts.next().is_none() } else { ok && parts.next().is_none() }
}

/// 判定标准结果或完整数量摘要；正数失败优先，全零或未知文本不推定通过。返回 (通过, 不通过)。
fn verdict(cell: &str) -> (bool, bool) {
    let c = cell.trim();
    let counts: Option<Vec<_>> = c.split(['、', ',', '，', ';', '；', '/']).map(|part| {
        let part = part.trim();
        let end = part.find(|ch: char| !ch.is_ascii_digit()).unwrap_or(part.len());
        if end == 0 { return None; }
        let positive = part[..end].bytes().any(|ch| ch != b'0');
        let word = part[end..].trim().to_ascii_uppercase();
        let pass = match word.as_str() {
            "通过" | "PASSED" | "PASS" => true,
            "不通过" | "失败" | "FAILED" | "FAIL" => false,
            _ => return None,
        };
        Some((positive, pass))
    }).collect();
    if let Some(counts) = counts {
        let fail = counts.iter().any(|(positive, pass)| *positive && !pass);
        return (!fail && counts.iter().any(|(positive, pass)| *positive && *pass), fail);
    }
    let fail = c.starts_with("不通过") || c.starts_with("失败") || c.to_ascii_uppercase().starts_with("FAIL");
    let pass = !fail && (c.starts_with("通过") || c.to_ascii_uppercase().starts_with("PASS"));
    (pass, fail)
}

/// 按结果列统计 (通过, 不通过, 非空未识别, 总数)；每行一项，缺结果列不推定通过。
fn test_tally(lines: &[&str], head: &str) -> (usize, usize, usize, usize) {
    let (_, body) = region(lines, head, stop_h3);
    let col = body.iter().find(|(_, l)| l.trim().starts_with('|')).and_then(|(_, l)| {
        l.trim().trim_matches('|').split('|').position(|c| c.contains("结果"))
    });
    let rows: Vec<_> = table_rows(&body).into_iter().filter(|(_, c)| !c.first().is_some_and(|x| x.starts_with('<'))).collect();
    let (mut pass, mut fail, mut unknown) = (0, 0, 0);
    for (_, cells) in &rows {
        if let Some(cell) = col.and_then(|i| cells.get(i)) {
            let (p, f) = verdict(cell);
            pass += p as usize;
            fail += f as usize;
            unknown += (!cell.trim().is_empty() && !p && !f) as usize;
        }
    }
    (pass, fail, unknown, rows.len())
}

/// §3.2 记录标题 `### YYYY-MM-DD [T<N>] …`：返回 (日期, T 编号)。一条记录可写多个 T（如 `[T2][T3]` 或 `[T2,T3]`）。
fn record_heading(line: &str) -> Option<(String, Vec<String>)> {
    let rest = line.trim_start().strip_prefix("### ")?.trim_start();
    let date: String = rest.chars().take(10).collect();
    let valid = date.len() == 10 && date.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    if !valid {
        return None;
    }
    let mut ids = Vec::new();
    let mut s = &rest[10..];
    while let Some(open) = s.find('[') {
        let Some(close) = s[open..].find(']') else { break };
        for part in s[open + 1..open + close].split([',', '，', '/', ' ']) {
            let id = part.trim();
            if is_task_id(id, false) {
                ids.push(id.to_string());
            }
        }
        s = &s[open + close + 1..];
    }
    Some((date, ids))
}

/// 解析一份档案文本；`header_status` 为档案头状态原文（由 feat::parse_md 取得）。
pub fn parse(text: &str, header_status: &str) -> Parsed {
    let clean = strip_comments(text);
    let lines: Vec<&str> = clean.lines().collect();

    // 需求：§1.3 验收标准复选框，占位条目（框后为空或以 < 开头）不计。
    let (_, acc) = region(&lines, "### 1.3", stop_h3);
    let mut req = Tally { line: region(&lines, "## 1.", stop_never).0, ..Default::default() };
    for (_, l) in &acc {
        let t = l.trim_start().trim_start_matches(['-', '*']).trim_start();
        let (checked, rest) = if let Some(r) = t.strip_prefix("[ ]") { (false, r) } else if let Some(r) = t.strip_prefix("[x]").or_else(|| t.strip_prefix("[X]")) { (true, r) } else { continue };
        let rest = rest.trim();
        if rest.is_empty() || rest.starts_with('<') {
            continue;
        }
        req.total += 1;
        req.done += checked as usize;
    }

    // UI：§2.1 有实际内容即视为已有总纲。
    let ui = UiStage {
        has: meaningful(&region(&lines, "### 2.1", stop_h3).1) > 0,
        controls: table_rows(&region(&lines, "### 2.2", stop_h3).1).iter().filter(|(_, c)| !c.first().is_some_and(|x| x.starts_with('<'))).count(),
        logs: region(&lines, "### 2.4", stop_h3).1.iter().filter(|(_, l)| l.trim_start().starts_with("- ")).count(),
        line: region(&lines, "## 2.", stop_never).0,
    };

    // 开发：§3.1 的 T 行与 §3.2 的子 T 行、记录标题。
    let mut tasks: Vec<Task> = Vec::new();
    for (n, cells) in table_rows(&region(&lines, "### 3.1", stop_h3).1) {
        let Some(id) = cells.first().filter(|c| is_task_id(c, false)) else { continue };
        let status = cells.last().cloned().unwrap_or_default();
        tasks.push(Task {
            id: id.clone(),
            title: cells.get(1).cloned().unwrap_or_default(),
            deps: if cells.len() >= 5 { cells[2].clone() } else { String::new() },
            state: task_state(&status),
            status,
            line: n,
            record_line: 0,
            first_date: String::new(),
            last_date: String::new(),
            records: 0,
            dup: false,
            subs: Vec::new(),
        });
    }
    for i in 0..tasks.len() {
        tasks[i].dup = tasks.iter().filter(|t| t.id == tasks[i].id).count() > 1;
    }
    let (_, rec) = region(&lines, "### 3.2", stop_never);
    for (n, l) in &rec {
        let Some((date, ids)) = record_heading(l) else { continue };
        for t in tasks.iter_mut().filter(|t| ids.contains(&t.id)) {
            if t.record_line == 0 {
                t.record_line = *n;
            }
            if t.first_date.is_empty() || date < t.first_date {
                t.first_date = date.clone();
            }
            if date > t.last_date {
                t.last_date = date.clone();
            }
            t.records += 1;
        }
    }
    for (n, cells) in table_rows(&rec) {
        let Some(id) = cells.first().filter(|c| is_task_id(c, true)) else { continue };
        let parent = id.split('.').next().unwrap_or_default();
        let Some(t) = tasks.iter_mut().find(|t| t.id == parent) else { continue };
        let status = cells.last().cloned().unwrap_or_default();
        let sub = SubTask { id: id.clone(), title: cells.get(2).cloned().unwrap_or_default(), state: task_state(&status), status, line: n };
        // 同一子号后出现的行代表最新状态（返工轮次），覆盖前一行。
        match t.subs.iter_mut().find(|s| s.id == sub.id) {
            Some(old) => *old = sub,
            None => t.subs.push(sub),
        }
    }
    let mut dev = DevStage { line: region(&lines, "## 3.", stop_never).0, ..Default::default() };
    for t in &tasks {
        match t.state {
            TaskState::Todo => dev.todo += 1,
            TaskState::Doing => dev.doing += 1,
            TaskState::Waiting => dev.waiting += 1,
            TaskState::Done => dev.done += 1,
            TaskState::Paused => dev.paused += 1,
            TaskState::Cancelled => dev.cancelled += 1,
            TaskState::Unknown => dev.unknown += 1,
        }
    }
    dev.total = tasks.len() - dev.paused - dev.cancelled;

    // 测试：§4.1 / §4.2 结果列，§4.3 以「- 」开头的问题行，含「复测：通过」视为闭环。
    let (auto_pass, auto_fail, auto_unknown, auto_total) = test_tally(&lines, "### 4.1");
    let (manual_pass, manual_fail, manual_unknown, manual_total) = test_tally(&lines, "### 4.2");
    let issues: Vec<_> = region(&lines, "### 4.3", stop_h3).1.into_iter().filter(|(_, l)| l.trim_start().starts_with("- ")).collect();
    let issues_open = issues.iter().filter(|(_, l)| !(l.contains("复测：通过") || l.contains("复测:通过"))).count();
    let test = TestStage {
        auto_pass, auto_fail, auto_unknown, auto_total, manual_pass, manual_fail, manual_unknown, manual_total,
        issues_open, issues_total: issues.len(),
        line: region(&lines, "## 4.", stop_never).0,
    };

    let (close_line, release) = region(&lines, "## 5.", stop_never);
    let close = CloseStage { release: meaningful(&release) > 0, line: close_line };

    // 当前阶段以档案头状态为准；需求阶段已写 §2.1 视为进入 UI；暂停、废弃及词表外状态按内容推断。
    let s = header_status.trim();
    let inferred = if test.auto_total + test.manual_total > 0 { "test" } else if !tasks.is_empty() { "dev" } else if ui.has { "ui" } else { "req" };
    let (stage, flag) = if s.starts_with("探讨中") || s.starts_with("需求整理中") {
        (if ui.has { "ui" } else { "req" }, "")
    } else if s.starts_with("开发中") {
        ("dev", "")
    } else if s.starts_with("测试中") {
        ("test", "")
    } else if s.starts_with("已关闭") {
        ("close", "")
    } else if s.starts_with("已暂停") {
        (inferred, "paused")
    } else if s.starts_with("已废弃") {
        (inferred, "dropped")
    } else {
        (inferred, "")
    };
    Parsed { stage, flag, req, ui, dev, test, close, tasks }
}

/// 读取一个 APP 的全部 Feat 档案并解析进度，按文件名倒序（新编号在前）。读取失败的档案跳过。
pub fn of_dir(feat_dir: &Path) -> Vec<Progress> {
    crate::feat::list_feats(feat_dir)
        .into_iter()
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            let id = crate::feat::id_from_name(&p);
            let (title, status, _, _) = crate::feat::parse_md(&text, &id);
            Some(Progress {
                path: p.to_string_lossy().into_owned(),
                archived: crate::feat::is_archived(&status),
                closed_at: crate::feat::closed_at(&text),
                parsed: parse(&text, &status),
                id, title, status,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MD: &str = "# Feat_261103_1 示例\n\n> 状态：开发中\n\n## 1. 需求\n\n### 1.3 验收标准\n- [x] 能打开\n- [ ] 能保存\n- [ ] <占位>\n\n### 1.4 初步路线\n\n## 2. 原型\n\n### 2.1 设计总纲\n左右两栏。\n\n### 2.2 控件清单\n| 控件对象名 | 类型 | 用途 |\n| --- | --- | --- |\n| btn_ok | QPushButton | 确定 |\n\n### 2.4 UI 变更日志\n<!-- - 示例 -->\n- 2026-11-03 新增按钮\n\n## 3. 开发任务\n\n### 3.1 任务路线图\n<!--\n| 编号 | 任务 | 依赖 | 可并行 | 状态 |\n| --- | --- | --- | --- | --- |\n| T1 | 模板 | - | - | 待开发/进行中/完成/取消 |\n-->\n| 编号 | 任务 | 依赖 | 可并行 | 状态 |\n| --- | --- | --- | --- | --- |\n| T1 | 解析 | - | T2 | 完成（离线验收） |\n| T2 | 界面 | T1 | - | 进行中 |\n| T3 | 真机 | T2 | - | 待用户确认 |\n| T4 | 旧项 | - | - | 取消 |\n| T5 | 旧写法 | - | - | 已完成 |\n\n### 3.2 开发记录\n### 2026-11-01 [T1] 解析\n- 方案：x\n### 2026-11-03 [T2][T1] 界面\n| 子任务编号 | 执行者 | 目标与产物 | 依赖 | 可写范围 | 状态 / 验证与提交证据 |\n| --- | --- | --- | --- | --- | --- |\n| T2.1 | ar-1 | 表格 | - | ui | 进行中 |\n| T2.2 | 主Harness | 联动 | T2.1 | ui | 待开发 |\n| T2.1 | ar-1 | 表格 | - | ui | 完成；12项通过 |\n\n## 4. 测试记录\n\n### 4.1 程序自测（Agent 执行）\n| # | 自测项 | 方式 | 结果 | 备注 |\n| --- | --- | --- | --- | --- |\n| 1 | a | pytest | 通过 | |\n| 2 | b | pytest | 不通过 | |\n\n### 4.2 人工确认清单（用户执行）\n| # | 测试项 | 操作/输入 | 预期 | 结果 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | c | d | e |  | |\n\n### 4.3 问题与修复\n- 2026-11-03 a -> b -> 复测：通过\n- 2026-11-03 c -> d -> 复测：未复测\n\n## 5. 发布说明\n";

    /// Rust/JS 共用同一结果表；同时验证自测与人工的判定、未识别统计及空白边界。
    #[test]
    fn shared_test_verdicts() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../tests/fixtures/test_verdicts.json")).unwrap();
        for case in cases {
            let text = case["text"].as_str().unwrap();
            let expected = case["verdict"].as_str().unwrap();
            assert_eq!(verdict(text), (expected == "pass", expected == "fail"), "{text}");
            let doc = format!("# X\n\n## 4. 测试记录\n\n### 4.1 自测\n| # | 自测项 | 结果 |\n| --- | --- | --- |\n| 1 | 检查 | {text} |\n\n### 4.2 人工\n| # | 测试项 | 结果 |\n| --- | --- | --- |\n| 1 | 检查 | {text} |\n");
            let t = parse(&doc, "测试中").test;
            let counts = ((expected == "pass") as usize, (expected == "fail") as usize, (expected == "other") as usize, 1);
            assert_eq!((t.auto_pass, t.auto_fail, t.auto_unknown, t.auto_total), counts, "自测：{text}");
            assert_eq!((t.manual_pass, t.manual_fail, t.manual_unknown, t.manual_total), counts, "人工：{text}");
        }
    }

    /// 按档案表格的12个测试组统计，混合组有失败即不通过，不累加48个子用例。
    #[test]
    fn grouped_test_results() {
        let values = ["17 通过", "2 通过", "3 通过、5 失败", "2 失败", "4 失败", "1 失败", "4 通过、2 失败", "1 通过、4 失败", "1 失败", "2 失败", "通过（有限验证）", "通过"];
        let rows = values.iter().enumerate().map(|(i, value)| format!("| {} | 检查 | {value} |", i + 1)).collect::<Vec<_>>().join("\n");
        let doc = format!("# X\n\n## 4. 测试记录\n\n### 4.1 自测\n| # | 自测项 | 结果 |\n| --- | --- | --- |\n{rows}\n");
        let t = parse(&doc, "测试中").test;
        assert_eq!((t.auto_pass, t.auto_fail, t.auto_unknown, t.auto_total), (4, 8, 0, 12));
    }

    /// 状态词按开头匹配，说明写在括号或分号后；近义词与空白为未识别。
    #[test]
    fn state_words() {
        assert_eq!(task_state("完成（离线验收）"), TaskState::Done);
        assert_eq!(task_state("**完成**；85项通过"), TaskState::Done);
        assert_eq!(task_state("待用户确认（真机）"), TaskState::Waiting);
        assert_eq!(task_state("待开发（后续批次）"), TaskState::Todo);
        assert_eq!(task_state("暂缓"), TaskState::Paused);
        assert_eq!(task_state("已完成"), TaskState::Unknown);
        assert_eq!(task_state(""), TaskState::Unknown);
    }

    /// 各阶段计数、注释中的模板表不计入、子 T 以最后一行为准、记录行号与日期。
    #[test]
    fn parse_stages_and_tasks() {
        let Parsed { req, ui, dev, test, close, tasks, stage, flag } = parse(MD, "开发中");
        assert_eq!((req.done, req.total), (1, 2));
        assert!(ui.has && ui.controls == 1 && ui.logs == 1);
        assert_eq!(tasks.len(), 5, "注释里的模板行不计入");
        assert_eq!((dev.done, dev.doing, dev.waiting, dev.cancelled, dev.unknown, dev.total), (1, 1, 1, 1, 1, 4));
        let t1 = &tasks[0];
        assert_eq!((t1.first_date.as_str(), t1.last_date.as_str(), t1.records), ("2026-11-01", "2026-11-03", 2));
        assert_eq!(MD.lines().nth(t1.line - 1).unwrap(), "| T1 | 解析 | - | T2 | 完成（离线验收） |");
        assert!(MD.lines().nth(t1.record_line - 1).unwrap().starts_with("### 2026-11-01 [T1]"));
        let t2 = &tasks[1];
        assert_eq!(t2.deps, "T1");
        assert_eq!(t2.subs.len(), 2);
        assert_eq!((t2.subs[0].state, t2.subs[0].title.as_str()), (TaskState::Done, "表格"));
        assert_eq!((test.auto_pass, test.auto_fail, test.auto_total), (1, 1, 2));
        assert_eq!((test.manual_pass, test.manual_total), (0, 1));
        assert_eq!((test.issues_open, test.issues_total), (1, 2));
        assert!(!close.release && close.line > 0);
        assert_eq!((stage, flag), ("dev", ""));
    }

    /// 档案头状态决定当前阶段；需求阶段写了总纲进入 UI；重复编号标记 dup。
    #[test]
    fn stage_from_header_and_dup() {
        let doc = "# X\n\n## 2. 原型\n\n### 2.1 设计总纲\n总纲\n\n## 3. 开发任务\n\n### 3.1 任务路线图\n| 编号 | 任务 | 依赖 | 可并行 | 状态 |\n| --- | --- | --- | --- | --- |\n| T1 | a | - | - | 完成 |\n| T1 | b | - | - | 待开发 |\n";
        assert_eq!(parse(doc, "需求整理中").stage, "ui");
        assert_eq!(parse(doc, "已暂停").stage, "dev");
        assert_eq!(parse(doc, "已暂停").flag, "paused");
        assert_eq!(parse(doc, "已关闭").stage, "close");
        assert!(parse(doc, "开发中").tasks.iter().all(|t| t.dup));
        assert_eq!(parse("# Y\n", "探讨中").stage, "req");
    }
}
