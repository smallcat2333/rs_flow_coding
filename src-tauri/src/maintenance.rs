//! 本机数据维护：统计历史库和目录扫描缓存，按用户指令保留最新快照清理旧历史。
//! 不删除项目图、Feat、配置偏好或编辑锁；数据库操作交给后台线程，避免阻塞窗口。

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use tauri::Emitter;

/// 设置页的数据用量，字节数仅统计实际数据库文件及序列化的目录缓存字段。
#[derive(Debug, Serialize)]
pub struct StorageStats {
    pub database_path: String,
    pub database_bytes: u64,
    pub diagrams: u64,
    pub snapshots: u64,
    pub old_snapshots: u64,
    pub node_states: u64,
    pub cached_dirs: usize,
    pub cache_bytes: usize,
}

/// 读取一个固定数据库文件的大小；文件尚未生成计零，其他 IO 错误直接报告。
fn file_bytes(path: &Path) -> Result<u64, String> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(meta.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!("读取文件大小失败 {}: {error}", path.display())),
    }
}

/// 汇总数据库行数和目录缓存大小；数据库占用包含 WAL/SHM，不把项目源文件算作缓存。
fn storage_stats() -> Result<StorageStats, String> {
    let conn = crate::db::open()?;
    let (diagrams, snapshots, old_snapshots, node_states) = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM diagram), (SELECT COUNT(*) FROM snapshot),
                (SELECT COUNT(*) FROM snapshot WHERE id NOT IN
                    (SELECT MAX(id) FROM snapshot GROUP BY diagram_id)),
                (SELECT COUNT(*) FROM node_state)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| e.to_string())?;
    let home = crate::paths::home()?;
    let mut database_bytes = 0;
    for name in ["flow.db", "flow.db-wal", "flow.db-shm"] {
        database_bytes += file_bytes(&home.join(name))?;
    }
    let cfg = crate::scan::load_config()?;
    let cache_bytes = if cfg.flow_dirs.is_empty() {
        0
    } else {
        serde_json::to_vec(&cfg.flow_dirs)
            .map_err(|e| e.to_string())?
            .len()
    };
    Ok(StorageStats {
        database_path: home.join("flow.db").to_string_lossy().into_owned(),
        database_bytes,
        diagrams,
        snapshots,
        old_snapshots,
        node_states,
        cached_dirs: cfg.flow_dirs.len(),
        cache_bytes,
    })
}

/// 同一写事务内删除旧快照的节点和快照；每张图保留最大 id，空库返回零。
/// SQLite 的写锁保证 flowctl/自动保存不能在删除两张表之间插入半份历史。
fn prune_history(conn: &mut Connection) -> Result<usize, String> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM node_state WHERE snapshot_id IN
        (SELECT id FROM snapshot WHERE id NOT IN
            (SELECT MAX(id) FROM snapshot GROUP BY diagram_id))",
        [],
    )
    .map_err(|e| e.to_string())?;
    let removed = tx
        .execute(
            "DELETE FROM snapshot WHERE id NOT IN
        (SELECT MAX(id) FROM snapshot GROUP BY diagram_id)",
            [],
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(removed)
}

/// 后台读取数据用量，失败显示在设置页，不改变历史或缓存。
#[tauri::command]
pub async fn get_storage_stats() -> Result<StorageStats, String> {
    tauri::async_runtime::spawn_blocking(storage_stats)
        .await
        .map_err(|e| e.to_string())?
}

/// 用户确认后保留每图最新快照并回收空闲页；通知其他窗口使历史选择失效。
/// 若清理后回收空间失败，错误明确说明旧历史已经删除，不能误报为未执行。
#[tauri::command]
pub async fn clean_database(app: tauri::AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = crate::db::open()?;
        let removed = prune_history(&mut conn)?;
        let _ = app.emit("history-pruned", ());
        conn.execute_batch("VACUUM;")
            .map_err(|e| format!("已清理 {removed} 条旧快照，但回收空间失败：{e}"))?;
        let (busy, _, _): (i64, i64, i64) = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(|e| format!("已清理 {removed} 条旧快照，但压缩 WAL 失败：{e}"))?;
        if busy != 0 {
            return Err(format!(
                "已清理 {removed} 条旧快照；其他连接正在使用数据库，WAL 空间暂未回收"
            ));
        }
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 仅清空已发现目录列表，保留项目根、APP 别名与侧栏偏好；下次刷新自动重新扫描。
#[tauri::command]
pub async fn clear_scan_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::scan::update_config(|cfg| cfg.flow_dirs.clear())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两张图交错快照清理后各留最新一份，节点保持外键完整，重复清理无额外删除。
    #[test]
    fn prune_keeps_latest_per_diagram() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE diagram(id INTEGER PRIMARY KEY);
            CREATE TABLE snapshot(id INTEGER PRIMARY KEY, diagram_id INTEGER REFERENCES diagram(id), xml TEXT);
            CREATE TABLE node_state(snapshot_id INTEGER REFERENCES snapshot(id), label TEXT);
            INSERT INTO diagram VALUES (1),(2);
            INSERT INTO snapshot VALUES (1,1,'old-a'),(2,2,'old-b'),(3,1,'new-a'),(4,2,'new-b');
            INSERT INTO node_state VALUES (1,'old-a'),(2,'old-b'),(3,'new-a'),(4,'new-b');").unwrap();
        assert_eq!(prune_history(&mut conn).unwrap(), 2);
        let mut stmt = conn.prepare("SELECT s.id, s.xml, n.label FROM snapshot s JOIN node_state n ON n.snapshot_id=s.id ORDER BY s.id").unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (3, "new-a".into(), "new-a".into()),
                (4, "new-b".into(), "new-b".into())
            ]
        );
        drop(stmt);
        assert_eq!(prune_history(&mut conn).unwrap(), 0);
        conn.execute_batch("DELETE FROM node_state; DELETE FROM snapshot;")
            .unwrap();
        assert_eq!(prune_history(&mut conn).unwrap(), 0);
    }
}
