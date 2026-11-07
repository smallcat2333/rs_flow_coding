//! 回合状态转换：区分在线进程、在途工具与已确认中断；中断不当成功，不推进协作队列。
use super::*;

/// 清除本轮工具，供新回合、中断、正常完成及进程退出复用。
pub(super) fn clear_tools(e: &mut Entry) {
    e.tools.clear();
    e.live.tool.clear();
    e.live.tool_since = 0;
}

/// 展示最后一个仍在途的工具；并行工具的结束不得清除其它调用。
fn show_tool(e: &mut Entry) {
    if let Some((_, name, since)) = e.tools.last() {
        e.live.tool = name.clone();
        e.live.tool_since = *since;
    } else {
        e.live.tool.clear();
        e.live.tool_since = 0;
    }
}

/// 按 CLI 调用 ID 登记工具开始；相同回报不重复累积。
pub(super) fn begin_tool(e: &mut Entry, p: &Value, t: i64) {
    let id = p["tool_use_id"].as_str().unwrap_or("").to_string();
    e.tools.retain(|(key, _, _)| *key != id);
    e.tools.push((id, p["tool_name"].as_str().unwrap_or("").into(), t));
    show_tool(e);
}

/// 只结束对应调用；迟到或缺少调用 ID 的结果不跨工具猜测归属。
pub(super) fn end_tool(e: &mut Entry, p: &Value) -> bool {
    let id = p["tool_use_id"].as_str().unwrap_or("");
    let found = e.tools.iter().position(|(key, _, _)| !id.is_empty() && key == id);
    let Some(index) = found else { return false };
    e.tools.remove(index);
    show_tool(e);
    true
}

/// 消费明确中断证据，冻结本轮并清除执行/权限/API 显示；不标 done、不停止未知子代理。
/// 返回状态是否变化，重复中断不重启计时或重复记录活动。
pub(super) fn interrupt(e: &mut Entry) -> bool {
    if e.live.status == "interrupted" { return false; }
    clear_tools(e);
    e.interrupt_requested = false;
    e.compacting = false;
    e.live.api_error.clear();
    e.live.wait_text.clear();
    e.live.beat = now();
    set_status(e, "interrupted");
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tests::entry;

    /// 并行工具分别结束，老回合结果不能清掉新回合工具。
    #[test]
    fn parallel_and_late_tool_results() {
        let mut e = entry("tools", "工具", String::new(), Vec::new());
        let a = json!({"tool_name":"Bash","tool_use_id":"a"});
        let b = json!({"tool_name":"Read","tool_use_id":"b"});
        begin_tool(&mut e, &a, 100);
        begin_tool(&mut e, &b, 200);
        assert!(end_tool(&mut e, &a));
        assert_eq!(e.live.tool, "Read");
        assert_eq!(e.live.tool_since, 200);
        clear_tools(&mut e);
        begin_tool(&mut e, &json!({"tool_name":"Bash","tool_use_id":"new"}), 300);
        assert!(!end_tool(&mut e, &b));
        assert_eq!(e.live.tool, "Bash");
    }

    /// 中断与成功完全分开，保留队列；重复通知不会刷新中断时间，新回合可正常恢复。
    #[test]
    fn interruption_is_not_completion() {
        let mut e = entry("cancel", "中断", String::new(), Vec::new());
        e.live.status = "run".into();
        e.live.done = 10;
        e.live.api_error = "old API error".into();
        e.interrupt_requested = true;
        e.queue.push_back("协作任务".into());
        begin_tool(&mut e, &json!({"tool_name":"Bash","tool_use_id":"old"}), 20);
        assert!(interrupt(&mut e));
        let since = e.live.since;
        assert_eq!(e.live.status, "interrupted");
        assert!(e.live.tool.is_empty() && e.live.api_error.is_empty());
        assert_eq!(e.live.done, 10);
        assert_eq!(e.queue.len(), 1);
        assert!(!interrupt(&mut e));
        assert_eq!(e.live.since, since);
        start_turn(&mut e, "继续", 30);
        assert_eq!(e.live.status, "run");
        assert!(!e.interrupt_requested);
    }
}
