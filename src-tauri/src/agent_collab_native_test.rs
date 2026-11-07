//! 独立进程中的真实 ConPTY/TCP 联调，使用本地假 CLI，不调用模型、不连接外部服务。

use super::*;

/// 即使测试断言失败也结束本测试启动的子进程，不留下后台假 CLI。
struct Cleanup;
impl Drop for Cleanup {
    /// 只使用测试进程中的 Hub；不会连接或停止实际 Flow Coding 的会话。
    fn drop(&mut self) { shutdown(); }
}

/// 等待本地状态到达预期；超时附带各会话状态及终端尾部，便于定位启动或输入链路失败。
fn wait_until(check: impl Fn() -> bool) {
    let start = std::time::Instant::now();
    while !check() {
        if start.elapsed() > Duration::from_secs(25) {
            let map = hub().unwrap().entries.lock().unwrap();
            let details: Vec<_> = map.values().map(|e| format!("{} {} {}", e.meta.id, e.live.status, e.buf.chars().rev().take(1000).collect::<String>())).collect();
            drop(map);
            panic!("离线 PTY 联调超时：{details:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 仅显式运行，独占本测试进程的 Hub/环境；真实启动模块和来源两个终端，验证完整回报链路。
#[test]
#[ignore = "独立运行真实 Windows ConPTY 假 CLI 联调，不调用模型"]
fn isolated_pty_collaboration() { run_collaboration(true); }

/// 独立进程验证从有效流程图自动创建图主并完成原请求，只有假 CLI，不调用模型。
#[test]
#[ignore = "独立运行 Windows ConPTY 自动创建负责人联调，不调用模型"]
fn isolated_pty_auto_created_owner() { run_collaboration(false); }

/// 两个隔离场景共用假 CLI 与真实 IPC/PTY 协议，是否预建负责人是唯一差异。
fn run_collaboration(bound_owner: bool) {
    let home = crate::paths::test_home();
    let root = home.join("collab-native");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("docs/flow")).unwrap();
    let flow = root.join("docs/flow/查询.drawio");
    std::fs::write(&flow, "<mxfile><diagram><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/></root></mxGraphModel></diagram></mxfile>").unwrap();
    let script = root.join("fake_cli.py");
    std::fs::write(&script, r#"import ctypes, json, msvcrt, os, re, socket, sys, time
from pathlib import Path
root = Path(__file__).parent
agent = os.environ['FLOW_AGENT_ID']
handle = ctypes.windll.kernel32.GetStdHandle(-10)
mode = ctypes.c_uint32()
if ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
    ctypes.windll.kernel32.SetConsoleMode(handle, (mode.value & ~6) | 0x200)
def rpc(op, **payload):
    data = dict(op=op, id=agent, token=os.environ['FLOW_AGENT_TOKEN'], **payload)
    with socket.create_connection(('127.0.0.1', int(os.environ['FLOW_AGENT_PORT'])), 5) as sock:
        sock.sendall((json.dumps(data, ensure_ascii=False)+'\n').encode())
        response = json.loads(sock.makefile('r', encoding='utf-8').readline())
        if 'error' in response: raise RuntimeError(response['error'])
        return response
def hook(event, **payload):
    return rpc('hook', event=event, payload=payload)
print('fake CLI ready', flush=True)
hook('SessionStart', session_id=agent, source='startup')
text = ''
raw = (root/'raw-input.log').open('w', encoding='utf-8')
while True:
    char = msvcrt.getwch()
    if not char: break
    raw.write(repr(char)+'\n'); raw.flush()
    if char not in '\r\n':
        text += char
        continue
    if not text: continue
    prompt, text = text, ''
    hook('UserPromptSubmit', prompt=prompt)
    match = re.search(r'\[模块协作请求 ([a-f0-9-]+)\]', prompt)
    if match:
        key = match.group(1)
        rpc('scope', description='查询模块', paths=['src'])
        for state in ['accept', 'run']:
            rpc('reply', request=key, state=state, text='已接单并处理', files=[], verification='')
        (root/'src'/'result.txt').write_text('query ready', encoding='utf-8')
        rpc('reply', request=key, state='done', text='查询接口已完成', files=['src/result.txt'], verification='假 CLI 断言通过')
    elif '[协作结果 ' in prompt:
        (root/'result-received.txt').write_text(prompt, encoding='utf-8')
    else:
        raise RuntimeError('unexpected prompt: '+repr(prompt))
    hook('Stop')
"#).unwrap();
    let wrapper = root.join("fake-claude.cmd");
    std::fs::write(&wrapper, format!("@echo off\r\npython -I \"{}\"\r\n", script.display())).unwrap();
    let data = home.join("agent"); std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("settings.json"), serde_json::to_string(&json!({ "claude_path": wrapper, "extra_args": "", "idle_hours": 0 })).unwrap()).unwrap();
    let cwd = root.to_string_lossy().into_owned();
    let feat = entry("11111111-1111-4111-8111-111111111111", "原需求", &cwd, "Feat_test.md", "").meta;
    let owner = entry("22222222-2222-4222-8222-222222222222", "查询", &cwd, "", &flow.to_string_lossy()).meta;
    let initial = if bound_owner { vec![&feat, &owner] } else { vec![&feat] };
    std::fs::write(data.join("sessions.json"), serde_json::to_string(&initial).unwrap()).unwrap();
    std::env::set_var("FLOW_CTL", std::env::current_exe().unwrap());
    build_hub().unwrap();
    let _cleanup = Cleanup;
    assert!(hub().unwrap().entries.lock().unwrap().values().all(|e| e.proc.is_none()));
    let to = if bound_owner { owner.id.clone() } else { flow.to_string_lossy().into_owned() };
    let value = dispatch(&feat.id, &json!({ "op": "request", "to": to, "text": "新增查询条件", "contract": "status 参数", "acceptance": "回报文件和测试" })).unwrap();
    assert_eq!(value["created"], !bound_owner);
    let target = value["request"]["to"].as_str().unwrap().to_string();
    if bound_owner { assert_eq!(target, owner.id); }
    else {
        let map = hub().unwrap().entries.lock().unwrap();
        assert_eq!(map[&target].meta.links[0].flow, crate::paths::norm(&flow).unwrap().to_string_lossy());
        assert_eq!(map[&target].meta.cwd, crate::paths::norm(&root).unwrap().to_string_lossy());
    }
    let request = value["request"]["id"].as_str().unwrap().to_string();
    wait_until(|| root.join("result-received.txt").exists());
    {
        let store = STORE.get().unwrap().lock().unwrap();
        let task = store.book.requests.iter().find(|r| r.id == request).unwrap();
        assert_eq!(task.phase, Phase::Completed);
        assert_eq!(task.files.len(), 1);
        assert_eq!(store.book.notices.iter().find(|n| n.request == request).unwrap().phase, Phase::Delivered);
        assert_eq!(store.book.requests.len(), 1, "结果通知不能形成新请求循环");
    }
    assert_eq!(std::fs::read_to_string(root.join("src/result.txt")).unwrap(), "query ready");
    assert_eq!(hub().unwrap().entries.lock().unwrap().len(), 2, "自动唤醒必须使用原会话");
    shutdown();
    wait_until(|| hub().unwrap().entries.lock().unwrap().values().all(|e| e.proc.is_none()));
}
