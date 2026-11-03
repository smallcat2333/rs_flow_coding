// Feat 档案编辑栏：CodeMirror 6 就地实时预览，实时保存、加锁（与流程图同口径），
// 并与流程图联动：打开 Feat 时高亮挂了该编号标签的节点，列出关联节点可点击定位；
// 从节点打开 Feat 时滚动到档案中提及该节点 id 的位置。
// 依赖：ui/vendor/vendor.js（window.Vendor）、app.js 暴露的 window.FlowLink / window.Split。
'use strict';

window.FeatPane = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const { EditorView, EditorState, Transaction, Compartment, basicSetup, keymap, indentWithTab, undo, redo, markdown, oneDark } = window.Vendor;
  const $ = (id) => document.getElementById(id);

  /** 停止输入多久后保存（毫秒）；停止编辑多久后释放锁。 */
  const SAVE_DEBOUNCE_MS = 600;
  const IDLE_RELEASE_MS = 3000;
  const LOCK_POLL_MS = 1500;

  const st = {
    path: null,       // 当前档案路径
    id: '',           // 当前 Feat 编号
    hash: '',         // 当前内容对应的磁盘哈希
    holding: false,
    readOnly: false,
    saveTimer: 0,
    idleTimer: 0,
    saving: false,
    applying: false,  // 正在把磁盘内容写入编辑器（不触发保存）
  };

  /** HTML 转义。 */
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** 编辑器主题槽：深色用 oneDark，浅色为空；切换主题时 reconfigure，不重建状态。 */
  const themeSlot = new Compartment();
  const lockSlot = new Compartment();
  let dark = document.documentElement.dataset.theme === 'dark';

  /**
   * 编辑器扩展（函数形式：重建状态时带上当前主题）。basicSetup 自带撤销历史（Ctrl+Z 撤销、Ctrl+Y 重做）；
   * 内容变化时刷新就地排版与大纲并防抖保存；滚动时同步大纲选中项。
   */
  const extensions = () => [
    basicSetup,
    keymap.of([indentWithTab]),
    markdown(),
    LiveMarkdown.extension(revealRef),
    EditorView.contentAttributes.of({ 'aria-label': 'Feat 正文，点击内容直接编辑' }),
    EditorView.lineWrapping,
    lockSlot.of([EditorState.readOnly.of(st.readOnly), EditorView.editable.of(!st.readOnly)]),
    themeSlot.of(dark ? oneDark : []),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged || st.applying) return;
      scheduleToc();
      if (st.readOnly) return;
      clearTimeout(st.saveTimer);
      st.saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
      setState('编辑中…');
    }),
    EditorView.domEventHandlers({ scroll: () => syncTocFromEditor() }),
  ];

  /** CodeMirror 实例。 */
  const view = new EditorView({ parent: $('md-editor'), state: EditorState.create({ doc: '', extensions: extensions() }) });

  /** 换档案时重建编辑器状态：撤销历史清空，不能撤销到上一个档案或空白内容。 */
  function resetDoc(text) {
    view.setState(EditorState.create({ doc: text, extensions: extensions() }));
    renderToc();
  }

  /** 主题切换（app.js 派发 fc-theme）：只换编辑器主题，内容与撤销历史不变。 */
  window.addEventListener('fc-theme', (e) => {
    dark = e.detail.dark;
    view.dispatch({ effects: themeSlot.reconfigure(dark ? oneDark : []) });
  });

  // ---------------- 标题大纲 ----------------

  /** 当前大纲：[{level, text, line}]，line 为 1 起的源码行号；与预览中 h1–h4 按出现顺序一一对应。 */
  let toc = [];
  let tocTimer = 0;

  /** 输入时防抖重建大纲。 */
  function scheduleToc() {
    clearTimeout(tocTimer);
    tocTimer = setTimeout(renderToc, 300);
  }

  /** 从源码提取 1–4 级 ATX 标题（跳过 ``` / ~~~ 代码块），渲染为缩进列表。 */
  function renderToc() {
    const lines = view.state.doc.toString().split('\n');
    let fence = '';
    toc = [];
    lines.forEach((ln, i) => {
      const f = ln.match(/^\s*(```|~~~)/);
      if (f) { fence = fence ? (fence === f[1] ? '' : fence) : f[1]; return; }
      if (fence) return;
      const m = ln.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
      if (m) toc.push({ level: m[1].length, text: m[2].replace(/\*\*|__|`/g, ''), line: i + 1 });
    });
    $('md-toc').innerHTML = toc.length
      ? toc.map((h, i) => `<div class="toc-item l${h.level}" data-i="${i}" title="${esc(h.text)}">${esc(h.text)}</div>`).join('')
      : '<div class="empty mini">没有标题</div>';
    syncTocFromEditor();
  }

  /** 标记大纲选中项并保持可见。 */
  function markToc(i) {
    document.querySelectorAll('.toc-item.active').forEach((e) => e.classList.remove('active'));
    const el = document.querySelector(`.toc-item[data-i="${i}"]`);
    if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
  }

  /** 正文滚动时，以实际视口位置同步大纲（包含渲染块的高度）。 */
  function syncTocFromEditor() {
    if (!toc.length) return;
    const top = view.documentTop + view.scrollDOM.scrollTop;
    let cur = 0;
    toc.forEach((h, i) => {
      if (h.line > view.state.doc.lines) return;
      const pos = view.state.doc.line(h.line).from;
      const block = view.lineBlockAt(pos);
      if (view.documentTop + block.top <= top + 12) cur = i;
    });
    markToc(cur);
  }

  /** 大纲直接定位到同一份正文，移开焦点后仍显示排版效果。 */
  $('md-toc').onclick = (e) => {
    const it = e.target.closest('.toc-item');
    if (!it) return;
    const i = Number(it.dataset.i);
    const pos = view.state.doc.line(toc[i].line).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
    markToc(i);
  };

  /** 大纲显示开关，记入 localStorage（默认显示）。 */
  function applyTocVisible(show) {
    $('md-body').classList.toggle('no-toc', !show);
    $('btn-toc').classList.toggle('on', show);
  }
  $('btn-toc').onclick = () => {
    const show = $('md-body').classList.contains('no-toc');
    localStorage.setItem('fc-toc', show ? '1' : '0');
    applyTocVisible(show);
  };
  applyTocVisible(localStorage.getItem('fc-toc') !== '0');

  /** 顶栏保存状态。 */
  function setState(text, isError) {
    const el = $('md-state');
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  /** 同步当前档案：只替换变化片段，让滚动快照和光标随文字映射；外部改动不进撤销历史。 */
  function applyText(text) {
    const previous = view.state.doc.toString();
    if (text === previous) return;
    let from = 0, to = previous.length, end = text.length;
    while (from < to && from < end && previous[from] === text[from]) from++;
    while (to > from && end > from && previous[to - 1] === text[end - 1]) { to--; end--; }
    const changes = view.state.changes({ from, to, insert: text.slice(from, end) });
    const keep = Settings.keepFeatPosition();
    const scroll = keep ? view.scrollSnapshot().map(changes) : EditorView.scrollIntoView(0, { y: 'start', x: 'start', yMargin: 0, xMargin: 0 });
    st.applying = true;
    const pos = keep ? changes.mapPos(view.state.selection.main.head) : 0;
    view.dispatch({
      changes,
      selection: { anchor: pos },
      effects: scroll,
      annotations: Transaction.addToHistory.of(false),
    });
    st.applying = false;
    renderToc();
  }

  /** 保存：加用户锁 + 原子写盘；Agent 持锁时转只读并丢弃本次改动（随后同步磁盘）。 */
  async function save() {
    if (!st.path || st.readOnly) return;
    if (st.saving) { clearTimeout(st.saveTimer); st.saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS); return; }
    st.saving = true;
    st.saveTimer = 0;
    try {
      st.hash = await invoke('save_md', { path: st.path, text: view.state.doc.toString() });
      st.holding = true;
      setState('已保存 ' + new Date().toLocaleTimeString());
      clearTimeout(st.idleTimer);
      st.idleTimer = setTimeout(release, IDLE_RELEASE_MS);
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith('LOCKED:')) {
        setState('Agent 正在编辑，本次改动未保存，已切只读', true);
        await enterReadOnly();
      } else setState('保存失败：' + msg, true);
    } finally {
      st.saving = false;
      renderBar();
    }
  }

  /** 释放用户锁；保存进行中或还有待保存内容时顺延。 */
  async function release() {
    clearTimeout(st.idleTimer);
    if (!st.holding || !st.path) return;
    if (st.saving || st.saveTimer) { st.idleTimer = setTimeout(release, IDLE_RELEASE_MS); return; }
    try { await invoke('release_lock', { path: st.path }); } catch (e) { setState('释放锁失败：' + e, true); }
    st.holding = false;
    renderBar();
    FlowLink.refresh();
  }

  /** 只读：Agent 持锁时禁止编辑。 */
  async function enterReadOnly() {
    st.readOnly = true;
    view.dispatch({ effects: lockSlot.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]) });
    $('md-mask').hidden = false;
    renderBar();
  }

  /** 退出只读并同步磁盘。 */
  async function leaveReadOnly() {
    st.readOnly = false;
    view.dispatch({ effects: lockSlot.reconfigure([EditorState.readOnly.of(false), EditorView.editable.of(true)]) });
    $('md-mask').hidden = true;
    await reload();
    renderBar();
  }

  /** 从磁盘重新载入当前档案；fresh=true 时（打开新档案）同时清空撤销历史。 */
  async function reload(fresh) {
    const d = await invoke('read_md', { path: st.path });
    st.hash = d.hash;
    if (fresh) resetDoc(d.text);
    else applyText(d.text);
  }

  /** 顶栏：编号、标题、锁、关联节点列表。 */
  function renderBar() {
    const app = st.path ? FlowLink.appOf(st.path) : null;
    const f = app ? app.feats.find((x) => x.path === st.path) : null;
    $('feat-id').textContent = st.id;
    $('feat-title').textContent = f ? f.title : '';
    $('feat-status').textContent = f ? f.status : '';
    const b = $('md-lock');
    if (st.readOnly) { b.className = 'agent'; b.textContent = 'Agent 持锁'; }
    else if (st.holding) { b.className = 'user'; b.textContent = '你持锁'; }
    else { b.className = ''; b.textContent = ''; }
  }

  /** 关联节点列表：调用 tagged_nodes，按图分组，点击定位到流程图节点。 */
  async function renderNodes() {
    const box = $('feat-nodes');
    const app = FlowLink.appOf(st.path);
    if (!app) { box.innerHTML = ''; return; }
    const nodes = await invoke('tagged_nodes', { flowDir: app.flow_dir, tag: st.id });
    $('feat-node-count').textContent = nodes.length;
    if (!nodes.length) {
      box.innerHTML = `<div class="empty mini">还没有节点挂 ${esc(st.id)} 标签。打开流程图选中节点，点底部状态栏「挂到 ${esc(st.id)}」。</div>`;
      return;
    }
    const byFile = {};
    for (const n of nodes) (byFile[n.file] = byFile[n.file] || []).push(n);
    box.innerHTML = Object.entries(byFile).map(([file, list]) => `
      <div class="nf"><div class="nf-name">${esc(file.split(/[\\/]/).pop().replace(/\.drawio$/i, ''))}</div>
      ${list.map((n) => `<div class="nn" data-file="${esc(file)}" data-id="${esc(n.id)}">
        <span class="sw s-${n.status}"></span><div class="nn-content"><span class="nn-id">${esc(n.id)}</span><span class="nn-label">${esc(n.label || n.id)}</span>
        <span class="nn-tags">${n.tags.filter((t) => t !== st.id).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span></div></div>`).join('')}
      </div>`).join('');
  }

  /** 在档案中查找节点 id 首次出现的位置并滚动选中（同一份正文内定位）。 */
  function revealNode(nodeId) {
    const text = view.state.doc.toString();
    const re = new RegExp(`#${nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    const m = re.exec(text);
    document.querySelectorAll('.nn.active').forEach((e) => e.classList.remove('active'));
    const item = document.querySelector(`.nn[data-id="${CSS.escape(nodeId)}"]`);
    if (item) { item.classList.add('active'); item.scrollIntoView({ block: 'nearest' }); }
    if (!m) { setState(`档案中未引用该节点（#${nodeId}）`); return; }
    view.dispatch({ selection: { anchor: m.index, head: m.index + m[0].length }, scrollIntoView: true });
  }

  /** 定位到源文件第 line 行（1 起，推进矩阵点阶段 / T 时传入），行首置于视口顶部。 */
  function revealLine(line) {
    const pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 8 }) });
    syncTocFromEditor();
  }

  /** 打开档案；opts.node 为从节点跳来时的节点 id，opts.line 为要定位的源文件行号。同一档案只做定位。 */
  async function open(path, opts = {}) {
    Split.show('feat');
    if (path !== st.path) {
      await flush();
      await release();
      st.path = path;
      st.id = (path.split(/[\\/]/).pop().match(/^(Feat_\d+_\d+)/) || [, path.split(/[\\/]/).pop().replace(/\.md$/i, '')])[1];
      st.readOnly = false;
      $('md-mask').hidden = true;
      view.dispatch({ effects: lockSlot.reconfigure([EditorState.readOnly.of(false), EditorView.editable.of(true)]) });
      setState('');
      await reload(true);
      document.querySelectorAll('.feat').forEach((e) => e.classList.toggle('active', e.dataset.feat === path));
      await checkLock();
      renderBar();
      FlowLink.setFeat(st.id, st.path);
    }
    await renderNodes();
    if (opts.node) revealNode(opts.node);
    else if (opts.line) revealLine(opts.line);
  }

  /** 关闭前把待保存内容立即写盘。 */
  async function flush() {
    if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = 0; if (!st.readOnly && st.path) await save(); }
  }

  /** 重命名前等待保存完成并释放锁；写盘失败或编辑仍未落盘时拒绝继续。 */
  async function settle() {
    while (st.saving) await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    while (st.saving) await new Promise((resolve) => setTimeout(resolve, 20));
    if (st.path) {
      const disk = await invoke('read_md', { path: st.path });
      // CodeMirror 内部统一 LF；Windows 磁盘的 CRLF 不代表未保存改动。
      if (disk.text.replace(/\r\n?/g, '\n') !== view.state.doc.toString()) throw new Error('档案尚未保存，请先处理保存错误再重命名');
      await release();
    }
  }

  /** 关闭 Feat 栏。 */
  async function close() {
    await flush();
    await release();
    st.path = null;
    st.id = '';
    Split.hide('feat');
    // 矩阵仍在查看该 Feat 时，关闭正文只收起文档，保留矩阵选中项和流程图高亮。
    if (!Split.isOpen('mx')) {
      FlowLink.setFeat('', '');
      document.querySelectorAll('.feat.active').forEach((e) => e.classList.remove('active'));
    }
  }

  /** 锁巡检：Agent 加锁转只读，释放后恢复。 */
  async function checkLock() {
    if (!st.path || st.holding) return;
    const l = await invoke('lock_status', { path: st.path });
    if (l && l.owner === 'agent') { if (!st.readOnly) await enterReadOnly(); }
    else if (st.readOnly) await leaveReadOnly();
  }
  setInterval(() => checkLock().catch(() => {}), LOCK_POLL_MS);

  /** 外部修改档案（Agent 或其他编辑器）：未持锁时同步磁盘。 */
  listen('md-changed', async (ev) => {
    const { path, hash } = ev.payload;
    FlowLink.refresh();
    if (path !== st.path || hash === st.hash || st.holding) return;
    await reload();
    setState('已同步外部改动 ' + new Date().toLocaleTimeString());
  });

  /** 流程图变化可能改变节点标签与颜色：刷新关联节点列表。 */
  listen('flow-changed', () => { if (st.path) setTimeout(renderNodes, 500); });

  const nodesBody = $('feat-body');
  const nodesToggle = $('btn-feat-nodes');
  const nodesResize = $('feat-nodes-resize');
  let nodesExpanded = localStorage.getItem('fc-feat-nodes-open') !== 'false';
  let narrowNodesOpen = false;
  let nodesNarrow = false;
  let nodesWidth = Number(localStorage.getItem('fc-feat-nodes-width')) || 280;

  function updateNodesSide() {
    const open = nodesNarrow ? narrowNodesOpen : nodesExpanded;
    nodesBody.classList.toggle('nodes-open', open);
    nodesBody.classList.toggle('nodes-narrow', nodesNarrow);
    nodesToggle.classList.toggle('on', open);
    nodesToggle.setAttribute('aria-expanded', String(open));
    $('feat-side').inert = !open;
  }

  function setNodesWidth(width) {
    nodesWidth = Math.round(Math.max(220, Math.min(480, width)));
    nodesBody.style.setProperty('--feat-nodes-width', nodesWidth + 'px');
    nodesResize.setAttribute('aria-valuenow', String(nodesWidth));
  }
  setNodesWidth(nodesWidth);
  new ResizeObserver(([entry]) => {
    if (!entry.contentRect.width) return;
    const narrow = entry.contentRect.width < 760;
    if (narrow !== nodesNarrow) narrowNodesOpen = false;
    nodesNarrow = narrow;
    updateNodesSide();
  }).observe(nodesBody);
  updateNodesSide();

  nodesToggle.onclick = () => {
    if (nodesNarrow) narrowNodesOpen = !narrowNodesOpen;
    else {
      nodesExpanded = !nodesExpanded;
      localStorage.setItem('fc-feat-nodes-open', String(nodesExpanded));
    }
    updateNodesSide();
  };
  $('fs-head').onclick = () => { nodesToggle.click(); nodesToggle.focus(); };
  nodesResize.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startWidth = nodesWidth;
    nodesResize.setPointerCapture(e.pointerId);
    nodesResize.onpointermove = (ev) => setNodesWidth(startWidth + startX - ev.clientX);
    nodesResize.onpointerup = nodesResize.onpointercancel = () => {
      nodesResize.onpointermove = null;
      localStorage.setItem('fc-feat-nodes-width', String(nodesWidth));
    };
  };
  nodesResize.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    setNodesWidth(e.key === 'Home' ? 220 : e.key === 'End' ? 480 : nodesWidth + (e.key === 'ArrowLeft' ? 10 : -10));
    localStorage.setItem('fc-feat-nodes-width', String(nodesWidth));
  };
  nodesResize.ondblclick = () => {
    setNodesWidth(280);
    localStorage.setItem('fc-feat-nodes-width', '280');
  };
  $('btn-feat-close').onclick = close;
  $('feat-nodes').onclick = (e) => {
    const n = e.target.closest('.nn');
    if (n) FlowLink.reveal(n.dataset.file, n.dataset.id);
  };
  /** 就地预览中的节点引用保留流程图跳转。 */
  function revealRef(name, id) {
    const app = FlowLink.appOf(st.path);
    const file = app && app.files.find((f) => f.name === name);
    if (file) FlowLink.reveal(file.path, id);
    else setState(`本 APP 没有流程图 ${name}`, true);
  }
  $('btn-ref').onclick = () => {
    // 把当前选中节点插入为引用 `<图名>#<id>`
    const cell = window.FlowSel && window.FlowSel()[0];
    const file = FlowLink.curFile();
    if (!cell || !file) { setState('先在流程图中选中一个节点', true); return; }
    const ref = `${file.split(/[\\/]/).pop()}#${cell.id}`;
    view.dispatch(view.state.replaceSelection(ref));
    view.focus();
  };
  /**
   * 编辑器外的撤销 / 重做：最后点击的是 Feat 栏（大纲、关联节点列表等焦点不在编辑器）时，
   * Ctrl+Z 撤销、Ctrl+Y 重做仍作用于档案；焦点在编辑器内由 CodeMirror 自己处理。
   * Agent 持锁只读时不响应；点过流程图或侧栏后不拦截，避免误改档案。
   */
  let paneActive = false;
  document.addEventListener('pointerdown', (e) => { paneActive = !!e.target.closest('#feat-pane'); }, true);
  document.addEventListener('keydown', (e) => {
    if (!paneActive || !st.path || st.readOnly || !e.ctrlKey || e.altKey) return;
    if (view.hasFocus || e.target.closest('input, textarea, [contenteditable="true"]')) return;
    const k = e.key.toLowerCase();
    const cmd = e.shiftKey ? null : k === 'z' ? undo : k === 'y' ? redo : null;
    if (!cmd) return;
    e.preventDefault();
    if (!cmd(view)) setState(cmd === undo ? '没有可撤销的改动' : '没有可重做的改动');
  });
  window.addEventListener('beforeunload', () => { if (st.holding) invoke('release_lock', { path: st.path }); });

  return {
    open,
    close,
    curPath: () => st.path,
    curId: () => st.id,
    flush,
    settle,
  };
})();
