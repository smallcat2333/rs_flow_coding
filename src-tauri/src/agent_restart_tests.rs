//! 独立进程的会话重新开启联调：真实 ConPTY + 本地假 CLI，验证续接身份及新配置，不调用模型。

use super::*;

/// 断言失败时也清理本测试启动的进程，与用户正在运行的应用隔离。
struct Cleanup;
impl Drop for Cleanup {
    /// 全局 Hub 仅属于本测试进程。
    fn drop(&mut self) { shutdown(); }
}

/// 等待假 CLI 就绪或退出，超时直接失败，避免把仅启动成功当成完整验证。
fn wait_until(check: impl Fn() -> bool) {
    let start = std::time::Instant::now();
    while !check() {
        assert!(start.elapsed() < Duration::from_secs(20), "假 CLI 状态等待超时");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 从假 CLI 的逐次启动日志读取实际命令与环境。
fn starts(root: &Path, id: &str) -> Vec<Value> {
    std::fs::read_to_string(root.join(format!("{id}.jsonl"))).unwrap_or_default()
        .lines().filter_map(|line| serde_json::from_str(line).ok()).collect()
}

/// 专用进程运行，不能与使用相同全局 Hub 或环境变量的其他测试一起执行。
#[test]
#[ignore = "独立运行真实 Windows ConPTY 会话重新开启联调，不调用模型"]
fn isolated_pty_restart_uses_new_settings_and_original_conversation() {
    let home = crate::paths::test_home();
    let root = home.join("restart-native");
    let config = root.join("claude-config");
    std::fs::create_dir_all(config.join("projects/mock")).unwrap();
    let first = "11111111-1111-4111-8111-111111111111";
    let other = "22222222-2222-4222-8222-222222222222";
    let conversation = "33333333-3333-4333-8333-333333333333";
    std::fs::write(config.join(format!("projects/mock/{conversation}.jsonl")), "已有对话\n").unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &config);
    let script = root.join("fake_cli.py");
    std::fs::write(&script, r#"import json, os, socket, sys, time
from pathlib import Path
root = Path(__file__).parent
agent = os.environ['FLOW_AGENT_ID']
args = sys.argv[1:]
record = dict(args=args, focus=os.environ.get('CLAUDE_CODE_NO_FLICKER'))
with (root/(agent+'.jsonl')).open('a', encoding='utf-8') as log:
    log.write(json.dumps(record)+'\n')
session = args[args.index('--resume')+1] if '--resume' in args else agent
payload = dict(op='hook', id=agent, token=os.environ['FLOW_AGENT_TOKEN'], event='SessionStart', payload=dict(session_id=session, source='resume'))
with socket.create_connection(('127.0.0.1', int(os.environ['FLOW_AGENT_PORT'])), 5) as sock:
    sock.sendall((json.dumps(payload)+'\n').encode())
    result = json.loads(sock.makefile('r', encoding='utf-8').readline())
    if 'error' in result: raise RuntimeError(result['error'])
print('fake CLI ready', flush=True)
while True: time.sleep(1)
"#).unwrap();
    let wrapper = root.join("fake-claude.cmd");
    std::fs::write(&wrapper, format!("@echo off\r\npython -I \"{}\" %*\r\n", script.display())).unwrap();
    let data = home.join("agent"); std::fs::create_dir_all(&data).unwrap();
    let settings_file = data.join("settings.json");
    std::fs::write(&settings_file, serde_json::to_string(&json!({ "claude_path": wrapper, "extra_args": "--model first", "idle_hours": 0 })).unwrap()).unwrap();
    let meta = |id: &str, cli: &str| json!({ "id": id, "title": id, "cwd": root, "app": "restart-test", "created": 1, "started": !cli.is_empty(), "cli_session_id": cli });
    std::fs::write(data.join("sessions.json"), serde_json::to_string(&json!([meta(first, conversation), meta(other, "")])).unwrap()).unwrap();
    std::env::set_var("FLOW_CTL", std::env::current_exe().unwrap());
    build_hub().unwrap();
    let _cleanup = Cleanup;
    spawn(first, None).unwrap(); spawn(other, None).unwrap();
    wait_until(|| hub().unwrap().entries.lock().unwrap().values().all(|e| e.live.status == "idle"));
    let other_gen = hub().unwrap().entries.lock().unwrap()[other].gen;
    let first_gen = hub().unwrap().entries.lock().unwrap()[first].gen;
    agent_set_settings(wrapper.to_string_lossy().into_owned(), "--model updated".into(), Some("focus".into()), Some(true)).unwrap();
    restart_session(first).unwrap();
    wait_until(|| hub().unwrap().entries.lock().unwrap()[first].live.status == "idle");
    let log = starts(&root, first);
    assert_eq!(log.len(), 2, "只重新开启一次所选会话");
    for entry in &log {
        let args = entry["args"].as_array().unwrap();
        assert!(args.windows(2).any(|pair| pair[0] == "--resume" && pair[1] == conversation), "续接最新 CLI 对话，而非新建会话");
        assert!(!args.iter().any(|arg| arg == "--session-id"));
    }
    let args = log[1]["args"].as_array().unwrap();
    assert!(args.windows(2).any(|pair| pair[0] == "--model" && pair[1] == "updated"));
    assert!(args.windows(2).any(|pair| pair[0] == "--permission-mode" && pair[1] == "bypassPermissions"));
    assert_eq!(log[1]["focus"], "1");
    assert_eq!(log[0]["focus"], "0");
    {
        let map = hub().unwrap().entries.lock().unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map[first].gen, first_gen + 1);
        assert_eq!(map[first].meta.cli_session_id, conversation);
        assert_eq!(map[other].gen, other_gen);
        assert!(map[other].proc.is_some());
    }
    assert_eq!(starts(&root, other).len(), 1, "其他会话没有重启");
    let good_settings = std::fs::read(&settings_file).unwrap();
    std::fs::write(&settings_file, r#"{"claude_path":"Z:\\nonexistent-restart-cli.exe"}"#).unwrap();
    assert!(restart_session(first).is_err(), "无法启动的新配置应在结束旧进程前拒绝");
    {
        let map = hub().unwrap().entries.lock().unwrap();
        assert!(map[first].proc.is_some());
        assert_eq!(map[first].gen, first_gen + 1);
        assert!(!map[first].stopping);
    }
    std::fs::write(&settings_file, good_settings).unwrap();
    hub().unwrap().entries.lock().unwrap().get_mut(first).unwrap().meta.stored_at = 1;
    assert!(restart_session(first).unwrap_err().contains("收纳"));
    assert!(hub().unwrap().entries.lock().unwrap()[first].proc.is_some());
    shutdown();
    wait_until(|| hub().unwrap().entries.lock().unwrap().values().all(|e| e.proc.is_none()));
}
