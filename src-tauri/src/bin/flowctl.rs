//! flowctl：Agent 侧命令行，与 App 共用锁和历史库。
//!
//! 用法：
//!   flowctl lock <file> [--wait 秒]   加 Agent 锁（.drawio 或 Feat 档案 .md）；被用户持有时等待至超时（默认 0 不等），失败退出码 2
//!   flowctl unlock <file>             释放 Agent 锁；.drawio 先校验 XML 并记入历史（source=agent）
//!   flowctl status <file>             输出锁 JSON（无锁输出 null）
//!   flowctl stats <file|dir>...       输出各图状态计数 JSON
//!   flowctl nodes <file> [--status s] 输出节点列表 JSON，可按状态过滤
//!   flowctl new <dir> <name>          新建空白 .drawio
//!   flowctl feat <feat.md> [--status s]  列出同 APP 流程图中挂了该 Feat 编号标签的节点
//!   flowctl check <feat.md>           Feat 关闭门槛：挂了该 Feat 的节点全部无色才退出码 0，否则 3
//!   flowctl links <file|dir>...       校验图间链接（link="图.drawio[#节点id]"）：目标文件与节点都存在才退出码 0，有坏链接退出码 3
//!
//! Agent 窗口会话内可用（依赖 Flow Coding 下发的 FLOW_AGENT_* 环境变量）：
//!   flowctl focus <图文件>#<节点id>     标记当前处理的节点，主窗口在该节点上显示本会话；--clear 清除
//!   flowctl focus <Feat档案>#T<编号>    标记当前处理的 Feat 任务（如 #T3、#T3.1），Feat 控件页在该任务卡片上显示本会话
//!   flowctl peers                     列出同 APP 的其他会话
//!   flowctl send <会话名> <消息>       给同 APP 会话发协作消息（对方运行中则排队到它本轮结束）
//!   flowctl agent-hook <事件>          Claude Code hook 回报（stdin 为 hook JSON），始终退出码 0
//!
//! 约定：Agent 修改流程图或 Feat 档案必须 `lock → 编辑 → unlock`；编辑超 10 分钟需重新 lock 刷新。
//! 节点关联 Feat：在 `<object>` 上写 `tags="Feat_YYMMDD_N"`（可多个，空格分隔）。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use flow_coding_lib::{agent, db, feat, flow, links, lock, paths, scan, write_atomic};

/// 打印错误并返回退出码 1。
fn fail(msg: impl std::fmt::Display) -> ExitCode {
    eprintln!("flowctl: {msg}");
    ExitCode::from(1)
}

/// 取第 i 个参数，缺失报错。
fn arg(args: &[String], i: usize, name: &str) -> Result<String, String> {
    args.get(i).cloned().ok_or_else(|| format!("缺少参数 <{name}>"))
}

/// 取 `--key value` 选项值。
fn opt(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1).cloned())
}

/// 是否流程图文件（.drawio）；其他文件（如 Feat 档案 .md）只加锁、不做 XML 校验与历史记录。
fn is_drawio(p: &Path) -> bool {
    p.extension().is_some_and(|x| x.eq_ignore_ascii_case("drawio"))
}

/// lock：循环尝试加锁直到成功或超时；成功输出锁 JSON。
fn cmd_lock(args: &[String]) -> Result<ExitCode, String> {
    let p = paths::norm(Path::new(&arg(args, 2, "file")?))?;
    let wait: u64 = opt(args, "--wait").map(|s| s.parse().map_err(|_| "--wait 需为整数秒")).transpose()?.unwrap_or(0);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait);
    loop {
        match lock::acquire(&p, "agent", lock::AGENT_TTL)? {
            Ok(l) => {
                // 加锁时记一次基线快照，便于对比 Agent 本次改了什么
                if is_drawio(&p) {
                    let xml = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
                    let mut conn = db::open()?;
                    db::record(&mut conn, &p, &scan::app_label(&p), &xml, "external")?;
                }
                println!("{}", serde_json::to_string(&l).unwrap());
                return Ok(ExitCode::SUCCESS);
            }
            Err(holder) if std::time::Instant::now() >= deadline => {
                eprintln!("flowctl: 图被 {} 持有（pid {}，心跳 {}）", holder.owner, holder.pid, holder.heartbeat);
                return Ok(ExitCode::from(2));
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(500)),
        }
    }
}

/// unlock：校验 XML 可解析 → 记快照（agent）→ 释放锁。XML 损坏时不释放并报错，避免把坏图交给用户。
fn cmd_unlock(args: &[String]) -> Result<ExitCode, String> {
    let p = paths::norm(Path::new(&arg(args, 2, "file")?))?;
    if is_drawio(&p) {
        let xml = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
        flow::parse(&xml).map_err(|e| format!("{e}；锁未释放，请修正后再 unlock"))?;
        let mut conn = db::open()?;
        db::record(&mut conn, &p, &scan::app_label(&p), &xml, "agent")?;
    }
    let released = lock::release(&p, "agent")?;
    println!("{}", serde_json::json!({ "released": released }));
    Ok(ExitCode::SUCCESS)
}

/// 展开参数为 .drawio 文件列表：目录取其下（不递归）全部 .drawio。
fn expand(items: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for it in items {
        let p = paths::norm(Path::new(it))?;
        if p.is_dir() { out.extend(scan::list_drawio(&p)) } else { out.push(p) }
    }
    Ok(out)
}

/// stats：逐图输出 {path, counts} 与合计。
fn cmd_stats(args: &[String]) -> Result<ExitCode, String> {
    let files = expand(&args[2..])?;
    let mut total = flow::empty_counts();
    let mut rows = Vec::new();
    for f in files {
        let xml = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
        let c = flow::count(&flow::parse(&xml)?);
        for (k, v) in &c {
            *total.get_mut(k).unwrap() += v;
        }
        rows.push(serde_json::json!({ "path": f, "counts": c }));
    }
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "files": rows, "total": total })).unwrap());
    Ok(ExitCode::SUCCESS)
}

/// nodes：输出节点列表，可 `--status review` 过滤。
fn cmd_nodes(args: &[String]) -> Result<ExitCode, String> {
    let p = paths::norm(Path::new(&arg(args, 2, "file")?))?;
    let want = opt(args, "--status");
    let xml = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let nodes: Vec<_> = flow::parse(&xml)?.into_iter().filter(|n| want.as_deref().is_none_or(|w| n.status == w)).collect();
    println!("{}", serde_json::to_string_pretty(&nodes).unwrap());
    Ok(ExitCode::SUCCESS)
}

/// new：新建空白图，同名存在报错。
fn cmd_new(args: &[String]) -> Result<ExitCode, String> {
    let dir = PathBuf::from(arg(args, 2, "dir")?);
    let name = arg(args, 3, "name")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let f = dir.join(format!("{}.drawio", name.trim_end_matches(".drawio")));
    if f.exists() {
        return Err(format!("文件已存在: {}", f.display()));
    }
    write_atomic(&f, &flow::blank_diagram(&name))?;
    println!("{}", f.display());
    Ok(ExitCode::SUCCESS)
}

/// 由 Feat 档案路径推导同 APP 的流程图文件列表（`docs/feat/x.md` → `docs/flow/*.drawio`）。
fn flows_of_feat(md: &Path) -> Result<Vec<PathBuf>, String> {
    let docs = md.parent().and_then(Path::parent).ok_or("Feat 档案应位于 <app>/docs/feat/ 下")?;
    Ok(scan::list_drawio(&docs.join("flow")))
}

/// feat：列出挂了该 Feat 编号标签的全部节点（跨同 APP 流程图），可 `--status` 过滤。
fn cmd_feat(args: &[String]) -> Result<ExitCode, String> {
    let md = paths::norm(Path::new(&arg(args, 2, "feat.md")?))?;
    let id = feat::id_from_name(&md);
    let want = opt(args, "--status");
    let nodes: Vec<_> = feat::tagged(&feat::collect_nodes(&flows_of_feat(&md)?), &id)
        .into_iter()
        .filter(|t| want.as_deref().is_none_or(|w| t.node.status == w))
        .collect();
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "feat": id, "nodes": nodes })).unwrap());
    Ok(ExitCode::SUCCESS)
}

/// check：Feat 关闭门槛。挂了该 Feat 的节点必须至少 1 个且全部为无色（已实现），否则退出码 3 并列出未完成节点。
fn cmd_check(args: &[String]) -> Result<ExitCode, String> {
    let md = paths::norm(Path::new(&arg(args, 2, "feat.md")?))?;
    let id = feat::id_from_name(&md);
    let nodes = feat::tagged(&feat::collect_nodes(&flows_of_feat(&md)?), &id);
    let pending: Vec<_> = nodes.iter().filter(|t| t.node.status != "none").collect();
    let ok = !nodes.is_empty() && pending.is_empty();
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "feat": id, "ok": ok, "total": nodes.len(), "pending": pending,
            "reason": if nodes.is_empty() { "没有节点挂该 Feat 标签" } else if ok { "" } else { "存在非无色节点" },
        }))
        .unwrap()
    );
    Ok(if ok { ExitCode::SUCCESS } else { ExitCode::from(3) })
}

/// links：校验图间链接。每张图收集 link 属性中的本地 .drawio 引用并逐个 resolve；
/// 有坏链接退出码 3（供脚本判断），读文件/XML 失败按 broken 记录同样退出 3。
fn cmd_links(args: &[String]) -> Result<ExitCode, String> {
    if args.len() < 3 { return Err("缺少参数 <file|dir>".into()); }
    let files = expand(&args[2..])?;
    if files.is_empty() { return Err("links: 没有匹配的 .drawio 文件".into()); }
    let mut total = 0usize;
    let mut broken: Vec<links::BrokenLink> = Vec::new();
    for f in files {
        let xml = match std::fs::read_to_string(&f) {
            Ok(x) => x,
            Err(e) => {
                broken.push(links::BrokenLink { file: f.to_string_lossy().into_owned(), node: String::new(), link: String::new(), error: format!("读取失败: {e}") });
                continue;
            }
        };
        let cells = match links::link_cells(&xml) {
            Ok(c) => c,
            Err(e) => {
                broken.push(links::BrokenLink { file: f.to_string_lossy().into_owned(), node: String::new(), link: String::new(), error: e });
                continue;
            }
        };
        for c in cells {
            total += 1;
            if let Err(e) = links::resolve(&f, &c.link) {
                broken.push(links::BrokenLink { file: f.to_string_lossy().into_owned(), node: c.id, link: c.link, error: e });
            }
        }
    }
    let ok = broken.is_empty();
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({ "ok": ok, "total": total, "broken": broken }))
            .unwrap()
    );
    Ok(if ok { ExitCode::SUCCESS } else { ExitCode::from(3) })
}

/// agent-hook：读 stdin 的 hook JSON 转发给 App。任何失败都忽略并退出码 0，不能拖住 Claude Code。
fn cmd_agent_hook(args: &[String]) -> ExitCode {
    use std::io::Read;
    let mut text = String::new();
    let _ = std::io::stdin().read_to_string(&mut text);
    let payload: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let event = args.get(2).cloned().unwrap_or_default();
    let _ = agent::client(serde_json::json!({ "op": "hook", "event": event, "payload": payload }));
    ExitCode::SUCCESS
}

/// focus / peers / send：转发给 App 并输出结果 JSON。
fn cmd_agent(args: &[String]) -> Result<ExitCode, String> {
    let req = match args[1].as_str() {
        "focus" => {
            let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            serde_json::json!({ "op": "focus", "ref": arg(args, 2, "图文件#节点id 或 Feat档案#T编号")?, "cwd": cwd })
        }
        "peers" => serde_json::json!({ "op": "peers" }),
        _ => serde_json::json!({ "op": "send", "to": arg(args, 2, "会话名")?, "text": args.get(3..).map(|a| a.join(" ")).unwrap_or_default() }),
    };
    let v = agent::client(req)?;
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let r = match args.get(1).map(String::as_str) {
        Some("lock") => cmd_lock(&args),
        Some("unlock") => cmd_unlock(&args),
        Some("status") => paths::norm(Path::new(&args.get(2).cloned().unwrap_or_default()))
            .and_then(|p| lock::read(&p))
            .map(|l| {
                println!("{}", serde_json::to_string(&l).unwrap());
                ExitCode::SUCCESS
            }),
        Some("stats") => cmd_stats(&args),
        Some("nodes") => cmd_nodes(&args),
        Some("new") => cmd_new(&args),
        Some("feat") => cmd_feat(&args),
        Some("check") => cmd_check(&args),
        Some("links") => cmd_links(&args),
        Some("agent-hook") => return cmd_agent_hook(&args),
        Some("focus" | "peers" | "send") => cmd_agent(&args),
        _ => Err("用法: flowctl <lock|unlock|status|stats|nodes|new|feat|check|links|focus|peers|send> ...（详见源码顶部说明）".into()),
    };
    r.unwrap_or_else(fail)
}
