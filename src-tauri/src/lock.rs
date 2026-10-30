//! 流程图编辑锁：App（用户）与 Agent（flowctl）互斥编辑同一张图。
//!
//! - 锁文件集中放在 `<数据目录>/locks/<路径哈希>.lock`，不污染项目目录；
//! - 以 `create_new` 独占创建保证原子性；
//! - 同一 owner 重入即刷新（Agent 的 lock/unlock 来自不同 flowctl 进程，故按 owner 判定而非 pid）；
//! - 心跳超过 ttl 秒视为失效，可被他人接管，防止崩溃后死锁。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 用户（App）锁的失效时间：App 编辑期间每次保存与定时心跳都会刷新。
pub const USER_TTL: i64 = 60;
/// Agent 锁的失效时间：Agent 一次编辑可能跨多次工具调用，给足 10 分钟。
pub const AGENT_TTL: i64 = 600;

/// 锁内容。`owner` 为 `user` 或 `agent`；`since`/`heartbeat` 为 Unix 秒；`ttl` 为失效秒数。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LockInfo {
    pub path: String,
    pub owner: String,
    pub pid: u32,
    pub since: i64,
    pub heartbeat: i64,
    pub ttl: i64,
}

impl LockInfo {
    /// 是否已失效：当前时间距最后心跳超过 ttl。
    pub fn is_stale(&self) -> bool {
        now() - self.heartbeat > self.ttl
    }
}

/// 当前 Unix 秒。
pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 锁目录 `<数据目录>/locks`，不存在则创建。
pub fn lock_dir() -> Result<PathBuf, String> {
    let d = crate::paths::home()?.join("locks");
    std::fs::create_dir_all(&d).map_err(|e| format!("创建锁目录失败: {e}"))?;
    Ok(d)
}

/// 由规范路径计算锁文件路径：sha256(小写路径) 前 16 位十六进制。
fn lock_file(path: &Path) -> Result<PathBuf, String> {
    let h = Sha256::digest(crate::paths::key(path).as_bytes());
    Ok(lock_dir()?.join(format!("{}.lock", &hex::encode(h)[..16])))
}

/// 读取锁；不存在、内容损坏或已失效均返回 None（失效锁文件保留，由下次 acquire 覆盖）。
pub fn read(path: &Path) -> Result<Option<LockInfo>, String> {
    let f = lock_file(path)?;
    let Ok(text) = std::fs::read_to_string(&f) else { return Ok(None) };
    Ok(serde_json::from_str::<LockInfo>(&text).ok().filter(|l| !l.is_stale()))
}

/// 写锁文件（覆盖）。
fn write(f: &Path, info: &LockInfo) -> Result<(), String> {
    std::fs::write(f, serde_json::to_string(info).unwrap()).map_err(|e| format!("写锁失败: {e}"))
}

/// 加锁或重入刷新。
/// 返回 `Ok(Ok(锁))` 成功；`Ok(Err(持有者))` 被他人持有；`Err` 为 IO 错误。
/// 规则：无锁 → 独占创建；有锁且（已失效 或 同 owner）→ 覆盖；否则返回持有者。
pub fn acquire(path: &Path, owner: &str, ttl: i64) -> Result<Result<LockInfo, LockInfo>, String> {
    let f = lock_file(path)?;
    let t = now();
    let mut info = LockInfo {
        path: path.to_string_lossy().into_owned(),
        owner: owner.to_string(),
        pid: std::process::id(),
        since: t,
        heartbeat: t,
        ttl,
    };
    match OpenOptions::new().write(true).create_new(true).open(&f) {
        Ok(mut file) => {
            file.write_all(serde_json::to_string(&info).unwrap().as_bytes())
                .map_err(|e| format!("写锁失败: {e}"))?;
            return Ok(Ok(info));
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("创建锁失败: {e}")),
    }
    let current = std::fs::read_to_string(&f).ok().and_then(|s| serde_json::from_str::<LockInfo>(&s).ok());
    match current {
        Some(c) if !c.is_stale() && c.owner != owner => Ok(Err(c)),
        Some(c) if !c.is_stale() => {
            info.since = c.since;
            write(&f, &info)?;
            Ok(Ok(info))
        }
        _ => {
            write(&f, &info)?;
            Ok(Ok(info))
        }
    }
}

/// 释放锁：仅当锁存在且属于 owner（或已失效）时删除；返回是否删除。
pub fn release(path: &Path, owner: &str) -> Result<bool, String> {
    let f = lock_file(path)?;
    let Ok(text) = std::fs::read_to_string(&f) else { return Ok(false) };
    let mine = match serde_json::from_str::<LockInfo>(&text) {
        Ok(c) => c.owner == owner || c.is_stale(),
        Err(_) => true,
    };
    if mine {
        std::fs::remove_file(&f).map_err(|e| format!("删除锁失败: {e}"))?;
    }
    Ok(mine)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusive_reentrant_release() {
        let tmp = crate::paths::test_home();
        let p = tmp.join("a.drawio");

        assert!(acquire(&p, "agent", AGENT_TTL).unwrap().is_ok());
        let holder = acquire(&p, "user", USER_TTL).unwrap().unwrap_err();
        assert_eq!(holder.owner, "agent");
        assert!(acquire(&p, "agent", AGENT_TTL).unwrap().is_ok());
        assert!(!release(&p, "user").unwrap());
        assert!(release(&p, "agent").unwrap());
        assert!(read(&p).unwrap().is_none());

        // 失效锁可被接管
        let f = lock_file(&p).unwrap();
        let stale = LockInfo { path: String::new(), owner: "agent".into(), pid: 1, since: 0, heartbeat: 0, ttl: 1 };
        write(&f, &stale).unwrap();
        assert!(read(&p).unwrap().is_none());
        assert!(acquire(&p, "user", USER_TTL).unwrap().is_ok());
        assert!(release(&p, "user").unwrap());
    }
}
