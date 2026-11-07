//! 从 CLI 终端流识别明确的 API 失败和中断标记；跨读取块保留 ANSI 与当前行，不依赖静默时长猜测。

/// 只保存当前可见行和转义解析状态；每次新进程从空状态开始。
#[derive(Default)]
pub(super) struct ErrorOutput {
    line: String,
    escape: u8,
    detected: bool,
    interrupted: bool,
}

impl ErrorOutput {
    /// 主会话已恢复或正在执行工具时清掉旧行，避免把旧错误拼到后续输出。
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }

    /// 接收已解码 UTF-8 输出；返回本块中明确的报错行，保留 ANSI 跨块状态。
    pub(super) fn feed(&mut self, text: &str) -> Option<String> {
        let mut found = None;
        for c in text.chars() {
            match self.escape {
                1 => self.escape = match c { '[' => 2, ']' => 3, _ => 0 },
                2 => {
                    if ('@'..='~').contains(&c) {
                        // 光标换行、定位和擦除不能把两段不同屏幕行拼成报错。
                        if matches!(c, 'H' | 'f' | 'A' | 'B' | 'E' | 'F' | 'G' | 'J' | 'K') {
                            self.capture(&mut found);
                            self.line.clear();
                        } else if c == 'C' {
                            self.line.push(' ');
                        }
                        self.escape = 0;
                    }
                }
                3 => { if c == '\u{7}' { self.escape = 0; } else if c == '\u{1b}' { self.escape = 4; } }
                4 => self.escape = if c == '\\' { 0 } else { 3 },
                _ => match c {
                    '\u{1b}' => self.escape = 1,
                    '\r' | '\n' => { self.capture(&mut found); self.line.clear(); }
                    '\u{8}' => { self.line.pop(); }
                    c if !c.is_control() => {
                        if self.line.len() < 8192 { self.line.push(c); }
                    }
                    _ => {}
                },
            }
        }
        // TUI 的最后一行通常没有换行；完整重试标识出现后立即更新。
        self.capture(&mut found);
        found
    }

    /// 仅识别行首 CLI 报错；重试必须在同一行带 attempt，普通正文中引用的错误不匹配。
    fn capture(&mut self, found: &mut Option<String>) {
        let line = self.line.trim().trim_start_matches(['⎿', '●', '✖', '└']).trim();
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("interrupted · what should claude do instead?") {
            self.interrupted = true;
        }
        let retry = lower.contains("retrying in ") && lower.contains("attempt ")
            && lower.split("attempt ").nth(1).is_some_and(|s| s.contains('/'));
        let api = lower.starts_with("api error:") || lower.starts_with("api error ·")
            || lower.starts_with("api error ") && retry;
        let network = ["connection refused", "request failed", "unable to connect", "connection error", "overloaded"]
            .iter().any(|prefix| lower.starts_with(prefix));
        if (api && (lower.starts_with("api error:") || retry)) || network && retry {
            *found = Some(line.chars().take(500).collect());
            self.detected = true;
        }
    }

    /// 取走本块的明确中断标记；是否属于当前用户操作由读取方的输入证据决定。
    pub(super) fn take_interrupt(&mut self) -> bool { std::mem::take(&mut self.interrupted) }

    /// 已识别过报错后，Hook 清空错误代表新的状态周期；读取方应先 reset。
    pub(super) fn detected(&self) -> bool { self.detected }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 明确中断标记可跨块和 ANSI；普通叙述不当作中断，标记读取后消费。
    #[test]
    fn interrupt_marker_across_chunks() {
        let text = "\x1b[33m  └ Interrupted · What should Claude do instead?\x1b[0m";
        for (split, _) in text.char_indices() {
            let mut p = ErrorOutput::default();
            p.feed(&text[..split]);
            p.feed(&text[split..]);
            assert!(p.take_interrupt(), "split={split}");
            assert!(!p.take_interrupt());
        }
        let mut p = ErrorOutput::default();
        p.feed("文档里的 Interrupted · What should Claude do instead?");
        assert!(!p.take_interrupt());
    }

    /// 截图中的两种报错在任意 UTF-8 字符边界拆包仍会被完整识别。
    #[test]
    fn retries_survive_every_split() {
        for line in ["API error · Retrying in 0s · attempt 1/10", "Connection refused — a firewall or proxy may be blocking · Retrying in 13s · attempt 6/10"] {
            for (split, _) in line.char_indices() {
                let mut parser = ErrorOutput::default();
                parser.feed(&line[..split]);
                assert_eq!(parser.feed(&line[split..]).as_deref(), Some(line));
            }
        }
    }

    /// 颜色和 OSC 链接可以跨块，定位指令分隔不同屏幕行。
    #[test]
    fn ansi_and_redraw() {
        let mut p = ErrorOutput::default();
        assert!(p.feed("\x1b[3").is_none());
        assert!(p.feed("1m⎿ API err").is_none());
        assert_eq!(p.feed("or · Retrying in 0s · attempt 1/10\x1b[0m").as_deref(), Some("API error · Retrying in 0s · attempt 1/10"));
        p.reset();
        assert!(p.feed("\x1b]8;;https://example.org\x1b").is_none());
        assert_eq!(p.feed("\\API Error: 504 gateway timeout\x1b]8;;\x07").as_deref(), Some("API Error: 504 gateway timeout"));
        p.reset();
        assert!(p.feed("Connection refused\x1b[2KRetrying in 1s · attempt 1/10").is_none());
    }

    /// 不以超时、普通叙述、跨行拼接或孤立 retry 字样猜测 API 失败。
    #[test]
    fn ordinary_output_is_not_error() {
        for line in ["用户说 API error · Retrying in 0s · attempt 1/10", "示例：API Error: 504", "Connection refused\nexample Retrying in 1s · attempt 1/10", "Retrying in 1s · attempt 1/10", "API error in documentation"] {
            assert!(ErrorOutput::default().feed(line).is_none(), "{line}");
        }
    }

    /// 清空后不会重放旧错误；下一次真实重试可以重新报告并更新次数。
    #[test]
    fn reset_and_new_attempt() {
        let mut p = ErrorOutput::default();
        assert!(p.feed("API Error: 429 rate limit").is_some());
        p.reset();
        assert!(p.feed("正常回复").is_none());
        assert!(p.feed("\rAPI error · Retrying in 3s · attempt 2/10").is_some());
    }
}
