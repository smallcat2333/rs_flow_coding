// 流程图时间线：编辑区底部常驻一条，按本机历史快照逐版回看图是怎么搭起来的。
// 拖到旧版本时在编辑区上方盖一层只读 draw.io 预览，正在编辑的图、自动保存与锁都不受影响；
// 拖回最右端（当前）收起预览。数据只读 Rust 的 history / snapshot_xml / diff，不新增存储。
// 依赖 app.js 的全局 st（st.cur 为当前图路径）与 isDark()，须在 app.js 之后加载。
'use strict';

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);

  /** 快照来源的中文名，与历史面板的 source 取值一致。 */
  const SRC = { user: '你', agent: 'Agent', external: '外部', scan: '扫描', restore: '回滚' };
  /** 拖动停顿多久后载入该版本（毫秒）：拖动中只更新文字，避免每格都重绘整张图。 */
  const SHOW_DELAY_MS = 120;
  /** 相对上一版的节点变化高亮色：新增 / 文字或状态变化。 */
  const MARK = { added: '#2da44e', changed: '#d4a72c' };

  const bar = $('flow-timeline'), range = $('tl-range'), ticks = $('tl-ticks'), info = $('tl-info');
  const view = $('tl-view'), frame = $('tl-frame'), stamp = $('tl-stamp');
  /** 轨道内由脚本补齐的层（自下而上）：日期标注、底轨、已播放的流动进度条；刻度与滑块在其上。 */
  const track = range.parentElement;
  const [dates, rail, fill] = ['tl-dates', 'tl-rail', 'tl-fill'].map((id) => Object.assign(document.createElement('div'), { id }));
  track.prepend(dates, rail, fill);
  /** 日期标注之间的最小间距（像素），更密时只保留靠前的一天，避免文字重叠。 */
  const DATE_GAP_PX = 46;

  const tl = {
    path: null,      // 时间线对应的图路径
    rows: [],        // 快照（旧 → 新）
    idx: -1,         // 滑块所在下标；rows.length - 1 为当前
    xml: new Map(),  // 快照 id → XML 缓存，切图时清空
    ready: null,     // 预览 iframe 初始化完成的 Promise
    loaded: false,   // 预览 iframe 已 load 过一张图（之后改用 merge 保持视口）
    seq: 0,          // 预览请求序号，丢弃过期的异步结果
    timer: 0,
    marks: [],       // 预览中的 mxCellHighlight
    pending: null,   // 等待 load / merge 回执的 { resolve }
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const last = () => tl.rows.length - 1;
  const previewing = () => !view.hidden;

  /**
   * 拉取当前图快照并重绘刻度。正在回看时按快照 id 保持滑块位置（id 已被清理则回到当前）；
   * 不在回看时停在最新。没有打开的图时隐藏整条。
   */
  async function load() {
    const path = tl.path;
    if (!path) { bar.hidden = true; closePreview(); return; }
    const rows = (await invoke('history', { path })).reverse();
    if (path !== tl.path) return;
    const keepId = previewing() ? tl.rows[tl.idx]?.id : null;
    tl.rows = rows;
    const kept = keepId == null ? -1 : rows.findIndex((r) => r.id === keepId);
    tl.idx = kept >= 0 ? kept : last();
    bar.hidden = false;
    range.max = String(Math.max(0, last()));
    range.value = String(tl.idx);
    range.disabled = rows.length < 2;
    renderTicks();
    renderInfo();
    if (kept < 0) closePreview();
  }

  /** 快照时间的日期部分；兼容「2026-11-04 14:10:13」与「2026/11/4 14:10:13」两种写法，返回 [年, 月, 日] 数字。 */
  const dayOf = (ts) => ts.split(' ')[0].split(/[-/]/).map(Number);
  /** 第 i 个快照在轨道上的比例位置（0~1）；只有一版时放在最右端。 */
  const ratio = (i) => tl.rows.length > 1 ? i / (tl.rows.length - 1) : 1;

  /** 每个快照一个圆点，按来源着色，悬停显示时间与来源；同时重绘日期标注。 */
  function renderTicks() {
    ticks.innerHTML = tl.rows.map((r, i) =>
      `<i class="tl-tick s-${esc(r.source)}" style="left:${ratio(i) * 100}%" title="${esc(`#${r.id} ${r.ts} · ${SRC[r.source] || r.source}`)}"></i>`).join('');
    renderDates();
  }

  /**
   * 在每天第一版的位置上方标注日期（今年只写月/日，往年带年份，今天另加「今天」并高亮）。
   * 按轨道实际宽度换算位置，与上一个已显示标注过近时跳过；贴近两端的标注向内对齐，不被裁切。
   */
  function renderDates() {
    const w = ticks.clientWidth, now = new Date();
    const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].join('-');
    let lastX = -Infinity;
    dates.innerHTML = tl.rows.map((r, i) => {
      const [y, m, d] = dayOf(r.ts);
      if (i > 0 && dayOf(tl.rows[i - 1].ts).join('-') === [y, m, d].join('-')) return '';
      const x = ratio(i) * w;
      if (x - lastX < DATE_GAP_PX) return '';
      lastX = x;
      const md = `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
      const isToday = [y, m, d].join('-') === today;
      const text = (y === now.getFullYear() ? md : `${y}/${md}`) + (isToday ? ' 今天' : '');
      const edge = x < 24 ? ' start' : w - x < 24 ? ' end' : '';
      return `<span class="tl-date${edge}${isToday ? ' today' : ''}" style="left:${ratio(i) * 100}%">${text}</span>`;
    }).join('');
  }

  /** 按滑块位置刷新进度条长度与圆点状态：当前版放大，之后的版本变淡。 */
  function paintProgress() {
    track.style.setProperty('--p', tl.idx < 0 ? 1 : ratio(tl.idx));
    [...ticks.children].forEach((t, i) => {
      t.classList.toggle('on', i === tl.idx);
      t.classList.toggle('ahead', i > tl.idx);
    });
  }

  /** 滑块旁文字：第几版、时间戳、来源；在最右端显示「当前」。 */
  function renderInfo() {
    const r = tl.rows[tl.idx];
    paintProgress();
    if (!r) { info.textContent = '暂无历史'; $('tl-now').disabled = true; return; }
    const pos = `${tl.idx + 1}/${tl.rows.length}`;
    info.innerHTML = tl.idx === last()
      ? `<b>当前</b> · ${esc(r.ts)} · ${pos}`
      : `<b>${esc(r.ts)}</b> · ${esc(SRC[r.source] || r.source)} · ${pos}<span id="tl-diff"></span>`;
    info.title = `快照 #${r.id}`;
    $('tl-now').disabled = tl.idx === last();
  }

  /** 预览 iframe 只建一次：draw.io 无工具栏只读模式，init 后 resolve。 */
  function ensureFrame() {
    if (tl.ready) return tl.ready;
    tl.ready = new Promise((resolve) => {
      const onMsg = (ev) => {
        if (ev.source !== frame.contentWindow || typeof ev.data !== 'string') return;
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.event === 'init') resolve();
        else if ((m.event === 'load' || m.event === 'merge') && tl.pending) { tl.pending.resolve(); tl.pending = null; }
      };
      window.addEventListener('message', onMsg);
      frame.src = 'drawio/index.html?' + new URLSearchParams({ embed: '1', proto: 'json', chrome: '0', lang: 'zh', stealth: '1', pwa: '0', splash: '0', nav: '1', ...(isDark() ? { dark: '1' } : {}) });
    });
    return tl.ready;
  }

  /** 向预览 iframe 发协议消息，等待 load / merge 回执（最多 3 秒，超时也继续，避免卡住滑块）。 */
  function postAndWait(msg) {
    return new Promise((resolve) => {
      tl.pending = { resolve };
      frame.contentWindow.postMessage(JSON.stringify(msg), '*');
      setTimeout(resolve, 3000);
    });
  }

  /** 预览 iframe 里 draw.io 的 graph；同源可直接访问，桥未装好时返回 null（只是不高亮）。 */
  function previewGraph() {
    return frame.contentWindow?.fcBridge?.ui?.editor?.graph || null;
  }

  /** 首次打开预览时沿用编辑器当前缩放与滚动位置，回看时画面不跳。 */
  function copyLiveViewport() {
    const live = $('editor').contentWindow?.fcBridge?.ui?.editor?.graph, g = previewGraph();
    if (!live || !g) return;
    g.view.scaleAndTranslate(live.view.scale, live.view.translate.x, live.view.translate.y);
    g.container.scrollLeft = live.container.scrollLeft;
    g.container.scrollTop = live.container.scrollTop;
  }

  /** 读取快照 XML（带缓存）。 */
  async function xmlOf(id) {
    if (!tl.xml.has(id)) tl.xml.set(id, await invoke('snapshot_xml', { id }));
    return tl.xml.get(id);
  }

  /**
   * 载入滑块所在版本：最右端收起预览；否则首版 load、之后 merge（保持视口不闪），
   * 再按与上一版的节点差异描边高亮（新增绿、变化黄），并更新画面上的时间戳。
   */
  async function show() {
    clearTimeout(tl.timer);
    if (tl.idx === last() || tl.idx < 0) { closePreview(); return; }
    const seq = ++tl.seq, row = tl.rows[tl.idx], prev = tl.rows[tl.idx - 1];
    stamp.textContent = `历史版本 · ${row.ts} · ${SRC[row.source] || row.source} · 只读`;
    view.hidden = false;
    bar.classList.add('previewing');
    await ensureFrame();
    const [xml, changes] = await Promise.all([xmlOf(row.id), prev ? invoke('diff', { old: prev.id, new: row.id }) : Promise.resolve(null)]);
    if (seq !== tl.seq) return;
    const first = !tl.loaded;
    await postAndWait(first ? { action: 'load', xml } : { action: 'merge', xml });
    tl.loaded = true;
    if (seq !== tl.seq) return;
    if (first) copyLiveViewport();
    mark(changes || []);
    const box = $('tl-diff');
    if (box) {
      const n = (k) => (changes || []).filter((c) => c.kind === k).length;
      box.textContent = prev ? ` · 新增 ${n('added')} 变化 ${n('changed')} 删除 ${n('removed')}` : ' · 最早记录';
    }
  }

  /** 清掉旧高亮，给本版相对上一版新增 / 变化的节点描边；删除的节点已不在图中，只计数。 */
  function mark(changes) {
    tl.marks.forEach((h) => h.destroy());
    tl.marks = [];
    const g = previewGraph(), w = frame.contentWindow;
    if (!g || !w.mxCellHighlight) return;
    for (const c of changes) {
      if (c.kind === 'removed') continue;
      const cell = g.model.getCell(c.node_id), state = cell && g.view.getState(cell);
      if (!state) continue;
      const h = new w.mxCellHighlight(g, MARK[c.kind], 3);
      h.highlight(state);
      tl.marks.push(h);
    }
  }

  /** 收起预览回到可编辑的当前图；预览 iframe 保留，下次回看不用重新初始化。 */
  function closePreview() {
    tl.seq++;
    view.hidden = true;
    bar.classList.remove('previewing');
    if (tl.rows.length && tl.idx !== last()) {
      tl.idx = last();
      range.value = String(tl.idx);
      renderInfo();
    }
  }

  /** 当前图切换（app.js 每次 renderCurrentBar 都会重写 #cur-name）：路径变了才重置时间线。 */
  function syncPath() {
    const path = st.cur || null;
    if (path === tl.path) return;
    tl.path = path;
    tl.rows = [];
    tl.idx = -1;
    tl.xml.clear();
    closePreview();
    load();
  }

  range.addEventListener('input', () => {
    tl.idx = Number(range.value);
    renderInfo();
    clearTimeout(tl.timer);
    tl.timer = setTimeout(show, SHOW_DELAY_MS);
  });
  range.addEventListener('change', show);
  range.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && previewing()) { ev.stopPropagation(); closePreview(); } });
  $('tl-now').onclick = closePreview;

  new ResizeObserver(renderDates).observe(track);
  new MutationObserver(syncPath).observe($('cur-name'), { childList: true, characterData: true, subtree: true });

  let refreshTimer = 0;
  listen('flow-changed', (ev) => {
    if (ev.payload.path !== tl.path) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(load, 300);
  });
  listen('history-pruned', () => { tl.xml.clear(); load(); });

  syncPath();
})();
