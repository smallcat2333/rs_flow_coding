// 主窗口栏顶的 Agent 机器人：Feat 栏一个「主」机器人；流程图栏一个「主」机器人加一个「客」计数。
// - 主会话：Feat 的主会话是关联该 Feat 的会话；流程图的主会话是没有 Feat、关联了这张图（整图或其中节点）的会话。
//   后端保证每个 Feat / 每张图只有一个主会话（agent.rs main_conflict）；规则之前留下的重复以最早创建的为主。
// - 客会话：带 Feat、关联或正在处理这张图节点的会话；「客 N」的 N 是其中正在运行的个数。
// - 颜色（多个会话取最紧急）：红 异常 > 黄 等你确认 > 紫 多个 subagent 运行中 > 蓝 运行中 > 绿 运行完成未查看 > 白 有会话 > 灰 无会话。
// - 单击：有会话切到 Agent 窗口的该会话；没有会话时打开 Agent 窗口并预填新建面板。
// 数据：agent_list 初始化，agent-update / agent-removed 增量；当前图取 app.js 的 st.cur，当前 Feat 取 FeatPane。
'use strict';

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  /** 会话 id → 视图（与 Agent 窗口同源，只用状态与关联字段）。 */
  const sessions = new Map();
  const RANK = { err: 0, wait: 1, multi: 2, run: 3, done: 4, has: 5, none: 6 };
  const TEXT = { err: '异常退出', wait: '等你确认', multi: '多个 subagent 运行中', run: '运行中', done: '运行完成，还没查看', has: '空闲', none: '还没有会话' };
  const SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="an" d="M8 1.7v2"/><circle class="ab" cx="8" cy="1.4" r="1"/>'
    + '<rect class="hd" x="2.4" y="3.7" width="11.2" height="9.4" rx="2.7"/><circle class="ey" cx="5.9" cy="8.3" r="1.1"/><circle class="ey" cx="10.1" cy="8.3" r="1.1"/>'
    + '<path class="ar" d="M.9 7.4v2.6M15.1 7.4v2.6"/></svg>';
  const key = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

  /** 单个会话的颜色状态；输入为后端会话视图，输出为 RANK 的键（none 除外）。 */
  function stateOf(s) {
    if (s.status === 'err') return 'err';
    if (s.running && s.status === 'wait') return 'wait';
    if (s.running && (s.status === 'run' || s.status === 'boot')) {
      return (s.workers || []).filter((w) => w.running).length >= 2 ? 'multi' : 'run';
    }
    return s.done > s.seen ? 'done' : 'has';
  }
  /** 一组会话里最紧急的那个（并列取最早创建）；空组返回 null。 */
  function urgent(list) {
    return [...list].sort((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)] || a.created - b.created)[0] || null;
  }
  const oldest = (list) => [...list].sort((a, b) => a.created - b.created)[0] || null;
  const touches = (s, flow) => (s.links || []).some((l) => key(l.flow) === flow) || (s.focus && key(s.focus.flow) === flow);

  /** 当前 Feat 的主会话。 */
  function featMain(path) {
    const k = key(path);
    return oldest([...sessions.values()].filter((s) => key(s.feat) === k));
  }
  /** 当前流程图的主会话与客会话。 */
  function flowParts(path) {
    const k = key(path), all = [...sessions.values()];
    return {
      main: oldest(all.filter((s) => !s.feat && (s.links || []).some((l) => key(l.flow) === k))),
      guests: all.filter((s) => s.feat && touches(s, k)),
    };
  }

  /** 把按钮画成某状态；内容没变不动 DOM（避免悬停提示闪动）。 */
  function paint(btn, st, title, text) {
    const sig = st + '|' + title + '|' + (text ?? '');
    if (btn.dataset.sig === sig) return;
    btn.dataset.sig = sig;
    btn.dataset.state = st;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = SVG + (text == null ? '' : `<span>${text}</span>`);
  }

  /** 刷新三个按钮：Feat 主、图主、图客。 */
  function render() {
    const featPath = window.FeatPane?.curPath() || '';
    const fb = document.getElementById('btn-feat-bot');
    fb.disabled = !featPath;
    const fm = featPath ? featMain(featPath) : null;
    paint(fb, fm ? stateOf(fm) : 'none', fm ? `主会话「${fm.title}」：${TEXT[stateOf(fm)]}，点击打开` : '这个 Feat 还没有会话，点击新建');

    const flowPath = st.cur || '';
    const mb = document.getElementById('btn-flow-bot'), gb = document.getElementById('btn-flow-guest');
    mb.disabled = !flowPath;
    const { main, guests } = flowPath ? flowParts(flowPath) : { main: null, guests: [] };
    paint(mb, main ? stateOf(main) : 'none', main ? `主会话「${main.title}」：${TEXT[stateOf(main)]}，点击打开` : '这张图还没有主会话，点击新建');
    gb.hidden = !guests.length;
    if (guests.length) {
      const running = guests.filter((s) => ['run', 'multi', 'wait'].includes(stateOf(s))).length;
      const lines = guests.map((s) => `「${s.title}」${s.feat_code ? ' ' + s.feat_code : ''}：${TEXT[stateOf(s)]}`);
      paint(gb, stateOf(urgent(guests)), `客会话（来自 Feat，处理本图节点），${running} 个运行中：\n${lines.join('\n')}\n点击打开最需要处理的一个`, `客 ${running}`);
    }
  }

  /** 打开会话；没有会话时打开 Agent 窗口并预填新建面板。 */
  function open(s, prefill) {
    invoke('open_agent_window', s ? { focus: s.id } : { prefill }).catch((e) => console.error('打开 Agent 窗口失败', e));
  }
  document.getElementById('btn-feat-bot').addEventListener('click', () => {
    const path = FeatPane.curPath();
    const f = appOf(path)?.feats.find((x) => x.path === path);
    open(featMain(path), { root: appOf(path)?.root, feat: { id: FeatPane.curId() || f?.id || '', title: f?.title || '', path }, links: [] });
  });
  document.getElementById('btn-flow-bot').addEventListener('click', () => {
    open(flowParts(st.cur).main, { root: appOf(st.cur)?.root, links: [{ flow: st.cur, node: '' }] });
  });
  document.getElementById('btn-flow-guest').addEventListener('click', () => open(urgent(flowParts(st.cur).guests)));

  // ---------------- Feat 控件页：任务卡片上的实时 Agent ----------------
  // 会话用 `flowctl focus <Feat档案>#T<n>` 标记正在做的任务（后端 live.task）；子任务 T3.1 显示在 T3 卡片上。
  // 控件页每次重绘都替换 DOM，这里用 MutationObserver 在重绘后补上装饰：
  // 任务图卡片发光 + 卡片右上角机器人（单击打开会话）+ 新活动气泡；阶段栏 T 小标与任务详情行同步发光。
  // 栏顶「正在做」条显示本 Feat 运行中会话的最近一条活动。
  /** 会话 id → 最近一条活动。 */
  const lastAct = new Map();
  const KIND = { prompt: '提问', read: '读取', edit: '编辑', cmd: '命令', commit: '提交', worker: '派出', tool: '', msg: '协作', note: '通知', compact: '压缩' };
  const actText = (a) => (a ? [KIND[a.kind] ?? '', a.text].filter(Boolean).join(' ') : '');
  const escH = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  /** 运行中、正在处理当前 Feat 某个任务的会话，按紧急程度排序。 */
  function taskSessions(featPath) {
    const k = key(featPath);
    return [...sessions.values()].filter((s) => s.running && s.task && key(s.task.feat) === k)
      .sort((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)] || a.created - b.created);
  }
  const parentT = (t) => t.split('.')[0];

  /** 清掉上一次的装饰（发光类与插入的元素），重绘后的新 DOM 本来就没有。 */
  function clearBoard(board) {
    board.querySelectorAll('.fbx-on').forEach((el) => { el.classList.remove('fbx-on'); delete el.dataset.fbx; });
    board.querySelectorAll('.fbx-layer, .fbx-inline').forEach((el) => el.remove());
  }

  /** 在控件页上画出正在处理任务的会话；输入为当前 Feat 路径，没有会话时只清理。 */
  function decorate() {
    const board = document.getElementById('feat-board');
    if (!board) return;
    observer.disconnect();
    try {
      const featPath = window.FeatPane?.curPath() || '';
      const list = featPath ? taskSessions(featPath) : [];
      clearBoard(board);
      const byT = new Map();
      for (const s of list) {
        const t = parentT(s.task.task);
        if (!byT.has(t)) byT.set(t, []);
        byT.get(t).push(s);
      }
      for (const [t, ss] of byT) {
        const st0 = stateOf(ss[0]);
        const mark = (el) => { if (el) { el.classList.add('fbx-on'); el.dataset.fbx = st0; } };
        // 任务图卡片：发光 + 右上角机器人（卡片 overflow:hidden，机器人放在图上方的独立层）
        const node = board.querySelector(`.fb-node[data-node="${CSS.escape(t)}"]`);
        if (node && node.offsetParent) {
          mark(node);
          let layer = node.offsetParent.querySelector(':scope > .fbx-layer');
          if (!layer) { layer = document.createElement('div'); layer.className = 'fbx-layer'; node.offsetParent.appendChild(layer); }
          const dock = document.createElement('div');
          dock.className = 'fbx-dock';
          dock.style.left = (node.offsetLeft + node.offsetWidth) + 'px';
          dock.style.top = node.offsetTop + 'px';
          dock.innerHTML = ss.slice(0, 3).map((s) => chip(s, s.task.task !== t)).join('');
          layer.appendChild(dock);
        }
        board.querySelectorAll(`.fb-tchip[data-tjump="${CSS.escape(t)}"]`).forEach(mark);
        // 任务详情列表：行内发光 + 行尾机器人
        for (const row of board.querySelectorAll('.fb-task-row')) {
          if (row.querySelector('.fb-tid')?.textContent.trim() !== t) continue;
          mark(row);
          const inl = document.createElement('span');
          inl.className = 'fbx-inline';
          inl.innerHTML = ss.slice(0, 3).map((s) => chip(s, s.task.task !== t)).join('');
          row.appendChild(inl);
        }
      }
      renderNow(featPath, list);
    } finally {
      observer.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    }
  }
  /** 一个会话的机器人小卡：状态色脸 + 会话名（子任务时带编号）；单击打开会话。 */
  function chip(s, showSub) {
    const st0 = stateOf(s), a = lastAct.get(s.id);
    const tip = `「${s.title}」${s.task.task}：${TEXT[st0]}${a ? '\n最近：' + actText(a) : ''}\n点击打开会话`;
    return `<span class="fbx-chip" data-state="${st0}" data-sid="${escH(s.id)}" role="button" tabindex="0" title="${escH(tip)}">`
      + `<span class="fbx-face">${SVG}</span><span class="nm">${escH(s.title)}</span>${showSub ? `<em>${escH(s.task.task)}</em>` : ''}</span>`;
  }
  /** 栏顶「正在做」：本 Feat 运行中的会话（优先在做任务的，其次主会话）的最近活动。 */
  function renderNow(featPath, list) {
    const el = document.getElementById('feat-agent-now');
    const fm = featPath ? featMain(featPath) : null;
    const s = list[0] || (fm && fm.running ? fm : null);
    el.hidden = !s;
    if (!s) return;
    const a = lastAct.get(s.id), st0 = stateOf(s);
    const doing = st0 === 'wait' ? '等你确认' : actText(a) || TEXT[st0];
    const sig = [s.id, st0, s.task?.task, doing].join('|');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.dataset.sid = s.id;
    el.dataset.state = st0;
    el.title = `「${s.title}」${s.task ? ' 正在做 ' + s.task.task : ''}：${TEXT[st0]}${a ? '\n最近：' + actText(a) : ''}\n点击打开会话`;
    el.innerHTML = `<span class="fbx-face">${SVG}</span>${s.task ? `<b>${escH(s.task.task)}</b>` : ''}<span class="tx">${escH(doing)}</span>`;
  }
  /** 新活动：在对应机器人上冒一个气泡（约 2.6 秒淡出）。 */
  function say(id, a) {
    const text = actText(a);
    if (!text) return;
    for (const c of document.querySelectorAll(`#feat-board .fbx-layer .fbx-chip[data-sid="${CSS.escape(id)}"]`)) {
      c.querySelector('.fbx-say')?.remove();
      const b = document.createElement('span');
      b.className = 'fbx-say k-' + a.kind;
      b.textContent = text.length > 40 ? text.slice(0, 40) + '…' : text;
      c.appendChild(b);
      setTimeout(() => b.remove(), 2800);
    }
  }
  let queued = false;
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; decorate(); }); } };
  const observer = new MutationObserver(schedule);
  document.getElementById('feat-board').addEventListener('click', (e) => {
    const c = e.target.closest('.fbx-chip');
    if (!c) return;
    e.stopPropagation();
    e.preventDefault();
    open(sessions.get(c.dataset.sid));
  }, true);
  document.getElementById('feat-agent-now').addEventListener('click', (e) => open(sessions.get(e.currentTarget.dataset.sid)));
  window.addEventListener('resize', schedule);

  invoke('agent_list').then((list) => {
    for (const s of list) { sessions.set(s.id, s); if (s.acts?.length) lastAct.set(s.id, s.acts[s.acts.length - 1]); }
    render(); schedule();
  }).catch((e) => console.error('读取 Agent 会话失败', e));
  listen('agent-update', (e) => { sessions.set(e.payload.id, e.payload); render(); schedule(); });
  listen('agent-removed', (e) => { sessions.delete(e.payload.id); lastAct.delete(e.payload.id); render(); schedule(); });
  listen('agent-act', (e) => {
    lastAct.set(e.payload.id, e.payload.act);
    const s = sessions.get(e.payload.id);
    if (s?.task && key(s.task.feat) === key(window.FeatPane?.curPath() || '')) { decorate(); say(e.payload.id, e.payload.act); }
    else if (s && s.feat && key(s.feat) === key(window.FeatPane?.curPath() || '')) renderNow(FeatPane.curPath(), taskSessions(FeatPane.curPath()));
  });
  // 当前图 / Feat 切换没有统一事件，按秒轮询；内容不变时 paint / renderNow 不改 DOM
  let lastFeat = '';
  setInterval(() => {
    render();
    const f = window.FeatPane?.curPath() || '';
    if (f !== lastFeat) { lastFeat = f; schedule(); }
  }, 1000);
  render();
})();
