// Agent 总览：真实会话构成的「流程图 → Feat → 会话」关系图；独立绘图层不改写关联或业务文件。
// 依赖 agent_core.js 的状态、路径与 Tauri 方法；打开会话和定位复用 agent.js 的入口。
'use strict';

window.AgentOverview = (() => {
  const nodeId = (kind, path) => `${kind}:${key(path)}`;
  const sessionId = (id) => `session:${id}`;
  const flowIcon = '<svg class="rel-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="5" y="1" width="6" height="4" rx="1"/><path d="M8 5v3M3 8h10M3 8v3M13 8v3"/><rect x="1" y="11" width="4" height="4" rx=".7"/><rect x="11" y="11" width="4" height="4" rx=".7"/></svg>';

  /** 按完整路径和会话 ID 建模；标签关联、独立会话、同名 Feat 和多子代理不会互相覆盖。 */
  function build(ss, catalog, tagged, selection, at = now()) {
    const nodes = new Map(), edges = new Map(), sessionNodes = [];
    const featIndex = new Map(catalog.flatMap((a) => a.feats.map((f) => [key(f.path), { ...f, app: a.app }])));
    const findFeat = (path) => featIndex.get(key(path));
    const add = (kind, path, data) => {
      const id = kind === 'session' ? sessionId(path) : nodeId(kind, path);
      if (!nodes.has(id)) nodes.set(id, { id, kind, path, owners: new Set(), ...data });
      return nodes.get(id);
    };
    const link = (from, to, kind, state, label) => {
      const id = JSON.stringify([kind, from, to]);
      if (!edges.has(id)) edges.set(id, { id, from, to, kind, state, label });
      return edges.get(id);
    };
    const addFlow = (path, owner, app) => {
      const n = add('flow', path, { label: base(path), detail: app || '', state: 'none' });
      if (owner) n.owners.add(owner);
      return n;
    };
    for (const s of [...ss].sort(byUrgency)) {
      const sn = add('session', s.id, { label: s.title, detail: stText(s), state: vs(s), session: s.id, source: s });
      sn.owners.add(s.id);
      sessionNodes.push(sn);
      let fn = null;
      if (s.feat) {
        const f = findFeat(s.feat);
        fn = add('feat', s.feat, { label: f?.title || base(s.feat).replace(/\.md$/i, ''), detail: `${f?.id || s.feat_code || ''} ${f?.status || ''}`.trim(), state: vs(s) });
        fn.owners.add(s.id);
        link(fn.id, sn.id, 'session', vs(s), `${fn.label} → ${s.title}：${stText(s)}`);
      }
      const refs = [...refsOf(s), ...(s.feat ? tagged.get(key(s.feat)) || [] : [])];
      for (const r of refs) {
        const flow = addFlow(r.flow, s.id, s.app);
        link(flow.id, fn?.id || sn.id, fn ? 'association' : 'session', fn ? 'none' : vs(s), fn ? `${flow.label} ↔ ${fn.label}` : `${flow.label} → ${s.title}：${stText(s)}`);
      }
      for (const w of s.workers || []) {
        if (!w.running && (!w.t1 || at - w.t1 > WINDOW)) continue;
        const id = `worker:${s.id}/${w.id}`;
        nodes.set(id, { id, kind: 'worker', label: w.desc, detail: w.running ? '子代理运行中' : '子代理已完成', state: w.running ? 'run' : 'off', owners: new Set([s.id]), session: s.id, worker: w.id, source: w });
        sessionNodes.push(nodes.get(id));
        link(sn.id, id, 'worker', w.running ? 'run' : 'off', `${s.title} → 子代理：${w.desc}`);
      }
    }
    // 主窗口当前对象即便没有会话也保留，避免空白总览无法表达当前查看的图或 Feat。
    if (selection?.featPath) {
      const f = findFeat(selection.featPath);
      const fn = add('feat', selection.featPath, { label: f?.title || base(selection.featPath), detail: f?.id || '', state: 'none' });
      for (const r of tagged.get(key(selection.featPath)) || []) {
        const flow = addFlow(r.flow, '', f?.app);
        link(flow.id, fn.id, 'association', 'none', `${flow.label} ↔ ${fn.label}`);
      }
    } else if (selection?.path) addFlow(selection.path, '', '');
    const files = new Map();
    for (const s of ss) for (const a of s.acts) {
      if (a.kind !== 'edit' || !a.path || at - a.t > 30 * 60000) continue;
      const k = key(a.path);
      if (!files.has(k)) files.set(k, { path: a.path, ids: new Set(), t: a.t });
      files.get(k).ids.add(s.id);
      files.get(k).t = Math.max(files.get(k).t, a.t);
    }
    const pairLink = (a, b, kind, label, t) => {
      if (a === b || !nodes.has(sessionId(a)) || !nodes.has(sessionId(b))) return;
      const [from, to] = [sessionId(a), sessionId(b)].sort();
      const e = link(from, to, kind, kind === 'conflict' ? 'err' : 'none', label);
      if (!e.t || t >= e.t) { e.label = label; e.t = t; }
    };
    for (const f of files.values()) {
      const ids = [...f.ids];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairLink(ids[i], ids[j], 'conflict', `同改 ${base(f.path)}（近 30 分钟）`, f.t);
    }
    // peer 来自后端真实消息目标，不按显示名称或同 APP 推断协作关系。
    for (const s of ss) for (const a of s.acts) {
      if (a.kind === 'msg' && a.peer && at - a.t <= 30 * 60000) pairLink(s.id, a.peer, 'collab', `协作消息：${a.text}`, a.t);
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()], sessions: sessionNodes };
  }

  let model = { nodes: [], edges: [], sessions: [] }, selected = '', mode = 'graph', signature = '';
  const tagged = new Map(), loads = new Map(), hot = new Map();
  let drawQueued = false;

  /** 只加载参与总览的 Feat 标签节点；失败显示可重试入口，不把失败当作无关联。 */
  function loadRelations() {
    const paths = new Set(list().map((s) => s.feat).filter(Boolean));
    if (mainSel?.featPath) paths.add(mainSel.featPath);
    for (const path of paths) {
      const k = key(path), f = featEntry(path);
      if (!f || loads.has(k)) continue;
      const request = { pending: true, error: '' };
      loads.set(k, request);
      invoke('tagged_nodes', { flowDir: f.app.flow_dir, tag: f.id }).then((rows) => {
        if (loads.get(k) === request) tagged.set(k, rows.map((r) => ({ flow: r.file, node: r.node.id })));
      }).catch((e) => { request.error = String(e); }).finally(() => {
        request.pending = false;
        if (active === 'OV') render();
      });
    }
  }

  /** 生成当前选择的一跳任务关系链；协作与同文件提醒包含对方会话，避免整张图递归全亮。 */
  function chain(id) {
    const n = model.nodes.find((x) => x.id === id);
    if (!n) return null;
    const original = new Set([...n.owners].map(sessionId)), owners = new Set(n.owners);
    for (const e of model.edges) {
      if (!['conflict', 'collab'].includes(e.kind)) continue;
      const peerId = original.has(e.from) ? e.to : original.has(e.to) ? e.from : '';
      const peer = model.nodes.find((x) => x.id === peerId);
      if (peer) for (const o of peer.owners) owners.add(o);
    }
    const result = new Set([id]);
    for (const x of model.nodes) if ([...x.owners].some((o) => owners.has(o))) result.add(x.id);
    for (const e of model.edges) if (e.kind === 'association' && (e.from === id || e.to === id)) { result.add(e.from); result.add(e.to); }
    return result;
  }

  /** 选择节点只改变高亮，不启动 CLI；再次点击或点背景清除。 */
  function highlight(id) {
    selected = selected === id ? '' : id;
    applyHighlight();
  }
  /** 同步卡片、连线和辅助文本的高亮，保留键盘选择状态。 */
  function applyHighlight() {
    const g = $('#rel-graph');
    if (!g) return;
    const set = selected && chain(selected);
    g.classList.toggle('filtered', !!set);
    $$('.rel-node', g).forEach((el) => { el.classList.toggle('lit', !!set && set.has(el.dataset.rel)); el.classList.toggle('selected', el.dataset.rel === selected); el.setAttribute('aria-pressed', String(el.dataset.rel === selected)); });
    $$('[data-from]', g).forEach((el) => el.classList.toggle('lit', !!set && set.has(el.dataset.from) && set.has(el.dataset.to)));
  }

  /** 卡片完整路径与状态放在原生提示中，图上仅保留标题、状态、打开按钮。 */
  function card(n) {
    const main = n.kind === 'flow' ? !mainSel?.featPath && key(mainSel?.path) === key(n.path) : n.kind === 'feat' && key(mainSel?.featPath) === key(n.path);
    const clockHtml = n.kind === 'session' ? `<span data-tk="${esc(n.session)}">${esc(timeText(n.source))}</span>` : n.kind === 'worker' && n.source.running ? `<span data-wk="${esc(n.session)}/${esc(n.worker)}">${clock(now() - n.source.t0)}</span>` : '';
    const icon = n.kind === 'flow' ? flowIcon : n.kind === 'feat' ? '<i class="rel-dot" aria-hidden="true"></i>' : bot();
    return `<div class="rel-node rel-${n.kind} v-${n.state}" data-rel="${esc(n.id)}" tabindex="0" role="button" aria-pressed="false" aria-label="${esc(n.label + '，' + n.detail)}" title="${esc([n.label, n.detail, n.kind === 'flow' || n.kind === 'feat' ? n.path : '', '单击高亮关联，双击打开'].filter(Boolean).join('\n'))}">
      ${icon}<div class="rel-copy"><b>${esc(n.label)}</b><small><span>${esc(n.detail)}</span>${clockHtml}</small></div>${main ? '<span class="mt">主窗口</span>' : ''}${n.kind === 'session' ? `<button class="rel-open" data-open="${esc(n.session)}">打开</button>` : ''}</div>`;
  }

  /** 关系图的可访问列表视图；打开和定位仍使用原有委托事件。 */
  function tableView() {
    return `<div class="rel-table-wrap"><table class="rel-table"><caption>会话与流程图、Feat 的关联</caption><thead><tr><th>会话</th><th>Feat</th><th>流程图 / 节点</th><th>状态</th></tr></thead><tbody>${list().sort(byUrgency).map((s) => `<tr><td><button data-open="${esc(s.id)}">${esc(s.title)}</button></td><td>${s.feat ? `<button data-feat="${esc(s.id)}">${esc(s.feat_code || base(s.feat))}</button>` : '—'}</td><td>${refsOf(s).map((r) => `<button data-ref="${esc(r.flow)}" data-node="${esc(r.node)}">${esc(refLabel(r))}</button>`).join(' ') || '—'}</td><td>${stText(s)} <span data-tk="${esc(s.id)}">${esc(timeText(s))}</span></td></tr>`).join('')}</tbody></table></div>`;
  }

  /** 按结构签名更新总览，普通心跳不重建卡片；关联查询与状态事件只补真实数据。 */
  function render() {
    const ov = $('#ov');
    if (!ov.querySelector('.rel-content')) {
      ov.innerHTML = '<div class="attn"></div><div class="rel-tools"><span class="rel-load" role="status"></span><button class="rel-mode" data-rel-mode="1">列表视图</button></div><div class="rel-content"></div>';
      signature = '';
    }
    const items = attnItems(), notice = `<span class="attn-l">${items.length ? '需要你处理' : '目前没有需要你处理的会话'}</span>${items.join('')}`;
    if ($('.attn', ov).innerHTML !== notice) $('.attn', ov).innerHTML = notice;
    loadRelations();
    model = build(list(), apps, tagged, mainSel);
    if (!model.nodes.some((n) => n.id === selected)) selected = '';
    const errors = [...loads.values()].filter((v) => v.error), pending = [...loads.values()].some((v) => v.pending);
    $('.rel-load', ov).innerHTML = errors.length ? '<button data-rel-retry="1">部分 Feat 关联读取失败，点击重试</button>' : pending ? '读取 Feat 关联中…' : '';
    const sig = JSON.stringify([mode, mainSel, model.nodes.map(({ source, owners, ...n }) => n), model.edges]);
    if (sig !== signature) {
      signature = sig;
      $('.rel-mode', ov).textContent = mode === 'graph' ? '列表视图' : '关系图';
      $('.rel-content', ov).innerHTML = !model.nodes.length ? '<div class="ovempty">还没有会话。点「新建会话」，关联流程图或 Feat 后即可查看关系。</div>' : mode === 'table' ? tableView() : `<div class="rel-scroll"><div class="rel-graph" id="rel-graph" role="group" aria-label="流程图、Feat 与 Claude Code 会话关系图"><svg class="rel-edges" aria-hidden="true"></svg><h3>流程图</h3><h3>Feat</h3><h3>Claude Code 会话</h3><div class="rel-col">${model.nodes.filter((n) => n.kind === 'flow').map(card).join('') || '<p class="rel-empty">尚未关联流程图</p>'}</div><div class="rel-col">${model.nodes.filter((n) => n.kind === 'feat').map(card).join('') || '<p class="rel-empty">未关联 Feat 的会话直接连接流程图</p>'}</div><div class="rel-col">${model.sessions.map(card).join('') || '<p class="rel-empty">暂无关联会话</p>'}</div></div></div><div class="rel-legend"><span><i class="live"></i>运行中</span><span><i class="wait"></i>等待确认</span><span><i class="conflict"></i>异常 / 同文件修改</span><span><i class="collab"></i>协作消息</span><span><i class="worker"></i>子代理</span></div><p class="hint">单击高亮关联，再点一次或点空白处恢复；双击图、Feat 或会话打开。连线依据实际关联和最近 30 分钟活动，同文件提醒不代表已发生内容冲突。</p>`;
    }
    scheduleDraw();
  }

  /** 从实际卡片边界计算曲线；滚动、缩放、窗口改尺寸后仍准确连接，右侧弧线保留独立空间。 */
  function draw() {
    const g = $('#rel-graph');
    if (!g || !g.clientWidth || active !== 'OV') return;
    const gr = g.getBoundingClientRect(), rects = new Map();
    $$('.rel-node', g).forEach((el) => { const r = el.getBoundingClientRect(); rects.set(el.dataset.rel, { l: r.left - gr.left, r: r.right - gr.left, y: r.top - gr.top + r.height / 2, b: r.bottom - gr.top }); });
    const captions = new Set();
    const paths = model.edges.map((e) => {
      const a = rects.get(e.from), b = rects.get(e.to);
      if (!a || !b) return '';
      let d;
      if (['collab', 'conflict'].includes(e.kind)) {
        const bend = Math.max(a.r, b.r) + (e.kind === 'collab' ? 122 : 68);
        d = `M${a.r},${a.y} C${bend},${a.y} ${bend},${b.y} ${b.r},${b.y}`;
      } else if (e.kind === 'worker') d = `M${a.l + 10},${a.b} L${a.l + 10},${b.y} L${b.l},${b.y}`;
      else { const dx = Math.max(28, (b.l - a.r) / 2); d = `M${a.r},${a.y} C${a.r + dx},${a.y} ${b.l - dx},${b.y} ${b.l},${b.y}`; }
      const arc = ['collab', 'conflict'].includes(e.kind);
      const label = e.kind === 'collab' ? '协作消息' : e.label.replace('（近 30 分钟）', '');
      const showCaption = arc && !captions.has(e.label);
      if (showCaption) captions.add(e.label);
      const caption = showCaption ? `<text class="rel-edge-label" data-from="${esc(e.from)}" data-to="${esc(e.to)}" x="${Math.max(a.r, b.r) + 14}" y="${(a.y + b.y) / 2 - 5}"><title>${esc(e.label)}</title>${esc(label.length > 15 ? label.slice(0, 14) + '…' : label)}</text>` : '';
      return `<path class="rel-edge ${e.kind} v-${e.state}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${d}"><title>${esc(e.label)}</title></path>${caption}`;
    });
    const svg = $('.rel-edges', g);
    svg.setAttribute('viewBox', `0 0 ${gr.width} ${gr.height}`);
    svg.innerHTML = paths.join('');
    applyHighlight();
    for (const id of hot.keys()) applyHot(id, true);
  }
  /** 一帧内多次尺寸或数据更新合并为一次几何计算。 */
  function scheduleDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  /** 工具活动只闪亮所属会话和当前图上的关系线，不让同 APP 的无关会话一起发光。 */
  function applyHot(id, on) {
    $$('#rel-graph .rel-node').forEach((el) => { if (el.dataset.rel === id) el.classList.toggle('hot', on); });
    $$('#rel-graph .rel-edge').forEach((el) => { if (el.dataset.from === id || el.dataset.to === id) el.classList.toggle('hot', on); });
  }
  /** 真实活动让会话和所属图短暂高亮；同一对象的新活动延长本次显示，不累积定时器。 */
  function activity(s, a) {
    if (active !== 'OV') return;
    const ids = [sessionId(s.id)];
    if (a.flow) ids.push(nodeId('flow', a.flow));
    for (const id of ids) {
      clearTimeout(hot.get(id));
      applyHot(id, true);
      hot.set(id, setTimeout(() => { hot.delete(id); applyHot(id, false); }, 900));
    }
  }

  /** 双击打开对象；无会话的 Feat 打开主窗口档案，子代理打开其父会话。 */
  function openNode(id) {
    const n = model.nodes.find((x) => x.id === id);
    if (!n) return;
    if (n.session) openSession(n.session);
    else if (n.kind === 'flow') locate(n.path, '');
    else {
      const s = list().filter((x) => key(x.feat) === key(n.path)).sort(byUrgency)[0];
      if (s) openSession(s.id); else emit('agent-locate', { feat: n.path });
    }
  }

  /** 一次性安装委托，渲染替换卡片不会累积监听或影响其他会话页签。 */
  function init() {
    const ov = $('#ov');
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-rel-mode]')) { mode = mode === 'graph' ? 'table' : 'graph'; render(); return; }
      if (e.target.closest('[data-rel-retry]')) { for (const [k, v] of loads) if (v.error) loads.delete(k); render(); return; }
      if (e.target.closest('[data-open]')) return;
      const n = e.target.closest('[data-rel]');
      if (n) highlight(n.dataset.rel); else if (e.target.closest('.rel-graph')) { selected = ''; applyHighlight(); }
    });
    ov.addEventListener('dblclick', (e) => { const n = e.target.closest('[data-rel]'); if (n && !e.target.closest('[data-open]')) openNode(n.dataset.rel); });
    ov.addEventListener('keydown', (e) => {
      const n = e.target.closest('[data-rel]');
      if (e.key === 'Escape') { selected = ''; applyHighlight(); }
      if (n && e.target === n && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); if (e.key === ' ') highlight(n.dataset.rel); else openNode(n.dataset.rel); }
    });
    new ResizeObserver(scheduleDraw).observe(ov);
    window.addEventListener('resize', scheduleDraw);
    // 空闲会话可能长期没有事件；定期剔除过期协作、同文件提醒与已结束子代理，签名不变时不重建卡片。
    setInterval(() => { if (active === 'OV') render(); }, 30000);
  }
  /** 标签图发生变化后失效缓存，未显示总览时延后加载。 */
  function invalidate() { loads.clear(); tagged.clear(); if (active === 'OV') render(); }
  return { build, render, activity, init, invalidate };
})();
