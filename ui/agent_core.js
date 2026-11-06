// Agent 窗口（一）：状态、工具函数、左上动态活动、左下 CLI 会话列表、新建会话。
// 每个 Claude Code CLI 会话显示状态与本轮摘要两行，可关联 Feat 与流程图节点；数据来自后端 agent.rs：
// agent_list 初始化，agent-update / agent-act / agent-removed 增量（事件处理在 agent.js）。
// 与 agent.js 共用全局作用域（普通脚本，按 agent.html 中的顺序加载）。
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const now = () => Date.now();
const base = (p) => String(p || '').split(/[\\/]/).pop();
const key = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
const flowName = (p) => base(p).replace(/\.drawio$/i, '');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const WINDOW = 5 * 60000, LANE_WINDOW = 10 * 60000, STALL = 60000;
const TAB_KEY = 'fc-agent-tabs', FOLLOW_KEY = 'fc-agent-follow';

/** 分:秒（超过 1 小时为 时:分:秒）。 */
function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
/** 相对时间。 */
function ago(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return s < 172800 ? '昨天' : `${Math.floor(s / 86400)} 天前`;
}
const hms = (t) => new Date(t).toTimeString().slice(0, 8);
const BOT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle class="ant" cx="8" cy="1.3" r="1.05"/><rect x="2.4" y="3.7" width="11.2" height="9.2" rx="2.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle class="eye" cx="5.9" cy="8.2" r="1.15"/><circle class="eye" cx="10.1" cy="8.2" r="1.15"/><path d="M.9 7.4v2.6M15.1 7.4v2.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
const bot = () => `<span class="bot">${BOT}</span>`;
const ICON = {
  stop: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>',
  archive: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 5.5h11v8h-11zM1.5 2.5h13v3h-13zM6 8h4" stroke-linejoin="round"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 4h11M6 2h4l1 2M4 4l.7 10h6.6L12 4M6.5 6.5v5M9.5 6.5v5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  graph: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="3" cy="4" r="2"/><circle cx="3" cy="12" r="2"/><circle cx="13" cy="8" r="2"/><path d="M5 4.6 11 7.4M5 11.4 11 8.6"/></svg>',
  feat: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 7h4M6 10h4" stroke-linejoin="round"/></svg>',
  x: '<svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.4"><path d="M2 2l6 6M8 2 2 8"/></svg>',
  plus: '<svg width="13" height="13" viewBox="0 0 14 14" stroke="currentColor" stroke-width="1.5"><path d="M7 2v10M2 7h10"/></svg>',
  pin: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.8 1.2 14.8 6.2 13.7 7.3 12.6 6.9 9.9 9.6 10.4 12.9 9.3 14 6.1 10.8 2.3 14.6 1.4 13.7 5.2 9.9 2 6.7 3.1 5.6 6.4 6.1 9.1 3.4 8.7 2.3Z"/></svg>',
};
const KIND = { prompt: '提问', read: '读取', edit: '编辑', cmd: '命令', commit: '提交', worker: 'worker', tool: '工具', msg: '协作', note: '通知', compact: '压缩' };
const TICK = { prompt: 'prompt', read: 'read', edit: 'edit', cmd: 'cmd', commit: 'commit', msg: 'msg', worker: 'cmd', tool: 'cmd', note: 'cmd', compact: 'cmd' };
const ORDER = { wait: 0, err: 1, stall: 2, run: 3, tool: 3, boot: 3, idle: 4, off: 5 };

// ---------------- 状态 ----------------
const S = new Map();      // 会话 id → 视图（acts 为最近活动）
let apps = [];            // summary：APP、Feat、流程图
const savedTabs = JSON.parse(localStorage.getItem(TAB_KEY) || '{}');
let openTabs = Array.isArray(savedTabs.tabs) ? savedTabs.tabs : [];
let active = savedTabs.active || 'OV';
let query = '', mainSel = null;
let follow = localStorage.getItem(FOLLOW_KEY) !== '0';
const nb = { links: [], feat: null, sel: 0, cand: [] };
let enterId = '';

/** 显示状态：未运行为 off / err；运行中细分 tool（工具执行中，不算停滞）与 stall（60 秒没有 hook 活动）。 */
function vs(s) {
  if (!s.running) return s.status === 'err' ? 'err' : 'off';
  if (s.status === 'run') {
    if (s.tool) return 'tool';
    if (now() - s.beat > STALL) return 'stall';
  }
  return s.status;
}
const lastT = (s) => (s.acts.length ? s.acts[s.acts.length - 1].t : (s.since || s.created));
const byUrgency = (a, b) => ORDER[vs(a)] - ORDER[vs(b)] || lastT(b) - lastT(a);
/** 活跃会话供列表、总览和画布联动使用；归档记录仍保留在 S 中，等待恢复或删除事件。 */
const list = () => [...S.values()].filter((s) => !s.archived_at);
function stText(s) {
  return { wait: '等你确认', err: '异常退出', stall: '可能停滞', tool: '执行中', run: '运行中', boot: '启动中', idle: '空闲', off: '待命' }[vs(s)];
}
function timeText(s) {
  const n = now(), v = vs(s);
  if (v === 'run') return s.turn ? clock(n - s.turn) : '';
  if (v === 'tool') return `${s.tool} ${clock(n - s.tool_since)}`;
  if (v === 'stall') return clock(n - s.beat);
  if (v === 'wait') return clock(n - s.since);
  if (v === 'err' && s.exit_code != null) return `代码 ${s.exit_code}`;
  return ago(n - lastT(s));
}
/** 会话关联的节点（flowctl focus 标记的当前位置排第一，cur=true）。 */
function refsOf(s) {
  const out = [];
  if (s.focus) out.push({ ...s.focus, cur: true });
  for (const l of s.links || []) if (!out.some((x) => key(x.flow) === key(l.flow) && x.node === l.node)) out.push(l);
  return out;
}
const refLabel = (r) => flowName(r.flow) + (r.node ? '#' + r.node : '');
/** 名称由唯一来源决定；其余流程图只是协作关联。兼容尚未带来源字段的旧会话视图。 */
function sourceOf(s) {
  const kind = s.source_kind ?? (s.feat ? 'feat' : s.links?.length ? 'flow' : '');
  const path = s.source_path ?? (kind === 'feat' ? s.feat : kind === 'flow' ? s.links?.[0]?.flow : '');
  return { kind, path: path || '', locked: s.title_locked ?? !!kind, label: kind === 'feat' ? 'Feat 主' : kind === 'flow' ? '图主' : '独立' };
}
function sourceBadge(s) {
  const src = sourceOf(s);
  return `<span class="source-role" title="${src.locked ? '名称跟随来源，不能单独修改' : '独立会话，可双击标题改名'}">${src.label}</span>`;
}
/** Feat 档案的汇总条目（标题、状态、所在 APP）。 */
function featEntry(path) {
  for (const a of apps) for (const f of a.feats) if (key(f.path) === key(path)) return { ...f, app: a };
  return null;
}
/** 文件所在 APP（按 APP 根目录前缀，取最深的）。 */
function appOfPath(p) {
  const k = key(p);
  return apps.filter((a) => k.startsWith(key(a.root) + '\\')).sort((a, b) => b.root.length - a.root.length)[0] || null;
}
/** 近 30 分钟被两个以上会话编辑过的文件。 */
function conflicts() {
  const map = new Map(), lo = now() - 30 * 60000;
  for (const s of list()) for (const a of s.acts) {
    if (a.kind !== 'edit' || !a.path || a.t < lo) continue;
    const k = key(a.path);
    if (!map.has(k)) map.set(k, { path: a.path, ss: new Set() });
    map.get(k).ss.add(s.id);
  }
  return [...map.values()].filter((c) => c.ss.size > 1).map((c) => ({ path: c.path, ss: [...c.ss].map((id) => S.get(id)).filter(Boolean) }));
}
const recentCollab = (s) => [...s.acts].reverse().find((a) => a.kind === 'msg' && now() - a.t < 3 * 60000);
/** 会话是否就是主窗口当前选中的节点 / Feat 对应的会话。 */
function mainMatch(s) {
  if (!mainSel) return false;
  if (mainSel.featPath) return key(s.feat) === key(mainSel.featPath);
  if (mainSel.node) return refsOf(s).some((r) => key(r.flow) === key(mainSel.path) && r.node === mainSel.node);
  return false;
}
function saveTabs() { localStorage.setItem(TAB_KEY, JSON.stringify({ tabs: openTabs, active })); }

// ---------------- 左上：概况、泳道、最新动态 ----------------
function renderToday() {
  const ss = list(), files = new Set(), run = ss.filter((s) => s.running).length;
  let commits = 0, tools = 0;
  for (const s of ss) for (const a of s.acts) {
    if (a.kind === 'edit' && a.path) files.add(key(a.path));
    if (a.kind === 'commit') commits++;
    if (a.kind !== 'prompt' && a.kind !== 'msg') tools++;
  }
  const wr = ss.reduce((n, s) => n + (s.workers || []).filter((w) => w.running).length, 0);
  $('#today').textContent = `${run} 个会话运行中，本次改动 ${files.size} 个文件，提交 ${commits} 次，工具调用 ${tools} 次${wr ? `，${wr} 个 worker 在跑` : ''}`;
  $('#today').title = $('#today').textContent;
}
function renderMix() {
  const ss = list().filter((s) => s.running || vs(s) === 'err'), c = {};
  ss.forEach((s) => { const v = vs(s) === 'tool' || vs(s) === 'boot' ? 'run' : vs(s); c[v] = (c[v] || 0) + 1; });
  const name = { wait: '等你', err: '异常', stall: '停滞', run: '运行', idle: '空闲' };
  $('#mix').innerHTML = `<div class="units">${ss.sort(byUrgency).map((s) => `<i class="unit v-${vs(s)}" data-open="${s.id}" title="${esc(s.title)}：${stText(s)}"></i>`).join('')}</div>
    <div class="counts">${ss.length ? ['wait', 'err', 'stall', 'run', 'idle'].filter((k) => c[k]).map((k) => `<span class="c-${k}"><b>${c[k]}</b>${name[k]}</span>`).join('') : '<span>没有运行中的会话</span>'}</div>`;
}
let laneGeom = { w: 0, mpp: 1 }, laneEls = [];
const T0 = now();
const lx = (t) => (t - T0) / laneGeom.mpp;
const tickHtml = (a, pop) => `<i class="tk ${TICK[a.kind] || 'cmd'}${pop ? ' pop' : ''}" style="left:${lx(a.t).toFixed(1)}px"></i>`;
function laneSt(o) {
  if (o.w) return o.w.running ? clock(now() - o.w.t0) : '完成';
  const v = vs(o.s), tk = `<span data-tk="${o.s.id}">${esc(timeText(o.s))}</span>`;
  return { wait: `等你 ${tk}`, stall: `停滞 ${tk}`, tool: tk, run: tk, err: '异常退出', idle: '空闲', boot: '启动中', off: '已结束' }[v];
}
/** 泳道：运行中 / 异常 / 近 10 分钟有活动的会话各一条，worker 为缩进子泳道；刻度随时间向左平移。 */
function renderLanes() {
  const box = $('#lanes'), n = now(), rows = [];
  list().filter((s) => (s.running || vs(s) === 'err' || n - lastT(s) < LANE_WINDOW) && (s.acts.length || s.running)).sort(byUrgency).forEach((s) => {
    rows.push({ id: s.id, s });
    (s.workers || []).filter((w) => w.running || n - w.t1 < LANE_WINDOW).forEach((w) => rows.push({ id: s.id + '/' + w.id, s, w }));
  });
  box.innerHTML = rows.length ? rows.map((o) => `<div class="lane ${o.w ? 'sub ' + (o.w.running ? 'v-run' : 'done') : 'v-' + vs(o.s)}" data-o="${esc(o.id)}">
      <span class="lane-name" title="${esc(o.w ? o.w.desc : o.s.title)}">${o.w ? '↳ ' + esc(o.w.desc) : esc(o.s.title)}</span>
      <div class="track"><div class="layer"></div><i class="head"></i></div>
      <span class="lane-st">${laneSt(o)}</span></div>`).join('') : '<p class="none">近 10 分钟没有活动</p>';
  $('.axis').style.setProperty('--lane-gutter', `${box.offsetWidth - box.clientWidth}px`);
  const tr = box.querySelector('.track');
  laneGeom.w = tr ? tr.clientWidth : 0;
  laneGeom.mpp = LANE_WINDOW / Math.max(1, laneGeom.w);
  const lo = n - LANE_WINDOW - 4000;
  laneEls = rows.map((o) => {
    const el = box.querySelector(`.lane[data-o="${CSS.escape(o.id)}"]`), layer = el.querySelector('.layer');
    const acts = o.s.acts.filter((a) => a.t > lo && (o.w ? a.worker === o.w.id : !a.worker));
    const v = o.w ? '' : vs(o.s);
    const bt = v === 'wait' ? o.s.since : v === 'stall' ? o.s.beat : v === 'tool' ? o.s.tool_since : 0;
    layer.innerHTML = acts.map((a) => tickHtml(a)).join('') + (bt ? `<i class="band ${v}" style="left:${lx(bt).toFixed(1)}px"></i>` : '');
    return { o, el, layer, band: layer.querySelector('.band'), bt };
  });
  paintLanes();
}
function addTick(s, a) {
  const L = laneEls.find((l) => l.o.s === s && (a.worker ? l.o.w?.id === a.worker : !l.o.w));
  if (L) L.layer.insertAdjacentHTML('beforeend', tickHtml(a, true)); else renderLanes();
}
function paintLanes() {
  if (!laneGeom.w) return;
  const n = now(), tx = laneGeom.w - (n - T0) / laneGeom.mpp;
  for (const L of laneEls) {
    L.layer.style.transform = `translateX(${tx.toFixed(1)}px)`;
    if (L.band) L.band.style.width = Math.max(0, (n - L.bt) / laneGeom.mpp).toFixed(1) + 'px';
  }
}
function frame() { paintLanes(); requestAnimationFrame(frame); }
function renderTicker() {
  let best = null;
  for (const s of list()) { const a = s.acts[s.acts.length - 1]; if (a && (!best || a.t > best.a.t)) best = { s, a }; }
  $('#ticker').innerHTML = best ? `最新 <b>${esc(best.s.title)}</b> ${KIND[best.a.kind] || ''} ${esc(best.a.text)}<span class="ago" data-ago="${best.a.t}">${ago(now() - best.a.t)}</span>` : '<span class="muted">会话有新动作时显示在这里</span>';
}

// ---------------- 左下：CLI 会话列表 ----------------
function hlText(t, q) {
  t = String(t ?? '');
  if (!q) return esc(t);
  const i = t.toLowerCase().indexOf(q);
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
}
/** 搜索：名称、APP、Feat、节点、worker 命中即显示；否则按最近活动文本计命中数。 */
function matchInfo(s, q) {
  if (!q) return { ok: true };
  const f = s.feat && featEntry(s.feat);
  const meta = [s.title, s.app, s.feat_code, f?.title, ...refsOf(s).map(refLabel), ...(s.workers || []).map((w) => w.desc)].filter(Boolean).join(' ').toLowerCase();
  if (meta.includes(q)) return { ok: true };
  const hits = s.acts.filter((a) => (a.text + ' ' + a.path).toLowerCase().includes(q)).length;
  return { ok: hits > 0, hits };
}
/** 取本轮提问首句作摘要；完整提问保留在 tooltip，清空对话后不沿用上一轮。 */
function rowSummary(s) {
  const prompt = s.turn_prompt || (s.turn === 0 ? '' : [...s.acts].reverse().find((a) => a.kind === 'prompt' && !a.worker && (!s.turn || a.t >= s.turn))?.text) || '';
  const full = prompt.replace(/\s+/g, ' ').trim();
  const first = prompt.trim().split(/\r?\n/).find((line) => line.trim())?.trim() || '';
  const text = first.match(/^.*?[。！？!?](?=\s|$|[^\x00-\x7f])/)?.[0] || first;
  return { text: text || '暂无本轮对话摘要', full };
}
/** 最近一次活动或状态变化的时间；终端重绘与用量上报不计作内容更新。 */
function rowUpdated(s) {
  return Math.max(0, ...[s.created, s.since, s.beat, s.done, s.acts.at(-1)?.t].filter(Number.isFinite));
}
function rowHtml(s, q, hits) {
  const v = vs(s), src = sourceOf(s), refs = refsOf(s);
  const summary = rowSummary(s), updated = rowUpdated(s), date = new Date(updated);
  const workers = (s.workers || []).filter((w) => w.running);
  const co = recentCollab(s), cf = conflicts().find((c) => c.ss.includes(s));
  const details = [s.title, `${src.label} · ${stText(s)} ${timeText(s)}`.trim(), s.app, src.path,
    ...refs.map(refLabel), s.wait_text,
    workers.length ? `执行中的子代理：${workers.map((w) => w.desc).join('、')}` : '',
    co?.text, s.queued ? `${s.queued} 条协作消息排队中` : '',
    cf ? `与「${cf.ss.find((x) => x !== s).title}」同改 ${base(cf.path)}` : '',
    hits ? `最近活动中匹配 ${hits} 处` : '',
  ].filter(Boolean).join('\n');
  const source = src.kind === 'feat'
    ? `<button class="source-icon" data-feat="${s.id}" aria-label="打开 Feat：${esc(s.title)}" title="${esc(s.feat_code || 'Feat')}：${esc(src.path)}">${ICON.feat}</button>`
    : src.kind === 'flow'
      ? `<button class="source-icon" data-ref="${esc(src.path)}" data-node="" aria-label="打开流程图：${esc(s.title)}" title="流程图：${esc(src.path)}">${ICON.graph}</button>` : '';
  return `<li class="row v-${v}${src.locked ? ' is-bound' : ''}${mainMatch(s) ? ' is-main' : ''}${active === s.id ? ' is-open' : ''}${s.id === enterId ? ' enter' : ''}" data-s="${s.id}" data-app="${esc(s.app)}" tabindex="0" aria-current="${active === s.id}" aria-label="${esc(s.title + '，' + src.label + '，' + stText(s))}" title="${esc(details)}">
    ${bot()}<div class="row-main">${source}<span class="nm" title="${esc(s.title)}">${hlText(s.title, q)}</span>
      <button class="pin${s.pinned ? ' on' : ''}" data-pin="${s.id}" title="${s.pinned ? '取消置顶' : '置顶'}" aria-label="${s.pinned ? '取消置顶' : '置顶'} ${esc(s.title)}" aria-pressed="${s.pinned}">${ICON.pin}</button></div>
    <time class="row-time"${updated ? ` datetime="${date.toISOString()}"` : ''} title="${updated ? esc('更新于 ' + date.toLocaleString()) : '暂无更新时间'}">${updated ? hms(updated).slice(0, 5) : '--:--'}</time>
    <span class="row-status">${stText(s)}</span>
    <div class="row-summary${summary.full ? '' : ' empty'}" title="${esc(summary.full || summary.text)}">${hlText(summary.text, q)}</div>
  </li>`;
}
/** 列表：置顶区在上（按置顶先后），其余按紧急程度排序；排序变化用 FLIP 平滑移动。 */
function renderRows() {
  const el = $('#rows'), q = query;
  const items = list().map((s) => ({ s, m: matchInfo(s, q) })).filter((x) => x.m.ok);
  const pinned = items.filter((x) => x.s.pinned).sort((a, b) => a.s.pin_at - b.s.pin_at);
  const rest = items.filter((x) => !x.s.pinned).sort((a, b) => byUrgency(a.s, b.s));
  const before = new Map($$('.row', el).map((r) => [r.dataset.s, r.getBoundingClientRect().top]));
  el.innerHTML = items.length
    ? [...pinned, ...rest].map((x) => rowHtml(x.s, q, x.m.hits)).join('')
    : S.size ? `<li class="empty-row">没有匹配“${esc(q)}”的会话</li>`
      : '<li class="empty-row">从 Feat 或流程图点击机器人，直接创建同名主 Agent。<br>也可以点「新建会话」开始独立会话。</li>';
  enterId = '';
  if (!reduceMotion) for (const r of $$('.row', el)) {
    const b = before.get(r.dataset.s);
    if (b == null) continue;
    const dy = b - r.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
}

// ---------------- 新建会话 ----------------
/** 列出 APP 目录；主侧栏入口按 flowDir 选中准确 APP，工作目录仍取现有 root。 */
function fillApps(sel, flowDir) {
  const opts = apps.map((a) => `<option value="${esc(a.root)}" data-app="${esc(a.app)}" data-flow-dir="${esc(a.flow_dir)}">${esc(a.group ? a.group + ' / ' : '')}${esc(a.app)}</option>`);
  $('#nbApp').innerHTML = opts.join('') + '<option value="">其他目录…</option>';
  if (sel != null) $('#nbApp').value = sel;
  if (flowDir) for (const option of $('#nbApp').options) option.selected = key(option.dataset.flowDir) === key(flowDir);
}
async function loadApps() {
  try { apps = await invoke('summary', { full: false }); } catch (e) { toast('读取项目失败：' + e); }
}
/** 打开新建面板；pre 可带目录 root、关联节点 links、Feat（主窗口点了还没有会话的节点时预填）。 */
async function openNewBox(pre = {}) {
  if (!apps.length) await loadApps();
  nb.links = pre.links || [];
  nb.feat = pre.feat || null;
  $('#nbName').value = '';
  $('#nbName').readOnly = false;
  $('#nbName').dataset.draft = '';
  $('#nbPin').checked = false;
  $$('input[name="nbWorkflow"]').forEach((input) => { input.checked = false; });
  $('#nbLink').value = '';
  fillApps(pre.root ?? (apps[0]?.root || ''), pre.flowDir);
  renderNbChips();
  $('#nbDrop').hidden = true;
  $('#newwrap').inert = false;
  $('#newwrap').classList.add('open');
  $('#newBtn').classList.add('on');
  $('#newBtn').setAttribute('aria-expanded', 'true');
  setTimeout(() => $('#nbName').focus(), 60);
}
function closeNewBox() {
  $('#newwrap').inert = true;
  $('#newwrap').classList.remove('open');
  $('#newBtn').classList.remove('on');
  $('#newBtn').setAttribute('aria-expanded', 'false');
  $('#nbDrop').hidden = true;
}
function renderNbChips() {
  const chips = [];
  if (nb.feat) chips.push(`<span class="chip"><span>${esc(nb.feat.id + ' ' + nb.feat.title)}</span><button data-rm="feat" aria-label="移除">×</button></span>`);
  nb.links.forEach((l, i) => chips.push(`<span class="chip"><span>${esc(refLabel(l))}</span><button data-rm="${i}" aria-label="移除">×</button></span>`));
  $('#nbChips').innerHTML = chips.join('');
  const name = $('#nbName'), hint = $('#nbNameHint');
  const locked = !!(nb.feat || nb.links.length);
  if (locked && !name.readOnly) name.dataset.draft = name.value;
  if (locked) name.value = nb.feat?.title || flowName(nb.links[0].flow);
  else if (name.readOnly) name.value = name.dataset.draft || '';
  name.readOnly = locked;
  hint.textContent = locked ? '主 Agent 名称跟随来源，来源改名后自动同步。' : '关联 Feat 或流程图后，名称自动跟随来源。';
}
/** 关联候选：未归档的 Feat 与流程图，root 所属 APP 排前面，最多 12 条。 */
function linkCandidates(q, root) {
  q = q.toLowerCase();
  const out = [];
  const ordered = [...apps].sort((a, b) => (b.root === root) - (a.root === root));
  for (const a of ordered) {
    for (const f of a.feats) if (!f.archived) out.push({ t: 'feat', f, label: `${f.id} ${f.title}`, app: a });
    for (const d of a.files) out.push({ t: 'flow', flow: d.path, label: d.name, app: a });
  }
  return out.filter((x) => !q || (x.label + ' ' + x.app.app).toLowerCase().includes(q)).slice(0, 12);
}
function renderDrop(drop, input, anchor, cand) {
  nb.cand = cand;
  nb.sel = 0;
  drop.hidden = !cand.length || document.activeElement !== input;
  drop.style.left = anchor.offsetLeft + 'px';
  drop.style.width = Math.max(260, anchor.offsetWidth) + 'px';
  drop.style.top = (anchor.offsetTop + anchor.offsetHeight + 4) + 'px';
  drop.innerHTML = cand.map((x, i) => `<button data-cand="${i}" class="${i === 0 ? 'on' : ''}"><em>${x.t === 'feat' ? 'Feat' : '流程图'}</em><span>${esc(x.label)}</span><small>${esc(x.app.app)}</small></button>`).join('');
}
function pickNb(x) {
  if (x.t === 'feat') { nb.feat = { id: x.f.id, title: x.f.title, path: x.f.path }; $('#nbApp').value = x.app.root; }
  else if (!nb.links.some((l) => key(l.flow) === key(x.flow) && !l.node)) { nb.links.push({ flow: x.flow, node: '' }); if (!nb.feat) $('#nbApp').value = x.app.root; }
  $('#nbLink').value = '';
  renderNbChips();
  renderDrop($('#nbDrop'), $('#nbLink'), $('#nbLinks'), linkCandidates('', $('#nbApp').value));
  $('#nbLink').focus();
}
/** Feat 挂了标签的节点（同 APP 的流程图），作为会话的关联节点。 */
async function featLinks(featPath, id) {
  const a = featEntry(featPath)?.app || appOfPath(featPath);
  if (!a) return [];
  try {
    const nodes = await invoke('tagged_nodes', { flowDir: a.flow_dir, tag: id });
    return nodes.map((t) => ({ flow: t.file, node: t.id }));
  } catch (e) { return []; }
}
const creatingSources = new Map();
/** 来源入口直接创建，不展开命名表单；连续点击共享同一次请求。 */
async function createFromSource(pre = {}) {
  const source = pre.feat?.path || pre.links?.[0]?.flow;
  if (!source) return openNewBox(pre);
  const sourceKey = (pre.feat ? 'feat:' : 'flow:') + key(source);
  if (creatingSources.has(sourceKey)) return creatingSources.get(sourceKey);
  const task = (async () => {
    if (!apps.length) await loadApps();
    const a = appOfPath(source) || apps.find((x) => x.root === pre.root);
    const root = pre.root || a?.root;
    if (!root) { toast('无法确定来源的 APP 目录，请在新建会话中选择目录。'); return openNewBox(pre); }
    const existing = list().find((s) => sourceOf(s).kind === (pre.feat ? 'feat' : 'flow') && key(sourceOf(s).path) === key(source));
    if (existing) return openFocusedSession(existing.id);
    return submitSession({ root, feat: pre.feat, links: pre.links || [], title: '', pinned: false, direct: true });
  })();
  creatingSources.set(sourceKey, task);
  try { return await task; } finally { creatingSources.delete(sourceKey); }
}
let creatingManual = false;
/** 提交手动表单及可选启动流程；连续点击仅创建一次，失败后恢复启动按钮。 */
async function createSession() {
  if (creatingManual) return;
  let root = $('#nbApp').value;
  if (!root) {
    root = (prompt('输入会话的工作目录（绝对路径）') || '').trim();
    if (!root) return;
  }
  creatingManual = true;
  const button = $('#newbox [data-nb="ok"]');
  button.disabled = true;
  try {
    await submitSession({ root, appName: $('#nbApp').selectedOptions[0].dataset.app, feat: nb.feat, links: [...nb.links], title: $('#nbName').value.trim(), pinned: $('#nbPin').checked, workflow: $('input[name="nbWorkflow"]:checked')?.value || null });
  } finally { creatingManual = false; button.disabled = false; }
}
/** 创建并打开会话；可选 workflow 仅传给本次启动，不随来源入口或后续续接重放。 */
async function submitSession({ root, appName, feat, links, title, pinned, direct = false, workflow = null }) {
  const a = apps.find((x) => x.root === root && (!appName || x.app === appName));
  links = [...links];
  if (feat) for (const l of await featLinks(feat.path, feat.id)) if (!links.some((x) => key(x.flow) === key(l.flow) && x.node === l.node)) links.push(l);
  try {
    const v = await invoke('agent_create', {
      title, cwd: root, app: a ? a.app : base(root), feat: feat?.path || '', featCode: feat?.id || '', links, pinned, workflow,
    });
    upsert(v);
    enterId = v.id;
    if (!direct) closeNewBox();
    openSession(v.id);
    return v;
  } catch (e) {
    const duplicate = /^DUP:([^:]+):/s.exec(String(e));
    if (direct && duplicate) {
      (await invoke('agent_list')).forEach(upsert);
      openFocusedSession(duplicate[1]);
    } else if (!dupToast(e)) toast('创建或启动失败：' + e);
  }
}

/** 后端拒绝「同一 Feat / 流程图第二个主会话」时（错误为 DUP:<id>:<说明>），提示并给出切到已有会话的按钮。
 *  返回是否是这类错误。 */
function dupToast(e) {
  const m = /^DUP:([^:]+):(.*)$/s.exec(String(e));
  if (!m) return false;
  if (S.has(m[1])) toast(m[2], '切换', () => { closeNewBox(); openSession(m[1]); });
  else toast(m[2]);
  return true;
}

// ---------------- 提示 ----------------
/** 底部提示；带 action 时显示一个按钮，点了执行 fn。 */
function toast(msg, action, fn) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.addEventListener('click', () => { el.remove(); fn(); });
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), action ? 6000 : 2800);
}
function showTip(e, html) {
  const t = $('#tip');
  t.innerHTML = html;
  t.style.display = 'block';
  t.style.left = Math.min(e.clientX + 12, innerWidth - t.offsetWidth - 8) + 'px';
  t.style.top = (e.clientY + 14) + 'px';
}
const hideTip = () => { $('#tip').style.display = 'none'; };
