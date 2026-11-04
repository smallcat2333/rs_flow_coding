// Flow Coding 前端：APP 树（流程图 + Feat）+ 状态统计 + draw.io 嵌入编辑（实时保存、加锁）+ 历史对比
// + 节点与 Feat 联动（Feat 档案编辑见 feat.js，通过 window.FeatPane / window.FlowLink 互调）
// + 主窗口页签（tabs.js，经 tabApi 打开 / 关闭页签内容）。
// 与 Rust 通信：window.__TAURI__.core.invoke；文件变化：flow-changed / md-changed 事件。
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;

/** 窗口角色：'' 主窗口；'flow' / 'feat' 为弹出的独立窗口（只显示该栏）。 */
const PARAMS = new URLSearchParams(location.search);
const SOLO = PARAMS.get('solo') || '';
/** 本机记住的打开方式（localStorage）：值为 '1' 表示该类文件上次在独立窗口打开，下次启动仍弹出。 */
const POP_KEY = { flow: 'fc-pop-flow', feat: 'fc-pop-feat' };
/** 主窗口：某栏已弹到独立窗口时为 true，该类文件改由弹出窗口打开；启动时按记住的打开方式初始化。 */
const popped = {
  flow: !SOLO && localStorage.getItem(POP_KEY.flow) === '1',
  feat: !SOLO && localStorage.getItem(POP_KEY.feat) === '1',
};
/** 主窗口：独立窗口点「回到主窗口」后待其关闭再在主窗口打开的文件，按类别存 { path, node, line }。 */
const docking = {};
/** 主窗口退出时，等待已弹出的窗口保存并关闭。 */
const closingPopouts = {};
/** 当前打开的 Feat（可能在另一个窗口里），由 ui-cur-feat 事件在窗口间同步。 */
let curFeat = { id: '', path: '' };
/** 最近一次选中的节点（可能来自另一个窗口的流程图），供「插入节点引用」使用。 */
let lastSel = { file: null, cells: [] };
/** 本窗口是否负责流程图栏 / Feat 栏。 */
const ownsFlow = () => SOLO === 'flow' || (!SOLO && !popped.flow);
const ownsFeat = () => SOLO === 'feat' || (!SOLO && !popped.feat);

/** 状态元数据：顺序即统计条与徽标的展示顺序（按协作流转：实现 → 待审 → 想法 → 确认 → 问题 → 删除 → 未识别）。 */
const STATUS = [
  { key: 'none', name: '已实现', details: ['无色或白色实线：代码已与流程图一致。', '有新想法或需要调整时，由你标蓝；发现问题时标红。'] },
  { key: 'review', name: '起草待审', details: ['黄色实线：Agent 已起草方案或完成修正，等待你审核。', '同意方案：你改为绿色，交给 Agent 实现。', '不同意或有问题：你改为红色，并写明原因。'] },
  { key: 'idea', name: '你的想法', details: ['蓝色实线：你提出的新想法或改动，尚待 Agent 评估。', '可行：Agent 补充方案后标黄，等待你审核。', '不可行：保持蓝色，用便签写明原因。'] },
  { key: 'confirmed', name: '已确认', details: ['绿色实线：你已认可方案，等待 Agent 实现。', 'Agent 按图修改代码；完成后改回无色或白色实线。'] },
  { key: 'issue', name: '有问题', details: ['红色实线：你指出方案或实现存在问题。', '在节点内或关联便签中写清问题与期望。', 'Agent 修正后标黄，再交给你审核。'] },
  { key: 'plan_delete', name: '计划删除', details: ['灰色虚线：Agent 建议删除该步骤，等待你确认。', '同意删除：你改为绿色虚线。', '不同意删除：你改回无色或白色实线，保留该步骤。'] },
  { key: 'confirm_delete', name: '确认删除', details: ['绿色虚线：你已确认删除该步骤。', 'Agent 删除对应节点及相关代码，并处理受影响的连接与引用。'] },
  { key: 'unknown', name: '未识别颜色', details: ['节点使用了协作规则之外的颜色，暂时无法归类。', '按实际进度改为上述协作状态对应的颜色与实线／虚线。', '连线、便签、文本、泳道和分组不计入节点统计。'] },
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

/** 图导航回退栈只保留在本窗口，记录来源图和节点，不写进项目文件。 */
const flowBack = [];
let flowNavigating = false;
let tabChanging = false;
let viewFreezeReady = null;

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
  restoreView: false, // 同一张图同步完成后，按设置恢复视图或自适应。
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

/** 绘制八种状态的统计行：「已实现」只显示数量；其余状态以其中最大值为满格画数量条，零值不填充。
 *  悬停显示数量、占比及分条协作说明；文字与数量提供非颜色识别。 */
function renderStatusStats(counts) {
  const total = STATUS.reduce((sum, s) => sum + (counts[s.key] || 0), 0);
  const max = Math.max(0, ...STATUS.filter((s) => s.key !== 'none').map((s) => counts[s.key] || 0));
  $('status-bars').innerHTML = STATUS.map((s) => {
    const value = counts[s.key] || 0;
    const pct = total ? value / total * 100 : 0;
    const bar = s.key === 'none' ? '<span class="status-track none" aria-hidden="true"></span>'
      : `<span class="status-track" aria-hidden="true"><span class="status-fill s-${s.key}" style="width:${max ? value / max * 100 : 0}%"></span></span>`;
    return `<div class="status-row" data-status="${s.key}" title="${esc(`${s.name}：${value.toLocaleString()} / ${total.toLocaleString()} 节点（${pct.toFixed(1)}%）\n\n${s.details.map((text) => '• ' + text).join('\n')}`)}"><span class="sw s-${s.key}" aria-hidden="true"></span><span class="status-name">${s.name}</span>${bar}<b class="status-value">${value.toLocaleString()}</b></div>`;
  }).join('');
}

let floatingStatusTimer = 0;
/** 非交互状态统一浮在窗口底部；新提示重置计时，原文按纯文本显示，六秒后收起且不抢焦点。 */
function floatingStatus(text, tone = 'error') {
  const el = $('floating-status');
  clearTimeout(floatingStatusTimer);
  el.textContent = text || '';
  el.className = `floating-status ${tone}`;
  if (!text) { el.hidePopover(); return; }
  el.showPopover();
  floatingStatusTimer = setTimeout(() => el.hidePopover(), 6000);
}

/** 侧栏操作结果改为悬浮提示；原节点仅保留结果文本，供设置页识别扫描失败。 */
function sideMsg(msg, success = false) {
  $('side-msg').textContent = msg || '';
  if (msg) floatingStatus(msg, success ? 'success' : 'error');
}

/** 操作提示统一走气泡，保存与复制结果均不占标题栏空间。 */
function saveState(text, isError) {
  $('save-state').textContent = '';
  if (text) floatingStatus(text, isError ? 'error' : /已复制|已保存|完成/.test(text) ? 'success' : 'info');
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
    Sidebar.prune(st.apps);
    sideMsg(st.apps.length ? '' : '未发现流程图或 Feat。请在设置 → 项目目录中配置并扫描。');
  } catch (e) {
    sideMsg(String(e));
    return false;
  }
  renderTree();
  renderCurrentBar();
  return true;
}

/** 重绘侧栏与顶部合计；生命周期、收纳和本机偏好由 Sidebar 统一维护。 */
function renderTree() {
  Sidebar.render(st.apps, st.cur, curFeat.path);
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

/** 同步图或 Feat 的锁标签；解锁和锁超时不触发文件变更，必须读取实时锁而非沿用汇总快照。 */
async function syncTreeLock(path) {
  if (!path) return;
  const lock = await invoke('lock_status', { path });
  let changed = false;
  for (const a of st.apps) for (const f of [...a.files, ...a.feats]) {
    if (f.path !== path) continue;
    changed ||= (f.lock?.owner || '') !== (lock?.owner || '');
    f.lock = lock;
  }
  if (changed) renderTree();
}

/** 顶栏：当前 APP、图名、状态分布、锁。 */
function renderCurrentBar() {
  const e = curEntry();
  $('cur-app').textContent = e ? `${e.app.group ? e.app.group + ' / ' : ''}${e.app.app}` : '';
  $('cur-name').textContent = e ? e.file.name.replace(/\.drawio$/i, '') : (st.cur ? st.cur : '未打开流程图');
  $('cur-counts').innerHTML = e ? badges(e.file.counts) : '';
  $('btn-flow-back').disabled = !st.cur || !flowBack.length || flowNavigating;
  $('btn-history').disabled = !st.cur;
  $('btn-copy-flow-path').disabled = !st.cur;
  $('btn-flow-full').disabled = !st.cur;
  $('node-find').disabled = !st.cur;
  $('btn-flow-pop').disabled = !st.cur;
  const feat = appOf(curFeat.path)?.feats.find((f) => f.path === curFeat.path);
  $('feat-status').textContent = feat ? feat.status : '';
  const badge = $('lock-badge');
  if (st.readOnly) { badge.className = 'agent'; badge.textContent = 'Agent 持锁'; }
  else if (st.holding) { badge.className = 'user'; badge.textContent = '你持锁'; }
  else { badge.className = ''; badge.textContent = ''; }
  syncMenuFeats();
}

/** 把当前图所属 APP 的未收纳 Feat 下发给编辑器，供右键「挂到 Feat」列出；编辑器未就绪时跳过，init 时补发。 */
function syncMenuFeats() {
  if (!st.ready) return;
  const feats = (curEntry()?.app.feats || []).filter((f) => !f.archived).map((f) => ({ id: f.id, title: f.title }));
  post({ action: 'fc-feats', feats });
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
  // 已打开内容优先跳转到已有页签；Ctrl+点击只为尚未打开的内容新建页签。
  const file = ev.target.closest('.file'), feat = ev.target.closest('.feat');
  if (file || feat) {
    const kind = file ? 'flow' : 'feat', path = file ? file.dataset.path : feat.dataset.feat;
    if (!SOLO && await Tabs.reveal(kind, path)) { Sidebar.select(path); return; }
    if (ev.ctrlKey && !SOLO) return Tabs.openNew(kind, path);
    return file ? routeDiagram(path) : routeFeat(path);
  }
  const head = ev.target.closest('.app-head, .sec-head');
  if (head) head.parentElement.classList.toggle('collapsed');
});

// ---------------- 编辑器（draw.io embed 协议） ----------------

/** 向编辑器发送协议消息。 */
function post(msg) { editor.contentWindow.postMessage(JSON.stringify(msg), '*'); }

/** 仅首次载入用空白提示；已有画面保留冻结层，成功、关闭或失败时统一释放。 */
function setDiagramLoading(on) {
  $('editor-wrap').classList.toggle('loading', on);
  $('editor-wrap').setAttribute('aria-busy', String(on));
  if (!on) {
    $('editor-wrap').classList.remove('frozen');
    if (st.ready) post({ action: 'fc-view-reveal' });
  }
}

/** 在异步读取或布局变更前冻结当前图，不重建 iframe，也不把旧图替换成纯色。 */
async function freezeDiagram() {
  if (!st.ready || !st.loaded || $('editor-wrap').classList.contains('frozen')) return;
  await new Promise((resolve) => {
    viewFreezeReady = resolve;
    post({ action: 'fc-view-freeze' });
  });
  setDiagramLoading(true);
}

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

/** 把磁盘内容推给编辑器：首次 load，更新时 merge；同步前暂存视图，完成后按设置恢复。
 *  合并失败重载时复用同一次视图快照；推送的 autosave 回显在 SUPPRESS_MS 内忽略。 */
async function pushFromDisk(first, retry = false) {
  const d = await invoke('read_diagram', { path: st.cur });
  st.curHash = d.hash;
  st.suppressUntil = Date.now() + SUPPRESS_MS;
  st.restoreView = first ? 'fit' : 'update';
  if (!first && !retry) post({ action: 'fc-viewport-save' });
  if (first || retry) post({ action: 'load', xml: d.xml, autosave: 1, diffSync: true, title: d.path.split(/[\\/]/).pop() });
  else post({ action: 'merge', xml: d.xml });
  post({ action: 'fc-path', path: d.path });
}

/** 新图先适应内容；同图更新按偏好恢复视图，后续节点定位仍优先。 */
function finishViewUpdate() {
  if (!st.restoreView) return;
  const keep = st.restoreView !== 'fit' && Settings.keepFlowView();
  st.restoreView = false;
  post({ action: 'fc-viewport-apply', keep });
}

/** 打开一张图：先释放上一张的锁，再加载。 */
async function openDiagram(path) {
  if (path === st.cur) return;
  await releaseNow();
  st.cur = path;
  if (!SOLO) Tabs.note('flow', path);
  renderTree();
  st.pendingXml = null;
  st.loaded = false;
  selCells = [];
  renderNodeBar();
  $('empty').hidden = true;
  Split.show('flow');
  saveState('');
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

/** 进入只读：编辑器禁用编辑但仍可缩放、滚动查看，内容区显示悬浮标识（轮询由常驻锁巡检负责）。 */
async function enterReadOnly(l) {
  l = l || await invoke('lock_status', { path: st.cur });
  st.readOnly = true;
  if (st.ready) post({ action: 'fc-readonly', on: true });
  $('readonly-mask').hidden = false;
  $('mask-detail').textContent = l ? `pid ${l.pid}，开始于 ${new Date(l.since * 1000).toLocaleTimeString()}` : '';
  renderCurrentBar();
}

/** 退出只读：重新载入磁盘最新内容。 */
async function leaveReadOnly() {
  st.readOnly = false;
  if (st.ready) post({ action: 'fc-readonly', on: false });
  $('readonly-mask').hidden = true;
  renderCurrentBar();
  if (st.ready && st.cur) await pushFromDisk(false);
}

/** 巡检当前图只读状态，并刷新当前 Feat 与侧栏已标锁的条目；覆盖解锁、超时以及切走文件后的残留标签。 */
let checkingTreeLocks = false;
setInterval(async () => {
  if (checkingTreeLocks) return;
  checkingTreeLocks = true;
  try {
    if (st.cur && !st.holding) await checkLock();
    const paths = new Set(st.apps.flatMap((a) => [...a.files, ...a.feats]).filter((f) => f.lock).map((f) => f.path));
    const featPath = FeatPane.curPath();
    if (featPath) paths.add(featPath);
    await Promise.all([...paths].map(syncTreeLock));
  } catch (e) { console.error('锁状态巡检失败', e); }
  finally { checkingTreeLocks = false; }
}, LOCK_POLL_MS);

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
      post({ action: 'fc-ids', show: showIds() });
      post({ action: 'fc-readonly', on: st.readOnly });
      syncMenuFeats();
      if (st.cur) pushFromDisk(true);
      break;
    case 'fc-select':
      onNodeSelect(m.cells || []);
      break;
    case 'fc-open-feat':
      if (m.cell) openNodeFeat(m.cell);
      break;
    case 'fc-open-flow':
      if (m.source === st.cur) followFlowLink(m.link, m.cell);
      break;
    case 'fc-copied':
      saveState(m.error ? '复制失败：' + m.error : `已复制 ${m.count} 条节点引用`, !!m.error);
      break;
    case 'fc-tagged':
      setTimeout(() => refresh(false), 1500);
      break;
    case 'fc-select-miss':
      saveState(`当前图没有节点 ${m.id}`, true);
      break;
    case 'fc-view-frozen':
      $('editor-wrap').classList.toggle('frozen', m.frozen);
      if (viewFreezeReady) { const ready = viewFreezeReady; viewFreezeReady = null; ready(); }
      break;
    case 'fc-presentation-ready':
      $('editor-wrap').classList.toggle('frozen', m.frozen);
      if (fullScreenReady) { const ready = fullScreenReady; fullScreenReady = null; ready(); }
      break;
    case 'fc-presentation-painted':
      if (fullScreenPaintReady) { const ready = fullScreenPaintReady; fullScreenPaintReady = null; ready(); }
      break;
    case 'fc-toggle-fullscreen':
      if (st.cur && ownsFlow()) setFlowFull(!flowFull);
      break;
    case 'fc-escape':
      if (flowFull) setFlowFull(false);
      else if (SOLO) currentWindow.close();
      break;
    case 'load':
      // 图模型载入后先完成高亮、视图恢复和节点定位，绘制完成再展示。
      applyFeat();
      finishViewUpdate();
      if (st.pendingSelect) { post({ action: 'fc-select-cell', id: st.pendingSelect }); st.pendingSelect = ''; }
      post({ action: 'fc-render-ready', path: st.cur });
      break;
    case 'fc-render-ready':
      if (m.path !== st.cur || !st.cur) break;
      st.loaded = true;
      flowNavigating = false;
      if (!tabChanging) setDiagramLoading(false);
      renderCurrentBar();
      break;
    case 'autosave':
    case 'save':
      if (m.xml != null) onAutosave(m.xml);
      break;
    case 'merge':
      if (m.error) pushFromDisk(false, true); // 合并失败整页重载，仍按设置恢复原视图。
      else finishViewUpdate();
      break;
  }
});

// ---------------- 节点 ↔ Feat 联动 ----------------

/** 当前选中的节点（来自桥接脚本），用于「挂到当前 Feat」。 */
let selCells = [];

/** 节点选中只更新底部状态栏与跨窗口选中状态，不打开档案。 */
function onNodeSelect(cells) {
  selCells = cells;
  lastSel = { file: st.cur, cells };
  emit('ui-flow-sel', lastSel);
  renderNodeBar();
}

/** 点击书签时打开关联档案；挂了多个 Feat 时弹列表选择。 */
function openNodeFeat(cell) {
  const app = appOf(st.cur);
  if (!app) return;
  const feats = app.feats.filter((f) => cell.tags.includes(f.id));
  const missing = cell.tags.filter((id) => /^Feat_\d+_\d+$/.test(id) && !app.feats.some((f) => f.id === id));
  if (missing.length) {
    const elsewhere = st.apps.filter((a) => a !== app).flatMap((a) => a.feats.filter((f) => missing.includes(f.id))
      .map((f) => ({ ...f, foreign: true, owner: a.app })));
    pickFeat([...feats, ...elsewhere], cell, `本 APP（${app.app}）找不到：${missing.join('、')}。可解除缺失档案的关联；其他 APP 的同号档案仅供查看，不会建立跨 APP 关联。`, missing);
  } else if (feats.length === 1) openLinked('feat', feats[0].path, cell.id);
  else if (feats.length > 1) pickFeat(feats, cell);
}

/** 弹出节点的 Feat 列表；missing 中的缺失编号可逐个解除，只读时禁用；Esc、点空白或取消关闭。 */
function pickFeat(feats, cell, notice = '', missing = []) {
  const wrap = document.createElement('div');
  wrap.id = 'roots-dlg';
  wrap.innerHTML = `<div class="dlg"><b>节点「${esc(cell.label.slice(0, 30))}」关联的 Feat</b>${notice ? `<p class="hint">${esc(notice)}</p>` : ''}
    <div class="pick">${feats.map((f) => `<button data-p="${esc(f.path)}"><b>${esc(f.id)}</b> ${esc(f.title)}<small>${esc(f.owner || '')} ${esc(f.status)}</small></button>`).join('')}
      ${missing.map((id) => `<button data-unlink="${esc(id)}"${st.readOnly ? ' disabled title="流程图只读，暂不能解除关联"' : ''}><b>${esc(id)}</b><small>解除关联</small></button>`).join('')}</div>
    <div class="dlg-btns"><button data-x="1">取消（Esc）</button></div></div>`;
  document.body.appendChild(wrap);
  const close = (path) => {
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    if (path) openLinked('feat', path, feats.find((f) => f.path === path).foreign ? undefined : cell.id);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  wrap.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b && ev.target !== wrap) return;
    if (b?.dataset.unlink) {
      if (st.readOnly) return;
      close();
      post({ action: 'fc-tag', tag: b.dataset.unlink, add: false });
      setTimeout(() => refresh(false), 1500);
      return;
    }
    close(b && b.dataset.p);
  };
  // 焦点原在 draw.io iframe 内，按键到不了本页；移到首个可用选项上，Esc 才能生效
  (wrap.querySelector('.pick button:not(:disabled)') || wrap.querySelector('[data-x]')).focus();
}

/** 当前流程图与当前 Feat 是否属于同一 APP（Feat 编号只在 APP 内唯一，只允许同 APP 挂接与高亮）。 */
function sameApp() {
  const a = appOf(st.cur);
  return !!a && a === appOf(curFeat.path);
}

/** 不需要用户作选择的异常说明统一悬浮显示；调用方的挂接限制保持不变。 */
function alertBox(title, message) {
  floatingStatus(title + '：' + message);
}

/** 底部状态栏：选中节点的标签，以及对当前 Feat 的挂/摘按钮。
 *  跨 APP 不在状态栏预告；点「挂到」时悬浮提示拒绝，已挂上的残留标签仍可摘除。 */
function renderNodeBar() {
  const fid = curFeat.id;
  const btn = $('btn-tag');
  btn.hidden = true;
  $('btn-copy-ref').hidden = !st.cur || !selCells.length;
  if (!st.cur || !selCells.length) {
    $('node-info').textContent = st.cur ? '未选中节点' : '未打开流程图';
    return;
  }
  const tags = [...new Set(selCells.flatMap((c) => c.tags))];
  const ids = selCells.slice(0, 3).map((c) => `<code class="node-id">${esc(c.id)}</code>`).join('') +
    (selCells.length > 3 ? '…' : '');
  let info = `选中 ${selCells.length} 个节点 · ID ${ids}` +
    (tags.length ? '：' + tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') : '：未挂标签');
  const app = appOf(st.cur);
  const missing = tags.filter((id) => /^Feat_\d+_\d+$/.test(id) && app && !app.feats.some((f) => f.id === id));
  if (missing.length) info += `<span class="hint">　本 APP 缺少档案：${esc(missing.join('、'))}；点击书签查看</span>`;
  if (fid && !st.readOnly) {
    const allHave = selCells.every((c) => c.tags.includes(fid));
    const anyHave = selCells.some((c) => c.tags.includes(fid));
    const cross = !sameApp();
    // 跨 APP 且节点已有该标签时只摘除；否则显示「挂到」，点击后再拒绝跨 APP。
    const remove = cross ? anyHave : allHave;
    btn.hidden = false;
    btn.textContent = remove ? `从 ${fid} 摘除` : `挂到 ${fid}`;
    btn.onclick = () => {
      if (!remove && cross) {
        const fa = appOf(curFeat.path);
        alertBox('不能挂接', `${fid} 属于 ${fa ? fa.app : '其他 APP'}，只能挂到该 APP 的流程图`);
        return;
      }
      post({ action: 'fc-tag', tag: fid, add: !remove });
      setTimeout(() => refresh(false), 1500);
    };
  }
  $('node-info').innerHTML = info;
  $('node-info').title = $('node-info').textContent;
}

/**
 * 复制节点引用「图名.drawio#ID」，多个每行一个；与 Feat 档案节点引用格式一致，可直接发给 Agent。
 * 底部栏按钮使用；成功时按钮短暂显示「已复制」，状态栏同时提示条数。
 * 右键菜单的同名操作在编辑器 iframe 内写剪贴板（焦点在那边），结果经 fc-copied 回报。
 */
function copyRefs(ids) {
  if (!st.cur || !ids.length) return;
  const name = st.cur.split(/[\\/]/).pop();
  const btn = $('btn-copy-ref');
  navigator.clipboard.writeText(ids.map((id) => `${name}#${id}`).join('\n')).then(() => {
    btn.textContent = '已复制';
    saveState(`已复制 ${ids.length} 条节点引用`);
    setTimeout(() => { btn.textContent = '复制引用'; }, 1200);
  }, (error) => saveState('复制失败：' + error, true));
}
$('btn-copy-ref').onclick = () => copyRefs(selCells.map((c) => c.id));

/**
 * 复制当前流程图的绝对路径，供粘贴给 Agent 继续处理这张图。
 * 扫描结果里的路径已是绝对路径；未打开图时按钮禁用。成功提示不替换按钮图标。
 */
function copyFlowPath() {
  if (!st.cur) return;
  const btn = $('btn-copy-flow-path');
  navigator.clipboard.writeText(st.cur).then(() => {
    btn.title = '已复制流程图绝对路径';
    setTimeout(() => { btn.title = '复制当前流程图的绝对路径，可发给 Agent 继续处理'; }, 1200);
  }, (error) => saveState('复制失败：' + error, true));
}
$('btn-copy-flow-path').onclick = copyFlowPath;

/**
 * 解析定位输入：取文字中第一个「图名.drawio#ID」（可带目录），否则把整段视为当前图的节点 ID（可带前导 #）。
 * 返回 {file, id}，file 为空表示当前图；无法识别返回 null。
 */
function parseNodeRef(text) {
  const t = text.trim();
  const m = t.match(/([^\s"'`<>()（）[\]【】「」]+?\.drawio)(?:#([^\s"'`<>()（）[\]【】「」,，。;；]+))?/i);
  if (m) return { file: m[1], id: m[2] || '' };
  const id = t.replace(/^#/, '');
  return id && !/\s/.test(id) ? { file: '', id } : null;
}

/**
 * 按图名找流程图：当前 APP 优先，其次全部 APP 中唯一同名；带目录时按路径尾部匹配。
 * 粘贴的中文句子里图名前常紧贴其他文字（如「见01_启动.drawio」），精确匹配不到时退回按图名结尾匹配，取最长图名。
 */
function findFlowByName(file) {
  const want = file.replace(/\\/g, '/').toLowerCase();
  const norm = (f) => f.path.replace(/\\/g, '/').toLowerCase();
  const exact = (f) => { const p = norm(f); return p === want || p.endsWith('/' + want); };
  const loose = (f) => want.endsWith(norm(f).split('/').pop());
  for (const hit of [exact, loose]) {
    const pick = (list) => list.sort((a, b) => norm(b).split('/').pop().length - norm(a).split('/').pop().length);
    const own = pick(appOf(st.cur)?.files.filter(hit) || []);
    if (own.length) return own[0].path;
    const all = pick(st.apps.flatMap((a) => a.files.filter(hit)));
    if (all.length === 1) return all[0].path;
    if (all.length > 1) throw new Error(`多个 APP 都有 ${file}，请带上目录`);
  }
  throw new Error(`找不到流程图 ${file}`);
}

/** 定位框回车：跳到目标图（可跨图，进入返回栈）并选中节点；找不到时在顶栏提示。 */
$('node-find').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.isComposing || !st.cur) return;
  ev.preventDefault();
  const ref = parseNodeRef(ev.target.value);
  if (!ref) { saveState('请输入节点 ID 或「图名.drawio#ID」', true); return; }
  try {
    const path = ref.file ? findFlowByName(ref.file) : st.cur;
    saveState('');
    routeDiagram(path, ref.id);
  } catch (error) { saveState(error.message, true); }
});

/** 按当前 Feat 刷新图中节点高亮（仅同 APP）与状态栏；侧栏选中由主动打开操作维护。 */
function applyFeat() {
  if (st.ready && st.cur) post({ action: 'fc-highlight', tag: sameApp() ? curFeat.id : '' });
  renderTree();
  renderNodeBar();
}

/**
 * 打开流程图并可选定位节点：本窗口负责流程图栏时本地打开；否则交给主窗口路由
 * （独立窗口发 ui-route 给主窗口；主窗口在流程图已弹出时转给弹出窗口）。
 */
async function routeDiagram(path, node, options = {}) {
  if (!SOLO && Settings.projectsNewTab() && Tabs.isOtherProject(path)) return Tabs.openNew('flow', path, { node });
  Sidebar.select(path);
  if (ownsFlow()) {
    if (flowNavigating) return;
    const from = st.cur ? { path: st.cur, node: options.fromNode || selCells[0]?.id || '' } : null;
    const changed = path !== st.cur || (!!node && node !== selCells[0]?.id);
    flowNavigating = true;
    renderCurrentBar();
    try {
      if (path !== st.cur || !st.loaded) {
        await freezeDiagram();
        setDiagramLoading(true);
      }
      // 切图前等最后一次自动保存结束，避免旧图的异步写入落到新路径。
      while (st.saving || st.pendingXml != null) await new Promise((resolve) => setTimeout(resolve, 20));
      await invoke('read_diagram', { path }); // 读取失败时保留当前图与回退栈。
      // 切页签打开的图不进回退栈（回退栈在切页签时清空，只记同一页签内的跳转）。
      if (from && changed && !options.back && !options.tab) flowBack.push(from);
      if (options.back) flowBack.pop();
      if (path !== st.cur || !st.loaded) {
        st.pendingSelect = node || '';
        await openDiagram(path);
      } else {
        if (node) post({ action: 'fc-select-cell', id: node });
        flowNavigating = false;
      }
    } catch (error) {
      flowNavigating = false;
      setDiagramLoading(false);
      saveState('打开流程图失败：' + error, true);
    }
    renderCurrentBar();
    return;
  }
  if (SOLO) emit('ui-route', { kind: 'flow', path, node: node || '' });
  else await invoke('open_popout', { kind: 'flow', path, node: node || null });
}

/** 右上角挂载标记：根据本机偏好另开页签，普通打开与侧栏点击保持原行为。 */
function openLinked(kind, path, node) {
  if (Settings.linksNewTab()) {
    if (SOLO) return emit('ui-route', { kind, path, node: node || '', newTab: true });
    return Tabs.openNew(kind, path, { node });
  }
  return kind === 'flow' ? routeDiagram(path, node, { fromNode: selCells[0]?.id }) : routeFeat(path, node);
}

/** 按当前图解析链接；目标不存在时留在原图，错误显示在保存状态栏。 */
async function followFlowLink(link, cell) {
  if (!st.cur || flowNavigating) return;
  const source = st.cur;
  try {
    const target = await invoke('resolve_flow_link', { source, link });
    if (st.cur === source) {
      if (Settings.linksNewTab()) await openLinked('flow', target.path, target.node);
      else await routeDiagram(target.path, target.node, { fromNode: cell });
    }
  } catch (error) { saveState('图链接无法打开：' + error, true); }
}

/** 回到来源图并定位原节点；失败时保留栈，方便修正链接或恢复文件后重试。 */
$('btn-flow-back').onclick = () => {
  const previous = flowBack[flowBack.length - 1];
  if (previous) routeDiagram(previous.path, previous.node, { back: true });
};

/** 改名后同步本窗口的回退栈，防止返回旧文件名。 */
listen('rename-finished', ({ payload: p }) => {
  if (p.error) return;
  for (const item of flowBack) if (item.path === p.oldPath) item.path = p.path;
});

// 快速连续选 Feat 时串行完成保存与载入，防止前一份异步读取覆盖后一份文档。
let featRoute = Promise.resolve();

/** 打开 Feat 档案并可选定位节点引用或源文件行号（line，1 起；0 为不定位）：路由规则同 routeDiagram。 */
async function routeFeat(path, node, line = 0) {
  if (!SOLO && Settings.projectsNewTab() && Tabs.isOtherProject(path)) return Tabs.openNew('feat', path, { node, line });
  Sidebar.select(path);
  if (ownsFeat()) {
    featRoute = featRoute.catch(() => {}).then(() => FeatPane.open(path, { node, line }));
    return featRoute;
  }
  if (SOLO) emit('ui-route', { kind: 'feat', path, node: node || '', line });
  else await invoke('open_popout', { kind: 'feat', path, node: node || null, line: line || null });
}

/** 页签接口（tabs.js）：在主窗口打开 / 关闭页签里的图与档案；已弹到独立窗口的一类照常转给独立窗口。
 *  切页签时清空图导航回退栈，回退只在同一页签内有效。 */
const tabApi = {
  /** 页签的两栏作为一次绘制事务，避免图已显示后 Feat 才改变布局。 */
  async begin() {
    tabChanging = true;
    await freezeDiagram();
  },
  /** 两栏开闭完成后再确认最终尺寸；无冻结层但已加载的图也须完成回执，避免载入遮罩残留。 */
  end() {
    tabChanging = false;
    if (st.cur && st.ready && (st.loaded || $('editor-wrap').classList.contains('frozen'))) {
      post({ action: 'fc-render-ready', path: st.cur });
    } else if (!st.cur) setDiagramLoading(false);
  },
  /** 同一 APP 使用同一个规范化目录键，同名 APP 或不同分组不混淆。 */
  project: (path) => (appOf(path)?.flow_dir || '').replace(/\\/g, '/').toLowerCase(),
  async openFlow(path, node = '') {
    while (flowNavigating) await new Promise((resolve) => setTimeout(resolve, 20));
    flowBack.length = 0;
    await routeDiagram(path, node, { tab: true });
  },
  openFeat: (path, node, line = 0) => routeFeat(path, node, line),
  async closeFlow() {
    flowBack.length = 0;
    if (st.cur) await closeFlow();
  },
  /** 排在 Feat 打开队列之后关闭，避免和正在载入的档案交错。 */
  closeFeat() {
    featRoute = featRoute.catch(() => {}).then(() => FeatPane.curPath() && FeatPane.close());
    return featRoute;
  },
  /** 文件是否还在汇总里（恢复页签时剔除已删除或移出项目的文件）。 */
  exists: (kind, path) => !!appOf(path)?.[kind === 'flow' ? 'files' : 'feats'].some((x) => x.path === path),
  /** 页签显示名：图取文件名，Feat 取标题（无标题用编号）；汇总里找不到时退回文件名。 */
  label(kind, path) {
    const list = appOf(path)?.[kind === 'flow' ? 'files' : 'feats'] || [];
    const f = list.find((x) => x.path === path);
    const file = path.split(/[\\/]/).pop();
    if (kind === 'flow') return (f ? f.name : file).replace(/\.drawio$/i, '');
    return f ? f.title || f.id : file.replace(/\.md$/i, '');
  },
};

/** 供 FeatPane 调用的流程图侧接口。 */
window.FlowLink = {
  /** 当前 Feat 变化（打开 / 关闭）：本窗口立即生效并广播给其他窗口。 */
  setFeat(id, path) {
    curFeat = { id: id || '', path: path || '' };
    if (!SOLO) Tabs.note('feat', curFeat.path);
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
    const { kind, path, node, line, newTab } = ev.payload;
    if (newTab) return Tabs.openNew(kind, path, { node, line });
    if (kind === 'flow') routeDiagram(path, node);
    else routeFeat(path, node, line || 0);
  });
  /** 独立窗口请求回到主窗口：先记下文件与位置，等该窗口保存、释放锁并关闭后再打开（见 popout-closed）。 */
  listen('ui-dock', (ev) => { docking[ev.payload.kind] = ev.payload; });
  /** 弹出窗口关闭：该类文件恢复在主窗口打开，并记住打开方式；主窗口退出时关闭的不改记忆。
   *  若是「回到主窗口」触发的关闭，接着在主窗口打开同一文件。 */
  listen('popout-closed', (ev) => {
    const kind = ev.payload.kind;
    popped[kind] = false;
    if (!closing) localStorage.removeItem(POP_KEY[kind]);
    if (closingPopouts[kind]) { closingPopouts[kind](); delete closingPopouts[kind]; }
    if (kind === 'flow') { lastSel = { file: null, cells: [] }; $('empty').textContent = EMPTY_TEXT; }
    if (kind === 'feat' && curFeat.path && $('feat-pane').hidden) FlowLink.setFeat('', '');
    const dock = docking[kind];
    delete docking[kind];
    if (!dock || closing || !dock.path) return;
    if (kind === 'flow') routeDiagram(dock.path, dock.node || '');
    else routeFeat(dock.path, '', dock.line || 0);
  });
} else {
  /** 独立窗口：主窗口把新文件转过来。 */
  listen('popout-open', (ev) => {
    const { kind, path, node, line } = ev.payload;
    if (kind !== SOLO) return;
    if (kind === 'flow') routeDiagram(path, node || '');
    else routeFeat(path, node || '', line || 0);
  });
}

/** 主窗口：把流程图栏 / Feat 栏弹到独立窗口，主窗口关闭该栏，之后该类文件都在独立窗口打开。 */
async function popOut(kind) {
  const path = kind === 'flow' ? st.cur : FeatPane.curPath();
  if (!path) return;
  if (kind === 'flow') await closeFlow('流程图已在独立窗口中打开');
  else await FeatPane.close();
  popped[kind] = true;
  try {
    await invoke('open_popout', { kind, path, node: null });
    localStorage.setItem(POP_KEY[kind], '1');
    await Tabs.closeEmpty();
  }
  catch (e) { popped[kind] = false; sideMsg(String(e)); }
}
$('btn-flow-pop').onclick = () => popOut('flow');
$('btn-feat-pop').onclick = () => popOut('feat');
$('btn-flow-tab').onclick = () => Tabs.split('flow', { node: selCells[0]?.id });
$('btn-feat-tab').onclick = () => Tabs.split('feat', { line: FeatPane.topLine() });

/** 独立窗口：回到主窗口。告知主窗口当前文件与位置（图取选中节点，档案取视口顶部行），
 *  再走正常关闭流程（保存并释放锁）；主窗口收到 popout-closed 后打开。 */
async function dockBack() {
  const path = SOLO === 'flow' ? st.cur : FeatPane.curPath();
  await emit('ui-dock', { kind: SOLO, path: path || '', node: SOLO === 'flow' ? selCells[0]?.id || '' : '', line: SOLO === 'feat' ? FeatPane.topLine() : 0 });
  currentWindow.close();
}
$('btn-flow-dock').onclick = dockBack;
$('btn-feat-dock').onclick = dockBack;

// ---------------- 文件变化 ----------------

/** 项目元数据启停变化：所有窗口刷新统计与收纳列表，不重载正在编辑的原图。 */
listen('catalog-changed', () => refresh(false));

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

// ---------------- 刷新与历史维护 ----------------

$('btn-refresh').onclick = async () => {
  const button = $('btn-refresh');
  button.disabled = true;
  try { await refresh(false); } finally { button.disabled = false; }
};
listen('history-pruned', () => {
  st.histSel = [];
  $('viewer').hidden = true;
  $('viewer-frame').removeAttribute('src');
  if (!$('history').hidden) loadHistory();
});

// ---------------- 分栏 ----------------

// 栏的显示、排布、固定 / 悬浮由 layout.js 的 window.Split 负责。
/** 流程图栏空白时的提示。 */
const EMPTY_TEXT = '从左侧选择一张流程图或一个 Feat';

/** 关闭当前流程图并释放锁；空位或首页提示由布局规则统一决定，msg 用于空位说明。 */
async function closeFlow(msg) {
  await releaseNow();
  st.cur = null;
  if (!SOLO) Tabs.note('flow', '');
  // 图还在载入时关闭：结束这次导航，否则后续打开图（含切页签）会一直等载入完成。
  flowNavigating = false;
  setDiagramLoading(false);
  st.loaded = false;
  selCells = [];
  $('empty').textContent = msg || EMPTY_TEXT;
  $('empty').hidden = false;
  Split.hide('flow');
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
  $('settings-theme').value = themeSetting();
  if (st.ready) post({ action: 'fc-theme', dark });
  window.dispatchEvent(new CustomEvent('fc-theme', { detail: { dark } }));
}
darkQuery.addEventListener('change', applyTheme);
window.addEventListener('storage', (e) => { if (e.key === 'fc-theme') applyTheme(); });

// ---------------- 节点 ID 小卡 ----------------

/** ID 小卡显示偏好：存 localStorage（默认显示，各窗口共享，storage 事件同步）。 */
const showIds = () => localStorage.getItem('fc-show-ids') !== '0';
/** 按偏好刷新开关按钮，并通知 draw.io 显示或移除小卡。 */
function applyShowIds() {
  const show = showIds();
  $('btn-ids').classList.toggle('on', show);
  $('btn-ids').setAttribute('aria-pressed', String(show));
  if (st.ready) post({ action: 'fc-ids', show });
}
$('btn-ids').onclick = () => {
  localStorage.setItem('fc-show-ids', showIds() ? '0' : '1');
  applyShowIds();
};
window.addEventListener('storage', (e) => { if (e.key === 'fc-show-ids') applyShowIds(); });
applyShowIds();

// ---------------- 启动 ----------------

renderStatusStats({});
window.addEventListener('beforeunload', () => { if (st.holding) invoke('release_lock', { path: st.cur }); });
applyTheme();

/**
 * 关窗前把待保存内容写盘并释放锁（beforeunload 里的异步调用不保证完成）：
 * 同步阻止默认关闭，待保存与释放完成后主动销毁窗口。
 */
const currentWindow = window.__TAURI__.window.getCurrentWindow();
let closing = false;

/** 流程图是否处于全屏。 */
let flowFull = false;
/** 全屏切换期间等待编辑器确认已记录当前视图，同时阻止重复切换。 */
let fullScreenReady = null;
let fullScreenPaintReady = null;
let fullScreenSwitching = false;

/**
 * 全屏只展示当前流程图视图：改变窗口尺寸前先记录画布中心，进出时保持最新位置与缩放。
 * 退出恢复窗口和编辑状态；窗口切换失败时保留原状态并显示错误。
 */
async function setFlowFull(on) {
  if (on === flowFull || fullScreenSwitching || flowNavigating || tabChanging || !st.loaded || !st.ready || $('editor-wrap').classList.contains('loading')) return;
  fullScreenSwitching = true;
  try {
    await new Promise((resolve) => {
      fullScreenReady = resolve;
      post({ action: 'fc-presentation-prepare' });
    });
    setDiagramLoading(true);
    await currentWindow.setFullscreen(on);
    flowFull = on;
    document.body.classList.toggle('flow-full', on);
    const btn = $('btn-flow-full');
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? '退出全屏（F11 / Esc）' : '全屏显示流程图（F11，Esc 退出）';
    await new Promise((resolve) => {
      fullScreenPaintReady = resolve;
      post({ action: 'fc-presentation', show: on });
    });
  } catch (error) {
    saveState('切换全屏失败：' + error, true);
  } finally {
    fullScreenReady = fullScreenPaintReady = null;
    fullScreenSwitching = false;
    setDiagramLoading(false);
  }
}
$('btn-flow-full').onclick = () => setFlowFull(!flowFull);
// 焦点在编辑器外时的 Esc：先退出全屏；有对话框时留给对话框自己处理。焦点在编辑器内由 fc-escape 转发。
// 须注册在独立窗口「Esc 关窗」之前，同为捕获阶段时先执行并截住事件。
document.addEventListener('keydown', (event) => {
  if (event.key === 'F11' && !event.isComposing && st.cur && ownsFlow() && !document.querySelector('dialog[open], #roots-dlg')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) setFlowFull(!flowFull);
    return;
  }
  if (event.key !== 'Escape' || event.isComposing || !flowFull || document.getElementById('roots-dlg')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  setFlowFull(false);
}, true);

if (SOLO) {
  listen('ui-close-popouts', () => currentWindow.close());
  // 多 Feat 选择框优先取消；其余 Esc 在编辑器快捷键之前关闭窗口，正常保存并释放锁。
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing && !document.querySelector('.pick')) {
      event.preventDefault();
      event.stopPropagation();
      currentWindow.close();
    }
  }, true);
}
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
  // 退出时关栏不改页签记录，下次启动照样恢复。
  if (!SOLO) Tabs.freeze();
  // 只在本窗口确实开着档案时关闭，避免流程图窗口关闭时把其他窗口的当前 Feat 广播清空
  if (FeatPane.curPath()) await FeatPane.close();
  await releaseNow();
  await currentWindow.destroy();
});

// 所有外部脚本加载完再初始化，先恢复侧栏偏好，再读取项目列表。
window.addEventListener('DOMContentLoaded', async () => {
  Split.init();
  Settings.init();
  try { await Sidebar.init(() => refresh(false)); }
  catch (error) { sideMsg('读取侧栏设置失败：' + error); return; }
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
      else routeFeat(path, node, Number(PARAMS.get('line')) || 0);
    });
  } else {
    // 上次流程图在独立窗口打开：本次仍弹出，主窗口提示原因。
    if (popped.flow) $('empty').textContent = '流程图在独立窗口中打开（独立窗口里点「回到主窗口」可改回）';
    // 汇总到手后再恢复页签：页签名称取自汇总。
    refresh(false).then(() => Tabs.init(tabApi));
  }
}, { once: true });
