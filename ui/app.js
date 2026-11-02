// Flow Coding 前端：APP 树（流程图 + Feat）+ 状态统计 + draw.io 嵌入编辑（实时保存、加锁）+ 历史对比
// + 节点与 Feat 联动（Feat 档案编辑见 feat.js，通过 window.FeatPane / window.FlowLink 互调）。
// 与 Rust 通信：window.__TAURI__.core.invoke；文件变化：flow-changed / md-changed 事件。
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;

/** 窗口角色：'' 主窗口；'flow' / 'feat' 为弹出的独立窗口（只显示该栏）。 */
const PARAMS = new URLSearchParams(location.search);
const SOLO = PARAMS.get('solo') || '';
/** 主窗口：某栏已弹到独立窗口时为 true，该类文件改由弹出窗口打开。 */
const popped = { flow: false, feat: false };
/** 主窗口退出时，等待已弹出的窗口保存并关闭。 */
const closingPopouts = {};
/** 当前打开的 Feat（可能在另一个窗口里），由 ui-cur-feat 事件在窗口间同步。 */
let curFeat = { id: '', path: '' };
/** 最近一次选中的节点（可能来自另一个窗口的流程图），供「插入节点引用」使用。 */
let lastSel = { file: null, cells: [] };
/** 本窗口是否负责流程图栏 / Feat 栏。 */
const ownsFlow = () => SOLO === 'flow' || (!SOLO && !popped.flow);
const ownsFeat = () => SOLO === 'feat' || (!SOLO && !popped.feat);

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
  loaded: false,      // 当前图已在编辑器中载入完成
  pendingSelect: '',  // 图载入完成后要选中的节点 id
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

/** 重绘侧栏 APP 树与顶部合计。每个 APP 下分「流程图」「Feat」两组。 */
function renderTree() {
  const total = {};
  const collapsed = new Set([...document.querySelectorAll('.collapsed[data-key]')].map((e) => e.dataset.key));
  let html = '', lastGroup = null;
  for (const a of st.apps) {
    for (const [k, v] of Object.entries(a.counts)) total[k] = (total[k] || 0) + v;
    if (a.group !== lastGroup) {
      html += `<div class="group">${esc(a.group || '未分组')}</div>`;
      lastGroup = a.group;
    }
    const lockTag = (l) => l ? `<span class="lock-dot">${l.owner === 'agent' ? 'Agent 编辑中' : '编辑中'}</span>` : '';
    const files = a.files.map((f) => `
      <div class="file ${f.path === st.cur ? 'active' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)}">
        <span class="file-name">${esc(f.name.replace(/\.drawio$/i, ''))}</span>
        ${lockTag(f.lock)}
        ${f.error ? `<span class="err" title="${esc(f.error)}">解析失败</span>` : badges(f.counts)}
      </div>`).join('');
    const feats = a.feats.map((f) => `
      <div class="feat ${f.path === curFeat.path ? 'active' : ''}" data-feat="${esc(f.path)}" data-id="${esc(f.id)}" title="${esc(f.path)}">
        <div class="feat-line">
          <span class="file-name">${esc(f.title || f.id)}</span>
          ${lockTag(f.lock)}
          ${f.closable ? '<span class="closable" title="挂的节点全部已实现">可关闭</span>' : badges(f.counts)}
        </div>
        <div class="feat-meta"><span>${esc(f.id)}</span><span>${esc(f.status)}</span>
          ${f.tasks_total ? `<span>T ${f.tasks_done}/${f.tasks_total}</span>` : ''}
          <span>${f.node_total} 节点</span></div>
      </div>`).join('');
    const key = a.flow_dir;
    html += `<div class="app ${collapsed.has(key) ? 'collapsed' : ''}" data-key="${esc(key)}">
      <div class="app-head"><span class="app-name">${esc(a.app)}</span>${badges(a.counts)}</div>
      <div class="sec ${collapsed.has(key + '#flow') ? 'collapsed' : ''}" data-key="${esc(key)}#flow">
        <div class="sec-head"><span>流程图 ${a.files.length}</span>
          <button class="app-new" data-dir="${esc(a.flow_dir)}" title="新建流程图">＋</button></div>
        <div class="sec-body">${files || '<div class="empty mini">暂无流程图</div>'}</div></div>
      <div class="sec ${collapsed.has(key + '#feat') ? 'collapsed' : ''}" data-key="${esc(key)}#feat">
        <div class="sec-head"><span>Feat ${a.feats.length}</span>
          <button class="feat-new" data-dir="${esc(a.feat_dir)}" title="新建 Feat 档案">＋</button></div>
        <div class="sec-body">${feats || '<div class="empty mini">暂无 Feat</div>'}</div></div>
    </div>`;
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

/** 按路径找 APP：流程图或 Feat 档案所属的 APP 条目。 */
function appOf(path) {
  return st.apps.find((a) => a.files.some((f) => f.path === path) || a.feats.some((f) => f.path === path)) || null;
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
  $('btn-flow-pop').disabled = !st.cur;
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
      routeDiagram(p);
    } catch (e) { sideMsg(String(e)); }
    return;
  }
  const fb = ev.target.closest('.feat-new');
  if (fb) {
    ev.stopPropagation();
    const title = await ask('新 Feat 标题（中文短语，编号自动生成）');
    if (!title) return;
    try {
      const p = await invoke('create_feat', { dir: fb.dataset.dir, title });
      await refresh();
      routeFeat(p);
    } catch (e) { sideMsg(String(e)); }
    return;
  }
  const file = ev.target.closest('.file');
  if (file) return routeDiagram(file.dataset.path);
  const feat = ev.target.closest('.feat');
  if (feat) return routeFeat(feat.dataset.feat);
  const head = ev.target.closest('.app-head, .sec-head');
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
  if (isDark()) q.set('dark', '1');
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
  st.loaded = false;
  selCells = [];
  renderNodeBar();
  $('empty').hidden = true;
  Split.show('flow');
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
      post({ action: 'fc-theme', dark: isDark() });
      if (st.cur) pushFromDisk(true);
      break;
    case 'fc-select':
      onNodeSelect(m.cells || [], !!m.auto);
      break;
    case 'load':
      // 图载入完成：按当前 Feat 重新高亮，执行等待中的节点定位
      st.loaded = true;
      applyFeat();
      if (st.pendingSelect) { post({ action: 'fc-select-cell', id: st.pendingSelect }); st.pendingSelect = ''; }
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

// ---------------- 节点 ↔ Feat 联动 ----------------

/** 当前选中的节点（来自桥接脚本），用于「挂到当前 Feat」。 */
let selCells = [];

/**
 * 节点选中：更新底部状态栏并把选中广播给其他窗口；用户点选（auto=false）时，
 * 节点只挂 1 个本 APP 的 Feat 直接打开，挂多个弹列表选择，0 个不切换。
 * auto=true 为程序定位（如从 Feat 关联节点列表跳来），只更新状态，不再反向打开 Feat。
 */
function onNodeSelect(cells, auto) {
  selCells = cells;
  lastSel = { file: st.cur, cells };
  emit('ui-flow-sel', lastSel);
  renderNodeBar();
  if (auto || cells.length !== 1) return;
  const app = appOf(st.cur);
  if (!app) return;
  const feats = app.feats.filter((f) => cells[0].tags.includes(f.id));
  if (feats.length === 1) routeFeat(feats[0].path, cells[0].id);
  else if (feats.length > 1) pickFeat(feats, cells[0]);
}

/** 多 Feat 时弹出选择列表；Esc、点空白处或「取消」关闭。 */
function pickFeat(feats, cell) {
  const wrap = document.createElement('div');
  wrap.id = 'roots-dlg';
  wrap.innerHTML = `<div class="dlg"><b>节点「${esc(cell.label.slice(0, 30))}」关联了 ${feats.length} 个 Feat</b>
    <div class="pick">${feats.map((f) => `<button data-p="${esc(f.path)}"><b>${esc(f.id)}</b> ${esc(f.title)}<small>${esc(f.status)}</small></button>`).join('')}</div>
    <div class="dlg-btns"><button data-x="1">取消（Esc）</button></div></div>`;
  document.body.appendChild(wrap);
  const close = (path) => {
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    if (path) routeFeat(path, cell.id);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  wrap.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b && ev.target !== wrap) return;
    close(b && b.dataset.p);
  };
  // 焦点原在 draw.io iframe 内，按键到不了本页；移到第一个选项上，Esc 才能生效
  wrap.querySelector('.pick button').focus();
}

/** 当前流程图与当前 Feat 是否属于同一 APP（Feat 编号只在 APP 内唯一，只允许同 APP 挂接与高亮）。 */
function sameApp() {
  const a = appOf(st.cur);
  return !!a && a === appOf(curFeat.path);
}

/** 底部状态栏：选中节点的标签，以及对当前 Feat 的挂/摘按钮；跨 APP 时只允许摘除。 */
function renderNodeBar() {
  const fid = curFeat.id;
  const btn = $('btn-tag');
  btn.hidden = true;
  if (!st.cur || !selCells.length) {
    $('node-info').textContent = st.cur ? '未选中节点' : '未打开流程图';
    return;
  }
  const tags = [...new Set(selCells.flatMap((c) => c.tags))];
  let info = `选中 ${selCells.length} 个节点` +
    (tags.length ? '：' + tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') : '：未挂标签');
  if (fid && !st.readOnly) {
    const allHave = selCells.every((c) => c.tags.includes(fid));
    const anyHave = selCells.some((c) => c.tags.includes(fid));
    if (sameApp() || anyHave) {
      const remove = sameApp() ? allHave : true;
      btn.hidden = false;
      btn.textContent = remove ? `从 ${fid} 摘除` : `挂到 ${fid}`;
      btn.onclick = () => {
        post({ action: 'fc-tag', tag: fid, add: !remove });
        setTimeout(() => refresh(false), 1500);
      };
    }
    if (!sameApp()) {
      const fa = appOf(curFeat.path);
      info += `<span class="hint">　${esc(fid)} 属于 ${esc(fa ? fa.app : '其他 APP')}，只能挂到该 APP 的流程图</span>`;
    }
  }
  $('node-info').innerHTML = info;
}

/** 按当前 Feat 刷新高亮（仅同 APP）、状态栏与树中选中项。 */
function applyFeat() {
  if (st.ready && st.cur) post({ action: 'fc-highlight', tag: sameApp() ? curFeat.id : '' });
  renderNodeBar();
  document.querySelectorAll('.feat').forEach((e) => e.classList.toggle('active', e.dataset.feat === curFeat.path));
}

/**
 * 打开流程图并可选定位节点：本窗口负责流程图栏时本地打开；否则交给主窗口路由
 * （独立窗口发 ui-route 给主窗口；主窗口在流程图已弹出时转给弹出窗口）。
 */
async function routeDiagram(path, node) {
  if (ownsFlow()) {
    if (path !== st.cur || !st.loaded) {
      st.pendingSelect = node || '';
      await openDiagram(path);
    } else if (node) post({ action: 'fc-select-cell', id: node });
    return;
  }
  if (SOLO) emit('ui-route', { kind: 'flow', path, node: node || '' });
  else await invoke('open_popout', { kind: 'flow', path, node: node || null });
}

/** 打开 Feat 档案并可选定位节点引用：路由规则同 routeDiagram。 */
async function routeFeat(path, node) {
  if (ownsFeat()) return FeatPane.open(path, { node });
  if (SOLO) emit('ui-route', { kind: 'feat', path, node: node || '' });
  else await invoke('open_popout', { kind: 'feat', path, node: node || null });
}

/** 供 FeatPane 调用的流程图侧接口。 */
window.FlowLink = {
  /** 当前 Feat 变化（打开 / 关闭）：本窗口立即生效并广播给其他窗口。 */
  setFeat(id, path) {
    curFeat = { id: id || '', path: path || '' };
    applyFeat();
    emit('ui-cur-feat', curFeat);
  },
  /** 打开图并选中节点（可能在另一个窗口）。 */
  reveal: (file, nodeId) => routeDiagram(file, nodeId),
  curFile: () => lastSel.file || st.cur,
  appOf,
  refresh: () => refresh(false),
};
window.FlowSel = () => lastSel.cells;

// ---------------- 多窗口 ----------------

/** 其他窗口的当前 Feat / 节点选中同步过来。 */
listen('ui-cur-feat', (ev) => {
  const p = ev.payload || {};
  if (p.id === curFeat.id && p.path === curFeat.path) return;
  curFeat = { id: p.id || '', path: p.path || '' };
  applyFeat();
});
listen('ui-flow-sel', (ev) => { lastSel = ev.payload || { file: null, cells: [] }; });

if (!SOLO) {
  /** 新独立窗口就绪后补发当前状态，保证弹出流程图仍高亮当前 Feat、弹出档案仍能引用已选节点。 */
  listen('ui-state-request', () => {
    emit('ui-cur-feat', curFeat);
    emit('ui-flow-sel', lastSel);
  });
  /** 主窗口：独立窗口请求打开某类文件时由主窗口路由。 */
  listen('ui-route', (ev) => {
    const { kind, path, node } = ev.payload;
    if (kind === 'flow') routeDiagram(path, node);
    else routeFeat(path, node);
  });
  /** 弹出窗口关闭：该类文件恢复在主窗口打开。 */
  listen('popout-closed', (ev) => {
    const kind = ev.payload.kind;
    popped[kind] = false;
    if (closingPopouts[kind]) { closingPopouts[kind](); delete closingPopouts[kind]; }
    if (kind === 'flow') { lastSel = { file: null, cells: [] }; $('empty').textContent = EMPTY_TEXT; }
    if (kind === 'feat' && curFeat.path && $('feat-pane').hidden) FlowLink.setFeat('', '');
  });
} else {
  /** 独立窗口：主窗口把新文件转过来。 */
  listen('popout-open', (ev) => {
    const { kind, path, node } = ev.payload;
    if (kind !== SOLO) return;
    if (kind === 'flow') routeDiagram(path, node || '');
    else routeFeat(path, node || '');
  });
}

/** 主窗口：把流程图栏 / Feat 栏弹到独立窗口，主窗口关闭该栏，之后该类文件都在独立窗口打开。 */
async function popOut(kind) {
  const path = kind === 'flow' ? st.cur : FeatPane.curPath();
  if (!path) return;
  if (kind === 'flow') await closeFlow('流程图已在独立窗口中打开');
  else await FeatPane.close();
  popped[kind] = true;
  try { await invoke('open_popout', { kind, path, node: null }); }
  catch (e) { popped[kind] = false; sideMsg(String(e)); }
}
$('btn-flow-pop').onclick = () => popOut('flow');
$('btn-feat-pop').onclick = () => popOut('feat');

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
  frame.src = 'drawio/index.html?' + new URLSearchParams({ embed: '1', proto: 'json', chrome: '0', lang: 'zh', stealth: '1', pwa: '0', splash: '0', nav: '1', ...(isDark() ? { dark: '1' } : {}) });
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

// ---------------- 分栏 ----------------

/** 主区分栏：流程图 / Feat 两栏，可拖动分隔；只打开一个时占满。 */
window.Split = {
  /** 显示某一栏（flow / feat）。 */
  show(which) {
    $(which === 'flow' ? 'flow-pane' : 'feat-pane').hidden = false;
    this.layout();
  },
  /** 关闭某一栏。 */
  hide(which) {
    $(which === 'flow' ? 'flow-pane' : 'feat-pane').hidden = true;
    this.layout();
  },
  /** 两栏都开时显示分隔条。 */
  layout() {
    $('splitter').hidden = $('flow-pane').hidden || $('feat-pane').hidden;
  },
};
(() => {
  const sp = $('splitter');
  sp.addEventListener('pointerdown', (e) => {
    sp.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    const box = $('panes').getBoundingClientRect();
    const move = (ev) => {
      const pct = Math.min(80, Math.max(20, ((ev.clientX - box.left) / box.width) * 100));
      $('flow-pane').style.flex = `0 0 ${pct}%`;
    };
    const up = () => {
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging');
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
  });
})();
/** 流程图栏空白时的提示。 */
const EMPTY_TEXT = '从左侧选择一张流程图或一个 Feat';

/** 关闭当前流程图：释放锁；Feat 栏开着时收起流程图栏，否则保留栏并显示提示 msg。 */
async function closeFlow(msg) {
  await releaseNow();
  st.cur = null;
  st.loaded = false;
  selCells = [];
  $('empty').textContent = msg || EMPTY_TEXT;
  $('empty').hidden = false;
  if (!$('feat-pane').hidden) Split.hide('flow');
  renderTree();
  renderCurrentBar();
  renderNodeBar();
}
$('btn-flow-close').onclick = () => closeFlow();

// ---------------- 侧栏宽度 ----------------

/** 拖动侧栏右边线调整宽度（200–640px），记入 localStorage；双击恢复默认 330px。 */
(() => {
  const sp = $('side-splitter');
  const root = document.documentElement;
  sp.addEventListener('pointerdown', (e) => {
    sp.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging-side');
    let w = $('side').getBoundingClientRect().width;
    const move = (ev) => {
      w = Math.round(Math.min(640, Math.max(200, ev.clientX)));
      root.style.setProperty('--side-w', w + 'px');
    };
    const up = () => {
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging-side');
      localStorage.setItem('fc-side-w', String(w));
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
  });
  sp.ondblclick = () => { root.style.removeProperty('--side-w'); localStorage.removeItem('fc-side-w'); };
})();

// ---------------- 主题 ----------------

/** 主题设置：auto 跟随系统 / light / dark，存 localStorage（各窗口共享，storage 事件同步）。 */
const THEME_NAMES = { auto: '◐ 自动', light: '☀ 浅色', dark: '☾ 深色' };
const themeSetting = () => localStorage.getItem('fc-theme') || 'auto';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
/** 当前是否深色。 */
function isDark() {
  const t = themeSetting();
  return t === 'dark' || (t === 'auto' && darkQuery.matches);
}
/** 应用主题：页面变量、draw.io（桥接 setDarkMode）、Markdown 编辑器（fc-theme 事件由 feat.js 处理）。 */
function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('btn-theme').textContent = THEME_NAMES[themeSetting()];
  if (st.ready) post({ action: 'fc-theme', dark });
  window.dispatchEvent(new CustomEvent('fc-theme', { detail: { dark } }));
}
$('btn-theme').onclick = () => {
  const order = ['auto', 'light', 'dark'];
  localStorage.setItem('fc-theme', order[(order.indexOf(themeSetting()) + 1) % order.length]);
  applyTheme();
};
darkQuery.addEventListener('change', applyTheme);
window.addEventListener('storage', (e) => { if (e.key === 'fc-theme') applyTheme(); });

// ---------------- 启动 ----------------

$('legend').innerHTML = STATUS.map((s) => `<span><span class="sw s-${s.key}"></span>${s.name}</span>`).join('');
window.addEventListener('beforeunload', () => { if (st.holding) invoke('release_lock', { path: st.cur }); });
applyTheme();

/**
 * 关窗前把待保存内容写盘并释放锁（beforeunload 里的异步调用不保证完成）：
 * 同步阻止默认关闭，待保存与释放完成后主动销毁窗口。
 */
const currentWindow = window.__TAURI__.window.getCurrentWindow();
let closing = false;
if (SOLO) listen('ui-close-popouts', () => currentWindow.close());
currentWindow.onCloseRequested(async (event) => {
  event.preventDefault();
  if (closing) return;
  closing = true;
  if (!SOLO) {
    const wait = Object.keys(popped).filter((kind) => popped[kind]).map((kind) =>
      new Promise((resolve) => { closingPopouts[kind] = resolve; }));
    await emit('ui-close-popouts');
    await Promise.all(wait);
  }
  // 只在本窗口确实开着档案时关闭，避免流程图窗口关闭时把其他窗口的当前 Feat 广播清空
  if (FeatPane.curPath()) await FeatPane.close();
  await releaseNow();
  await currentWindow.destroy();
});

// 所有外部脚本加载完再初始化，确保独立 Feat 窗口可直接调用 FeatPane。
window.addEventListener('DOMContentLoaded', () => {
  if (SOLO) {
    // 独立窗口：只显示一栏，打开 URL 参数指定的文件
    document.body.classList.add('solo');
    Split.hide(SOLO === 'flow' ? 'feat' : 'flow');
    refresh(false).then(() => {
      emit('ui-state-request');
      const path = PARAMS.get('path');
      const node = PARAMS.get('node') || '';
      if (!path) return;
      if (SOLO === 'flow') routeDiagram(path, node);
      else routeFeat(path, node);
    });
  } else {
    refresh(false);
  }
}, { once: true });
