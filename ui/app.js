// Flow Coding 前端：APP 树 + 状态统计 + draw.io 嵌入编辑（实时保存、加锁）+ 历史对比。
// 与 Rust 通信：window.__TAURI__.core.invoke；文件变化：flow-changed 事件。
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/** 状态元数据：顺序即展示顺序。who 表示「轮到谁处理」：user=待你审，agent=待 Agent。 */
const STATUS = [
  { key: 'none', name: '已实现', who: '' },
  { key: 'review', name: '起草待审', who: 'user' },
  { key: 'plan_delete', name: '计划删除', who: 'user' },
  { key: 'issue', name: '有问题', who: 'agent' },
  { key: 'idea', name: '你的想法', who: 'agent' },
  { key: 'confirmed', name: '已确认', who: 'agent' },
  { key: 'confirm_delete', name: '确认删除', who: 'agent' },
  { key: 'unknown', name: '未识别颜色', who: '' },
];
/** 编辑器调色板只给协作色（draw.io 颜色值不带 #）。 */
const PALETTE = ['FFF2CC', 'F5F5F5', 'F8CECC', 'DAE8FC', 'D5E8D4', 'FFFFFF'];
/** 停止编辑多久后释放用户锁（毫秒）。 */
const IDLE_RELEASE_MS = 3000;
/** 只读期间轮询锁状态的间隔（毫秒）。 */
const LOCK_POLL_MS = 1500;
/** 从磁盘推送内容后忽略编辑器回显 autosave 的时长（毫秒）。 */
const SUPPRESS_MS = 1200;

const $ = (id) => document.getElementById(id);
const editor = $('editor');

/** 运行状态。 */
const st = {
  apps: [],
  cur: null,          // 当前图路径
  curHash: '',        // 编辑器当前内容对应的磁盘哈希（用于忽略自己写入引起的变更通知）
  ready: false,       // 编辑器已 init
  holding: false,     // 本 App 持有用户锁
  idleTimer: 0,
  saving: false,
  pendingXml: null,   // 保存进行中时到来的最新内容
  readOnly: false,
  suppressUntil: 0,   // 此时刻前的 autosave 视为回显
  histSel: [],        // 历史面板勾选的快照 id
  histRows: [],
};

// ---------------- 通用 ----------------

/** HTML 转义。 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** 渲染非零状态徽标串；counts 为 {状态: 数量}。 */
function badges(counts) {
  return '<span class="badges">' + STATUS.filter((s) => counts[s.key] > 0 && s.key !== 'none')
    .map((s) => `<span class="badge s-${s.key}" title="${s.name}">${counts[s.key]}</span>`).join('') + '</span>';
}

/** 待你审 / 待 Agent 数量。 */
function whoCounts(counts) {
  let user = 0, agent = 0;
  for (const s of STATUS) {
    if (s.who === 'user') user += counts[s.key] || 0;
    if (s.who === 'agent') agent += counts[s.key] || 0;
  }
  return { user, agent };
}

/** 侧栏底部错误提示；空串清除。 */
function sideMsg(msg) { $('side-msg').textContent = msg || ''; }

/** 顶栏保存状态提示。 */
function saveState(text, isError) {
  const el = $('save-state');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

/** 简易输入对话框，返回 Promise<string|null>。 */
function ask(title, value = '') {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.id = 'roots-dlg';
    wrap.innerHTML = `<div class="dlg"><b>${esc(title)}</b><input value="${esc(value)}" style="padding:5px">
      <div class="dlg-btns"><button data-r="0">取消</button><button data-r="1">确定</button></div></div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('input');
    input.focus();
    const done = (ok) => { wrap.remove(); resolve(ok ? input.value.trim() : null); };
    wrap.querySelectorAll('button').forEach((b) => b.onclick = () => done(b.dataset.r === '1'));
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  });
}

// ---------------- 汇总树 ----------------

/** 拉取汇总并重绘；full=true 时重新遍历项目根。 */
async function refresh(full = false) {
  sideMsg(full ? '扫描中…' : '');
  try {
    st.apps = await invoke('summary', { full });
    sideMsg(st.apps.length ? '' : '未发现 docs/flow 目录。点「项目根」配置后「全量扫描」。');
  } catch (e) {
    sideMsg(String(e));
  }
  renderTree();
  renderCurrentBar();
}

/** 重绘侧栏 APP 树与顶部合计。 */
function renderTree() {
  const total = {};
  const collapsed = new Set([...document.querySelectorAll('.app.collapsed')].map((e) => e.dataset.dir));
  let html = '', lastGroup = null;
  for (const a of st.apps) {
    for (const [k, v] of Object.entries(a.counts)) total[k] = (total[k] || 0) + v;
    if (a.group !== lastGroup) {
      html += `<div class="group">${esc(a.group || '未分组')}</div>`;
      lastGroup = a.group;
    }
    const files = a.files.map((f) => `
      <div class="file ${f.path === st.cur ? 'active' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)}">
        <span class="file-name">${esc(f.name.replace(/\.drawio$/i, ''))}</span>
        ${f.lock ? `<span class="lock-dot">${f.lock.owner === 'agent' ? 'Agent 编辑中' : '编辑中'}</span>` : ''}
        ${f.error ? `<span class="err" title="${esc(f.error)}">解析失败</span>` : badges(f.counts)}
      </div>`).join('');
    html += `<div class="app ${collapsed.has(a.flow_dir) ? 'collapsed' : ''}" data-dir="${esc(a.flow_dir)}">
      <div class="app-head"><span class="app-name">${esc(a.app)}</span>${badges(a.counts)}
        <button class="app-new" data-dir="${esc(a.flow_dir)}" title="新建流程图">＋</button></div>
      <div class="files">${files || '<div class="empty" style="padding:6px">暂无流程图</div>'}</div></div>`;
  }
  $('tree').innerHTML = html;
  const w = whoCounts(total);
  $('t-user').textContent = w.user;
  $('t-agent').textContent = w.agent;
}

/** 当前图在汇总中的条目。 */
function curEntry() {
  for (const a of st.apps) for (const f of a.files) if (f.path === st.cur) return { app: a, file: f };
  return null;
}

/** 锁状态变化后同步左侧树中该图的锁标签（锁释放不触发文件变化通知，需主动刷新）。 */
async function syncTreeLock(path) {
  if (!path) return;
  const lock = await invoke('lock_status', { path });
  for (const a of st.apps) for (const f of a.files) if (f.path === path) f.lock = lock;
  renderTree();
}

/** 顶栏：当前 APP、图名、状态分布、锁。 */
function renderCurrentBar() {
  const e = curEntry();
  $('cur-app').textContent = e ? `${e.app.group ? e.app.group + ' / ' : ''}${e.app.app}` : '';
  $('cur-name').textContent = e ? e.file.name.replace(/\.drawio$/i, '') : (st.cur ? st.cur : '未打开流程图');
  $('cur-counts').innerHTML = e ? badges(e.file.counts) : '';
  $('btn-history').disabled = !st.cur;
  const badge = $('lock-badge');
  if (st.readOnly) { badge.className = 'agent'; badge.textContent = 'Agent 持锁'; }
  else if (st.holding) { badge.className = 'user'; badge.textContent = '你持锁'; }
  else { badge.className = ''; badge.textContent = ''; }
}

$('tree').addEventListener('click', async (ev) => {
  const nb = ev.target.closest('.app-new');
  if (nb) {
    ev.stopPropagation();
    const name = await ask('新流程图名称（不含扩展名）');
    if (!name) return;
    try {
      const p = await invoke('create_diagram', { dir: nb.dataset.dir, name });
      await refresh();
      openDiagram(p);
    } catch (e) { sideMsg(String(e)); }
    return;
  }
  const file = ev.target.closest('.file');
  if (file) return openDiagram(file.dataset.path);
  const head = ev.target.closest('.app-head');
  if (head) head.parentElement.classList.toggle('collapsed');
});

// ---------------- 编辑器（draw.io embed 协议） ----------------

/** 向编辑器发送协议消息。 */
function post(msg) { editor.contentWindow.postMessage(JSON.stringify(msg), '*'); }

/** 加载编辑器页面（只在首次打开图时加载一次）。 */
function ensureEditor() {
  if (editor.src) return;
  const q = new URLSearchParams({
    embed: '1', proto: 'json', configure: '1', spin: '1', ui: 'kennedy', lang: 'zh',
    noExitBtn: '1', noSaveBtn: '1', saveAndExit: '0', stealth: '1', pwa: '0', splash: '0',
    libraries: '1', grid: '1',
  });
  editor.src = `drawio/index.html?${q}`;
}

/** 把磁盘内容推给编辑器：首次用 load（开启实时保存 + diffSync），之后用 merge 保留视图。
 *  推送引起的那次 autosave 是编辑器回显，不是用户改动，在 SUPPRESS_MS 内忽略，避免把外部改动写回并抢锁。 */
async function pushFromDisk(first) {
  const d = await invoke('read_diagram', { path: st.cur });
  st.curHash = d.hash;
  st.suppressUntil = Date.now() + SUPPRESS_MS;
  if (first) post({ action: 'load', xml: d.xml, autosave: 1, diffSync: true, title: d.path });
  else post({ action: 'merge', xml: d.xml });
}

/** 打开一张图：先释放上一张的锁，再加载。 */
async function openDiagram(path) {
  if (path === st.cur) return;
  await releaseNow();
  st.cur = path;
  st.pendingXml = null;
  $('empty').hidden = true;
  saveState('');
  document.querySelectorAll('.file').forEach((f) => f.classList.toggle('active', f.dataset.path === path));
  renderCurrentBar();
  ensureEditor();
  if (st.ready) await pushFromDisk(true);
  await checkLock();
  if (!$('history').hidden) loadHistory();
}

/** 编辑器内容变化（实时保存）：串行写盘，保存中到来的内容只保留最新一份。 */
async function onAutosave(xml) {
  if (!st.cur || st.readOnly) return;
  if (Date.now() < st.suppressUntil) return;
  if (st.saving) { st.pendingXml = xml; return; }
  st.saving = true;
  saveState('保存中…');
  try {
    st.curHash = await invoke('save_diagram', { path: st.cur, xml });
    st.holding = true;
    saveState('已保存 ' + new Date().toLocaleTimeString());
    clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(releaseNow, IDLE_RELEASE_MS);
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith('LOCKED:')) {
      saveState('Agent 正在编辑，本次改动未保存，已切只读', true);
      st.pendingXml = null;
      await enterReadOnly();
    } else {
      saveState('保存失败：' + msg, true);
    }
  } finally {
    st.saving = false;
    renderCurrentBar();
  }
  if (st.pendingXml != null) {
    const next = st.pendingXml;
    st.pendingXml = null;
    onAutosave(next);
  }
}

/** 释放用户锁（空闲或切图时）。 */
async function releaseNow() {
  clearTimeout(st.idleTimer);
  if (!st.holding || !st.cur) return;
  if (st.saving || st.pendingXml != null) { st.idleTimer = setTimeout(releaseNow, IDLE_RELEASE_MS); return; }
  try { await invoke('release_lock', { path: st.cur }); } catch (e) { saveState('释放锁失败：' + e, true); }
  st.holding = false;
  renderCurrentBar();
  await syncTreeLock(st.cur);
}

/** 查询当前图锁；被 Agent 持有则进入只读。 */
async function checkLock() {
  if (!st.cur) return;
  const l = await invoke('lock_status', { path: st.cur });
  const e = curEntry();
  if (e && (e.file.lock?.owner || '') !== (l?.owner || '')) {
    e.file.lock = l;
    renderTree();
  }
  if (l && l.owner === 'agent') {
    if (!st.readOnly) await enterReadOnly(l);
  } else if (st.readOnly) await leaveReadOnly();
}

/** 进入只读：遮罩挡住编辑器交互（轮询由常驻锁巡检负责）。 */
async function enterReadOnly(l) {
  l = l || await invoke('lock_status', { path: st.cur });
  st.readOnly = true;
  $('readonly-mask').hidden = false;
  $('mask-detail').textContent = l ? `pid ${l.pid}，开始于 ${new Date(l.since * 1000).toLocaleTimeString()}` : '';
  renderCurrentBar();
}

/** 退出只读：重新载入磁盘最新内容。 */
async function leaveReadOnly() {
  st.readOnly = false;
  $('readonly-mask').hidden = true;
  renderCurrentBar();
  if (st.ready && st.cur) await pushFromDisk(false);
}

/** 常驻锁巡检：未持锁时定时查当前图锁，Agent 加锁后立即转只读，释放后恢复。 */
setInterval(() => { if (st.cur && !st.holding) checkLock().catch(() => {}); }, LOCK_POLL_MS);

window.addEventListener('message', (ev) => {
  if (ev.source !== editor.contentWindow || typeof ev.data !== 'string') return;
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  switch (m.event) {
    case 'configure':
      post({
        action: 'configure',
        config: {
          compressXml: false,
          presetColors: PALETTE,
          defaultColors: PALETTE,
          defaultColorSchemes: [[
            { fill: '#FFF2CC', stroke: '#D6B656' }, { fill: '#F5F5F5', stroke: '#666666' },
            { fill: '#F8CECC', stroke: '#B85450' }, { fill: '#DAE8FC', stroke: '#6C8EBF' },
            { fill: '#D5E8D4', stroke: '#82B366' }, { fill: '#FFFFFF', stroke: '#000000' },
          ]],
        },
      });
      break;
    case 'init':
      st.ready = true;
      if (st.cur) pushFromDisk(true);
      break;
    case 'autosave':
    case 'save':
      if (m.xml != null) onAutosave(m.xml);
      break;
    case 'merge':
      if (m.error) pushFromDisk(true);  // 合并失败退回整页重载
      break;
  }
});

// ---------------- 文件变化 ----------------

let refreshTimer = 0;
listen('flow-changed', async (ev) => {
  const { path, hash } = ev.payload;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(false), 400);
  if (path !== st.cur || !hash || hash === st.curHash) return;
  if (st.holding) return;  // 自己持锁期间的外部写入不合并（理论上不会发生）
  await checkLock();
  if (!st.readOnly && st.ready) {
    await pushFromDisk(false);
    saveState('已同步外部改动 ' + new Date().toLocaleTimeString());
  }
  if (!$('history').hidden) loadHistory();
});

// ---------------- 历史 ----------------

/** 拉取当前图历史快照并渲染表格。 */
async function loadHistory() {
  if (!st.cur) return;
  st.histRows = await invoke('history', { path: st.cur });
  st.histSel = st.histSel.filter((id) => st.histRows.some((r) => r.id === id));
  const tb = $('hist-table').querySelector('tbody');
  tb.innerHTML = st.histRows.map((r) => `
    <tr data-id="${r.id}" class="${st.histSel.includes(r.id) ? 'sel' : ''}">
      <td><input type="checkbox" ${st.histSel.includes(r.id) ? 'checked' : ''}></td>
      <td>${esc(r.ts)}</td><td><span class="src ${esc(r.source)}">${esc(r.source)}</span></td>
      <td>${badges(r.counts)}</td></tr>`).join('');
  updateHistButtons();
  renderDiff();
}

/** 勾选状态决定按钮可用。 */
function updateHistButtons() {
  $('btn-hist-view').disabled = st.histSel.length !== 1;
  $('btn-hist-restore').disabled = st.histSel.length !== 1;
}

/** 选中两个快照时渲染差异表。 */
async function renderDiff() {
  const box = $('diff');
  if (st.histSel.length !== 2) {
    box.innerHTML = '<div class="empty">选择两个快照查看差异</div>';
    return;
  }
  const [oldId, newId] = [...st.histSel].sort((a, b) => a - b);
  const changes = await invoke('diff', { old: oldId, new: newId });
  const name = (k) => (STATUS.find((s) => s.key === k) || { name: '' }).name;
  const sw = (k) => k ? `<span class="sw s-${k}"></span> ${name(k)}` : '';
  const kindName = { added: '新增', removed: '删除', changed: '变化' };
  const sum = ['added', 'removed', 'changed'].map((k) => `${kindName[k]} ${changes.filter((c) => c.kind === k).length}`).join('，');
  box.innerHTML = `<div class="diff-sum">#${oldId} → #${newId}：${sum}</div>` + (changes.length ? `
    <table><thead><tr><th>类型</th><th>节点</th><th>状态</th><th>文字</th></tr></thead><tbody>
    ${changes.map((c) => `<tr><td class="k-${c.kind}">${kindName[c.kind]}</td>
      <td title="${esc(c.page_name)}">${esc(c.node_id)}</td>
      <td>${c.old_status === c.new_status ? sw(c.new_status) : `${sw(c.old_status)}<span class="arrow">→</span>${sw(c.new_status)}`}</td>
      <td>${c.old_label === c.new_label ? esc(c.new_label) : `<s>${esc(c.old_label)}</s><span class="arrow">→</span>${esc(c.new_label)}`}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">两个版本节点无差异（可能只是位置或样式变化）</div>');
}

$('hist-table').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-id]');
  if (!tr) return;
  const id = Number(tr.dataset.id);
  if (st.histSel.includes(id)) st.histSel = st.histSel.filter((x) => x !== id);
  else st.histSel = [...st.histSel, id].slice(-2);
  loadHistory();
});

$('btn-history').onclick = () => {
  const h = $('history');
  h.hidden = !h.hidden;
  if (!h.hidden) loadHistory();
};
$('btn-hist-close').onclick = () => { $('history').hidden = true; };

/** 只读打开旧版快照（draw.io 查看器模式）。 */
$('btn-hist-view').onclick = async () => {
  const id = st.histSel[0];
  const xml = await invoke('snapshot_xml', { id });
  const row = st.histRows.find((r) => r.id === id);
  $('viewer-title').textContent = `旧版 #${id}（${row ? row.ts : ''}，只读）`;
  const frame = $('viewer-frame');
  const onMsg = (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const m = JSON.parse(ev.data);
    if (m.event === 'init') {
      frame.contentWindow.postMessage(JSON.stringify({ action: 'load', xml }), '*');
      window.removeEventListener('message', onMsg);
    }
  };
  window.addEventListener('message', onMsg);
  frame.src = 'drawio/index.html?' + new URLSearchParams({ embed: '1', proto: 'json', chrome: '0', lang: 'zh', stealth: '1', pwa: '0', splash: '0', nav: '1' });
  $('viewer').hidden = false;
};
$('btn-viewer-close').onclick = () => { $('viewer').hidden = true; $('viewer-frame').src = 'about:blank'; };

/** 回滚：确认后用旧快照覆盖当前图（作为一次新快照记录，可再回滚）。 */
$('btn-hist-restore').onclick = async () => {
  const id = st.histSel[0];
  if (!confirm(`用快照 #${id} 覆盖当前流程图？\n覆盖本身会记成新快照，可以再回滚回来。`)) return;
  try {
    await releaseNow();
    await invoke('restore', { path: st.cur, id });
    await pushFromDisk(false);
    saveState('已回滚到 #' + id);
    loadHistory();
    refresh(false);
  } catch (e) { saveState('回滚失败：' + e, true); }
};

// ---------------- 项目根 ----------------

$('btn-refresh').onclick = () => refresh(false);
$('btn-rescan').onclick = () => refresh(true);
$('btn-roots').onclick = async () => {
  const cfg = await invoke('get_config');
  $('roots-text').value = cfg.roots.join('\n');
  $('roots-dlg').hidden = false;
};
$('roots-cancel').onclick = () => { $('roots-dlg').hidden = true; };
$('roots-ok').onclick = async () => {
  const roots = $('roots-text').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  try {
    await invoke('set_roots', { roots });
    $('roots-dlg').hidden = true;
    await refresh(true);
  } catch (e) { sideMsg(String(e)); }
};

// ---------------- 启动 ----------------

$('legend').innerHTML = STATUS.map((s) => `<span><span class="sw s-${s.key}"></span>${s.name}</span>`).join('');
window.addEventListener('beforeunload', () => { if (st.holding) invoke('release_lock', { path: st.cur }); });
refresh(false);
