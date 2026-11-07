//! 会话累计用量：增量读取 CLI 对话记录（主对话，不含子代理文件），按请求 ID 去重统计 token、请求数与请求耗时。
//! 状态行只给出当前上下文，不含累计 token；对话记录每段回复一行、同一请求共用 message.id，后写的用量覆盖先写的。
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

/// 本会话累计值；request_ms 为各请求从发出（前一条记录写入）到最后一段回复写入的时长之和，含首字延迟。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub requests: u64,
    pub input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub output_tokens: u64,
    pub request_ms: u64,
}

#[derive(Debug, Clone, Copy, Default)]
struct One { input: u64, creation: u64, read: u64, output: u64, ms: u64 }

/// 单个对话记录文件的增量统计状态；未写完的末行留到下次读取。
#[derive(Debug, Default)]
pub struct Tally {
    offset: u64,
    partial: Vec<u8>,
    total: Usage,
    last_id: String,
    last: One,
    start_ms: Option<i64>,
    prev_ms: Option<i64>,
}

const TS_KEY: &[u8] = b"\"timestamp\":\"";

/// 只取顶层时间戳，不为大段工具结果做完整 JSON 解析；转义在字符串内的同名字段不会匹配。
fn line_ts(line: &[u8]) -> Option<i64> {
    let at = line.windows(TS_KEY.len()).position(|w| w == TS_KEY)? + TS_KEY.len();
    let end = line[at..].iter().position(|b| *b == b'"')? + at;
    parse_ms(std::str::from_utf8(&line[at..end]).ok()?)
}

fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn contains(line: &[u8], pat: &[u8]) -> bool { line.windows(pat.len()).any(|w| w == pat) }

impl Tally {
    /// 喂入新读取的字节；按换行切分，最后一段不完整的行暂存。
    pub fn feed(&mut self, bytes: &[u8]) {
        self.partial.extend_from_slice(bytes);
        let Some(cut) = self.partial.iter().rposition(|b| *b == b'\n') else { return };
        let rest = self.partial.split_off(cut + 1);
        let done = std::mem::replace(&mut self.partial, rest);
        for line in done.split(|b| *b == b'\n') {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if !line.is_empty() { self.line(line); }
        }
    }

    pub fn total(&self) -> Usage { self.total }

    fn line(&mut self, line: &[u8]) {
        // 只有带用量的助手回复需要完整解析；其余记录只取时间，作为下一次请求的发出时间。
        let parsed = if contains(line, b"\"usage\"") && contains(line, b"\"assistant\"") {
            serde_json::from_slice::<Value>(line).ok()
        } else { None };
        let Some(v) = parsed.filter(|v| v["type"] == "assistant" && v["isSidechain"] != true) else {
            if let Some(t) = line_ts(line) { self.prev_ms = Some(t); }
            return;
        };
        let msg = &v["message"];
        let (id, u) = (msg["id"].as_str().unwrap_or(""), &msg["usage"]);
        let ts = v["timestamp"].as_str().and_then(parse_ms);
        // 本地合成消息（如中断提示）不是 API 请求。
        if id.is_empty() || !u.is_object() || msg["model"] == "<synthetic>" {
            if let Some(t) = ts { self.prev_ms = Some(t); }
            return;
        }
        if id != self.last_id {
            self.last_id = id.to_string();
            self.last = One::default();
            self.total.requests += 1;
            self.start_ms = self.prev_ms;
        }
        let n = |k: &str| u[k].as_u64().unwrap_or(0);
        let ms = match (self.start_ms, ts) { (Some(a), Some(b)) if b >= a => (b - a) as u64, _ => 0 };
        let next = One { input: n("input_tokens"), creation: n("cache_creation_input_tokens"), read: n("cache_read_input_tokens"), output: n("output_tokens"), ms };
        let t = &mut self.total;
        let swap = |sum: &mut u64, old: u64, new: u64| *sum = sum.saturating_sub(old).saturating_add(new);
        swap(&mut t.input_tokens, self.last.input, next.input);
        swap(&mut t.cache_creation_input_tokens, self.last.creation, next.creation);
        swap(&mut t.cache_read_input_tokens, self.last.read, next.read);
        swap(&mut t.output_tokens, self.last.output, next.output);
        swap(&mut t.request_ms, self.last.ms, next.ms);
        self.last = next;
        if let Some(t) = ts { self.prev_ms = Some(t); }
    }
}

static TALLIES: OnceLock<Mutex<HashMap<PathBuf, Tally>>> = OnceLock::new();

/// 读取对话记录新增部分并返回累计值；文件变短（被重写）时从头统计。只接受 .jsonl。
pub fn read(path: &Path) -> Option<Usage> {
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { return None; }
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut map = TALLIES.get_or_init(Default::default).lock().unwrap();
    let t = map.entry(path.to_path_buf()).or_default();
    if len < t.offset { *t = Tally::default(); }
    if len > t.offset {
        f.seek(SeekFrom::Start(t.offset)).ok()?;
        let mut buf = vec![0u8; 1 << 20];
        let mut left = len - t.offset;
        while left > 0 {
            let want = buf.len().min(left as usize);
            let got = f.read(&mut buf[..want]).ok()?;
            if got == 0 { break; }
            t.feed(&buf[..got]);
            t.offset += got as u64;
            left -= got as u64;
        }
    }
    Some(t.total())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(id: &str, ts: &str, input: u64, read: u64, output: u64) -> String {
        format!(r#"{{"type":"assistant","timestamp":"{ts}","message":{{"id":"{id}","model":"m","usage":{{"input_tokens":{input},"cache_creation_input_tokens":10,"cache_read_input_tokens":{read},"output_tokens":{output}}}}}}}"#)
    }
    fn user(ts: &str) -> String { format!(r#"{{"type":"user","timestamp":"{ts}","message":{{"content":"含 \"timestamp\":\"2000-01-01T00:00:00Z\" 的文本"}}}}"#) }

    /// 同一请求多段回复只计一次、取最后的用量；耗时从前一条记录算起；子代理与合成消息不计。
    #[test]
    fn dedupes_requests_and_measures_duration() {
        let mut t = Tally::default();
        let lines = [
            user("2026-11-06T10:00:00Z"),
            assistant("a", "2026-11-06T10:00:02Z", 5, 100, 1),
            assistant("a", "2026-11-06T10:00:04Z", 5, 100, 40),
            user("2026-11-06T10:00:10Z"),
            r#"{"type":"assistant","isSidechain":true,"timestamp":"2026-11-06T10:00:11Z","message":{"id":"x","usage":{"output_tokens":999}}}"#.to_string(),
            r#"{"type":"assistant","timestamp":"2026-11-06T10:00:11Z","message":{"id":"s","model":"<synthetic>","usage":{"output_tokens":0}}}"#.to_string(),
            assistant("b", "2026-11-06T10:00:12Z", 3, 200, 60),
        ];
        t.feed((lines.join("\n") + "\n").as_bytes());
        assert_eq!(t.total(), Usage { requests: 2, input_tokens: 8, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 100, request_ms: 4000 + 1000 });
    }

    /// 末行未写完时暂不计入，补齐后与一次性读取结果一致；CRLF 换行同样处理。
    #[test]
    fn partial_lines_wait_for_completion() {
        let whole = format!("{}\r\n{}\n", user("2026-11-06T10:00:00Z"), assistant("a", "2026-11-06T10:00:03Z", 1, 2, 30));
        let (a, b) = whole.as_bytes().split_at(whole.len() - 20);
        let mut t = Tally::default();
        t.feed(a);
        assert_eq!(t.total().requests, 0);
        t.feed(b);
        assert_eq!(t.total(), Usage { requests: 1, input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 30, request_ms: 3000 });
    }

    /// 增量读取真实文件：只读新增字节，文件被截短后重新统计，非 jsonl 拒绝。
    #[test]
    fn reads_file_incrementally() {
        let dir = std::env::temp_dir().join(format!("flow_usage_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("会话 记录.jsonl");
        std::fs::write(&path, format!("{}\n{}\n", user("2026-11-06T10:00:00Z"), assistant("a", "2026-11-06T10:00:01Z", 1, 0, 5))).unwrap();
        assert_eq!(read(&path).unwrap().output_tokens, 5);
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(&mut f, format!("{}\n", assistant("b", "2026-11-06T10:00:03Z", 1, 0, 7)).as_bytes()).unwrap();
        drop(f);
        let u = read(&path).unwrap();
        assert_eq!((u.requests, u.output_tokens, u.request_ms), (2, 12, 3000));
        std::fs::write(&path, format!("{}\n", assistant("c", "2026-11-06T10:00:05Z", 1, 0, 2))).unwrap();
        assert_eq!(read(&path).unwrap().output_tokens, 2);
        assert!(read(&dir.join("x.txt")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
