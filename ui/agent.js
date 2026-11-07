// Agent 窗口（二）：页签、会话头、内嵌终端（xterm.js 显示真实的 claude TUI）、总览、主窗口联动、事件与启动。
// - 终端输出走 agent-output；打开页签先取 agent_buffer 回放，之后只写序号更大的输出；进程重启时 agent-reset 清屏；
// - 主窗口联动：收 agent-main-select（画布选中节点、打开 Feat）按“跟随主窗口”切会话；
//   会话里的 Feat / 节点标签发 agent-locate，由画布层（flow_agents.js）让主窗口打开并选中。
// 依赖 agent_core.js 中的状态与渲染函数。
'use strict';

const terms = new Map();  // 会话 id → { term, fit, el, seq, pending, gen, cols, rows }
AgentMetrics.init(() => { if (active !== 'OV') fitTerm(active, true); });

// ---------------- 页签 ----------------
function attnItems() {
  const items = [], ss = list();
  ss.filter((s) => vs(s) === 'wait').forEach((s) => items.push(`<button class="ai-btn v-wait" data-open="${s.id}">${bot()}${esc(s.title)} 等你确认 <span data-tk="${s.id}">${timeText(s)}</span></button>`));
  ss.filter((s) => vs(s) === 'apierr').forEach((s) => items.push(`<button class="ai-btn v-apierr" data-open="${s.id}" title="${esc(s.api_error || '')}">${bot()}${esc(s.title)} API 错误</button>`));
  ss.filter((s) => vs(s) === 'err').forEach((s) => items.push(`<button class="ai-btn v-err" data-open="${s.id}">${bot()}${esc(s.title)} 异常退出，点击重试</button>`));
  ss.filter((s) => vs(s) === 'stall').forEach((s) => items.push(`<button class="ai-btn v-stall" data-open="${s.id}">${bot()}${esc(s.title)} 已 <span data-tk="${s.id}">${timeText(s)}</span> 没有新活动</button>`));
  conflicts().forEach((c) => items.push(`<button class="ai-btn cf" data-open="${c.ss[0].id}">${c.ss.map((s) => esc(s.title)).join(' 和 ')} 都改了 ${esc(base(c.path))}</button>`));
  return items;
}
/** 仅保留正在运行或由用户发起启动的会话；待命、停止及归档会话不恢复为页签。 */
function renderTabs() {
  openTabs = openTabs.filter((id) => S.has(id) && !S.get(id).archived_at && !S.get(id).stored_at && (S.get(id).running || startingSessions.has(id)));
  if (active !== 'OV' && !openTabs.includes(active)) active = 'OV';
  const n = attnItems().length, tabs = $('#tabs');
  const scroll = tabs.querySelector('.session-tabs')?.scrollLeft || 0;
  tabs.innerHTML = `<button class="tab${active === 'OV' ? ' on' : ''}" data-tab="OV" role="tab" aria-selected="${active === 'OV'}">${ICON.graph}<span class="tl">总览</span>${n ? `<b class="cnt" title="${n} 项需要你处理">${n}</b>` : ''}</button><div class="session-tabs" role="presentation">`
    + openTabs.map((id) => {
      const s = S.get(id), wr = (s.workers || []).filter((w) => w.running).length;
      return `<button class="tab v-${vs(s)}${active === id ? ' on' : ''}" data-tab="${id}" role="tab" aria-selected="${active === id}" title="${esc(s.title + '：' + stText(s) + (s.api_error ? '\n' + s.api_error : ''))}">${bot()}<span class="tl">${esc(s.title)}</span>${wr ? `<span class="wc" title="${wr} 个 worker 运行中">+${wr}</span>` : ''}<span class="x" data-close="${id}" title="关闭页签（会话保留）">${ICON.x}</span></button>`;
    }).join('') + `<button class="tab-add" data-act="new" title="新建会话">${ICON.plus}</button></div>`;
  tabs.querySelector('.session-tabs').scrollLeft = scroll;
  tabs.scrollLeft = 0;
  saveTabs();
}
function activate(id) {
  active = id;
  renderTabs();
  renderPane();
  renderRows();
  markSeen();
}
/** 当前页签的会话「运行完成」且窗口在前台时记为已查看，主窗口机器人的绿色随之变白。 */
function markSeen() {
  const s = S.get(active);
  if (s && s.done > s.seen && document.hasFocus()) invoke('agent_seen', { id: s.id }).catch(() => {});
}
window.addEventListener('focus', markSeen);
async function sessionAction(id, action) {
  try {
    const value = action === 'store' || action === 'enable'
      ? await invoke('agent_store', { id, stored: action === 'store' })
      : await invoke('agent_archive', { id, archived: action === 'archive' });
    upsert(value); refreshAll();
    toast(`${value.title}：${{ store: '已收纳', enable: '已启用', archive: '已归档', restore: '已取消归档' }[action]}`);
  } catch (error) { toast(String(error)); }
}
function openSession(id) {
  if (!S.has(id)) return;
  if (S.get(id).archived_at) { toast('会话已归档', '取消归档', () => sessionAction(id, 'restore')); return; }
  if (S.get(id).stored_at) { toast('会话已收纳，启用后可继续对话', '启用', () => sessionAction(id, 'enable')); return; }
  startSession(id);
  if (!openTabs.includes(id)) openTabs.push(id);
  activate(id);
  const t = $(`.tab[data-tab="${id}"]`);
  if (t) { t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); t.classList.add('flash'); }
}
/** 主窗口机器人与左侧列表共用按需启动入口。 */
function openFocusedSession(id) { openSession(id); }
function closeTab(id) {
  const i = openTabs.indexOf(id);
  openTabs.splice(i, 1);
  const s = S.get(id);
  if (s?.running) toast(`「${s.title}」仍在后台运行，只关闭了页签`);
  if (active === id) activate(openTabs[i] || openTabs[i - 1] || 'OV'); else renderTabs();
}

// ---------------- 会话头与终端 ----------------
function renderPane() {
  const ov = active === 'OV';
  $('#ov').hidden = !ov;
  $('#sessionBody').hidden = ov;
  $('#terms').hidden = ov;
  if (ov) { $('#head').innerHTML = ''; $('#headLinks').innerHTML = ''; AgentMetrics.render(null); renderOverview(); return; }
  renderHead(S.get(active));
  showTerm(active);
}
/** 会话头放在右侧信息栏：顶部为名称（双击改名）与停止 / 收纳 / 归档图标，其下一节为 Feat、关联节点与同 APP 会话。 */
function renderHead(s) {
  AgentMetrics.render(s);
  if ($('#head .sh1 h2 input') || document.activeElement === $('#hdLink')) return;  // 正在改名或搜索关联时不重绘
  const f = s.feat && featEntry(s.feat), src = sourceOf(s);
  const peers = list().filter((x) => x !== s && x.app === s.app && x.running);
  const sel = mainSel?.node && !refsOf(s).some((r) => key(r.flow) === key(mainSel.path) && r.node === mainSel.node) ? mainSel : null;
  const act = (name, label, tip) => `<button class="am-act" data-act="${name}" aria-label="${label}" title="${label}：${tip}">${ICON[name]}</button>`;
  $('#head').innerHTML = `<div class="sh1"><h2 class="${src.locked ? 'name-locked' : ''}" title="${esc(s.title)}${src.locked ? '（名称跟随来源，不能单独修改）' : '（双击改名）'}">${esc(s.title)}</h2>
      <div class="am-acts">${s.running ? act('stop', '停止', '结束 Claude Code 进程，对话历史保留') : ''}${act('store', '收纳', '结束进程并收纳，保留会话供下次启用')}${act('archive', '归档', '结束进程并归档，按设置中的保留期限清理')}</div></div>
    <div class="am-sub">${sourceBadge(s)}<span class="sapp" title="${esc(s.cwd)}">${esc(s.app)}</span><span class="am-sid" title="${esc(s.id)}">${esc(s.id.slice(0, 8))}</span></div>`;
  const refRow = (r) => `<span class="ref${r.cur ? ' cur' : ''}" data-ref="${esc(r.flow)}" data-node="${esc(r.node)}" title="${esc(refLabel(r))}：${r.cur ? '当前位置（flowctl focus）' : '关联节点'}，点击在主窗口定位"><i class="ref-dot" aria-hidden="true"></i><span class="ref-t">${esc(refLabel(r))}</span>${r.cur ? '<span class="ref-tag">当前</span>' : `<span class="rx" data-unlink="${esc(r.flow)}" data-unnode="${esc(r.node)}" title="取消关联" role="button" aria-label="取消关联 ${esc(refLabel(r))}">${ICON.x}</span>`}</span>`;
  $('#headLinks').innerHTML = `<dl class="am-props">
      <dt>Feat</dt><dd class="am-feat">${s.feat ? `<button class="lnk" data-feat="${s.id}" title="在主窗口打开 ${esc(f?.title || s.feat)}">${esc(s.feat_code || base(s.feat))}</button>${f ? `<span class="stage feat-state ${window.FeatState(f.status).tone}" title="${esc(f.status)}">${esc(f.status)}</span>` : ''}` : '<span class="am-none">未关联</span>'}</dd>
      <dt>节点</dt><dd class="sh2">${refsOf(s).map(refRow).join('') || (sel ? '' : '<span class="am-none">未关联</span>')}${sel ? `<button class="ref ref-add" data-linksel="1" title="把主窗口选中的节点关联到这个会话">${ICON.plus}<span class="ref-t">${esc(flowName(sel.path))}#${esc(sel.node)}</span></button>` : ''}<input id="hdLink" class="search" placeholder="搜索流程图或 Feat" autocomplete="off" hidden><div class="drop" id="hdDrop" hidden></div></dd>
      ${peers.length ? `<dt>同 APP</dt><dd class="sh2">${peers.map((p) => `<button class="ref peer v-${vs(p)}" data-open="${p.id}" title="${esc(p.title)}：${esc(stText(p))}，可用 flowctl send 互发消息">${bot()}<span class="ref-t">${esc(p.title)}</span></button>`).join('')}</dd>` : ''}
    </dl>`;
}
function termTheme() { return window.TerminalThemes.resolve(); }
/** 仅更新调色板，不重建终端或回放输出，保留选择、滚动位置与输入。 */
function applyTerminalTheme() {
  const theme = termTheme();
  $('#pane').style.setProperty('--t-bg', theme.background);
  for (const x of terms.values()) x.term.options.theme = theme;
}
/** 剪贴板文件以 Claude Code 的 @ 引用插入；路径转为正斜杠，含空格的路径加引号。 */
function clipboardFileRefs(paths) {
  return paths.map((path) => {
    const p = path.replace(/\\/g, '/');
    return '@' + (/\s/.test(p) ? JSON.stringify(p) : p);
  }).join(' ') + ' ';
}
/** 捕获 xterm 的粘贴事件：图像交给 CLI 原生 Alt+V，文件插入引用，文本保留括号粘贴。 */
function bindTerminalPaste(id, term, el) {
  let queue = Promise.resolve();
  el.addEventListener('paste', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!S.get(id)?.running) { toast('会话未运行，无法粘贴'); return; }
    // ClipboardEvent 的数据只在事件中可读；异步 IPC 前保存文本和浏览器识别的图像类型。
    const text = event.clipboardData.getData('text/plain');
    const hasImage = Array.from(event.clipboardData.items).some((item) => item.type.startsWith('image/'));
    const clipboard = invoke('agent_clipboard');
    // 提前挂错误处理，避免前一次粘贴未完成时后一次 IPC 拒绝成为未处理异常。
    clipboard.catch(() => {});
    queue = queue.then(async () => {
      const content = await clipboard;
      if (!S.get(id)?.running) throw new Error('会话已停止');
      if (content.kind === 'files') term.paste(clipboardFileRefs(content.paths));
      else if (content.kind === 'image' || hasImage) await invoke('agent_write', { id, data: '\x1bv' });
      else if (text) term.paste(text);
    }).catch((error) => toast('粘贴失败：' + String(error)));
  }, true);
}
/** 创建会话终端：回放保留的输出，键盘输入写回 PTY；未运行时按 Enter 启动 / 续接。 */
function ensureTerm(id, host = $('#terms')) {
  let t = terms.get(id);
  if (t) return t;
  // 先显示再 open：xterm 打开时测量字符尺寸，隐藏的容器量出来是 0，之后无法正确排版
  const el = document.createElement('div');
  el.className = 'term';
  for (const x of terms.values()) if (x.el.parentNode === host) x.el.hidden = true;
  host.hidden = false;
  host.appendChild(el);
  const theme = termTheme();
  $('#pane').style.setProperty('--t-bg', theme.background);
  const term = new Terminal({
    fontFamily: window.TerminalThemes.FONT, fontSize: 13, lineHeight: 1.15,
    cursorBlink: true, allowProposedApi: true, scrollback: 8000, minimumContrastRatio: 4.5, theme,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(el);
  term.loadAddon(new AgentImeAddon());
  t = { term, fit, el, seq: -1, pending: [], gen: 0, cols: 0, rows: 0 };
  terms.set(id, t);
  term.onData((d) => {
    const s = S.get(id);
    if (s?.running) invoke('agent_write', { id, data: d }).catch(() => {});
    else if (d === '\r') startSession(id);
  });
  bindTerminalPaste(id, term, el);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'v') return false;  // 交给浏览器粘贴事件，xterm 按粘贴处理
    if (e.shiftKey && e.key === 'Enter') {                        // Shift+Enter 换行（Claude Code 认 Esc+Enter）
      if (S.get(id)?.running) invoke('agent_write', { id, data: '\x1b\r' }).catch(() => {});
      return false;
    }
    return true;
  });
  loadBuffer(id, t);
  return t;
}
/** 回放后端保留的输出；取回之前到达的输出先暂存，取回后只补写序号更大的部分。 */
function loadBuffer(id, t) {
  const gen = ++t.gen;
  t.seq = -1;
  t.pending = [];
  invoke('agent_buffer', { id }).then((b) => {
    if (gen !== t.gen) return;
    t.term.write(b.data);
    t.seq = b.seq;
    for (const [data, seq] of t.pending) if (seq > t.seq) { t.term.write(data); t.seq = seq; }
    t.pending = [];
  }).catch(() => { t.seq = 0; });
}
/** 仅连接中或失败时显示提示；待命会话没有手动续接步骤。 */
function updateMask(id) {
  if (active !== id) return;
  const s = S.get(id), connecting = startingSessions.has(id);
  const error = startErrors.get(id) || (vs(s) === 'err' ? `CLI 异常退出（代码 ${s.exit_code ?? '?'}）` : '');
  let mask = $('#terms .offmask');
  if (s.running || (!connecting && !error)) { mask?.remove(); return; }
  if (!mask) { mask = document.createElement('div'); $('#terms').appendChild(mask); }
  mask.className = 'offmask' + (error && !connecting ? ' err' : '');
  mask.setAttribute('role', 'status');
  mask.innerHTML = connecting ? '<span>正在连接 CLI…</span>'
    : `<span>${esc(error)}</span><button class="btn primary" data-act="start">重试</button>`;
}
/**
 * 把会话唯一的终端实例挂到指定容器（会话页签或总览下方操作区），不新建 xterm、不重放输出。
 * 移动前后保留视口行号，挂载后按新尺寸重排；同一容器内只显示这一个终端。
 */
function mountTerm(id, host) {
  const t = ensureTerm(id, host);
  if (t.el.parentNode !== host) {
    const y = t.term.buffer.active.viewportY, bottom = y >= t.term.buffer.active.baseY;
    host.appendChild(t.el);
    t.restore = bottom ? -1 : y;
  }
  for (const [k, x] of terms) if (x.el.parentNode === host) x.el.hidden = k !== id;
  return t;
}
/** 重排后恢复移动前的滚动位置：原本在底部的继续跟随最新输出。 */
function restoreScroll(t) {
  if (t.restore == null) return;
  if (t.restore < 0) t.term.scrollToBottom(); else t.term.scrollToLine(t.restore);
  t.restore = null;
}
function showTerm(id) {
  const t = mountTerm(id, $('#terms'));
  updateMask(id);
  fitTerm(id);
  t.term.focus();
  requestAnimationFrame(() => fitTerm(id));
}
/** 按容器尺寸重排终端，行列变化时同步 PTY 尺寸。 */
function fitTerm(id, force) {
  const t = terms.get(id), s = S.get(id);
  if (!t || t.el.hidden || !t.el.clientWidth) return;
  try { t.fit.fit(); } catch (e) { return; }
  restoreScroll(t);
  const { cols, rows } = t.term;
  if (s?.running && (force || cols !== t.cols || rows !== t.rows)) {
    t.cols = cols;
    t.rows = rows;
    invoke('agent_resize', { id, cols, rows }).catch(() => {});
  }
}
// 同一会话启动请求未完成时不重复发送，避免连续点击机器人或续接按钮重复启动。
const startingSessions = new Set();
const startErrors = new Map();
/** 打开会话即按需启动；并发点击合并，失败留在当前会话重试。 */
async function startSession(id) {
  if (!S.has(id) || S.get(id).running || startingSessions.has(id)) return;
  startingSessions.add(id);
  startErrors.delete(id);
  updateMask(id);
  try { await invoke('agent_start', { id }); }
  catch (e) {
    const error = '连接失败：' + String(e);
    startErrors.set(id, error);
    toast(error);
  }
  finally { startingSessions.delete(id); updateMask(id); refreshAll(); }
}

// ---------------- 总览：需要处理的事项与实时关系图 ----------------
/** 总览关系图复用当前会话和 APP 数据，几何与交互由独立模块维护。 */
function renderOverview() { AgentOverview.render(); }
AgentOverview.init();
listen('flow-changed', () => AgentOverview.invalidate());
listen('md-changed', async () => { await loadApps(); AgentOverview.invalidate(); refreshAll(); });
listen('catalog-changed', async () => { await loadApps(); AgentOverview.invalidate(); refreshAll(); });

// ---------------- 主窗口联动 ----------------
/** 自动跟随只切到已运行的会话；待命记录不启动，同一会话不重复抢回终端焦点。 */
function followSession(id) {
  if (S.get(id).running && active !== id) openSession(id);
}

/** 页面按唯一来源匹配；节点沿用直接关联、近期处理与 Feat 的优先级，跟随关闭时保留当前会话。 */
async function onMainSelect(p) {
  if (!apps.length) await loadApps();
  let label, go;
  const a = appOfPath(p.path);
  if (p.page === 'feat' || p.feat) {
    const fe = p.page === 'feat' ? featEntry(p.path) : a?.feats.find((f) => f.id === p.feat);
    const featPath = p.page === 'feat' ? p.path : fe?.path || '';
    mainSel = { path: p.path, featPath };
    label = fe ? `${fe.id} ${fe.title}` : p.feat || base(p.path);
    const cand = featPath ? list().filter((s) => key(s.feat) === key(featPath)).sort(byUrgency) : [];
    go = () => (cand.length ? followSession(cand[0].id)
      : !p.page && fe && toast(`${label} 还没有会话`, '新建', () => createFromSource({ root: a.root, feat: { id: fe.id, title: fe.title, path: fe.path } })));
  } else if (p.page === 'flow') {
    mainSel = { path: p.path, node: '' };
    label = flowName(p.path);
    const cand = list().filter((s) => { const src = sourceOf(s); return src.kind === 'flow' && key(src.path) === key(p.path); }).sort(byUrgency);
    go = () => { if (cand.length) followSession(cand[0].id); };
  } else {
    mainSel = { path: p.path, node: p.node };
    label = `${flowName(p.path)}#${p.node}`;
    const direct = list().filter((s) => refsOf(s).some((r) => key(r.flow) === key(p.path) && r.node === p.node)).sort(byUrgency);
    const lo = now() - WINDOW;
    const hot = list().map((s) => ({ s, t: Math.max(0, ...s.acts.filter((x) => x.node === p.node && key(x.flow) === key(p.path)).map((x) => x.t)) }))
      .filter((x) => x.t > lo).sort((x, y) => y.t - x.t)[0];
    const tags = p.tags || [];
    const byFeat = list().filter((s) => s.feat_code && tags.includes(s.feat_code) && a && key(s.feat).startsWith(key(a.root))).sort(byUrgency);
    go = () => {
      if (direct.length) return followSession(direct[0].id);
      if (hot) {
        if (hot.s.running) toast(`${label} 没有直接关联的会话，切到刚处理过它的「${hot.s.title}」`);
        return followSession(hot.s.id);
      }
      if (byFeat.length) return followSession(byFeat[0].id);
      const fe = a?.feats.find((f) => tags.includes(f.id));
      toast(`${label} 还没有会话`, '新建', () => createFromSource({ root: a?.root, links: [{ flow: p.path, node: p.node }], feat: fe ? { id: fe.id, title: fe.title, path: fe.path } : null }));
    };
  }
  if (follow) go();
  else {
    $$('.row.is-main').forEach((el) => { el.classList.remove('ping'); void el.offsetWidth; el.classList.add('ping'); });
    toast(`主窗口切到「${label}」，当前已锁定，没有跟着切换`);
  }
  renderRows();
  if (active === 'OV') renderOverview();
  else renderHead(S.get(active));
}
function locate(flow, node) {
  emit('agent-locate', { path: flow, node });
  toast(`已在主窗口定位 ${flowName(flow)}${node ? '#' + node : ''}`);
}
function openFeatInMain(s) {
  emit('agent-locate', { feat: s.feat });
  toast(`已在主窗口打开 ${s.feat_code || base(s.feat)}`);
}
async function patchSession(id, patch) {
  try { upsert(await invoke('agent_update', { id, patch })); refreshAll(); return true; } catch (e) { if (!dupToast(e)) toast(String(e)); return false; }
}

// ---------------- 数据同步 ----------------
function upsert(v) {
  const old = S.get(v.id);
  v.acts = v.acts || old?.acts || [];
  if (old && old.status !== 'wait' && v.status === 'wait' && v.running && active !== v.id) toast(`「${v.title}」等你确认`, '打开', () => openSession(v.id));
  S.set(v.id, v);
}
let refreshQueued = false;
/** 合并同一帧内的多次刷新。 */
function refreshAll() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    const previous = active;
    renderMix(); renderToday(); renderLanes(); renderTabs(); renderRows();    if (active !== previous) renderPane();
    else if (active === 'OV') renderOverview();
    else if (S.has(active)) { renderHead(S.get(active)); updateMask(active); }
  });
}
listen('agent-update', (e) => {
  const was = S.get(e.payload.id);
  upsert(e.payload);
  if ((e.payload.archived_at || e.payload.stored_at) && active === e.payload.id) activate('OV');
  if (was && !was.running && e.payload.running) requestAnimationFrame(() => fitTerm(e.payload.id, true));
  if (e.payload.id === active) markSeen();
  refreshAll();
});
listen('agent-act', (e) => {
  const s = S.get(e.payload.id), a = e.payload.act;
  if (!s) return;
  s.acts.push(a);
  if (s.acts.length > 300) s.acts.shift();
  addTick(s, a);
   if (a.kind === 'edit' || a.kind === 'msg' || a.kind === 'worker') refreshAll();
  AgentOverview.activity(s, a);
});
listen('agent-removed', (e) => {
  S.delete(e.payload.id);
  if (active === e.payload.id) activate('OV');
  startErrors.delete(e.payload.id);
  const t = terms.get(e.payload.id);
  if (t) { t.term.dispose(); t.el.remove(); terms.delete(e.payload.id); }
  refreshAll();
});
listen('agent-output', (e) => {
  const { id, data, seq } = e.payload, t = terms.get(id);
  if (!t) return;
  if (t.seq < 0) { t.pending.push([data, seq]); return; }
  if (seq <= t.seq) return;
  t.term.write(data);
  t.seq = seq;
});
listen('agent-reset', (e) => {
  const t = terms.get(e.payload.id);
  if (!t) return;
  t.gen++;
  t.term.reset();
  t.seq = e.payload.seq;
  t.pending = [];
  t.cols = 0;
  requestAnimationFrame(() => fitTerm(e.payload.id, true));
});
listen('agent-focus', (e) => openFocusedSession(e.payload.id));
// 主窗口机器人：Feat / 流程图还没有会话时，直接创建同名主 Agent。
listen('agent-prefill', (e) => createFromSource(e.payload));
listen('agent-main-select', (e) => onMainSelect(e.payload));
window.addEventListener('storage', (e) => {
  if (e.key === null || e.key === FOLLOW_KEY) follow = localStorage.getItem(FOLLOW_KEY) !== '0';
  if (e.key === null || e.key === 'fc-agent-summary') document.documentElement.dataset.agentSummary = String(localStorage.getItem('fc-agent-summary') === '1');
  if (e.key !== null && e.key !== 'fc-theme' && e.key !== window.TerminalThemes.KEY) return;
  if (e.key === null || e.key === 'fc-theme') {
    const t = localStorage.getItem('fc-theme') || 'auto';
    document.documentElement.dataset.theme = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  applyTerminalTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if ((localStorage.getItem('fc-theme') || 'auto') !== 'auto') return;
  document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
  applyTerminalTheme();
});

// ---------------- 事件：左栏 ----------------
$('#lanes').addEventListener('click', (e) => { const l = e.target.closest('.lane'); if (l) openSession(l.dataset.o.split('/')[0]); });
$('#lanes').addEventListener('mousemove', (e) => {
  const tr = e.target.closest('.track');
  if (!tr) return hideTip();
  const L = laneEls.find((x) => x.el === tr.parentElement);
  if (!L) return hideTip();
  const r = tr.getBoundingClientRect(), n = now(), tAt = n - (r.right - e.clientX) * laneGeom.mpp;
  let best = null, bd = Infinity;
  for (const a of L.o.s.acts) {
    if (a.t < n - LANE_WINDOW || a.t > n || (L.o.w ? a.worker !== L.o.w.id : a.worker)) continue;
    const d = Math.abs(a.t - tAt);
    if (d < bd) { bd = d; best = a; }
  }
  if (best && bd < 7 * laneGeom.mpp) return showTip(e, `${hms(best.t)}　${KIND[best.kind] || best.kind}　${esc(best.text)}${best.node ? `　<span class="muted">${esc(flowName(best.flow))}#${esc(best.node)}</span>` : ''}`);
  const s = L.o.s, v = vs(s);
  if (!L.o.w && v === 'wait' && tAt >= s.since) return showTip(e, `等你确认，已等 ${clock(now() - s.since)}`);
  if (!L.o.w && v === 'stall' && tAt >= s.beat) return showTip(e, `${clock(now() - s.beat)} 没有新的工具调用`);
  hideTip();
});
$('#lanes').addEventListener('mouseleave', hideTip);
$('#mix').addEventListener('click', (e) => { const u = e.target.closest('[data-open]'); if (u) openSession(u.dataset.open); });

const rowsEl = $('#rows');
rowsEl.addEventListener('click', async (e) => {
  const group = e.target.closest('[data-session-group]');
  if (group) {
    const name = group.dataset.sessionGroup;
    if (expandedGroups.has(name)) expandedGroups.delete(name); else expandedGroups.add(name);
    renderRows(); return;
  }
  const action = e.target.closest('[data-session-action]');
  if (action) { await sessionAction(action.dataset.id, action.dataset.sessionAction); return; }
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    const s = S.get(pin.dataset.pin), was = s.pinned;
    if (await patchSession(s.id, { pinned: !was })) toast(was ? `已取消置顶「${s.title}」` : `已置顶「${s.title}」`);
    return;
  }
  const fe = e.target.closest('[data-feat]');
  if (fe) { openFeatInMain(S.get(fe.dataset.feat)); return; }
  const rf = e.target.closest('[data-ref]');
  if (rf) { locate(rf.dataset.ref, rf.dataset.node); return; }
  const row = e.target.closest('.row');
  if (row) openSession(row.dataset.s);
});
rowsEl.addEventListener('keydown', (e) => {
  const row = e.target.closest('.row');
  if (!row || e.target !== row) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const all = $$('.row', rowsEl), i = all.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1);
    (all[i] || (i < 0 ? $('#q') : row)).focus();
  }
});
$('#q').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderRows(); });
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); $('.row', rowsEl)?.focus(); }
  if (e.key === 'Enter') $('.row', rowsEl)?.click();
  if (e.key === 'Escape') { e.target.value = ''; query = ''; renderRows(); }
});
$('#newBtn').addEventListener('click', () => ($('#newwrap').classList.contains('open') ? closeNewBox() : openNewBox()));
$('#newbox').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { if (rm.dataset.rm === 'feat') nb.feat = null; else nb.links.splice(+rm.dataset.rm, 1); renderNbChips(); return; }
  const c = e.target.closest('[data-cand]');
  if (c) { pickNb(nb.cand[+c.dataset.cand]); return; }
  const b = e.target.closest('[data-nb]');
  if (b) { if (b.dataset.nb === 'ok') createSession(); else closeNewBox(); }
});
const nbDrop = () => renderDrop($('#nbDrop'), $('#nbLink'), $('#nbLinks'), linkCandidates($('#nbLink').value, $('#nbApp').value));
$('#nbLink').addEventListener('input', nbDrop);
$('#nbLink').addEventListener('focus', nbDrop);
$('#nbLink').addEventListener('blur', () => setTimeout(() => { $('#nbDrop').hidden = true; }, 150));
$('#nbLink').addEventListener('keydown', (e) => {
  const d = $('#nbDrop');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    nb.sel = (nb.sel + (e.key === 'ArrowDown' ? 1 : nb.cand.length - 1)) % Math.max(1, nb.cand.length);
    $$('button', d).forEach((x, i) => x.classList.toggle('on', i === nb.sel));
  }
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!d.hidden && nb.cand[nb.sel]) pickNb(nb.cand[nb.sel]); else createSession(); }
  if (e.key === 'Backspace' && !e.target.value) { if (nb.links.length) nb.links.pop(); else nb.feat = null; renderNbChips(); }
});
$('#newbox').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNewBox();
  if (e.key === 'Enter' && !e.isComposing && e.target.id === 'nbName') { e.preventDefault(); createSession(); }
});

// ---------------- 事件：右栏 ----------------
$('#tabs').addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) { e.stopPropagation(); closeTab(c.dataset.close); return; }
  if (e.target.closest('[data-act="new"]')) { openNewBox(); return; }
  const t = e.target.closest('[data-tab]');
  if (t) {
    if (t.dataset.tab === 'OV') activate('OV');
    else openSession(t.dataset.tab);
  }
});
$('#tabs').addEventListener('auxclick', (e) => { const t = e.target.closest('[data-tab]'); if (e.button === 1 && t && t.dataset.tab !== 'OV') closeTab(t.dataset.tab); });

/** 会话头的“＋ 关联”：展开搜索框，选 Feat 时连同它挂了标签的节点一起关联。 */
async function openLinkSearch(s) {
  if (!apps.length) await loadApps();
  const inp = $('#hdLink'), drop = $('#hdDrop');
  const root = apps.find((a) => key(s.cwd).startsWith(key(a.root)))?.root || '';
  inp.hidden = false;
  inp.value = '';
  inp.focus();
  const upd = () => renderDrop(drop, inp, inp, linkCandidates(inp.value, root));
  inp.oninput = upd;
  inp.onblur = () => setTimeout(() => { drop.hidden = true; inp.hidden = true; renderHead(S.get(s.id)); }, 180);
  inp.onkeydown = (ev) => {
    if (ev.key === 'Escape') inp.blur();
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      nb.sel = (nb.sel + (ev.key === 'ArrowDown' ? 1 : nb.cand.length - 1)) % Math.max(1, nb.cand.length);
      $$('button', drop).forEach((x, i) => x.classList.toggle('on', i === nb.sel));
    }
    if (ev.key === 'Enter' && !ev.isComposing && nb.cand[nb.sel]) linkPicked(s, nb.cand[nb.sel]);
  };
  upd();
}
async function linkPicked(s, x) {
  $('#hdLink').blur();
  if (x.t === 'feat') {
    const links = [...(s.links || [])];
    for (const l of await featLinks(x.f.path, x.f.id)) if (!links.some((y) => key(y.flow) === key(l.flow) && y.node === l.node)) links.push(l);
    if (await patchSession(s.id, { feat: x.f.path, feat_code: x.f.id, links })) toast(`已关联 ${x.f.id}，下次打开时写进系统提示`);
  } else if (!(s.links || []).some((l) => key(l.flow) === key(x.flow) && !l.node)) {
    patchSession(s.id, { links: [...(s.links || []), { flow: x.flow, node: '' }] });
  }
}
$('#pane').addEventListener('mousedown', (e) => { if (e.target.closest('#hdDrop [data-cand]')) e.preventDefault(); });
$('#pane').addEventListener('click', async (e) => {
  const t = e.target, s = active !== 'OV' && S.get(active);
  const ux = t.closest('[data-unlink]');
  if (ux && s) {
    e.stopPropagation();
    patchSession(s.id, { links: (s.links || []).filter((l) => !(key(l.flow) === key(ux.dataset.unlink) && l.node === ux.dataset.unnode)) });
    return;
  }
  const cand = t.closest('#hdDrop [data-cand]');
  if (cand && s) { linkPicked(s, nb.cand[+cand.dataset.cand]); return; }
  const open = t.closest('[data-open]');
  if (open) { openSession(open.dataset.open); return; }
  const ref = t.closest('[data-ref]');
  if (ref) { locate(ref.dataset.ref, ref.dataset.node); return; }
  const fe = t.closest('[data-feat]');
  if (fe) { openFeatInMain(S.get(fe.dataset.feat)); return; }
  if (t.closest('[data-linksel]') && s && mainSel?.node) { patchSession(s.id, { links: [...(s.links || []), { flow: mainSel.path, node: mainSel.node }] }); return; }
  if (t.closest('[data-addlink]') && s) { e.preventDefault(); $('#headLinks').closest('details').open = true; openLinkSearch(s); return; }
  const act = t.closest('[data-act]');
  if (act && s) {
    if (act.dataset.act === 'start') startSession(s.id);
    if (act.dataset.act === 'stop') invoke('agent_stop', { id: s.id }).catch((err) => toast(String(err)));
    if (act.dataset.act === 'archive' || act.dataset.act === 'store') sessionAction(s.id, act.dataset.act);
  }
});
$('#pane').addEventListener('dblclick', (e) => {
  const h = e.target.closest('.sh1 h2'), s = active !== 'OV' && S.get(active);
  if (!h || !s || sourceOf(s).locked || h.querySelector('input')) return;
  h.innerHTML = `<input value="${esc(s.title)}" aria-label="会话名">`;
  const inp = h.querySelector('input');
  inp.select();
  let finished = false;
  const done = async (ok) => {
    if (finished) return;
    finished = true;
    const v = inp.value.trim();
    inp.remove();
    if (ok && v && v !== s.title) await patchSession(s.id, { title: v });
    renderHead(S.get(s.id));
  };
  inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) done(true); if (ev.key === 'Escape') done(false); });
  inp.addEventListener('blur', () => done(true));
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
});
const paneResizeObserver = new ResizeObserver(() => {
  const tr = $('#lanes .track');
  if (tr && tr.clientWidth !== laneGeom.w) renderLanes();
  if (active !== 'OV') fitTerm(active);
});
paneResizeObserver.observe(document.body);
paneResizeObserver.observe($('.left'));
paneResizeObserver.observe($('#terms'));

// ---------------- 启动 ----------------
(async () => {
  // APP 汇总独立加载：先显示会话并连接 CLI，避免所有项目的档案扫描挡住首屏；汇总到齐后补全关联信息。
  const appsReady = loadApps();
  $('#today').textContent = 'Agent 正在启动…（最多 30 秒）';
  try {
    const vs0 = await invoke('agent_list');
    vs0.forEach((v) => S.set(v.id, v));
  } catch (e) {
    $('#today').textContent = 'Agent 启动失败：' + e;
    return;
  }
  const params = new URLSearchParams(location.search), focus = params.get('focus'), prefill = params.get('new');
  renderMix(); renderToday(); renderLanes();  if (focus && S.has(focus)) openFocusedSession(focus);
  else { renderTabs(); renderPane(); renderRows(); }
  appsReady.then(() => {
    refreshAll();
    // 新建来源仍等汇总完成，确保 Feat 的关联节点完整；首屏和已有会话不等这一步。
    if (prefill) return createFromSource(JSON.parse(prefill));
  }).catch((e) => toast('打开来源会话失败：' + e));
  requestAnimationFrame(frame);
  let lastSig = '';
  setInterval(() => {
    if (active !== 'OV') AgentMetrics.render(S.get(active));
    $$('[data-tk]').forEach((el) => { const s = S.get(el.dataset.tk); if (s) el.textContent = timeText(s); });
    $$('[data-wk]').forEach((el) => {
      const [sid, wid] = el.dataset.wk.split('/'), w = S.get(sid)?.workers?.find((x) => x.id === wid);
      if (w) el.textContent = clock(now() - w.t0);
    });
    $$('[data-ago]').forEach((el) => { el.textContent = ago(now() - +el.dataset.ago); });
    // 运行 → 停滞是按时间推导的，签名变化时整体刷新
    const sig = list().map((s) => s.id + vs(s)).join();
    if (sig !== lastSig) { lastSig = sig; refreshAll(); }
  }, 1000);
})();
