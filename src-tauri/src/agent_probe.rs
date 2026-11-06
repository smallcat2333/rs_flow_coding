//! 设置页的 Claude Code 可用性测试：使用未保存的输入，不建立 Agent 会话。
use super::{find_claude, new_uuid, split_args, ClaudeSettings, Exe};
use serde_json::{json, Value};
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 独立临时目录隔离项目上下文；输出写文件，避免子进程持有管道导致读取永久阻塞。
struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("flow-claude-test-{}", new_uuid()));
        std::fs::create_dir(&path).map_err(|e| format!("创建测试目录失败：{e}"))?;
        Ok(Self(path))
    }

    fn output(&self, name: &str) -> String {
        let mut bytes = Vec::new();
        if let Ok(file) = File::open(self.0.join(name)) {
            let _ = file.take(128 * 1024).read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).trim().to_string()
    }
}
impl Drop for Workspace {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

/// 与 Agent 启动时相同的宿主环境清理规则，保留用户的认证、代理和 Git Bash 配置。
pub(super) fn host_env_keys() -> Vec<String> {
    if std::env::var_os("CLAUDECODE").is_none() { return Vec::new(); }
    std::env::vars_os().filter_map(|(key, _)| {
        let k = key.to_string_lossy().into_owned();
        let host = k == "CLAUDECODE" || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT"
            || k.starts_with("CLAUDE_CODE_") || k.starts_with("CLAUDE_AGENT_SDK_");
        (host && k != "CLAUDE_CODE_GIT_BASH_PATH").then_some(k)
    }).collect()
}

fn command(exe: &Exe) -> Command {
    // std::process 在 Windows 上会为 .cmd/.bat 自动调用 cmd.exe 并转义参数；
    // 不手动拼 /c，避免空参数使带空格的脚本路径被再次拆开。
    let mut cmd = Command::new(exe.path());
    for key in host_env_keys() { cmd.env_remove(key); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW：测试不闪出控制台。
    }
    cmd
}

/// 等待有硬上限；超时时终止进程树（包括 npm .cmd 启动的子进程）并回收主进程。
fn run(mut cmd: Command, work: &Workspace, timeout: Duration) -> Result<String, String> {
    let stdout = File::create(work.0.join("stdout.log")).map_err(|e| e.to_string())?;
    let stderr = File::create(work.0.join("stderr.log")).map_err(|e| e.to_string())?;
    cmd.current_dir(&work.0).stdin(Stdio::null()).stdout(stdout).stderr(stderr);
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 Claude Code：{e}"))?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(40)),
            state => {
                #[cfg(windows)] {
                    use std::os::windows::process::CommandExt;
                    let _ = Command::new("taskkill.exe").args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(match state {
                    Err(e) => format!("读取进程状态失败：{e}"),
                    _ => format!("测试超时（{} 秒），已停止测试进程。请检查网络、代理、登录状态或启动参数。", timeout.as_secs()),
                });
            }
        }
    };
    let stdout = work.output("stdout.log");
    if !status.success() {
        let stderr = work.output("stderr.log");
        let detail = if stderr.is_empty() { &stdout } else { &stderr };
        return Err(format!("Claude Code 退出码 {}\n{}", status.code().map(|c| c.to_string()).unwrap_or_else(|| "未知".into()), detail));
    }
    Ok(stdout)
}

/// 成功退出并不代表模型可用：还要收到 print JSON 的成功结果和非空回复。
fn reply(output: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(output).ok().or_else(|| {
        // 用户开启 verbose 时，兼容结果前面的独立日志行。
        output.lines().rev().filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|v| v["type"] == "result")
    }).ok_or_else(|| format!("未收到可识别的测试结果，请检查启动参数或升级 Claude Code。\n{output}"))?;
    if value["type"] != "result" || value["is_error"] != false || value["subtype"] != "success" {
        return Err(format!("Claude Code 未完成请求：{}", value.get("result").or_else(|| value.get("errors")).unwrap_or(&value)));
    }
    value["result"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
        .ok_or_else(|| "Claude Code 未返回回复，请检查模型和额度。".into())
}

fn test_settings(set: ClaudeSettings) -> Value {
    let start = Instant::now();
    let mut path = String::new();
    let mut version = String::new();
    let mut stage = "配置检查";
    let outcome = (|| -> Result<String, String> {
        let extra = split_args(&set.extra_args)?;
        let exe = find_claude(&set)?;
        path = exe.path().to_string_lossy().into_owned();
        let work = Workspace::new()?;
        stage = "启动检查";
        version = run({ let mut c = command(&exe); c.arg("--version"); c }, &work, Duration::from_secs(10))?;
        if version.is_empty() { return Err("CLI 没有返回版本号，请确认路径指向 Claude Code。".into()); }
        stage = "请求测试";
        let mut cmd = command(&exe);
        cmd.args(extra);
        // 最后固定测试协议；不保存对话，不开放工具，使用用户当前的认证和模型设置。
        cmd.args(["--print", "--output-format", "json", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--disable-slash-commands"]);
        cmd.arg("Reply only with FLOW_CODING_OK. This is a connectivity test; do not use tools.");
        reply(&run(cmd, &work, Duration::from_secs(60))?)
    })();
    let (ok, message, detail) = match outcome {
        Ok(text) => (true, "Claude Code 可用".to_string(), format!("已完成启动和实际请求测试。\n回复：{text}")),
        Err(error) => (false, format!("{stage}失败"), error),
    };
    json!({ "ok": ok, "message": message, "detail": detail.chars().take(6000).collect::<String>(), "path": path, "version": version, "elapsedMs": start.elapsed().as_millis() as u64 })
}

/// 测试当前输入，不写 settings.json；阻塞工作离开 IPC/UI 线程。
pub(super) async fn test(claude_path: String, extra_args: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || test_settings(ClaudeSettings {
        claude_path: claude_path.trim().into(), extra_args: extra_args.trim().into(), ..ClaudeSettings::default()
    })).await.map_err(|e| format!("测试任务失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_requires_successful_nonempty_reply() {
        assert_eq!(reply(r#"{"type":"result","subtype":"success","is_error":false,"result":"FLOW_CODING_OK"}"#).unwrap(), "FLOW_CODING_OK");
        assert!(reply(r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}"#).unwrap_err().contains("Not logged in"));
        assert!(reply(r#"{"type":"result","subtype":"error_max_turns","is_error":false}"#).is_err());
        assert!(reply(r#"{"type":"result","subtype":"success","is_error":false,"result":" "}"#).is_err());
        assert!(reply("version only").is_err());
        assert!(reply("log\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"OK\"}\n").is_ok());
    }

    #[test]
    fn probe_reports_draft_configuration_errors() {
        let bad = test_settings(ClaudeSettings { claude_path: "missing-claude.exe".into(), extra_args: String::new(), ..ClaudeSettings::default() });
        assert_eq!(bad["ok"], false);
        assert_eq!(bad["message"], "配置检查失败");
        assert!(bad["detail"].as_str().unwrap().contains("路径不存在"));
        let quoted = test_settings(ClaudeSettings { claude_path: String::new(), extra_args: "--model \"oops".into(), ..ClaudeSettings::default() });
        assert!(quoted["detail"].as_str().unwrap().contains("双引号"));
    }

    #[test]
    #[ignore = "需要本机 Claude Code 登录，会发送一条简短请求"]
    fn probe_live_claude() {
        let result = test_settings(ClaudeSettings::default());
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
        assert_eq!(result["ok"], true, "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn probe_cmd_path_with_spaces() {
        let work = Workspace::new().unwrap();
        let script = work.0.join("fake claude.cmd");
        std::fs::write(&script, concat!(
            "@echo off\r\n",
            "if \"%~1\"==\"--version\" (echo mock-version & exit /b 0)\r\n",
            "echo {\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"FLOW_CODING_OK\"}\r\n",
        )).unwrap();
        let result = test_settings(ClaudeSettings { claude_path: script.to_string_lossy().into_owned(), extra_args: "--model opus".into(), ..ClaudeSettings::default() });
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["version"], "mock-version");
    }

    #[cfg(windows)]
    #[test]
    fn probe_process_exit_and_timeout() {
        let work = Workspace::new().unwrap();
        let mut ok = Command::new("cmd.exe");
        ok.args(["/d", "/c", "echo test-version"]);
        assert_eq!(run(ok, &work, Duration::from_secs(5)).unwrap(), "test-version");
        let mut bad = Command::new("cmd.exe");
        bad.args(["/d", "/c", "echo denied 1>&2 & exit /b 7"]);
        assert!(run(bad, &work, Duration::from_secs(5)).unwrap_err().contains("denied"));
        let mut slow = Command::new("powershell.exe");
        slow.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 10"]);
        let start = Instant::now();
        assert!(run(slow, &work, Duration::from_millis(100)).unwrap_err().contains("测试超时"));
        assert!(start.elapsed() < Duration::from_secs(5));
        let path = work.0.clone();
        drop(work);
        assert!(!path.exists());
    }
}
