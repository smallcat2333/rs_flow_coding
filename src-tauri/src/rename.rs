//! 文件树重命名：保留 Feat 编号，同步流程图引用、启停元数据、图间链接和历史登记，拒绝覆盖同名文件。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use serde::Serialize;
use tauri::Emitter;
use crate::{db, feat, lifecycle, links, lock, paths, write_atomic};

/// 更名后的路径，以及引用随之更新的 Feat 档案与流程图。
#[derive(Debug, Serialize)]
pub struct Renamed {
    pub path: String,
    pub changed_feats: Vec<String>,
    /// 因 link 属性指向旧文件名而被改写的流程图（含被改名图自身）。
    pub changed_flows: Vec<String>,
}

/// 同步修改的文本；原文用于加锁后校验和失败回滚。
struct TextEdit { path: PathBuf, before: String, after: String }

/// 只替换完整文件名的节点引用，避免 chat.drawio 误改 mychat.drawio。
fn replace_refs(text: &str, old: &str, new: &str) -> String {
    let needle = format!("{old}#");
    let mut out = String::new();
    let mut from = 0;
    for (i, _) in text.match_indices(&needle) {
        if text[..i].chars().next_back().is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.')) { continue; }
        out.push_str(&text[from..i]); out.push_str(new); out.push('#');
        from = i + needle.len();
    }
    out.push_str(&text[from..]);
    out
}

/// 修改首个一级标题，保留其余内容和换行风格；缺少标题时拒绝更名。
fn retitle(text: &str, id: &str, title: &str) -> Result<String, String> {
    let mut found = false;
    let out = text.split_inclusive('\n').map(|line| {
        if !found && line.trim_start().starts_with("# ") {
            found = true;
            let ending = if line.ends_with("\r\n") { "\r\n" } else if line.ends_with('\n') { "\n" } else { "" };
            format!("# {id} {title}{ending}")
        } else { line.to_string() }
    }).collect();
    if !found { return Err("Feat 缺少一级标题，请先补全档案标题".into()); }
    Ok(out)
}

/// 同目录移动且不覆盖已有目标；Windows 使用 MoveFileW 的原子非覆盖语义。
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" { fn MoveFileW(from: *const u16, to: *const u16) -> i32; }
        let a: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileW(a.as_ptr(), b.as_ptr()) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if to.exists() { return Err("目标文件已存在".into()); }
        std::fs::rename(from, to).map_err(|e| e.to_string())
    }
}

/// 更名及关联更新；先加锁校验，写入失败恢复原文，历史路径在 SQLite 事务中提交。
fn rename_on_disk(path: &Path, name: &str) -> Result<Renamed, String> {
    // 沿用扫描条目的路径表示，与现有编辑锁和历史库的路径键保持一致。
    let path = path.to_path_buf();
    if !path.is_absolute() || !path.is_file() { return Err("文件路径无效，请刷新后重试".into()); }
    let name = name.trim();
    if name.is_empty() || name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) || name.chars().any(char::is_control) || name.ends_with('.') {
        return Err("名称不能为空，不能包含路径分隔符、非法字符或以点结尾".into());
    }
    let dir = path.parent().ok_or("文件缺少父目录")?;
    let flow = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("drawio"));
    let is_feat = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) && path.file_name().unwrap().to_string_lossy().starts_with("Feat_");
    if !(flow && dir.file_name().is_some_and(|n| n == "flow") || is_feat && dir.file_name().is_some_and(|n| n == "feat")) || !dir.parent().is_some_and(|d| d.file_name().is_some_and(|n| n == "docs")) {
        return Err("只能重命名 docs/flow 的流程图和 docs/feat 的 Feat 档案".into());
    }
    let filename = if flow { format!("{name}.drawio") } else { format!("{}_{name}.md", feat::id_from_name(&path)) };
    let target = dir.join(&filename);
    if path == target { return Ok(Renamed { path: target.to_string_lossy().into_owned(), changed_feats: vec![], changed_flows: vec![] }); }
    if target.exists() && paths::key(&path) != paths::key(&target) { return Err(format!("目标文件已存在：{filename}")); }
    let mut edits = Vec::new();
    let mut changed_feats = Vec::new();
    let mut changed_flows = Vec::new();
    if flow {
        let old = path.file_name().unwrap().to_string_lossy();
        for md in feat::list_feats(&feat::feat_dir_of(dir)) {
            let before = std::fs::read_to_string(&md).map_err(|e| e.to_string())?;
            let after = replace_refs(&before, &old, &filename);
            if before != after {
                changed_feats.push(md.to_string_lossy().into_owned());
                edits.push(TextEdit { path: md, before, after });
            }
        }
        // 图间链接：扫描同目录与已配置根下的全部 flow 目录，改写 link 属性里指向旧文件名的引用；
        // 被改名图自身的链接先改写，随后 move_file 把它带到新文件名。
        for (f, before, after) in links::collect_link_edits(&path, &filename)? {
            changed_flows.push(if paths::key(&f) == paths::key(&path) {
                target.to_string_lossy().into_owned()
            } else { f.to_string_lossy().into_owned() });
            edits.push(TextEdit { path: f, before, after });
        }
        let meta = dir.join(".flow-coding.json");
        if meta.exists() {
            let before = std::fs::read_to_string(&meta).map_err(|e| e.to_string())?;
            let mut states = lifecycle::chart_states(dir)?;
            if let Some(state) = states.charts.remove(old.as_ref()) {
                if states.charts.contains_key(&filename) { return Err("目标名称已有启停元数据，请换一个名称".into()); }
                states.charts.insert(filename, state);
                edits.push(TextEdit { path: meta, before, after: serde_json::to_string_pretty(&states).map_err(|e| e.to_string())? });
            }
        }
    } else {
        let before = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let after = retitle(&before, &feat::id_from_name(&path), name)?;
        edits.push(TextEdit { path: path.clone(), before, after });
    }
    let mut candidates = BTreeMap::new();
    for p in std::iter::once(&path).chain(std::iter::once(&target)).chain(edits.iter().map(|e| &e.path)) { candidates.insert(paths::key(p), p.clone()); }
    let mut held = Vec::new();
    let result = (|| {
        for p in candidates.values() {
            if let Some(holder) = lock::read(p)? { return Err(format!("LOCKED:{} 正在编辑 {}，停止编辑后重试", holder.owner, p.display())); }
            if let Err(holder) = lock::acquire(p, "user", lock::USER_TTL)? { return Err(format!("LOCKED:{} 正在编辑", holder.owner)); }
            held.push(p.clone());
        }
        for edit in &edits {
            if std::fs::read_to_string(&edit.path).map_err(|e| e.to_string())? != edit.before { return Err("文件已变化，请刷新后重新命名".into()); }
        }
        let mut conn = db::open()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if flow { tx.execute("UPDATE diagram SET path=?1 WHERE path=?2", rusqlite::params![paths::key(&target), paths::key(&path)]).map_err(|e| format!("无法迁移历史登记：{e}"))?; }
        let mut applied = 0;
        let mut moved = false;
        let written = (|| {
            for edit in &edits { write_atomic(&edit.path, &edit.after)?; applied += 1; }
            move_file(&path, &target)?; moved = true;
            tx.commit().map_err(|e| e.to_string())
        })();
        if let Err(error) = written {
            let mut rollback = Vec::new();
            if moved { if let Err(e) = move_file(&target, &path) { rollback.push(e); } }
            for edit in edits[..applied].iter().rev() { if let Err(e) = write_atomic(&edit.path, &edit.before) { rollback.push(e); } }
            return Err(if rollback.is_empty() { error } else { format!("{error}；恢复失败：{}", rollback.join("；")) });
        }
        Ok(Renamed { path: target.to_string_lossy().into_owned(), changed_feats, changed_flows })
    })();
    for p in held { if let Err(e) = lock::release(&p, "user") { eprintln!("重命名后释放锁失败：{e}"); } }
    result
}

/// 所有窗口完成保存并释放锁后调用；成功通知目录及相关 Markdown 更新。
/// 磁盘事务提交后再同步 Agent 会话引用（feat / 关联节点 / 当前位置 / 任务与主会话名），
/// 改名失败不会走到这里，不会留下指向旧路径的悬挂引用。
#[tauri::command]
pub fn rename_entry(app: tauri::AppHandle, path: String, name: String) -> Result<Renamed, String> {
    let result = rename_on_disk(Path::new(&path), &name)?;
    crate::agent::on_renamed(Path::new(&path), Path::new(&result.path));
    for md in &result.changed_feats {
        if let Ok(text) = std::fs::read_to_string(md) {
            let _ = app.emit("md-changed", crate::ChangeEvent { path: md.clone(), hash: db::hash(&text), source: "user".into() });
        }
    }
    for f in &result.changed_flows {
        if let Ok(text) = std::fs::read_to_string(f) {
            let _ = app.emit("flow-changed", crate::ChangeEvent { path: f.clone(), hash: db::hash(&text), source: "user".into() });
        }
    }
    let _ = app.emit("catalog-changed", ());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 各测试使用独立的临时 APP，避免并行改写样例。
    fn fixture() -> PathBuf {
        let p = paths::test_home().join(format!("rename_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(p.join("docs/flow")).unwrap();
        std::fs::create_dir_all(p.join("docs/feat")).unwrap();
        p
    }
    /// 流程图更名保留快照、停用状态，同步完整引用，不误改后缀相似的文件名。
    #[test]
    fn chart_rename_preserves_links_and_history() {
        let app = fixture(); let dir = app.join("docs/flow"); let old = dir.join("chat.drawio");
        let xml = "<mxfile><diagram><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/></root></mxGraphModel></diagram></mxfile>";
        std::fs::write(&old, xml).unwrap();
        let md = app.join("docs/feat/Feat_261102_1_引用.md");
        std::fs::write(&md, "# Feat_261102_1 引用\nchat.drawio#n1 mychat.drawio#n2 docs/flow/chat.drawio#n3").unwrap();
        std::fs::write(dir.join(".flow-coding.json"), r#"{"charts":{"chat.drawio":{"status":"disabled","disabled_at":"2026-11-02"}}}"#).unwrap();
        db::record(&mut db::open().unwrap(), &old, "sample", xml, "user").unwrap();
        let renamed = rename_on_disk(&old, "聊天").unwrap(); let new = Path::new(&renamed.path);
        assert!(new.exists()); assert!(!old.exists());
        assert!(std::fs::read_to_string(md).unwrap().contains("聊天.drawio#n1 mychat.drawio#n2 docs/flow/聊天.drawio#n3"));
        assert!(lifecycle::chart_states(&dir).unwrap().charts.contains_key("聊天.drawio"));
        assert_eq!(db::list(&db::open().unwrap(), new).unwrap().len(), 1);
    }
    /// 图改名时，其他图指向旧文件名的 link 属性同步改写；同图链接、跨 APP 与网页链接不受影响。
    #[test]
    fn chart_rename_rewrites_flow_links() {
        let app = fixture(); let dir = app.join("docs/flow"); let old = dir.join("chat.drawio");
        let xml = "<mxfile><diagram><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/></root></mxGraphModel></diagram></mxfile>";
        std::fs::write(&old, xml).unwrap();
        let src_xml = r#"<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" link="chat.drawio#n1" vertex="1" parent="1"/><mxCell id="b" link="mychat.drawio" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>"#;
        let src = dir.join("index.drawio");
        std::fs::write(&src, src_xml).unwrap();
        let renamed = rename_on_disk(&old, "聊天").unwrap();
        let after = std::fs::read_to_string(&src).unwrap();
        assert!(after.contains("link=\"聊天.drawio#n1\""));
        assert!(after.contains("link=\"mychat.drawio\""));
        assert_eq!(renamed.changed_flows, vec![src.to_string_lossy().into_owned()]);
    }
    /// 任一引用图被 Agent 持锁时，目标和所有引用文件均保持原样；释放锁后可正常改名。
    #[test]
    fn chart_rename_is_atomic_when_reference_locked() {
        let app = fixture(); let dir = app.join("docs/flow");
        let target = dir.join("target.drawio");
        let source = dir.join("source.drawio");
        let xml = flow_fixture("<object id=\"self\" link=\"target.drawio\"><mxCell vertex=\"1\" parent=\"1\"/></object>");
        std::fs::write(&target, &xml).unwrap();
        std::fs::write(&source, &xml).unwrap();
        lock::acquire(&source, "agent", lock::AGENT_TTL).unwrap().unwrap();
        assert!(rename_on_disk(&target, "new's & name").unwrap_err().starts_with("LOCKED:"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), xml);
        assert_eq!(std::fs::read_to_string(&source).unwrap(), xml);
        assert!(!dir.join("new's & name.drawio").exists());
        lock::release(&source, "agent").unwrap();
        let result = rename_on_disk(&target, "new's & name").unwrap();
        let after = std::fs::read_to_string(source).unwrap();
        assert!(after.contains("new&apos;s &amp; name.drawio"));
        assert!(links::resolve(&dir.join("source.drawio"), "new's & name.drawio#self").is_ok());
        assert!(result.changed_flows.contains(&result.path));
    }

    /// 为改名测试生成单页图，保持对象 link 与坐标可检查。
    fn flow_fixture(body: &str) -> String {
        format!("<mxfile><diagram><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>{body}</root></mxGraphModel></diagram></mxfile>")
    }

    /// Feat 保留编号并同步标题；同名和 Agent 锁均拒绝，不覆盖内容。
    #[test]
    fn feat_rename_rejects_collisions_and_locks() {
        let app = fixture(); let old = app.join("docs/feat/Feat_261102_1_原名.md");
        std::fs::write(&old, "# Feat_261102_1 原名\r\n\r\n正文\r\n").unwrap();
        lock::acquire(&old, "agent", lock::AGENT_TTL).unwrap().unwrap();
        assert!(rename_on_disk(&old, "新名").unwrap_err().starts_with("LOCKED:"));
        lock::release(&old, "agent").unwrap();
        let result = rename_on_disk(&old, "新名").unwrap(); let new = Path::new(&result.path);
        assert_eq!(std::fs::read_to_string(new).unwrap(), "# Feat_261102_1 新名\r\n\r\n正文\r\n");
        std::fs::write(&old, "existing").unwrap();
        assert!(rename_on_disk(new, "原名").is_err());
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "existing");
        assert!(rename_on_disk(new, "../越界").is_err());
    }
}
