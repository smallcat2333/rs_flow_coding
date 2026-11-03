// CodeMirror 就地预览：非编辑块显示 Markdown，光标进入后还原原文；磁盘内容始终为 Markdown。
'use strict';

window.LiveMarkdown = (() => {
  const { StateField, StateEffect, EditorView, Decoration, WidgetType, marked } = window.Vendor;
  const focusChanged = StateEffect.define();
  const allowed = new Set('P BR HR H1 H2 H3 H4 H5 H6 STRONG EM DEL S CODE PRE BLOCKQUOTE UL OL LI INPUT TABLE THEAD TBODY TR TH TD A IMG DIV SPAN SUP SUB KBD DETAILS SUMMARY'.split(' '));

  /** 预览只保留排版标签和安全属性，避免档案中的 HTML 在编辑器中执行。 */
  function fragment(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    for (const el of [...template.content.querySelectorAll('*')]) {
      if (!allowed.has(el.tagName)) { el.replaceWith(document.createTextNode(el.textContent)); continue; }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const keep = ['title', 'alt', 'start', 'colspan', 'rowspan', 'align'].includes(name)
          || (el.tagName === 'INPUT' && ['type', 'checked', 'disabled'].includes(name))
          || (el.tagName === 'A' && name === 'href') || (el.tagName === 'IMG' && name === 'src');
        if (!keep || (['href', 'src'].includes(name) && !safeUrl(attr.value))) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'INPUT') {
        if (el.type !== 'checkbox') el.remove();
        else { el.disabled = false; el.setAttribute('aria-label', '切换任务完成状态'); }
      }
      if (el.tagName === 'A') { el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    }
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const node of texts) {
      if (node.parentElement?.closest('a, pre, code')) continue;
      const re = /([\w一-龥-]+\.drawio)#([\w-]+)/g;
      const out = document.createDocumentFragment();
      let last = 0;
      for (const m of node.textContent.matchAll(re)) {
        out.append(node.textContent.slice(last, m.index));
        const a = document.createElement('a');
        a.className = 'node-ref'; a.href = '#'; a.textContent = m[0];
        a.dataset.file = m[1]; a.dataset.id = m[2];
        out.append(a); last = m.index + m[0].length;
      }
      if (last) { out.append(node.textContent.slice(last)); node.replaceWith(out); }
    }
    return template.content;
  }

  function safeUrl(value) {
    try { return ['http:', 'https:', 'mailto:'].includes(new URL(value, location.href).protocol); }
    catch { return false; }
  }

  /** 解析结果按文档缓存；只移动光标时无需重复解析 Markdown。 */
  function blocks(doc) {
    const text = doc.toString();
    const tokens = marked.lexer(text, { gfm: true });
    let from = 0;
    return tokens.map((token) => {
      const start = from;
      from += token.raw.length;
      // marked 会规范化少数空白；偏移不一致时保留原文，绝不改动档案内容。
      if (text.slice(start, from) !== token.raw) return null;
      if (['space', 'def', 'html'].includes(token.type)) return null;
      const to = from - (token.raw.match(/\n+$/) || [''])[0].length;
      const one = [token]; one.links = tokens.links;
      return to > start ? { from: start, to, raw: text.slice(start, to), html: marked.parser(one, { gfm: true }) } : null;
    }).filter(Boolean);
  }

  function extension(onNodeRef) {
    class Preview extends WidgetType {
      constructor(block) { super(); this.block = block; }
      eq(other) { return this.block.from === other.block.from && this.block.raw === other.block.raw && this.block.html === other.block.html; }
      toDOM(view) {
        const { from, to, raw, html } = this.block;
        const box = document.createElement('div');
        box.className = 'md md-live-block'; box.dataset.from = from;
        box.append(fragment(html));
        const checks = [...raw.matchAll(/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/gm)];
        box.querySelectorAll('input[type="checkbox"]').forEach((input, i) => {
          const match = checks[i];
          input.disabled = !match || view.state.readOnly;
          input.addEventListener('mousedown', (e) => e.preventDefault());
          input.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!match || view.state.readOnly || view.contentDOM.contentEditable === 'false') { e.preventDefault(); return; }
            const pos = from + match.index + match[0].lastIndexOf('[') + 1;
            view.dispatch({ changes: { from: pos, to: pos + 1, insert: input.checked ? 'x' : ' ' } });
          });
        });
        box.addEventListener('mousedown', (e) => {
          if (e.target.closest('a, input, summary')) return;
          e.preventDefault();
        });
        box.addEventListener('click', (e) => {
          const ref = e.target.closest('.node-ref');
          if (ref) { e.preventDefault(); onNodeRef(ref.dataset.file, ref.dataset.id); return; }
          if (e.target.closest('a, input, summary')) return;
          // 用点击处文本映射回源码，表格/代码块也在同一位置展开编辑。
          let pos = from;
          const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
          if (caret && box.contains(caret.startContainer) && caret.startContainer.nodeType === Node.TEXT_NODE) {
            const needle = caret.startContainer.textContent;
            const index = raw.indexOf(needle);
            if (index >= 0) pos += index + caret.startOffset;
          }
          view.dispatch({ selection: { anchor: Math.min(to, pos) } });
          view.focus();
        });
        return box;
      }
      ignoreEvent() { return true; }
    }

    function decorate(state, parsed, focused) {
      const ranges = [];
      for (const block of parsed) {
        const active = focused && state.selection.ranges.some((r) => r.from <= block.to && r.to >= block.from);
        if (!active) {
          ranges.push(Decoration.replace({ widget: new Preview(block), block: true }).range(block.from, block.to));
          continue;
        }
        const first = state.doc.lineAt(block.from).number;
        const last = state.doc.lineAt(block.to).number;
        for (let n = first; n <= last; n++) {
          const line = state.doc.line(n);
          const heading = line.text.match(/^(#{1,6})\s/);
          ranges.push(Decoration.line({ class: heading ? `md-source md-heading-${heading[1].length}` : 'md-source' }).range(line.from));
        }
      }
      return Decoration.set(ranges, true);
    }

    const field = StateField.define({
      create(state) {
        const parsed = blocks(state.doc);
        return { parsed, focused: false, decorations: decorate(state, parsed, false) };
      },
      update(value, tr) {
        let focused = value.focused;
        for (const effect of tr.effects) if (effect.is(focusChanged)) focused = effect.value;
        if (!tr.docChanged && !tr.selection && focused === value.focused) return value;
        const parsed = tr.docChanged ? blocks(tr.state.doc) : value.parsed;
        return { parsed, focused, decorations: decorate(tr.state, parsed, focused) };
      },
      provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
    });
    return [field, EditorView.domEventHandlers({
      focus: (_e, view) => { view.dispatch({ effects: focusChanged.of(true) }); },
      blur: (_e, view) => { view.dispatch({ effects: focusChanged.of(false) }); },
    })];
  }

  /**
   * 控件页（feat_board.js）复用同一套渲染与过滤：输入 Markdown 文本，返回已清理的 DOM 片段，
   * 节点引用 `<图>.drawio#<id>` 已转为 .node-ref 链接；勾选框按只读显示，由调用方决定是否接管。
   */
  function render(md) {
    const out = fragment(marked.parse(md, { gfm: true }));
    out.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.disabled = true; });
    return out;
  }

  return { extension, render };
})();
