//! SQLite 历史库：每次流程图内容变化记一个快照，并存该快照下全部节点状态，用于统计回看与版本对比。
//!
//! 表结构：
//! - `diagram(id, path UNIQUE, app)`：流程图登记，path 为规范路径；
//! - `snapshot(id, diagram_id, ts, source, hash, xml)`：内容快照，source ∈ user/agent/external/scan/restore；
//! - `node_state(snapshot_id, page_id, page_name, node_id, label, status, fill)`：快照节点。
//!
//! App 与 flowctl 可能同时写库：开 WAL + busy_timeout。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::flow::{self, Counts, Node};

/// 一个快照的摘要（不含 XML）。`counts` 为该快照各状态计数。
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotInfo {
    pub id: i64,
    pub ts: String,
    pub source: String,
    pub hash: String,
    pub counts: Counts,
}

/// 两个快照之间单个节点的变化。`kind` ∈ added/removed/changed；
/// changed 时 `old_*` 与 `new_*` 至少一项不同。
#[derive(Debug, Clone, Serialize)]
pub struct NodeChange {
    pub kind: String,
    pub page_name: String,
    pub node_id: String,
    pub old_label: String,
    pub new_label: String,
    pub old_status: String,
    pub new_status: String,
}

/// 计算内容哈希：sha256 十六进制。
pub fn hash(xml: &str) -> String {
    hex::encode(Sha256::digest(xml.as_bytes()))
}

/// 打开（必要时建表）数据目录下的 `flow.db`。
pub fn open() -> Result<Connection, String> {
    let path = crate::paths::home()?.join("flow.db");
    let conn = Connection::open(&path).map_err(|e| format!("打开数据库失败 {}: {e}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS diagram(
            id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, app TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS snapshot(
            id INTEGER PRIMARY KEY, diagram_id INTEGER NOT NULL REFERENCES diagram(id),
            ts TEXT NOT NULL, source TEXT NOT NULL, hash TEXT NOT NULL, xml TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS ix_snapshot_diagram ON snapshot(diagram_id, id);
         CREATE TABLE IF NOT EXISTS node_state(
            snapshot_id INTEGER NOT NULL REFERENCES snapshot(id),
            page_id TEXT NOT NULL, page_name TEXT NOT NULL, node_id TEXT NOT NULL,
            label TEXT NOT NULL, status TEXT NOT NULL, fill TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS ix_node_snapshot ON node_state(snapshot_id);",
    )
    .map_err(|e| format!("建表失败: {e}"))?;
    Ok(conn)
}

/// 取或建流程图登记，返回 diagram.id。app 每次覆盖为最新归属。
fn diagram_id(conn: &Connection, path: &str, app: &str) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO diagram(path, app) VALUES(?1, ?2) ON CONFLICT(path) DO UPDATE SET app=excluded.app",
        params![path, app],
    )?;
    conn.query_row("SELECT id FROM diagram WHERE path=?1", params![path], |r| r.get(0))
}

/// 记录快照：内容与该图最新快照哈希相同则跳过。
/// 输入：规范路径、所属 app、XML、来源；输出：新快照 id，跳过时 None。XML 无法解析时报错且不入库。
pub fn record(conn: &mut Connection, path: &Path, app: &str, xml: &str, source: &str) -> Result<Option<i64>, String> {
    let nodes = flow::parse(xml)?;
    let h = hash(xml);
    let key = crate::paths::key(path);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let did = diagram_id(&tx, &key, app).map_err(|e| e.to_string())?;
    let last: Option<String> = tx
        .query_row("SELECT hash FROM snapshot WHERE diagram_id=?1 ORDER BY id DESC LIMIT 1", params![did], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if last.as_deref() == Some(h.as_str()) {
        return Ok(None);
    }
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    tx.execute(
        "INSERT INTO snapshot(diagram_id, ts, source, hash, xml) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![did, ts, source, h, xml],
    )
    .map_err(|e| e.to_string())?;
    let sid = tx.last_insert_rowid();
    {
        let mut st = tx
            .prepare("INSERT INTO node_state(snapshot_id, page_id, page_name, node_id, label, status, fill) VALUES(?1,?2,?3,?4,?5,?6,?7)")
            .map_err(|e| e.to_string())?;
        for n in &nodes {
            st.execute(params![sid, n.page_id, n.page_name, n.id, n.label, n.status, n.fill])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(sid))
}

/// 读取快照下的节点。
fn nodes_of(conn: &Connection, sid: i64) -> Result<Vec<Node>, String> {
    let mut st = conn
        .prepare("SELECT page_id, page_name, node_id, label, status, fill FROM node_state WHERE snapshot_id=?1")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![sid], |r| {
            Ok(Node {
                page_id: r.get(0)?,
                page_name: r.get(1)?,
                id: r.get(2)?,
                label: r.get(3)?,
                status: r.get(4)?,
                fill: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 列出某图全部快照（新→旧），附各快照状态计数。图未登记返回空。
pub fn list(conn: &Connection, path: &Path) -> Result<Vec<SnapshotInfo>, String> {
    let key = crate::paths::key(path);
    let mut st = conn
        .prepare(
            "SELECT s.id, s.ts, s.source, s.hash FROM snapshot s JOIN diagram d ON d.id=s.diagram_id
             WHERE d.path=?1 ORDER BY s.id DESC",
        )
        .map_err(|e| e.to_string())?;
    let heads = st
        .query_map(params![key], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<(i64, String, String, String)>, _>>()
        .map_err(|e| e.to_string())?;
    let mut cnt = conn
        .prepare("SELECT status, COUNT(*) FROM node_state WHERE snapshot_id=?1 GROUP BY status")
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(heads.len());
    for (id, ts, source, hash) in heads {
        let mut counts = flow::empty_counts();
        let rows = cnt
            .query_map(params![id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (s, n) = row.map_err(|e| e.to_string())?;
            counts.insert(s, n as usize);
        }
        out.push(SnapshotInfo { id, ts, source, hash, counts });
    }
    Ok(out)
}

/// 取快照 XML。
pub fn xml_of(conn: &Connection, sid: i64) -> Result<String, String> {
    conn.query_row("SELECT xml FROM snapshot WHERE id=?1", params![sid], |r| r.get(0))
        .map_err(|e| format!("快照 {sid} 不存在: {e}"))
}

/// 对比两个快照（old → new）：按 (page_id, node_id) 匹配节点，输出新增/删除/文字或状态变化。
pub fn diff(conn: &Connection, old: i64, new: i64) -> Result<Vec<NodeChange>, String> {
    Ok(diff_nodes(&nodes_of(conn, old)?, &nodes_of(conn, new)?))
}

/// 节点列表对比的纯逻辑，便于单测。输出顺序：先按新图顺序的 changed/added，再 removed。
pub fn diff_nodes(old: &[Node], new: &[Node]) -> Vec<NodeChange> {
    use std::collections::HashMap;
    let k = |n: &Node| (n.page_id.clone(), n.id.clone());
    let old_map: HashMap<_, &Node> = old.iter().map(|n| (k(n), n)).collect();
    let new_keys: std::collections::HashSet<_> = new.iter().map(k).collect();
    let mut out = Vec::new();
    for n in new {
        match old_map.get(&k(n)) {
            None => out.push(NodeChange {
                kind: "added".into(),
                page_name: n.page_name.clone(),
                node_id: n.id.clone(),
                old_label: String::new(),
                new_label: n.label.clone(),
                old_status: String::new(),
                new_status: n.status.clone(),
            }),
            Some(o) if o.label != n.label || o.status != n.status => out.push(NodeChange {
                kind: "changed".into(),
                page_name: n.page_name.clone(),
                node_id: n.id.clone(),
                old_label: o.label.clone(),
                new_label: n.label.clone(),
                old_status: o.status.clone(),
                new_status: n.status.clone(),
            }),
            Some(_) => {}
        }
    }
    for o in old.iter().filter(|o| !new_keys.contains(&k(o))) {
        out.push(NodeChange {
            kind: "removed".into(),
            page_name: o.page_name.clone(),
            node_id: o.id.clone(),
            old_label: o.label.clone(),
            new_label: String::new(),
            old_status: o.status.clone(),
            new_status: String::new(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(id: &str, label: &str, status: &str) -> Node {
        Node { page_id: "p".into(), page_name: "页".into(), id: id.into(), label: label.into(), status: status.into(), fill: String::new() }
    }

    #[test]
    fn diff_kinds() {
        let old = vec![n("a", "A", "review"), n("b", "B", "none"), n("c", "C", "none")];
        let new = vec![n("a", "A", "confirmed"), n("b", "B", "none"), n("d", "D", "idea")];
        let d = diff_nodes(&old, &new);
        let kinds: Vec<(&str, &str)> = d.iter().map(|c| (c.kind.as_str(), c.node_id.as_str())).collect();
        assert_eq!(kinds, vec![("changed", "a"), ("added", "d"), ("removed", "c")]);
        assert_eq!(d[0].old_status, "review");
        assert_eq!(d[0].new_status, "confirmed");
    }

    #[test]
    fn record_dedup_and_list() {
        let tmp = crate::paths::test_home();
        let mut conn = open().unwrap();
        let p = tmp.join("x.drawio");
        let xml1 = r#"<mxfile><diagram id="p" name="页"><mxGraphModel><root><mxCell id="a" value="A" style="fillColor=#fff2cc;" vertex="1" parent="0"/></root></mxGraphModel></diagram></mxfile>"#;
        let xml2 = xml1.replace("#fff2cc", "#d5e8d4");
        let s1 = record(&mut conn, &p, "app", xml1, "agent").unwrap().unwrap();
        assert!(record(&mut conn, &p, "app", xml1, "user").unwrap().is_none());
        let s2 = record(&mut conn, &p, "app", &xml2, "user").unwrap().unwrap();
        let l = list(&conn, &p).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].counts["confirmed"], 1);
        let d = diff(&conn, s1, s2).unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(xml_of(&conn, s1).unwrap(), xml1);
    }
}
