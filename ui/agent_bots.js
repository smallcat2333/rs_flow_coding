// 主窗口栏顶的 Agent 机器人：Feat 栏一个「主」机器人；流程图栏一个「主」机器人加一个「客」计数。
// - 主会话：Feat 的主会话是关联该 Feat 的会话；流程图的主会话是没有 Feat、第一项关联指向这张图的会话。
//   后端保证每个 Feat / 每张图只有一个主会话（agent.rs main_conflict）；规则之前留下的重复以最早创建的为主。
// - 客会话：其他 Feat 或主图的会话关联或正在处理这张图；「客 N」的 N 是其中正在运行的个数。
// - 颜色（多个会话取最紧急）：红 异常 > 黄 等你确认 > 紫 多个 subagent 运行中 > 蓝 运行中 > 绿 运行完成未查看 > 白 有会话 > 灰 无会话。
// - 单击：有会话切到 Agent 窗口的该会话；没有会话时直接创建同名主 Agent 并启动。
// 数据：agent_list 初始化，agent-update / agent-removed 增量；当前图取 app.js 的 st.cur，当前 Feat 取 FeatPane。
'use strict';

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  /** 会话 id → 视图（与 Agent 窗口同源，只用状态与关联字段）。 */
  const sessions = new Map();
  // 初次列表返回前，机器人显示启动状态并禁止创建，避免把“尚未加载”误认成“没有主会话”。
  let ready = false, startupError = '';
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
    return oldest([...sessions.values()].filter((s) => !s.archived_at && key(s.feat) === k));
  }
  /** 当前流程图的主会话与客会话。 */
  function flowParts(path) {
    const k = key(path), all = [...sessions.values()].filter((s) => !s.archived_at);
    return {
      main: oldest(all.filter((s) => !s.feat && key(s.links?.[0]?.flow) === k)),
      guests: all.filter((s) => (s.feat || key(s.links?.[0]?.flow) !== k) && touches(s, k)),
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
    fb.disabled = !featPath || !ready;
    const fm = featPath ? featMain(featPath) : null;
    paint(fb, fm ? stateOf(fm) : 'none', !ready ? startupError || 'Agent 正在启动…（最多 30 秒）' : fm ? `主会话「${fm.title}」：${TEXT[stateOf(fm)]}，点击打开` : '这个 Feat 还没有会话，点击新建');

    const flowPath = st.cur || '';
    const mb = document.getElementById('btn-flow-bot'), gb = document.getElementById('btn-flow-guest');
    mb.disabled = !flowPath || !ready;
    const { main, guests } = flowPath ? flowParts(flowPath) : { main: null, guests: [] };
    paint(mb, main ? stateOf(main) : 'none', !ready ? startupError || 'Agent 正在启动…（最多 30 秒）' : main ? `主会话「${main.title}」：${TEXT[stateOf(main)]}，点击打开` : '这张图还没有主会话，点击新建');
    gb.hidden = !guests.length;
    if (guests.length) {
      const running = guests.filter((s) => ['run', 'multi', 'wait'].includes(stateOf(s))).length;
      const lines = guests.map((s) => `「${s.title}」${s.feat_code ? ' ' + s.feat_code : ''}：${TEXT[stateOf(s)]}`);
      paint(gb, stateOf(urgent(guests)), `客会话（来自其他 Feat 或主图，协作处理本图），${running} 个运行中：\n${lines.join('\n')}\n点击打开最需要处理的一个`, `客 ${running}`);
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

  // ---------------- Feat 控件页：阶段轴机器人与任务卡片上的实时 Agent ----------------
  // 阶段轴：本 Feat 有运行中的会话（进程在）时，左侧阶段轴当前阶段的圆点上站一个机器人（多个会话取最紧急的，
  //   其余列在悬停提示里），该阶段的摘要行换成它的最近活动，新活动从机器人上冒气泡。档案处于开发阶段、
  //   且该会话用 `flowctl focus <Feat档案>#T<n>` 标了任务时，机器人挪到对应 T 小标右上角。
  //   阶段推进或换 T 时机器人沿轴滑到新位置；单击打开该会话。
  // 任务卡片：标了任务的会话在开发页任务图卡片上发光，卡片右上角显示机器人小卡（子任务 T3.1 显示在 T3 上），
  //   阶段栏 T 小标与任务详情行同步发光；单击机器人小卡打开会话。
  // 控件页每次重绘都替换 DOM，这里用 MutationObserver 在重绘后补上装饰。阶段轴机器人始终是同一个元素：
  //   重绘后先按旧坐标放进新的阶段轴，再改到新坐标，所以由重绘引起的换位也有挪动过程。
  /** 会话 id → 最近一条活动。 */
  const lastAct = new Map();
  const KIND = { prompt: '提问', read: '读取', edit: '编辑', cmd: '命令', commit: '提交', worker: '派出', tool: '', msg: '协作', note: '通知', compact: '压缩' };
  const actText = (a) => (a ? [KIND[a.kind] ?? '', a.text].filter(Boolean).join(' ') : '');
  const escH = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  /** 排序比较：先按紧急程度，并列取最早创建。 */
  const byUrgency = (a, b) => RANK[stateOf(a)] - RANK[stateOf(b)] || a.created - b.created;
  /** 运行中、正在处理当前 Feat 某个任务的会话，按紧急程度排序。 */
  function taskSessions(featPath) {
    const k = key(featPath);
    return [...sessions.values()].filter((s) => !s.archived_at && s.running && s.task && key(s.task.feat) === k).sort(byUrgency);
  }
  /** 运行中、属于当前 Feat（关联了该 Feat，或正在做它的某个任务）的会话，按紧急程度排序。 */
  function featSessions(featPath) {
    const k = key(featPath);
    return [...sessions.values()].filter((s) => !s.archived_at && s.running && (key(s.feat) === k || (s.task && key(s.task.feat) === k))).sort(byUrgency);
  }
  /** 会话「正在做」的一行文字：等你确认 / 异常优先，其次最近活动，都没有时用状态名。 */
  function doingText(s) {
    const st0 = stateOf(s);
    return st0 === 'wait' || st0 === 'err' ? TEXT[st0] : actText(lastAct.get(s.id)) || TEXT[st0];
  }
  const parentT = (t) => t.split('.')[0];

  /** 清掉上一次的装饰（发光类、摘要替换与插入的元素），重绘后的新 DOM 本来就没有；阶段轴机器人由 placeRailBot 管。 */
  function clearBoard(board) {
    board.querySelectorAll('.fbx-on').forEach((el) => { el.classList.remove('fbx-on'); delete el.dataset.fbx; });
    board.querySelectorAll('.fbx-busy').forEach((el) => el.classList.remove('fbx-busy'));
    board.querySelectorAll('.fbx-layer, .fbx-inline, .fbx-sum').forEach((el) => el.remove());
  }

  /**
   * 在控件页上画出本 Feat 的会话：阶段轴机器人 + 正在处理任务的会话（卡片、T 小标、详情行）。
   * 输入取当前 Feat 路径；没有会话时只清理。控件页未显示（取不到坐标）时记 pendingPlace，由轮询在显示后补画。
   */
  function decorate() {
    const board = document.getElementById('feat-board');
    if (!board) return;
    observer.disconnect();
    try {
      pendingPlace = false;
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
        } else if (node) pendingPlace = true;
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
      placeRailBot(board, featPath, featPath ? featSessions(featPath) : []);
      paintBubbles();
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
  /** 阶段轴机器人：重绘后复用同一元素，保留上次坐标作为挪动起点。 */
  const rbot = document.createElement('span');
  rbot.className = 'fbx-rbot';
  rbot.setAttribute('role', 'button');
  rbot.tabIndex = 0;
  rbot.innerHTML = SVG;
  /** 控件页未显示、取不到坐标时置位，由每秒轮询在显示后补画。 */
  let pendingPlace = false;

  /**
   * 把阶段轴机器人放到位；输入为控件页根节点、当前 Feat 路径与本 Feat 运行中的会话（已按紧急程度排序）。
   * 位置跟最紧急的会话走：档案当前阶段是开发、该会话标了本 Feat 的 T 且 T 小标可见 → T 小标右上角；
   * 否则 → 档案当前阶段的圆点。机器人所在阶段的摘要行换成最近活动。
   * 同一 Feat 内换位时从旧坐标过渡到新坐标；换 Feat 或首次出现直接落位。没有会话或没有阶段轴时移除。
   */
  function placeRailBot(board, featPath, list) {
    const railIn = board.querySelector('.fb-rail-in');
    const cur = railIn?.querySelector('.fb-stage-item.current');
    const s = list[0];
    if (!s || !cur) { rbot.remove(); delete rbot.dataset.feat; return; }
    if (!railIn.getClientRects().length) { pendingPlace = true; return; }
    const k = key(featPath);
    let target = cur.querySelector('.fb-stage-dot'), onT = false;
    if (s.task && key(s.task.feat) === k && cur.querySelector('.fb-stage[data-tab="3"]')) {
      const tchip = cur.querySelector(`.fb-tchip[data-tjump="${CSS.escape(parentT(s.task.task))}"]`);
      if (tchip?.getClientRects().length) { target = tchip; onT = true; }
    }
    // 摘要行：当前阶段项的摘要换成最近活动（窄栏时摘要行整体隐藏，只剩悬停提示）
    cur.classList.add('fbx-busy');
    const sum = document.createElement('span');
    sum.className = 'fbx-sum';
    sum.textContent = (onT ? s.task.task + ' ' : '') + doingText(s);
    sum.title = sum.textContent;
    cur.querySelector('.fb-stage-meta').prepend(sum);

    const st0 = stateOf(s);
    if (rbot.dataset.sid !== s.id) rbot.querySelector(':scope > .fbx-say')?.remove();
    const lines = list.map((x) => {
      const a = lastAct.get(x.id), t = x.task && key(x.task.feat) === k ? ' ' + x.task.task : '';
      return `「${x.title}」${t}：${TEXT[stateOf(x)]}${a ? '，最近：' + actText(a) : ''}`;
    });
    rbot.dataset.state = st0;
    rbot.dataset.sid = s.id;
    rbot.title = `${lines.join('\n')}\n点击打开「${s.title}」`;
    rbot.setAttribute('aria-label', `${s.title}：${TEXT[st0]}，点击打开会话`);

    const r0 = railIn.getBoundingClientRect(), r = target.getBoundingClientRect();
    const x = Math.round((onT ? r.right - 2 : r.left + r.width / 2) - r0.left);
    const y = Math.round((onT ? r.top + 2 : r.top + r.height / 2) - r0.top);
    const jump = rbot.dataset.feat !== k;
    if (rbot.parentNode !== railIn) railIn.appendChild(rbot);
    rbot.classList.toggle('fbx-jump', jump);
    // 先让浏览器按旧坐标算一次样式，随后改坐标才会触发过渡（重绘后重新插入的元素也一样）
    rbot.getBoundingClientRect();
    rbot.classList.toggle('on-t', onT);
    rbot.style.left = x + 'px';
    rbot.style.top = y + 'px';
    if (jump) { rbot.getBoundingClientRect(); rbot.classList.remove('fbx-jump'); rbot.dataset.feat = k; }
  }
  /** 会话 id → 显示期内的活动气泡 { text, kind, t0 }：重绘会重建任务卡片小卡，气泡按已过时间续上，不从头播放。 */
  const bubbles = new Map();
  const SAY_MS = 2800;
  /** 把显示期内的气泡画到对应机器人上（任务卡片小卡与阶段轴机器人），已过期的移除。 */
  function paintBubbles() {
    const now = performance.now();
    for (const [id, b] of bubbles) {
      const elapsed = now - b.t0, hosts = [...document.querySelectorAll(`#feat-board .fbx-layer .fbx-chip[data-sid="${CSS.escape(id)}"]`)];
      if (rbot.isConnected && rbot.dataset.sid === id) hosts.push(rbot);
      if (elapsed >= SAY_MS) bubbles.delete(id);
      for (const c of hosts) {
        const old = c.querySelector(':scope > .fbx-say');
        if (elapsed >= SAY_MS) { old?.remove(); continue; }
        if (old?.dataset.t0 === String(b.t0)) continue;
        old?.remove();
        const el = document.createElement('span');
        el.className = 'fbx-say k-' + b.kind;
        el.dataset.t0 = b.t0;
        el.textContent = b.text;
        el.style.animationDelay = -elapsed + 'ms';
        c.appendChild(el);
      }
    }
  }
  /** 新活动：在对应机器人上冒一个气泡（约 2.6 秒淡出），到期后清掉。 */
  function say(id, a) {
    const text = actText(a);
    if (!text) return;
    bubbles.set(id, { text: text.length > 40 ? text.slice(0, 40) + '…' : text, kind: a.kind, t0: performance.now() });
    paintBubbles();
    setTimeout(paintBubbles, SAY_MS + 50);
  }
  let queued = false;
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; decorate(); }); } };
  /** 变动只发生在本脚本插入的装饰里（气泡出现 / 消失等）时不重画，否则重画会立刻清掉刚冒出的气泡。 */
  const ours = (n) => !!n.closest?.('.fbx-layer, .fbx-inline, .fbx-rbot, .fbx-sum');
  const observer = new MutationObserver((muts) => { if (muts.some((m) => !ours(m.target))) schedule(); });
  document.getElementById('feat-board').addEventListener('click', (e) => {
    const c = e.target.closest('.fbx-chip, .fbx-rbot');
    if (!c) return;
    e.stopPropagation();
    e.preventDefault();
    open(sessions.get(c.dataset.sid));
  }, true);
  window.addEventListener('resize', schedule);

  invoke('agent_list').then((list) => {
    for (const s of list) { sessions.set(s.id, s); if (s.acts?.length) lastAct.set(s.id, s.acts[s.acts.length - 1]); }
    ready = true;
    render(); schedule();
  }).catch((e) => { startupError = String(e); render(); });
  listen('agent-update', (e) => { sessions.set(e.payload.id, e.payload); render(); schedule(); });
  listen('agent-removed', (e) => { sessions.delete(e.payload.id); lastAct.delete(e.payload.id); render(); schedule(); });
  listen('agent-act', (e) => {
    lastAct.set(e.payload.id, e.payload.act);
    const s = sessions.get(e.payload.id), k = key(window.FeatPane?.curPath() || '');
    if (s && k && (key(s.feat) === k || (s.task && key(s.task.feat) === k))) { decorate(); say(e.payload.id, e.payload.act); }
  });
  // 当前图 / Feat 切换没有统一事件，按秒轮询；内容不变时 paint 不改 DOM。控件页从隐藏变为显示时补画（pendingPlace）
  let lastFeat = '';
  setInterval(() => {
    render();
    const f = window.FeatPane?.curPath() || '';
    if (f !== lastFeat || pendingPlace) { lastFeat = f; schedule(); }
  }, 1000);
  render();
})();
