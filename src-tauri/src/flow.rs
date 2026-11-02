//! draw.io 文件解析：读取 `.drawio`（mxfile）中的节点，并按填充色/虚线映射协作状态。
//!
//! 状态口径（与项目规则「程序流程图」一致）：
//! - 无色 `none`：现状已实现；
//! - 黄 `#FFF2CC` `review`：Agent 起草待审；
//! - 灰 `#F5F5F5`+虚线 `plan_delete`：Agent 计划删除；
//! - 红 `#F8CECC` `issue`：用户标记有问题；
//! - 蓝 `#DAE8FC` `idea`：用户的想法/改动；
//! - 绿 `#D5E8D4` `confirmed`：用户已确认，待执行；绿+虚线 `confirm_delete`：确认删除；
//! - 其他颜色 `unknown`。
//!
//! 不计入统计：连线、便签（`shape=note`）、纯文本、泳道、分组、连线标签。

use std::collections::BTreeMap;
use std::io::Read;

use base64::Engine;
use serde::{Deserialize, Serialize};

/// 协作状态全集，顺序即界面展示顺序。
pub const STATUSES: [&str; 8] = [
    "none",
    "review",
    "plan_delete",
    "issue",
    "idea",
    "confirmed",
    "confirm_delete",
    "unknown",
];

/// 一个参与统计的流程图节点。
/// - `page_id`/`page_name`：所在页（draw.io 多页）；
/// - `id`：mxCell id，页内唯一，用于历史对比；
/// - `label`：去 HTML 后的纯文本；`status`：见模块说明；`fill`：原始填充色（小写）；
/// - `tags`：draw.io 标签（`<object tags="Feat_260910_1 T2">`），用于关联 Feat，历史库不存。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Node {
    pub page_id: String,
    pub page_name: String,
    pub id: String,
    pub label: String,
    pub status: String,
    pub fill: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 各状态计数，键为 `STATUSES` 中的状态名，始终包含全部键。
pub type Counts = BTreeMap<String, usize>;

/// 生成全零计数表。
pub fn empty_counts() -> Counts {
    STATUSES.iter().map(|s| (s.to_string(), 0)).collect()
}

/// 统计节点列表的各状态数量。
pub fn count(nodes: &[Node]) -> Counts {
    let mut c = empty_counts();
    for n in nodes {
        *c.get_mut(&n.status).expect("状态必在 STATUSES 中") += 1;
    }
    c
}

/// 按 draw.io 样式串解析为 (基础形状名, 键值表)。
/// 样式形如 `ellipse;whiteSpace=wrap;fillColor=#fff2cc;`，首个无 `=` 的片段为基础形状名。
fn parse_style(style: &str) -> (String, BTreeMap<String, String>) {
    let mut base = String::new();
    let mut kv = BTreeMap::new();
    for part in style.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        match part.split_once('=') {
            Some((k, v)) => {
                kv.insert(k.to_string(), v.to_string());
            }
            None if base.is_empty() => base = part.to_string(),
            None => {}
        }
    }
    (base, kv)
}

/// 判断样式是否为不计入统计的形状（文本、便签、泳道、分组、连线标签）。
fn is_excluded(base: &str, kv: &BTreeMap<String, String>) -> bool {
    let shape = kv.get("shape").map(String::as_str).unwrap_or("");
    matches!(base, "text" | "swimlane" | "group" | "edgeLabel" | "note")
        || matches!(shape, "note" | "swimlane")
}

/// 按填充色与虚线映射状态；输入为样式键值表，输出 (状态名, 小写填充色)。
pub fn classify_style(kv: &BTreeMap<String, String>) -> (&'static str, String) {
    let fill = kv.get("fillColor").map(|s| s.to_lowercase()).unwrap_or_default();
    let dashed = kv.get("dashed").map(|s| s == "1").unwrap_or(false);
    let status = match fill.as_str() {
        "" | "none" | "default" | "#ffffff" => "none",
        "#fff2cc" => "review",
        "#f8cecc" => "issue",
        "#dae8fc" => "idea",
        "#d5e8d4" if dashed => "confirm_delete",
        "#d5e8d4" => "confirmed",
        "#f5f5f5" if dashed => "plan_delete",
        _ => "unknown",
    };
    (status, fill)
}

/// 把节点 value（HTML）转成纯文本：`<br>` 与块级标签换为空格，去其余标签，解常见实体，压缩空白。
pub fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' if in_tag => in_tag = false,
            _ if in_tag => {}
            _ => out.push(ch),
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 解码压缩格式的 diagram 文本：base64 → raw deflate → URL 解码。
pub fn decode_compressed(text: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|e| format!("diagram base64 解码失败: {e}"))?;
    let mut inflated = String::new();
    flate2::read::DeflateDecoder::new(&bytes[..])
        .read_to_string(&mut inflated)
        .map_err(|e| format!("diagram 解压失败: {e}"))?;
    Ok(percent_encoding::percent_decode_str(&inflated).decode_utf8_lossy().into_owned())
}

/// 从一个 mxGraphModel 节点收集参与统计的节点。
/// 兼容 `<object>`/`<UserObject>` 包裹 mxCell 的写法（id 与 label 在外层）。
fn collect_model(model: roxmltree::Node, page_id: &str, page_name: &str, out: &mut Vec<Node>) {
    for el in model.descendants().filter(|n| n.has_tag_name("mxCell")) {
        if el.attribute("vertex") != Some("1") {
            continue;
        }
        let wrapper = el
            .parent_element()
            .filter(|p| p.has_tag_name("object") || p.has_tag_name("UserObject"));
        let (id, value, tags) = match wrapper {
            Some(w) => (w.attribute("id"), w.attribute("label"), w.attribute("tags")),
            None => (el.attribute("id"), el.attribute("value"), None),
        };
        let Some(id) = id else { continue };
        let (base, kv) = parse_style(el.attribute("style").unwrap_or(""));
        if is_excluded(&base, &kv) {
            continue;
        }
        let (status, fill) = classify_style(&kv);
        out.push(Node {
            page_id: page_id.to_string(),
            page_name: page_name.to_string(),
            id: id.to_string(),
            label: strip_html(value.unwrap_or("")),
            status: status.to_string(),
            fill,
            tags: tags.map(|t| t.split_whitespace().map(str::to_string).collect()).unwrap_or_default(),
        });
    }
}

/// 解析 `.drawio` 文件内容，返回所有参与统计的节点。
/// 支持未压缩（diagram 内直接是 mxGraphModel）与压缩（diagram 文本为编码串）两种格式；
/// 根元素也可直接是 mxGraphModel（单页旧格式）。XML 非法时报错。
pub fn parse(xml: &str) -> Result<Vec<Node>, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("XML 解析失败: {e}"))?;
    let root = doc.root_element();
    let mut out = Vec::new();
    if root.has_tag_name("mxGraphModel") {
        collect_model(root, "", "", &mut out);
        return Ok(out);
    }
    for (i, diagram) in root.children().filter(|n| n.has_tag_name("diagram")).enumerate() {
        let page_id = diagram.attribute("id").map(str::to_string).unwrap_or_else(|| format!("page-{i}"));
        let page_name = diagram.attribute("name").unwrap_or("").to_string();
        if let Some(model) = diagram.children().find(|n| n.has_tag_name("mxGraphModel")) {
            collect_model(model, &page_id, &page_name, &mut out);
            continue;
        }
        let text = diagram.text().unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let inner = decode_compressed(text)?;
        let inner_doc = roxmltree::Document::parse(&inner).map_err(|e| format!("页 {page_name} XML 解析失败: {e}"))?;
        collect_model(inner_doc.root_element(), &page_id, &page_name, &mut out);
    }
    Ok(out)
}

/// 新建空白流程图的 XML（未压缩，一页），页名为图名。
pub fn blank_diagram(name: &str) -> String {
    let esc = name.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;");
    format!(
        "<mxfile host=\"rs_flow_coding\">\n  <diagram id=\"page-1\" name=\"{esc}\">\n    <mxGraphModel grid=\"1\" gridSize=\"10\" guides=\"1\" tooltips=\"1\" connect=\"1\" arrows=\"1\" fold=\"1\" page=\"1\" pageScale=\"1\" pageWidth=\"1400\" pageHeight=\"1000\" math=\"0\" shadow=\"0\">\n      <root>\n        <mxCell id=\"0\" />\n        <mxCell id=\"1\" parent=\"0\" />\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r##"<mxfile><diagram id="p1" name="页1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="加载配置&lt;br&gt;m_xxx.load_config" style="rounded=1;" vertex="1" parent="1"/>
<mxCell id="b" value="起草" style="fillColor=#FFF2CC;" vertex="1" parent="1"/>
<mxCell id="c" value="删" style="fillColor=#f5f5f5;dashed=1;" vertex="1" parent="1"/>
<mxCell id="d" value="灰实线" style="fillColor=#f5f5f5;" vertex="1" parent="1"/>
<mxCell id="e" value="确认删" style="fillColor=#d5e8d4;dashed=1;" vertex="1" parent="1"/>
<mxCell id="f" value="确认" style="fillColor=#d5e8d4;" vertex="1" parent="1"/>
<mxCell id="g" value="便签" style="shape=note;fillColor=#fff2cc;" vertex="1" parent="1"/>
<mxCell id="h" value="标题" style="text;html=1;" vertex="1" parent="1"/>
<mxCell id="i" value="V" style="swimlane;fillColor=#dae8fc;" vertex="1" parent="1"/>
<mxCell id="j" style="endArrow=classic;" edge="1" parent="1" source="a" target="b"/>
<object id="k" label="包裹" tags="Feat_1 T2"><mxCell style="fillColor=#f8cecc;" vertex="1" parent="1"/></object>
</root></mxGraphModel></diagram></mxfile>"##;

    #[test]
    fn parse_classifies_and_excludes() {
        let nodes = parse(SAMPLE).unwrap();
        let got: Vec<(&str, &str)> = nodes.iter().map(|n| (n.id.as_str(), n.status.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("a", "none"),
                ("b", "review"),
                ("c", "plan_delete"),
                ("d", "unknown"),
                ("e", "confirm_delete"),
                ("f", "confirmed"),
                ("k", "issue"),
            ]
        );
        assert_eq!(nodes[0].label, "加载配置 m_xxx.load_config");
        assert_eq!(nodes[6].label, "包裹");
        assert_eq!(nodes[6].tags, vec!["Feat_1", "T2"]);
        assert!(nodes[0].tags.is_empty());
        let c = count(&nodes);
        assert_eq!(c["review"], 1);
        assert_eq!(c.len(), STATUSES.len());
    }

    #[test]
    fn parse_compressed_page() {
        use std::io::Write;
        let inner = r#"<mxGraphModel><root><mxCell id="0"/><mxCell id="x" value="蓝" style="fillColor=#dae8fc;" vertex="1" parent="0"/></root></mxGraphModel>"#;
        let encoded: String = percent_encoding::utf8_percent_encode(inner, percent_encoding::NON_ALPHANUMERIC).to_string();
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(encoded.as_bytes()).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(enc.finish().unwrap());
        let xml = format!(r#"<mxfile><diagram id="p" name="n">{b64}</diagram></mxfile>"#);
        let nodes = parse(&xml).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].status, "idea");
    }

    #[test]
    fn blank_is_parsable() {
        assert!(parse(&blank_diagram("新图 <a&b>")).unwrap().is_empty());
    }
}
