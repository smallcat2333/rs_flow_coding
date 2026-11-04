// 流程图底部时间线：实际历史跨度（最多一年），密集快照只在显示层聚合，原始历史不变。
// 旧版使用独立只读画布，编辑器始终保留当前图；仅复用 history / snapshot_xml / diff。
// 依赖 app.js 的 st、isDark 与 floatingStatus，在 app.js 之后载入。
'use strict';

(async () => {
  const { yearWindow, historyWindow, visibleSnapshots, timeRatio, nearestSnapshot, clusterSnapshots, calendarTicks } = await import('./timeline_scale.mjs');
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = id => document.getElementById(id);
  const bar = $('flow-timeline'), range = $('tl-range'), ticks = $('tl-ticks'), info = $('tl-info');
  const view = $('tl-view'), frame = $('tl-frame'), stamp = $('tl-stamp'), track = range.parentElement;
  const SRC = { user: '你', agent: 'Agent', external: '外部', scan: '扫描', restore: '回滚' };
  const MARK = { added: '#2da44e', changed: '#d4a72c' };
  const [dates, rail, fill] = ['tl-dates', 'tl-rail', 'tl-fill'].map(id => Object.assign(document.createElement('div'), { id }));
  track.prepend(dates, rail, fill);
  // 保存时间与「回到当前」同列放在右侧，不占用轨道上方的一整行。
  const actions = Object.assign(document.createElement('div'), { className: 'tl-actions' });
  bar.appendChild(actions);
  actions.append(info, $('tl-now'));
  bar.querySelector('.tl-title').textContent = '历史';
  range.setAttribute('aria-label', '图历史（最多一年），左右方向键逐份查看快照，End 回到当前');
  range.step = '1';

  const tl = {
    path: null, rows: [], idx: -1, domain: yearWindow(Date.now()), groups: [], width: 0,
    xml: new Map(), ready: null, loadedPath: null, seq: 0, loadSeq: 0, timer: 0,
    marks: [], pending: null, busy: false, queued: false, resizeTimer: 0, dragging: false, refreshPending: false,
  };

  /** 转义外部文本，供刻度 tooltip 与日期标注安全插入 HTML。 */
  const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const last = () => tl.rows.length - 1;
  const previewing = () => !view.hidden;
  /** 本地日期按固定格式显示，端点只显示年月日，选中记录显示秒。 */
  function dateText(time, withTime = false) {
    const d = new Date(time), two = n => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`;
    return withTime ? `${date} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` : date;
  }

  /** 拉取元数据并筛选近一年；回看中的版本按 id 保持，切图和旧请求返回时不覆盖新数据。 */
  async function load() {
    const path = tl.path, request = ++tl.loadSeq;
    if (!path) { bar.hidden = true; closePreview(); return; }
    try {
      const rows = await invoke('history', { path });
      if (request !== tl.loadSeq || path !== tl.path) return;
      if (tl.dragging) { tl.refreshPending = true; return; }
      const keepId = previewing() ? tl.rows[tl.idx]?.id : null;
      const now = Date.now();
      tl.rows = visibleSnapshots(rows, yearWindow(now));
      tl.domain = historyWindow(tl.rows, now);
      const kept = keepId == null ? -1 : tl.rows.findIndex(row => row.id === keepId);
      tl.idx = kept >= 0 ? kept : last();
      bar.hidden = false;
      range.min = String(tl.domain.start);
      range.max = String(tl.domain.end);
      range.disabled = tl.rows.length < 2;
      if (kept < 0) closePreview();
      renderScale();
      renderInfo();
    } catch (error) { floatingStatus(`时间线读取失败：${error}`, 'error'); }
  }

  /** 聚合 tooltip 只在悬停/焦点时给数量；常驻轨道不展示统计信息。 */
  function groupText(group) {
    const a = tl.rows[group.from], b = tl.rows[group.to];
    return group.from === group.to
      ? `${dateText(a.time, true)}\n${SRC[a.source] || a.source}`
      : `${dateText(a.time, true)} — ${dateText(b.time, true)}\n${group.to - group.from + 1} 份快照；方向键逐份查看`;
  }

  /** 宽度改变才重算聚合和日历标签；DOM 全为绝对定位，不反过来影响被观察轨道尺寸。 */
  function renderScale() {
    tl.width = ticks.clientWidth;
    if (!tl.width) return;
    tl.groups = clusterSnapshots(tl.rows, tl.domain, tl.width);
    ticks.innerHTML = tl.groups.map(group => {
      const ratio = group.x / tl.width;
      return `<i class="tl-tick${group.from !== group.to ? ' cluster' : ''}" style="left:${ratio * 100}%" title="${esc(groupText(group))}"></i>`;
    }).join('');
    const short = tl.domain.end - tl.domain.start <= 2 * 86400000;
    const label = time => short ? dateText(time, true).slice(5, 16) : dateText(time);
    dates.innerHTML = !tl.rows.length ? '' : `<span class="tl-date start">${label(tl.domain.start)}</span>` +
      calendarTicks(tl.domain, tl.width).map(tick => `<span class="tl-date" style="left:${tick.ratio * 100}%">${tick.label}</span>`).join('') +
      `<span class="tl-date end">${label(tl.domain.end)}</span>`;
    renderInfo();
  }

  /** 原始快照时间决定指针位置；右侧时间精简为月/日 时:分，完整时间与来源放在悬停提示里。 */
  function renderInfo() {
    const row = tl.rows[tl.idx], current = !tl.dragging && !previewing() && tl.idx === last();
    const position = row ? timeRatio(row.time, tl.domain) : 1;
    track.style.setProperty('--p', position);
    // 原生滑块在 input 阶段即吸附原始快照时间；包括最新一版，不再把指针移到空白的“现在”。
    range.value = String(row ? row.time : tl.domain.end);
    info.textContent = row ? dateText(row.time, true).slice(5, 16) : '暂无快照';
    info.title = row ? `${SRC[row.source] || row.source} · ${row.ts}` : '';
    range.setAttribute('aria-valuetext', row ? `${dateText(row.time, true)}，${SRC[row.source] || row.source}` : '近一年暂无快照');
    ticks.querySelectorAll('.tl-tick').forEach((tick, i) => {
      const group = tl.groups[i];
      const selected = tl.idx >= group.from && tl.idx <= group.to;
      tick.classList.toggle('on', selected);
      tick.classList.toggle('ahead', group.from > tl.idx);
      // 聚合点在被选中时对齐组内的实际快照，与滑块中心保持重合。
      tick.style.left = `${(selected ? position : group.x / tl.width) * 100}%`;
    });
    $('tl-now').disabled = current;
  }

  /** 预览页只初始化一次；仅浏览器的特定布局通知降为警告，其他真实错误继续交给 draw.io 报告。 */
  function ensureFrame() {
    if (tl.ready) return tl.ready;
    tl.ready = new Promise(resolve => {
      window.addEventListener('message', ev => {
        if (ev.source !== frame.contentWindow || typeof ev.data !== 'string') return;
        let message;
        try { message = JSON.parse(ev.data); } catch { return; }
        if (message.event === 'init') {
          const w = frame.contentWindow, original = w.onerror;
          w.onerror = function (message, ...args) {
            if (message === 'ResizeObserver loop completed with undelivered notifications.' || message === 'ResizeObserver loop limit exceeded') {
              w.console.warn(message);
              return true;
            }
            return original ? original.call(this, message, ...args) : false;
          };
          // 和正式画布一样初始化主题、节点标记与只读状态；消息按顺序先锁定编辑，再载入旧版。
          w.postMessage(JSON.stringify({ action: 'fc-theme', dark: isDark() }), '*');
          w.postMessage(JSON.stringify({ action: 'fc-ids', show: showIds() }), '*');
          w.postMessage(JSON.stringify({ action: 'fc-readonly', on: true }), '*');
          resolve();
        } else if (message.event === 'load' || message.event === 'merge') tl.pending?.();
      });
      // 复用正式编辑器的 UI、网格和导航参数，避免 chromeless 查看器引入另一套显示和拖动规则。
      const url = new URL($('editor').src);
      url.searchParams.delete('configure');
      frame.src = url.href;
    });
    return tl.ready;
  }

  /** 串行发送预览载图请求，回执/超时后释放；失败不把预览当成成功载入。 */
  function postAndWait(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { tl.pending = null; reject(new Error('历史预览载入超时')); }, 5000);
      tl.pending = () => { clearTimeout(timeout); tl.pending = null; resolve(); };
      frame.contentWindow.postMessage(JSON.stringify(message), '*');
    });
  }

  /** 从同源预览取得图对象，draw.io 尚未就绪时不处理高亮。 */
  const previewGraph = () => frame.contentWindow?.fcBridge?.ui?.editor?.graph;

  /** 复用正式画布的视口协议：首次打开适应内容，同图切版保留用户的缩放和平移。 */
  function fitHistoryViewport(keep) {
    frame.contentWindow.postMessage(JSON.stringify({ action: 'fc-viewport-apply', keep }), '*');
  }

  /** XML 只缓存最近读取的 12 版，避免长时间拖动把所有完整图留在内存。 */
  async function xmlOf(id) {
    if (!tl.xml.has(id)) tl.xml.set(id, await invoke('snapshot_xml', { id }));
    const value = tl.xml.get(id);
    tl.xml.delete(id);
    tl.xml.set(id, value);
    if (tl.xml.size > 12) tl.xml.delete(tl.xml.keys().next().value);
    return value;
  }

  /** 清理上一版高亮再描出新增与变化节点；不在图中添加统计文字。 */
  function mark(changes) {
    tl.marks.forEach(highlight => highlight.destroy());
    tl.marks = [];
    const graph = previewGraph(), w = frame.contentWindow;
    if (!graph || !w.mxCellHighlight) return;
    for (const change of changes) {
      if (change.kind === 'removed') continue;
      const cell = graph.model.getCell(change.node_id), state = cell && graph.view.getState(cell);
      if (!state) continue;
      const highlight = new w.mxCellHighlight(graph, MARK[change.kind], 3);
      highlight.highlight(state);
      tl.marks.push(highlight);
    }
  }

  /** 快速拖动只保留最后一个目标，载图消息串行，防止旧回执错配新请求。 */
  async function show() {
    clearTimeout(tl.timer);
    if (tl.dragging) return;
    if (tl.busy) { tl.queued = true; return; }
    if (tl.idx < 0 || tl.idx === last()) { closePreview(); return; }
    const request = tl.seq, path = tl.path, row = tl.rows[tl.idx], prev = tl.rows[tl.idx - 1];
    const first = tl.loadedPath !== tl.path, keepView = !first && previewing();
    tl.busy = true;
    frame.inert = true;
    try {
      view.hidden = false;
      stamp.textContent = `${dateText(row.time, true)} · 只读`;
      renderInfo();
      await ensureFrame();
      const [xml, changes] = await Promise.all([xmlOf(row.id), prev ? invoke('diff', { old: prev.id, new: row.id }) : []]);
      if (request !== tl.seq) return;
      if (keepView) frame.contentWindow.postMessage(JSON.stringify({ action: 'fc-viewport-save' }), '*');
      await postAndWait(first ? { action: 'load', xml } : { action: 'merge', xml });
      tl.loadedPath = path;
      // 原生 load 会重设 graph.enabled，必须在载入后重新锁定，并刷新菜单/工具栏的可用状态。
      const ui = frame.contentWindow.fcBridge.ui;
      ui.editor.graph.setEnabled(false);
      ui.updateActionStates();
      frame.contentWindow.postMessage(JSON.stringify({ action: 'fc-readonly', on: true }), '*');
      // load/merge 回执之后让原生页背景和滚动区先完成本轮布局，再适应历史图。
      await new Promise(resolve => setTimeout(resolve, 0));
      if (request !== tl.seq) return;
      fitHistoryViewport(keepView);
      mark(changes);
    } catch (error) {
      if (request === tl.seq) { closePreview(); floatingStatus(`历史预览失败：${error}`, 'error'); }
    } finally {
      frame.inert = false;
      tl.busy = false;
      if (tl.queued) { tl.queued = false; show(); }
    }
  }

  /** 返回当前图并使已在途的历史结果失效；保留预览尺寸，不重复触发隐藏/显示的零尺寸适应。 */
  function closePreview() {
    clearTimeout(tl.timer);
    tl.seq++;
    tl.dragging = false;
    view.hidden = true;
    tl.idx = last();
    renderInfo();
  }

  /** 松手或键盘选定后才载图；拖动过程中只更新原生滑块与时间，避免反复解析整张图。 */
  function select(index) {
    tl.seq++;
    tl.dragging = false;
    tl.idx = index;
    renderInfo();
    clearTimeout(tl.timer);
    if (index === last()) closePreview();
    else show();
    if (tl.refreshPending) { tl.refreshPending = false; load(); }
  }

  /** 当前图改变才重置历史；不依赖图标题或文件名区分身份。 */
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
    tl.seq++;
    tl.dragging = true;
    tl.queued = false;
    clearTimeout(tl.timer);
    tl.idx = nearestSnapshot(tl.rows, Number(range.value));
    renderInfo();
  });
  range.addEventListener('change', () => select(nearestSnapshot(tl.rows, Number(range.value))));
  range.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePreview(); }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key) && tl.rows.length) {
      ev.preventDefault();
      const index = ev.key === 'Home' ? 0 : ev.key === 'End' ? last() :
        Math.max(0, Math.min(last(), tl.idx + (ev.key === 'ArrowLeft' ? -1 : 1)));
      select(index);
    }
  });
  // 指针悬停按实际位置显示聚合起止时间及份数，原生 slider 保留完整的拖动/键盘命中区。
  range.addEventListener('pointermove', ev => {
    const box = ticks.getBoundingClientRect(), x = ev.clientX - box.left;
    let nearest = null, distance = Infinity;
    for (const group of tl.groups) {
      const d = Math.abs(group.x - x);
      if (d < distance) { nearest = group; distance = d; }
    }
    range.title = nearest && distance <= 14 ? groupText(nearest) : '按真实时间定位；左右方向键逐份查看';
  });
  $('tl-now').onclick = closePreview;

  // ResizeObserver 回调只读通知，不同步改 DOM；同宽通知直接跳过，避免布局反馈循环。
  new ResizeObserver(entries => {
    const width = entries[0].contentRect.width;
    if (Math.round(width) === Math.round(tl.width + 14)) return;
    clearTimeout(tl.resizeTimer);
    tl.resizeTimer = setTimeout(renderScale, 0);
  }).observe(track);
  new MutationObserver(syncPath).observe($('cur-name'), { childList: true, characterData: true, subtree: true });
  let refreshTimer = 0;
  listen('flow-changed', ev => {
    if (ev.payload.path !== tl.path) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(load, 300);
  });
  listen('history-pruned', () => { tl.xml.clear(); load(); });
  syncPath();
})().catch(error => floatingStatus(`时间线初始化失败：${error}`, 'error'));
