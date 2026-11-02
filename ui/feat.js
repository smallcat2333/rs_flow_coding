// Feat 档案编辑栏：CodeMirror 6 源码编辑 + marked 预览，实时保存、加锁（与流程图同口径），
// 并与流程图联动：打开 Feat 时高亮挂了该编号标签的节点，列出关联节点可点击定位；
// 从节点打开 Feat 时滚动到档案中提及该节点 id 的位置。
// 依赖：ui/vendor/vendor.js（window.Vendor）、app.js 暴露的 window.FlowLink / window.Split。
'use strict';

window.FeatPane = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const { EditorView, EditorState, Transaction, basicSetup, keymap, indentWithTab, undo, redo, markdown, marked } = window.Vendor;
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
    mode: 'split',    // edit / split / preview
  };

  /** HTML 转义。 */
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** 编辑器扩展：basicSetup 自带撤销历史（Ctrl+Z 撤销、Ctrl+Y 重做）；内容变化时触发防抖保存与预览刷新。 */
  const extensions = [
    basicSetup,
    keymap.of([indentWithTab]),
    markdown(),
    EditorView.lineWrapping,
    EditorState.readOnly.of(false),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged || st.applying) return;
      renderPreview();
      if (st.readOnly) return;
      clearTimeout(st.saveTimer);
      st.saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
      setState('编辑中…');
    }),
  ];

  /** CodeMirror 实例。 */
  const view = new EditorView({ parent: $('md-editor'), state: EditorState.create({ doc: '', extensions }) });

  /** 换档案时重建编辑器状态：撤销历史清空，不能撤销到上一个档案或空白内容。 */
  function resetDoc(text) {
    view.setState(EditorState.create({ doc: text, extensions }));
    renderPreview();
  }

  /** 顶栏保存状态。 */
  function setState(text, isError) {
    const el = $('md-state');
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  /** 用磁盘内容替换编辑器（保留光标大致位置）；外部同步不进撤销历史，Ctrl+Z 不会撤掉 Agent 的改动。 */
  function applyText(text) {
    if (text === view.state.doc.toString()) return;
    st.applying = true;
    const pos = Math.min(view.state.selection.main.head, text.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: pos },
      annotations: Transaction.addToHistory.of(false),
    });
    st.applying = false;
    renderPreview();
  }

  /** 渲染预览：marked 转 HTML；`<图名>#<节点id>` 形式的引用渲染成可点击链接。 */
  function renderPreview() {
    if (st.mode === 'edit') return;
    const html = marked.parse(view.state.doc.toString(), { gfm: true, breaks: false });
    $('md-preview').innerHTML = html.replace(/([\w一-龥-]+\.drawio)#([\w-]+)/g,
      (m, f, id) => `<a href="#" class="node-ref" data-file="${esc(f)}" data-id="${esc(id)}">${esc(m)}</a>`);
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
    view.contentDOM.setAttribute('contenteditable', 'false');
    $('md-mask').hidden = false;
    renderBar();
  }

  /** 退出只读并同步磁盘。 */
  async function leaveReadOnly() {
    st.readOnly = false;
    view.contentDOM.setAttribute('contenteditable', 'true');
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
      box.innerHTML = `<div class="empty mini">还没有节点挂 ${esc(st.id)} 标签。打开流程图选中节点，点顶栏「挂到 ${esc(st.id)}」。</div>`;
      return;
    }
    const byFile = {};
    for (const n of nodes) (byFile[n.file] = byFile[n.file] || []).push(n);
    box.innerHTML = Object.entries(byFile).map(([file, list]) => `
      <div class="nf"><div class="nf-name">${esc(file.split(/[\\/]/).pop().replace(/\.drawio$/i, ''))}</div>
      ${list.map((n) => `<div class="nn" data-file="${esc(file)}" data-id="${esc(n.id)}">
        <span class="sw s-${n.status}"></span><span class="nn-label">${esc(n.label || n.id)}</span>
        <span class="nn-tags">${n.tags.filter((t) => t !== st.id).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span></div>`).join('')}
      </div>`).join('');
  }

  /** 在档案中查找节点 id 首次出现的位置并滚动选中（源码与预览都定位）。 */
  function revealNode(nodeId) {
    const text = view.state.doc.toString();
    const re = new RegExp(`#${nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    const m = re.exec(text);
    document.querySelectorAll('.nn.active').forEach((e) => e.classList.remove('active'));
    const item = document.querySelector(`.nn[data-id="${CSS.escape(nodeId)}"]`);
    if (item) { item.classList.add('active'); item.scrollIntoView({ block: 'nearest' }); }
    if (!m) { setState(`档案中未引用该节点（#${nodeId}）`); return; }
    view.dispatch({ selection: { anchor: m.index, head: m.index + m[0].length }, scrollIntoView: true });
    const a = [...document.querySelectorAll('#md-preview .node-ref')].find((x) => x.dataset.id === nodeId);
    if (a) { a.scrollIntoView({ block: 'center' }); a.classList.add('flash'); setTimeout(() => a.classList.remove('flash'), 1500); }
  }

  /** 打开档案；opts.node 为从节点跳来时的节点 id。同一档案只做定位。 */
  async function open(path, opts = {}) {
    if (path !== st.path) {
      await flush();
      await release();
      st.path = path;
      st.id = (path.split(/[\\/]/).pop().match(/^(Feat_\d+_\d+)/) || [, path.split(/[\\/]/).pop().replace(/\.md$/i, '')])[1];
      st.readOnly = false;
      $('md-mask').hidden = true;
      view.contentDOM.setAttribute('contenteditable', 'true');
      setState('');
      await reload(true);
      Split.show('feat');
      // 首次打开时栏宽不足 760px 分屏太挤，默认只看预览；之后保持用户选择
      if (!st.modeChosen) setMode($('feat-pane').getBoundingClientRect().width < 760 ? 'preview' : 'split');
      document.querySelectorAll('.feat').forEach((e) => e.classList.toggle('active', e.dataset.feat === path));
      await checkLock();
      renderBar();
      FlowLink.highlight(st.id);
    }
    await renderNodes();
    if (opts.node) revealNode(opts.node);
  }

  /** 关闭前把待保存内容立即写盘。 */
  async function flush() {
    if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = 0; if (!st.readOnly && st.path) await save(); }
  }

  /** 关闭 Feat 栏。 */
  async function close() {
    await flush();
    await release();
    st.path = null;
    st.id = '';
    Split.hide('feat');
    FlowLink.highlight('');
    document.querySelectorAll('.feat.active').forEach((e) => e.classList.remove('active'));
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

  /** 视图模式切换。 */
  function setMode(mode) {
    st.mode = mode;
    $('md-body').dataset.mode = mode;
    document.querySelectorAll('#md-modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    renderPreview();
  }

  $('md-modes').onclick = (e) => { const b = e.target.closest('button'); if (b) { st.modeChosen = true; setMode(b.dataset.mode); } };
  $('fs-head').onclick = () => $('feat-side').classList.toggle('collapsed');
  $('btn-feat-close').onclick = close;
  $('feat-nodes').onclick = (e) => {
    const n = e.target.closest('.nn');
    if (n) FlowLink.reveal(n.dataset.file, n.dataset.id);
  };
  $('md-preview').onclick = (e) => {
    const a = e.target.closest('.node-ref');
    if (!a) return;
    e.preventDefault();
    const app = FlowLink.appOf(st.path);
    const file = app && app.files.find((f) => f.name === a.dataset.file);
    if (file) FlowLink.reveal(file.path, a.dataset.id);
    else setState(`本 APP 没有流程图 ${a.dataset.file}`, true);
  };
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
   * 编辑器外的撤销 / 重做：最后点击的是 Feat 栏（预览模式、关联节点列表等焦点不在编辑器）时，
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
  window.addEventListener('beforeunload',() => { if (st.holding) invoke('release_lock', { path: st.path }); });
  setMode('split');

  return {
    open,
    close,
    curPath: () => st.path,
    curId: () => st.id,
  };
})();
