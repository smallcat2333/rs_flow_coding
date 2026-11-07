//! 独立进程中的状态机联调：真实 ConPTY、键盘输入和 Hook/TCP；假 CLI 不调用模型。
use super::*;

/// 即使断言失败也清理本测试独立数据目录中的假 CLI。
struct Cleanup;
impl Drop for Cleanup {
    /// shutdown 只作用于本测试进程的 Hub。
    fn drop(&mut self) { shutdown(); }
}

/// 有界等待真实读线程或 Hook 消费事件，超时终止测试。
fn wait_until(check: impl Fn() -> bool) {
    let start = std::time::Instant::now();
    while !check() {
        assert!(start.elapsed() < Duration::from_secs(20), "状态机联调超时");
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// 读取当前主回合状态与工具；不接触生产应用的 Hub。
fn state(id: &str) -> (String, String) {
    let map = hub().unwrap().entries.lock().unwrap();
    let e = &map[id];
    (e.live.status.clone(), e.live.tool.clone())
}

/// 发送无外部副作用的假 CLI 命令，等 Hook 已处理后才继续断言。
fn command(root: &Path, id: &str, text: &str) {
    let ack = root.join(format!("{text}.ack"));
    if ack.exists() { std::fs::remove_file(&ack).unwrap(); }
    agent_write(id.into(), format!("{text}\r")).unwrap();
    wait_until(|| ack.exists());
}

/// 显式独立运行：中断/菜单 Esc、旧输出、迟到工具、普通失败、权限等待、API 失败与恢复。
#[test]
#[ignore = "独立运行真实 ConPTY 状态机联调，不调用模型"]
fn isolated_pty_interrupt_state() {
    let home = crate::paths::test_home();
    let root = home.join("state-native");
    std::fs::create_dir_all(&root).unwrap();
    let script = root.join("fake_cli.py");
    std::fs::write(&script, r#"import ctypes, json, msvcrt, os, socket
from pathlib import Path
root = Path(__file__).parent
agent = os.environ['FLOW_AGENT_ID']
mode = ctypes.c_uint32()
handle = ctypes.windll.kernel32.GetStdHandle(-10)
if ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
    ctypes.windll.kernel32.SetConsoleMode(handle, mode.value & ~7)
def hook(event, **payload):
    data = dict(op='hook', id=agent, token=os.environ['FLOW_AGENT_TOKEN'], event=event, payload=payload)
    with socket.create_connection(('127.0.0.1', int(os.environ['FLOW_AGENT_PORT'])), 5) as sock:
        sock.sendall((json.dumps(data)+'\n').encode())
        result = json.loads(sock.makefile('r', encoding='utf-8').readline())
        if 'error' in result: raise RuntimeError(result['error'])
hook('SessionStart', session_id=agent, source='startup')
print('state fake CLI ready', flush=True)
text, active, count = '', False, 0
while True:
    char = msvcrt.getwch()
    if char == '\x1b':
        if active:
            print('\r\n\x1b[2K\x1b[33m  └ Interrupted · What should Claude do instead?\x1b[0m\r\n', flush=True)
            active = False
        else:
            print('menu closed', flush=True)
        continue
    if char not in '\r\n':
        text += char
        continue
    if not text: continue
    prompt, text = text, ''
    if prompt == 'history':
        print('\r\n└ Interrupted · What should Claude do instead?\r\nhistory_end', flush=True)
    elif prompt == 'late':
        hook('PostToolUse', tool_name='Bash', tool_use_id='tool-1')
    elif prompt == 'noise':
        hook('Notification', notification_type='other', message='ordinary notification')
        hook('PreToolUse', agent_id='child', tool_name='Read', tool_use_id='child-read', tool_input={})
        hook('Stop', agent_id='child')
    elif prompt == 'finish':
        hook('Stop')
        active = False
    elif prompt == 'answer':
        hook('PostToolUse', tool_name='AskUserQuestion', tool_use_id='question')
    elif prompt == 'deny':
        hook('PermissionDenied', tool_name='Bash', tool_use_id='permit', reason='auto mode denied')
    else:
        hook('UserPromptSubmit', prompt=prompt)
        active = True
        if prompt == 'ask':
            hook('PreToolUse', tool_name='AskUserQuestion', tool_use_id='question', tool_input=dict(questions=[dict(question='offline question')]))
        elif prompt == 'permit':
            hook('PreToolUse', tool_name='Bash', tool_use_id='permit', tool_input={})
            hook('PermissionRequest', tool_name='Bash', tool_input={})
        elif prompt in ('fail', 'cancelhook'):
            hook('PreToolUse', tool_name='Bash', tool_use_id='failure', tool_input={})
            hook('PostToolUseFailure', tool_name='Bash', tool_use_id='failure', error='offline failure', is_interrupt=(prompt == 'cancelhook'))
        elif prompt == 'api':
            print('\r\nAPI error · Retrying in 0s · attempt 1/10\r\n', flush=True)
        elif prompt == 'api-final':
            hook('StopFailure', error='server_error', last_assistant_message='API Error: 504')
        elif prompt == 'think':
            pass
        else:
            count += 1
            hook('PreToolUse', tool_name='Bash', tool_use_id='tool-'+str(count), tool_input=dict(command='offline wait'))
    (root/(prompt+'.ack')).write_text('done')
"#).unwrap();
    let wrapper = root.join("fake-claude.cmd");
    std::fs::write(&wrapper, format!("@echo off\r\npython -I \"{}\"\r\n", script.display())).unwrap();
    let data = home.join("agent"); std::fs::create_dir_all(&data).unwrap();
    let id = "44444444-4444-4444-8444-444444444444";
    std::fs::write(data.join("settings.json"), serde_json::to_string(&json!({"claude_path":wrapper,"idle_hours":0})).unwrap()).unwrap();
    std::fs::write(data.join("sessions.json"), serde_json::to_string(&json!([{"id":id,"title":"状态机联调","cwd":root,"app":"state-test","created":1}])).unwrap()).unwrap();
    std::env::set_var("FLOW_CTL", std::env::current_exe().unwrap());
    build_hub().unwrap();
    let _cleanup = Cleanup;
    spawn(id, None).unwrap();
    wait_until(|| state(id).0 == "idle");

    // 菜单 Esc 没有中断证据，不改变回合。
    agent_write(id.into(), "\x1b".into()).unwrap();
    wait_until(|| hub().unwrap().entries.lock().unwrap()[id].buf.contains("menu closed"));
    assert_eq!(state(id).0, "idle");
    command(&root, id, "busy");
    assert_eq!(state(id), ("run".into(), "Bash".into()));
    command(&root, id, "history");
    wait_until(|| hub().unwrap().entries.lock().unwrap()[id].buf.contains("history_end"));
    assert_eq!(state(id).0, "run", "没有本轮取消输入，历史中断输出不得改状态");
    agent_write(id.into(), "\x1b".into()).unwrap();
    wait_until(|| state(id) == ("interrupted".into(), String::new()));
    let done = hub().unwrap().entries.lock().unwrap()[id].live.done;
    command(&root, id, "noise");
    assert_eq!(state(id).0, "interrupted");
    assert!(hub().unwrap().entries.lock().unwrap()[id].proc.is_some());
    assert_eq!(hub().unwrap().entries.lock().unwrap()[id].live.done, done);

    command(&root, id, "busy");
    command(&root, id, "late");
    assert_eq!(state(id), ("run".into(), "Bash".into()), "旧工具回报不能清掉新工具");
    command(&root, id, "finish");
    assert_eq!(state(id).0, "idle");
    command(&root, id, "fail");
    assert_eq!(state(id), ("run".into(), String::new()), "普通工具失败后模型仍可继续");
    command(&root, id, "finish");
    command(&root, id, "ask");
    assert_eq!(state(id).0, "wait");
    command(&root, id, "answer");
    assert_eq!(state(id), ("run".into(), String::new()));
    command(&root, id, "finish");
    command(&root, id, "permit");
    assert_eq!(state(id).0, "wait");
    command(&root, id, "deny");
    assert_eq!(state(id), ("run".into(), String::new()));
    command(&root, id, "finish");
    command(&root, id, "cancelhook");
    assert_eq!(state(id).0, "interrupted");
    command(&root, id, "think");
    agent_write(id.into(), "\x1b".into()).unwrap();
    wait_until(|| state(id).0 == "interrupted");
    command(&root, id, "api");
    wait_until(|| state(id).0 == "apierr");
    agent_write(id.into(), "\x1b".into()).unwrap();
    wait_until(|| state(id).0 == "interrupted");
    assert!(hub().unwrap().entries.lock().unwrap()[id].live.api_error.is_empty());
    command(&root, id, "api-final");
    assert_eq!(state(id).0, "apierr");
    command(&root, id, "think");
    command(&root, id, "finish");
    assert_eq!(state(id).0, "idle");
}
