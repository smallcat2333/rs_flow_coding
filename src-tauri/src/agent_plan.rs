//! CLI 原生任务计划：在 flowctl hook 子进程中只读当前会话的命名任务目录，再随既有通道回报。
//! 任务目录不存在表示尚无计划；损坏或不可读时保留错误信息，不伪造任务，也不阻断终端。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// CLI 原生任务状态；删除任务不进入侧栏清单，未知状态作为读取错误展示。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
    Deleted,
}

/// 侧栏需要的原生任务字段；activeForm 在部分 CLI 任务中不存在，届时显示原 subject。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanItem {
    pub id: String,
    pub subject: String,
    pub status: PlanStatus,
    #[serde(default, rename = "activeForm")]
    pub active_form: String,
}

/// 一次完整任务目录快照；captured_at 拒绝迟到回报，文件修改时间 updated_at 标记上轮计划，错误单独展示。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlanSnapshot {
    pub tasks: Vec<PlanItem>,
    pub captured_at: i64,
    pub updated_at: i64,
    pub error: Option<String>,
}

/// 把文件时间转换为毫秒；异常时间直接报错，不把失效快照混成当前计划。
fn timestamp(time: SystemTime) -> Result<i64, String> {
    time.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).map_err(|e| e.to_string())
}

/// 只读一个 CLI 任务目录；忽略锁等非 JSON 文件，按原生编号排序并排除已删除任务。
fn read_plan(dir: &Path) -> Result<PlanSnapshot, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(PlanSnapshot::default()),
        Err(e) => return Err(format!("读取任务目录失败：{e}")),
    };
    let mut snapshot = PlanSnapshot {
        updated_at: timestamp(dir.metadata().and_then(|m| m.modified()).map_err(|e| e.to_string())?)?,
        ..PlanSnapshot::default()
    };
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let text = std::fs::read_to_string(&path).map_err(|e| format!("读取任务 {} 失败：{e}", path.display()))?;
        let task: PlanItem = serde_json::from_str(&text).map_err(|e| format!("任务 {} 格式错误：{e}", path.display()))?;
        let modified = timestamp(path.metadata().and_then(|m| m.modified()).map_err(|e| e.to_string())?)?;
        snapshot.updated_at = snapshot.updated_at.max(modified);
        if task.status != PlanStatus::Deleted { snapshot.tasks.push(task); }
    }
    snapshot.tasks.sort_by(|a, b| a.id.len().cmp(&b.id.len()).then_with(|| a.id.cmp(&b.id)));
    Ok(snapshot)
}

/// 遵循 CLI 的任务目录选择：显式任务列表标识优先，否则使用 hook 上报的实际会话 id。
fn task_dir(payload: &Value) -> Result<PathBuf, String> {
    let list = match std::env::var_os("CLAUDE_CODE_TASK_LIST_ID") {
        Some(list) => PathBuf::from(list),
        None => PathBuf::from(payload["session_id"].as_str().ok_or("CLI 会话标识缺失")?),
    };
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).ok_or("用户目录缺失")?).join(".claude"),
    };
    Ok(base.join("tasks").join(list))
}

/// 仅在任务相关成功 hook 或会话边界采集计划，不增加轮询，也不在 App 的会话锁内读取文件。
pub fn enrich_hook(event: &str, payload: &mut Value) {
    if !payload.is_object() { return; }
    let capture = matches!(event, "SessionStart" | "Stop") || (event == "PostToolUse"
        && matches!(payload["tool_name"].as_str(), Some("TaskCreate" | "TaskUpdate" | "TaskList")));
    if !capture { return; }
    let captured_at = timestamp(SystemTime::now()).unwrap();
    let mut snapshot = task_dir(payload).and_then(|dir| read_plan(&dir)).unwrap_or_else(|error| PlanSnapshot {
        error: Some(error),
        ..PlanSnapshot::default()
    });
    snapshot.captured_at = captured_at;
    payload["flow_coding_plan"] = serde_json::to_value(snapshot).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 创建独立任务夹具，不修改用户的 Claude 目录或进程环境。
    fn fixture() -> PathBuf {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("flow_plan_{}_{}", std::process::id(), unique));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 原生 JSON 的状态、编号和 activeForm 原样进入快照，锁文件及删除任务不进入计划。
    #[test]
    fn native_tasks_roundtrip_and_sort() {
        let dir = fixture();
        std::fs::write(dir.join("10.json"), r#"{"id":"10","subject":"验证结果","status":"pending"}"#).unwrap();
        std::fs::write(dir.join("2.json"), r#"{"id":"2","subject":"实现侧栏","activeForm":"正在实现侧栏","status":"in_progress","blockedBy":[],"blocks":[]}"#).unwrap();
        std::fs::write(dir.join("1.json"), r#"{"id":"1","subject":"核对需求","status":"completed"}"#).unwrap();
        std::fs::write(dir.join("3.json"), r#"{"id":"3","subject":"已移除","status":"deleted"}"#).unwrap();
        std::fs::write(dir.join(".lock"), "not json").unwrap();
        let snapshot = read_plan(&dir).unwrap();
        assert_eq!(snapshot.tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["1", "2", "10"]);
        assert_eq!(snapshot.tasks[1].active_form, "正在实现侧栏");
        assert_eq!(snapshot.tasks[1].status, PlanStatus::InProgress);
        assert!(snapshot.updated_at > 0 && snapshot.error.is_none());
        let roundtrip: PlanSnapshot = serde_json::from_value(serde_json::to_value(&snapshot).unwrap()).unwrap();
        assert_eq!(roundtrip.tasks[1].active_form, "正在实现侧栏");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 默认目录按 hook 的实际会话区分；用户显式设置任务列表时，两会话遵循同一选择。
    #[test]
    fn task_directory_follows_cli_selection() {
        let a = task_dir(&serde_json::json!({"session_id":"session-a"})).unwrap();
        let b = task_dir(&serde_json::json!({"session_id":"session-b"})).unwrap();
        if std::env::var_os("CLAUDE_CODE_TASK_LIST_ID").is_some() {
            assert_eq!(a, b);
        } else {
            assert_ne!(a, b);
            assert_eq!(a.file_name().unwrap(), "session-a");
            assert_eq!(b.file_name().unwrap(), "session-b");
            assert!(task_dir(&serde_json::json!({})).is_err());
        }
    }

    /// 尚未创建计划是空态；损坏文件或未知状态必须报错，不能假装清单为空。
    #[test]
    fn missing_and_invalid_tasks_are_distinct() {
        let dir = fixture();
        assert!(read_plan(&dir.join("missing")).unwrap().tasks.is_empty());
        std::fs::write(dir.join("1.json"), "{").unwrap();
        assert!(read_plan(&dir).is_err());
        std::fs::write(dir.join("1.json"), r#"{"id":"1","subject":"验证","status":"unknown"}"#).unwrap();
        assert!(read_plan(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
