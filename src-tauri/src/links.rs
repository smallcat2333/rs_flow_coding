//! 图间链接：解析 `.drawio` 节点上的 `link` 属性（draw.io「编辑链接」），
//! 提供解析（`resolve_flow_link`）、校验（`flowctl links`）与图改名后的批量改写（`rename`）。
//!
//! 约定：链接值 `<目标图>[#节点id]`，相对路径以所在图目录为基准，支持 `..` 跨 APP；
//! 中文、空格、`&` 可直写也可 URL 编码；`http:`、`data:`、`file:` 等非本地链接不参与解析；
//! `#节点id`（同图内跳转）不算图间链接，不校验。

use std::ops::Range;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{flow, paths, scan};

/// 一个携带图间链接的节点：id 为节点引用所用的 id（`<object>` 包装层或 `mxCell` id）。
#[derive(Debug, Clone)]
pub struct LinkCell {
    pub id: String,
    pub link: String,
}

/// `resolve_flow_link` 的返回：目标图规范路径；`node` 为链接 `#` 后的节点 id（无则空）。
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedLink {
    pub path: String,
    pub node: String,
}

/// `flowctl links` 的一条坏链接记录。
#[derive(Debug, Clone, Serialize)]
pub struct BrokenLink {
    pub file: String,
    pub node: String,
    pub link: String,
    pub error: String,
}

/// 一个待改写的 `link` 属性：`range` 为属性值在源文本中的字节范围，`value` 为解码后的链接。
struct LinkAttr {
    range: Range<usize>,
    value: String,
}

/// 是否指向本地文件路径（相对路径或 Windows 绝对路径）。
/// `http:`、`data:`、`file:`、`action:` 等 scheme 与 `#节点`、`?x` 返回 false；`C:\x.drawio` 视为本地路径。
/// 判定：取 `?`/`#` 之前的首段，含 `:` 时仅当形如 `X:\` / `X:/`（盘符）才算本地，否则非本地。
pub fn is_local_link(link: &str) -> bool {
    let head = link.split(['#', '?']).next().unwrap_or_default();
    if head.is_empty() {
        return false;
    }
    // Windows 盘符：`X:` 后跟 \ 或 / 时是绝对路径而不是 scheme。
    if head.len() >= 3
        && head.as_bytes()[0].is_ascii_alphabetic()
        && head.as_bytes()[1] == b':'
        && matches!(head.as_bytes()[2], b'/' | b'\\')
    {
        return true;
    }
    !head.contains(':') && !head.starts_with("//") && !head.starts_with("\\\\")
}

/// 本地且扩展名为 .drawio 的导航链接；普通文件和网页链接不参与图链接校验。
pub fn is_flow_link(link: &str) -> bool {
    let (path, _) = split(link);
    is_local_link(link) && Path::new(&decode(&path)).extension().is_some_and(|e| e.eq_ignore_ascii_case("drawio"))
}

/// 手工归一 `.` / `..` 与混用分隔符（`canonicalize` 不能处理含 `..` 的路径）。
/// 不存在的 `..` 段保留原样（越出根后由后续 exists 校验报错）。
fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out: Vec<std::path::Component> = Vec::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => { out.pop(); }
                _ => out.push(c),
            },
            _ => out.push(c),
        }
    }
    out.iter().collect()
}

/// 拆分为 (路径部分, fragment)；fragment 不含 `#`，均去首尾空白。
fn split(link: &str) -> (String, String) {
    match link.split_once('#') {
        Some((p, f)) => (p.trim().to_string(), f.trim().to_string()),
        None => (link.trim().to_string(), String::new()),
    }
}

/// percent 解码；无编码时与原值相同（`%` 后非法序列原样保留）。
fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

/// 解析 link 的目标文件：必须是本地链接、扩展名 `.drawio`、文件存在；返回规范路径。
/// 先按属性原值尝试，不存在再按 percent-decoded 值尝试（兼容直写与编码两种写法）。
pub fn resolve_file(source: &Path, link: &str) -> Result<PathBuf, String> {
    let (path_part, _) = split(link);
    if path_part.is_empty() {
        return Err("链接没有目标文件".into());
    }
    if !is_local_link(link) {
        return Err(format!("不是本地图链接：{link}"));
    }
    let base = source.parent().ok_or_else(|| "源图缺少父目录".to_string())?;
    let decoded = decode(&path_part);
    let mut last_err = String::new();
    for cand_s in std::iter::once(&path_part).chain((decoded != path_part).then_some(&decoded)) {
        let cand = Path::new(cand_s);
        let joined = if cand.is_absolute() { cand.to_path_buf() } else { base.join(cand) };
        let joined = normalize(&joined);
        if !joined.extension().is_some_and(|x| x.eq_ignore_ascii_case("drawio")) {
            last_err = format!("目标不是 .drawio：{cand_s}");
            continue;
        }
        match dunce::canonicalize(&joined) {
            Ok(p) => return Ok(p),
            Err(e) => last_err = format!("目标不存在：{}: {e}", joined.display()),
        }
    }
    Err(last_err)
}

/// 遍历图中全部顶点单元（含被统计排除的形状，泳道等也可作跳转目标）。
/// 未压缩页直接遍历文档；压缩页逐页解压后遍历（解析用，不给出文本位置）。
fn for_each_vertex(xml: &str, mut f: impl FnMut(roxmltree::Node, Option<roxmltree::Node>)) -> Result<(), String> {
    fn walk(doc: &roxmltree::Document, f: &mut impl FnMut(roxmltree::Node, Option<roxmltree::Node>)) {
        for el in doc.descendants().filter(|n| n.has_tag_name("mxCell") && n.attribute("vertex") == Some("1")) {
            let w = el.parent_element().filter(|p| p.has_tag_name("object") || p.has_tag_name("UserObject"));
            f(el, w);
        }
    }
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("XML 解析失败: {e}"))?;
    let root = doc.root_element();
    if root.has_tag_name("mxGraphModel") {
        walk(&doc, &mut f);
        return Ok(());
    }
    if !root.has_tag_name("mxfile") || !root.children().any(|n| n.has_tag_name("diagram")) {
        return Err("不是有效的 draw.io 流程图".into());
    }
    let mut doc_walked = false;
    for d in root.children().filter(|n| n.has_tag_name("diagram")) {
        if d.children().any(|n| n.has_tag_name("mxGraphModel")) {
            // 未压缩内容已在原文档树中，整体遍历一次即可。
            if !doc_walked {
                doc_walked = true;
                walk(&doc, &mut f);
            }
            continue;
        }
        let text = d.text().unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let inner = flow::decode_compressed(text)?;
        let inner_doc = roxmltree::Document::parse(&inner).map_err(|e| format!("压缩页 XML 解析失败: {e}"))?;
        walk(&inner_doc, &mut f);
    }
    Ok(())
}

/// 收集图中全部本地图间链接（含压缩页），返回 (节点id, link 原值)。
/// 非本地链接（scheme、同图 `#id`）不计入。
pub fn link_cells(xml: &str) -> Result<Vec<LinkCell>, String> {
    let mut out = Vec::new();
    for_each_vertex(xml, |cell, wrapper| {
        let (id, link) = match wrapper {
            Some(w) => (w.attribute("id").or(cell.attribute("id")), w.attribute("link").or(cell.attribute("link"))),
            None => (cell.attribute("id"), cell.attribute("link")),
        };
        if let (Some(id), Some(link)) = (id, link) {
            if is_flow_link(link) {
                out.push(LinkCell { id: id.to_string(), link: link.to_string() });
            }
        }
    })?;
    Ok(out)
}

/// 目标图中是否存在指定 id 的顶点节点（object 包装层 id 或 mxCell id 都算）。
fn has_vertex(xml: &str, id: &str) -> Result<bool, String> {
    let mut found = false;
    for_each_vertex(xml, |cell, wrapper| {
        let cid = wrapper.and_then(|w| w.attribute("id")).or(cell.attribute("id"));
        if cid == Some(id) {
            found = true;
        }
    })?;
    Ok(found)
}

/// 完整解析链接：目标文件存在，且 `#` 指定的节点在目标图中存在。
/// fragment 同样先按原值后按 percent-decoded 尝试；返回的 node 为实际匹配到的 id。
pub fn resolve(source: &Path, link: &str) -> Result<ResolvedLink, String> {
    let target = resolve_file(source, link)?;
    let (_, frag) = split(link);
    let mut node = String::new();
    let xml = std::fs::read_to_string(&target).map_err(|e| format!("读取目标图失败 {}: {e}", target.display()))?;
    for_each_vertex(&xml, |_, _| {})?;
    if !frag.is_empty() {
        let frag_dec = decode(&frag);
        if has_vertex(&xml, &frag)? {
            node = frag;
        } else if frag_dec != frag && has_vertex(&xml, &frag_dec)? {
            node = frag_dec;
        } else {
            return Err(format!("目标节点不存在：{link}"));
        }
    }
    Ok(ResolvedLink { path: target.to_string_lossy().into_owned(), node })
}

/// 收集未压缩文档中顶点的 `link` 属性位置（`value_range` 不含引号）；压缩页无法定位，跳过。
fn link_attrs(xml: &str) -> Result<Vec<LinkAttr>, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("XML 解析失败: {e}"))?;
    let mut out = Vec::new();
    for el in doc.descendants().filter(|n| n.has_tag_name("mxCell") && n.attribute("vertex") == Some("1")) {
        let w = el.parent_element().filter(|p| p.has_tag_name("object") || p.has_tag_name("UserObject"));
        let attr = w.and_then(|w| w.attribute_node("link")).or_else(|| el.attribute_node("link"));
        if let Some(a) = attr {
            out.push(LinkAttr { range: a.range_value(), value: a.value().to_string() });
        }
    }
    Ok(out)
}

/// XML 属性值转义（属性值写入双引号内）。
fn xml_escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// 改写 `xml` 中解析后指向 `old`（改名前路径）的全部图间链接为新文件名 `new_name`。
/// `src` 为含链接文件的路径（用于相对解析）。返回新文本；无命中返回 None。
/// 保留原相对路径结构与 `#` 片段，只替换路径末段文件名。
pub fn rewrite_links(src: &Path, xml: &str, old: &Path, new_name: &str) -> Result<Option<String>, String> {
    let attrs = link_attrs(xml)?;
    if attrs.is_empty() {
        return Ok(None);
    }
    let old_key = paths::key(&dunce::canonicalize(old).unwrap_or_else(|_| old.to_path_buf()));
    let mut hits: Vec<(Range<usize>, String)> = Vec::new();
    for a in attrs {
        if !is_local_link(&a.value) {
            continue;
        }
        let Ok(target) = resolve_file(src, &a.value) else { continue };
        if paths::key(&target) != old_key {
            continue;
        }
        let (p, frag) = split(&a.value);
        let p = decode(&p);
        let cut = p.rfind(['/', '\\']).map(|i| i + 1).unwrap_or(0);
        let mut newv = String::with_capacity(p.len() + new_name.len() + frag.len() + 1);
        newv.push_str(&p[..cut].replace('%', "%25").replace('#', "%23"));
        newv.push_str(&new_name.replace('%', "%25").replace('#', "%23"));
        if !frag.is_empty() {
            newv.push('#');
            newv.push_str(&frag);
        }
        hits.push((a.range, xml_escape_attr(&newv)));
    }
    if hits.is_empty() {
        return Ok(None);
    }
    hits.sort_by_key(|h| h.0.start);
    let mut out = xml.to_string();
    for (r, repl) in hits.into_iter().rev() {
        out.replace_range(r, &repl);
    }
    Ok(Some(out))
}

/// 收集同目录及已配置项目中所有指向改名图的链接；返回 (文件, 原文, 新文)。
/// 保留读取时的原文用于加锁后校验；无法读取或解析时拒绝改名，避免静默断链。
pub fn collect_link_edits(renamed: &Path, new_name: &str) -> Result<Vec<(PathBuf, String, String)>, String> {
    let mut dirs = std::collections::BTreeMap::new();
    if let Some(d) = renamed.parent() { dirs.insert(paths::key(d), d.to_path_buf()); }
    let cfg = scan::load_config()?;
    for root in &cfg.roots {
        for d in scan::scan_root(Path::new(root)) {
            let p = PathBuf::from(d.flow_dir);
            dirs.insert(paths::key(&p), p);
        }
    }
    for d in &cfg.flow_dirs {
        let p = PathBuf::from(d);
        dirs.insert(paths::key(&p), p);
    }
    let mut out = Vec::new();
    for dir in dirs.values() {
        for f in scan::list_drawio(dir) {
            let before = std::fs::read_to_string(&f).map_err(|e| format!("读取关联图失败 {}: {e}", f.display()))?;
            if let Some(after) = rewrite_links(&f, &before, renamed, new_name).map_err(|e| format!("{}: {e}", f.display()))? {
                out.push((f, before, after));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 各测试独立的临时 APP 目录，避免并行互相覆盖。
    fn fixture(tag: &str) -> PathBuf {
        let p = paths::test_home().join(format!("links_{tag}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(p.join("docs/flow")).unwrap();
        p
    }

    /// 生成单页未压缩的最小有效图，用于路径和链接测试。
    fn diagram(body: &str) -> String {
        format!("<mxfile><diagram id=\"p1\" name=\"页\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>{body}</root></mxGraphModel></diagram></mxfile>")
    }

    /// 本地/非本地链接的判定边界。
    #[test]
    fn local_link_detection() {
        for ok in ["b.drawio", "子/b.drawio", "../x/b.drawio", "配置 加载.drawio", "a&amp;b.drawio", "%E9%85%8D.drawio", "C:\\x\\b.drawio", "x.drawio#n1"] {
            assert!(is_local_link(ok), "应为本地: {ok}");
        }
        for no in ["#n1", "", "https://x/y.drawio", "data:page/id=1", "file:///x/b.drawio", "action:data,open", "mailto:a@b"] {
            assert!(!is_local_link(no), "应为非本地: {no}");
        }
    }

    /// resolve：普通、带 fragment、object 包装节点、泳道、URL 编码文件名。
    #[test]
    fn resolve_targets_and_nodes() {
        let app = fixture("resolve");
        let dir = app.join("docs/flow");
        std::fs::write(dir.join("b.drawio"), diagram(
            "<mxCell id=\"n1\" value=\"目标\" vertex=\"1\" parent=\"1\"/>\
             <object id=\"n2\"><mxCell vertex=\"1\" parent=\"1\"/></object>\
             <mxCell id=\"ln\" value=\"V\" style=\"swimlane;\" vertex=\"1\" parent=\"1\"/>")).unwrap();
        std::fs::write(dir.join("b 2.drawio"), diagram("<mxCell id=\"x\" vertex=\"1\" parent=\"1\"/>")).unwrap();
        let a = dir.join("a.drawio");
        assert_eq!(resolve(&a, "b.drawio").unwrap().path, dunce::canonicalize(dir.join("b.drawio")).unwrap().to_string_lossy());
        assert_eq!(resolve(&a, "b.drawio#n1").unwrap().node, "n1");
        assert_eq!(resolve(&a, "b.drawio#n2").unwrap().node, "n2");
        assert_eq!(resolve(&a, "b.drawio#ln").unwrap().node, "ln");
        assert!(resolve(&a, "b%202.drawio").is_ok());
        assert!(resolve(&a, "b 2.drawio").is_ok());
        assert!(resolve(&a, "b.drawio#none").unwrap_err().contains("目标节点不存在"));
        assert!(resolve(&a, "missing.drawio").unwrap_err().contains("目标不存在"));
        assert!(resolve(&a, "b.md").unwrap_err().contains("目标不是 .drawio"));
        assert!(resolve(&a, "https://x/b.drawio").unwrap_err().contains("不是本地图链接"));
    }

    /// resolve：跨 APP 相对路径（../ 跳出 docs/flow）。
    #[test]
    fn resolve_cross_app() {
        let root = fixture("cross");
        let f1 = root.join("app_a/docs/flow");
        let f2 = root.join("app_b/docs/flow");
        std::fs::create_dir_all(&f2).unwrap();
        std::fs::write(f2.join("m.drawio"), diagram("<mxCell id=\"n\" vertex=\"1\" parent=\"1\"/>")).unwrap();
        std::fs::create_dir_all(&f1).unwrap();
        let a = f1.join("a.drawio");
        std::fs::write(&a, diagram("<object id=\"a\" link=\"../../../app_b/docs/flow/m.drawio#n\"><mxCell vertex=\"1\" parent=\"1\"/></object>")).unwrap();
        let r = resolve(&a, "../../../app_b/docs/flow/m.drawio#n").unwrap();
        assert!(r.path.ends_with("m.drawio"));
        assert_eq!(r.node, "n");
        // 循环和自引用只解析直接目标，不递归，均合法。
        assert_eq!(resolve(&f2.join("m.drawio"), "../../../app_a/docs/flow/a.drawio#a").unwrap().node, "a");
        assert_eq!(resolve(&a, "a.drawio#a").unwrap().node, "a");
        std::fs::write(&a, "broken XML").unwrap();
        assert!(resolve(&a, "a.drawio").is_err());
    }

    /// link_cells：object/UserObject/mxCell 三种挂载位置与 XML 实体解码。
    #[test]
    fn link_cells_collect() {
        let xml = diagram(
            "<mxCell id=\"c1\" link=\"b.drawio\" vertex=\"1\" parent=\"1\"/>\
             <object id=\"c2\" link=\"x/y.drawio#n\"><mxCell vertex=\"1\" parent=\"1\"/></object>\
             <UserObject id=\"c3\" link=\"a&amp;b.drawio\" label=\"x\"><mxCell vertex=\"1\" parent=\"1\"/></UserObject>\
             <mxCell id=\"c4\" link=\"https://x/y\" vertex=\"1\" parent=\"1\"/>\
             <mxCell id=\"c5\" link=\"#n1\" vertex=\"1\" parent=\"1\"/>\
             <mxCell id=\"c6\" link=\"README.md\" vertex=\"1\" parent=\"1\"/>");
        let cells = link_cells(&xml).unwrap();
        let got: Vec<(&str, &str)> = cells.iter().map(|c| (c.id.as_str(), c.link.as_str())).collect();
        assert_eq!(got, vec![("c1", "b.drawio"), ("c2", "x/y.drawio#n"), ("c3", "a&b.drawio")]);
    }

    /// rewrite_links：指向被改名文件的链接更新文件名、保留相对路径与 fragment；
    /// 同名但不同路径的链接、网页链接、同图 # 链接不受影响。
    #[test]
    fn rewrite_keeps_structure() {
        let app = fixture("rewrite");
        let dir = app.join("docs/flow");
        let old = dir.join("chat.drawio");
        std::fs::write(&old, diagram("")).unwrap();
        let src_xml = diagram(
            "<mxCell id=\"a\" link=\"chat.drawio\" vertex=\"1\" parent=\"1\"/>\
             <object id=\"b\" link=\"chat.drawio#n1\"><mxCell vertex=\"1\" parent=\"1\"/></object>\
             <mxCell id=\"c\" link=\"../other/docs/flow/chat.drawio#x&amp;y\" vertex=\"1\" parent=\"1\"/>\
             <mxCell id=\"d\" link=\"mychat.drawio\" vertex=\"1\" parent=\"1\"/>\
             <mxCell id=\"e\" link=\"https://x/chat.drawio\" vertex=\"1\" parent=\"1\"/>");
        // 命中 a、b；c 指向另一 APP 同名文件不存在不误改；d/e 不动
        let other = dir.join("../other/docs/flow");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("chat.drawio"), diagram("")).unwrap();
        let after = rewrite_links(&dir.join("s.drawio"), &src_xml, &old, "聊天.drawio").unwrap().unwrap();
        assert!(after.contains("link=\"聊天.drawio\""));
        assert!(after.contains("link=\"聊天.drawio#n1\""));
        assert!(after.contains("link=\"../other/docs/flow/chat.drawio#x&amp;y\""));
        assert!(after.contains("link=\"mychat.drawio\""));
        assert!(after.contains("link=\"https://x/chat.drawio\""));
        assert!(roxmltree::Document::parse(&after).is_ok());
        assert_eq!(rewrite_links(&dir.join("s.drawio"), &src_xml, &other.join("chat.drawio"), "z.drawio").unwrap().unwrap().contains("link=\"../other/docs/flow/z.drawio#x&amp;y\""), true);
    }

    /// rewrite_links：URL 编码的旧文件名也能解析命中。
    #[test]
    fn rewrite_encoded() {
        let app = fixture("enc");
        let dir = app.join("docs/flow");
        let old = dir.join("配 置.drawio");
        std::fs::write(&old, diagram("")).unwrap();
        let xml = diagram("<mxCell id=\"a\" link=\"%E9%85%8D%20%E7%BD%AE.drawio#n\" vertex=\"1\" parent=\"1\"/>");
        let after = rewrite_links(&dir.join("s.drawio"), &xml, &old, "新 名.drawio").unwrap().unwrap();
        assert!(after.contains("link=\"新 名.drawio#n\""));
    }
}
