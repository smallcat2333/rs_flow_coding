//! flowctl：Agent 侧命令行，与 App 共用锁和历史库。
//!
//! 用法：
//!   flowctl lock <file> [--wait 秒]   加 Agent 锁；被用户持有时等待至超时（默认 0 不等），失败退出码 2
//!   flowctl unlock <file>             释放 Agent 锁，并把当前内容记入历史（source=agent）
//!   flowctl status <file>             输出锁 JSON（无锁输出 null）
//!   flowctl stats <file|dir>...       输出各图状态计数 JSON
//!   flowctl nodes <file> [--status s] 输出节点列表 JSON，可按状态过滤
//!   flowctl new <dir> <name>          新建空白 .drawio
//!
//! 约定：Agent 修改流程图必须 `lock → 编辑 → unlock`；编辑超 10 分钟需重新 lock 刷新。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rs_flow_coding_lib::{db, flow, lock, paths, scan, write_atomic};

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

/// lock：循环尝试加锁直到成功或超时；成功输出锁 JSON。
fn cmd_lock(args: &[String]) -> Result<ExitCode, String> {
    let p = paths::norm(Path::new(&arg(args, 2, "file")?))?;
    let wait: u64 = opt(args, "--wait").map(|s| s.parse().map_err(|_| "--wait 需为整数秒")).transpose()?.unwrap_or(0);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait);
    loop {
        match lock::acquire(&p, "agent", lock::AGENT_TTL)? {
            Ok(l) => {
                // 加锁时记一次基线快照，便于对比 Agent 本次改了什么
                let xml = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
                let mut conn = db::open()?;
                db::record(&mut conn, &p, &scan::app_label(&p), &xml, "external")?;
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
    let xml = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    flow::parse(&xml).map_err(|e| format!("{e}；锁未释放，请修正后再 unlock"))?;
    let mut conn = db::open()?;
    db::record(&mut conn, &p, &scan::app_label(&p), &xml, "agent")?;
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
        _ => Err("用法: flowctl <lock|unlock|status|stats|nodes|new> ...（详见源码顶部说明）".into()),
    };
    r.unwrap_or_else(fail)
}
