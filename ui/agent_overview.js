// Agent 总览：真实会话构成的「流程图 → Feat → 会话」关系图；独立绘图层不改写关联或业务文件。
// 依赖 agent_core.js 的状态、路径与 Tauri 方法；打开会话和定位复用 agent.js 的入口。
'use strict';

window.AgentOverview = (() => {
  const nodeId = (kind, path) => `${kind}:${key(path)}`;
  const sessionId = (id) => `session:${id}`;
  const flowIcon = '<svg class="rel-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="5" y="1" width="6" height="4" rx="1"/><path d="M8 5v3M3 8h10M3 8v3M13 8v3"/><rect x="1" y="11" width="4" height="4" rx=".7"/><rect x="11" y="11" width="4" height="4" rx=".7"/></svg>';

  /** 按完整路径和会话 ID 建模；标签关联、独立会话、同名 Feat 和多子代理不会互相覆盖。 */
  function build(ss, catalog, tagged, selection, at = now()) {
    ss = ss.filter((s) => !s.archived_at && !s.stored_at);
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

  let model = { nodes: [], edges: [], sessions: [] }, selected = '', signature = '';
  const tagged = new Map(), loads = new Map(), hot = new Map();
  let drawQueued = false;
  // 下方操作区：所选 Agent 的真实终端（与会话页签共用同一 xterm 实例）；子代理没有独立 PTY，归入父会话。
  const DOCK_KEY = 'fc-agent-ov-dock', SPLIT_KEY = 'fc-agent-ov-split';
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const write = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* 存储不可用时只保留本次选择 */ } };
  const DOCK_VISIBLE_KEY = 'fc-agent-overview-dock-visible';
  let dockId = read(DOCK_KEY), dockSig = '', dockVisible = read(DOCK_VISIBLE_KEY) !== '0';
  // 只为新出现的卡片和连线播放一次入场；状态刷新、尺寸变化重画不重复播放。
  // 记录首次出现时间：入场期间若被重画，按已过时间续播，不因频繁刷新被截断或重来。
  const seenNodes = new Map(), seenEdges = new Map(), INTRO = 640;
  /** 返回入场类名与续播延迟；超过入场时长返回 null。 */
  function intro(seen, id) {
    const t = performance.now();
    if (!seen.has(id)) seen.set(id, t);
    const age = t - seen.get(id);
    return age < INTRO ? { delay: age > 0 ? ` style="animation-delay:${-Math.round(age)}ms"` : '' } : null;
  }
  /** 卡片对应的终端归属：会话即自身，子代理归父会话；流程图与 Feat 没有输入通道。 */
  const dockTarget = (n) => (n && (n.kind === 'session' || n.kind === 'worker') ? n.session : '');

  /** 收纳或归档的来源不因主窗口选中而重新进入概览；手动启用的会话仍可显示。 */
  function overviewSelection() {
    if (!mainSel) return null;
    const kind = mainSel.featPath ? 'feat' : 'flow', path = mainSel.featPath || mainSel.path;
    const owners = [...S.values()].filter((s) => sourceOf(s).kind === kind && key(sourceOf(s).path) === key(path));
    if (owners.length && !owners.some((s) => !s.archived_at && !s.stored_at)) return null;
    if (mainSel.featPath && /^已关闭/.test(featEntry(path)?.status || '') && !list().some((s) => key(s.feat) === key(path))) return null;
    return mainSel;
  }

  /** 只加载参与总览的 Feat 标签节点；失败显示可重试入口，不把失败当作无关联。 */
  function loadRelations() {
    const paths = new Set(list().map((s) => s.feat).filter(Boolean));
    const selection = overviewSelection();
    if (selection?.featPath) paths.add(selection.featPath);
    for (const path of paths) {
      const k = key(path), f = featEntry(path);
      if (!f || loads.has(k)) continue;
      const request = { pending: true, error: '' };
      loads.set(k, request);
      invoke('tagged_nodes', { flowDir: f.app.flow_dir, tag: f.id }).then((rows) => {
        if (loads.get(k) === request) tagged.set(k, rows.map((r) => ({ flow: r.file, node: r.id })));
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
    $$('.rel-node', g).forEach((el) => { el.classList.toggle('lit', !!set && set.has(el.dataset.rel)); el.classList.toggle('selected', el.dataset.rel === selected); el.classList.toggle('docked', !!dockId && el.dataset.rel === sessionId(dockId)); el.setAttribute('aria-pressed', String(el.dataset.rel === selected)); });
    $$('[data-from]', g).forEach((el) => el.classList.toggle('lit', !!set && set.has(el.dataset.from) && set.has(el.dataset.to)));
  }

  /** 卡片完整路径与状态放在原生提示中，图上仅保留标题、状态、打开按钮；新卡片按列先后入场。 */
  function card(n) {
    const main = n.kind === 'flow' ? !mainSel?.featPath && key(mainSel?.path) === key(n.path) : n.kind === 'feat' && key(mainSel?.featPath) === key(n.path);
    const clockHtml = n.kind === 'session' ? `<span data-tk="${esc(n.session)}">${esc(timeText(n.source))}</span>` : n.kind === 'worker' && n.source.running ? `<span data-wk="${esc(n.session)}/${esc(n.worker)}">${clock(now() - n.source.t0)}</span>` : '';
    const icon = n.kind === 'flow' ? flowIcon : n.kind === 'feat' ? `<span class="rel-icon rel-feat-icon" aria-hidden="true">${ICON.feat}</span>` : bot();
    const fresh = intro(seenNodes, n.id);
    const tip = n.kind === 'session' ? '单击在下方终端操作，双击在页签打开' : n.kind === 'worker' ? '子代理随父会话运行；单击在下方显示父会话终端' : '单击高亮关联，双击打开';
    return `<div class="rel-node rel-${n.kind} v-${n.state}${fresh ? ' rel-in' : ''}" data-rel="${esc(n.id)}"${fresh ? fresh.delay : ''} tabindex="0" role="button" aria-pressed="false" aria-label="${esc(n.label + '，' + n.detail)}" title="${esc([n.label, n.detail, n.source?.api_error, n.kind === 'flow' || n.kind === 'feat' ? n.path : '', tip].filter(Boolean).join('\n'))}">
      ${icon}<div class="rel-copy"><b>${esc(n.label)}</b><small><span>${esc(n.detail)}</span>${clockHtml}</small></div>${main ? '<span class="mt">主窗口</span>' : ''}${n.kind === 'session' ? `<button class="rel-open" data-open="${esc(n.session)}" title="在会话页签中打开" aria-label="在页签中打开 ${esc(n.label)}">${ICON.tabOpen}</button>` : ''}</div>`;
  }

  /** 按结构签名更新总览，普通心跳不重建卡片；关联查询与状态事件只补真实数据。 */
  function render() {
    const ov = $('#ov');
    if (!ov.querySelector('.rel-content')) shell(ov);
    loadRelations();
    model = build(list(), apps, tagged, overviewSelection());
    if (!model.nodes.some((n) => n.id === selected)) selected = '';
    const errors = [...loads.values()].filter((v) => v.error), pending = [...loads.values()].some((v) => v.pending);
    $('.rel-load', ov).innerHTML = errors.length ? '<button data-rel-retry="1">部分 Feat 关联读取失败，点击重试</button>' : pending ? '读取 Feat 关联中…' : '';
    const sig = JSON.stringify([mainSel, model.nodes.map(({ source, owners, ...n }) => n), model.edges]);
    if (sig !== signature) {
      signature = sig;
      const flows = model.nodes.filter((n) => n.kind === 'flow'), feats = model.nodes.filter((n) => n.kind === 'feat');
      const arcs = model.edges.some((e) => e.kind === 'collab' || e.kind === 'conflict');
      $('.rel-content', ov).innerHTML = !model.nodes.length ? '<div class="ovempty">还没有会话。点「新建会话」，关联流程图或 Feat 后即可查看关系。</div>' : `<div class="rel-scroll"><div class="rel-graph${arcs ? ' has-arcs' : ''}" id="rel-graph" role="group" aria-label="流程图、Feat 与 Claude Code 会话关系图"><svg class="rel-edges" aria-hidden="true"></svg><div class="rel-col c0" aria-label="流程图">${flows.map(card).join('') || '<p class="rel-empty">尚未关联流程图</p>'}</div><div class="rel-col c1" aria-label="Feat">${feats.map(card).join('') || '<p class="rel-empty">未关联 Feat 的会话直接连接流程图</p>'}</div><div class="rel-col c2" aria-label="会话">${model.sessions.map(card).join('') || '<p class="rel-empty">暂无关联会话</p>'}</div></div></div>`;
    }
    syncDock();
    scheduleDraw();
  }

  /** 总览骨架只建一次：上方关系图、可拖动分隔条、下方终端操作区；终端容器在重绘间保持不变。 */
  function shell(ov) {
    ov.innerHTML = `<div class="ov-top"><div class="rel-tools"><span class="rel-load" role="status"></span><button data-dock-toggle="1" aria-controls="ovDock" aria-expanded="true">隐藏底栏</button></div><div class="rel-content"></div></div>
      <div class="ov-split" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="调整关系图与终端高度" title="上下拖动调整高度；双击恢复默认"></div>
      <section class="ov-dock" id="ovDock" aria-label="Agent 终端"><header class="dock-head"></header><div class="dock-body"><div class="dock-term" id="ovTerm"></div><div class="dock-empty"></div></div></section>`;
    signature = ''; dockSig = '';
    const ratio = parseFloat(read(SPLIT_KEY));
    if (ratio > 0 && ratio < 1) ov.style.setProperty('--dock', ratio * 100 + '%');
    new ResizeObserver(() => { if (active === 'OV' && dockVisible && dockId) fitTerm(dockId); }).observe($('#ovTerm', ov));
    setDockVisible(dockVisible, false);
  }

  /** 显隐底栏与分隔条并记住选择；保留所选会话及终端实例，重新显示时恢复尺寸。 */
  function setDockVisible(visible, remember = true) {
    dockVisible = visible;
    if (remember) write(DOCK_VISIBLE_KEY, visible ? '1' : '0');
    const ov = $('#ov'), button = $('[data-dock-toggle]', ov);
    $('.ov-dock', ov).hidden = !visible;
    $('.ov-split', ov).hidden = !visible;
    button.textContent = visible ? '隐藏底栏' : '显示底栏';
    button.setAttribute('aria-expanded', String(visible));
    if (visible) {
      syncDock();
      requestAnimationFrame(() => { if (active === 'OV' && dockVisible && dockId) fitTerm(dockId); });
    }
    scheduleDraw();
  }

  /** 操作区标题：会话切换入口、状态与启动 / 重试，以及在页签打开。不显示聊天气泡或推测回复。 */
  function dockHead(ss, s) {
    if (!ss.length) return '<span class="dock-title">暂无 Agent 会话</span>';
    const picks = ss.map((x) => `<button class="dock-pick v-${vs(x)}${x === s ? ' on' : ''}" data-dock="${esc(x.id)}" aria-pressed="${x === s}" title="${esc(x.title + '：' + stText(x))}">${bot()}<span>${esc(x.title)}</span></button>`).join('');
    let state = '';
    if (s) {
      const starting = startingSessions.has(s.id), error = startErrors.get(s.id) || (vs(s) === 'err' ? `CLI 异常退出（代码 ${s.exit_code ?? '?'}）` : '');
      state = s.running ? `<span class="dock-st v-${vs(s)}" title="${esc(s.api_error || '')}">${stText(s)} <span data-tk="${esc(s.id)}">${esc(timeText(s))}</span></span>`
        : starting ? '<span class="dock-st v-boot">正在连接 CLI…</span>'
        : `<span class="dock-st${error ? ' v-err' : ''}" title="${esc(error)}">${esc(error || '待命，按 Enter 启动')}</span><button class="dock-btn" data-dock-start="${esc(s.id)}">${error ? '重试' : '启动'}</button>`;
      state += `<button class="dock-icon" data-open="${esc(s.id)}" title="在会话页签中打开" aria-label="在页签中打开 ${esc(s.title)}">${ICON.tabOpen}</button>`;
    }
    return `<div class="dock-picks" role="group" aria-label="选择 Agent">${picks}</div>${state}`;
  }

  /** 同步操作区：所选会话被收纳、归档或删除时退回选择入口；只在终端换容器时重排，普通刷新不触碰终端。 */
  function syncDock() {
    const ov = $('#ov'), host = $('#ovTerm', ov);
    if (!host) return;
    const ss = list().sort(byUrgency);
    if (dockId && !ss.some((x) => x.id === dockId)) setDock('');
    const s = dockId ? S.get(dockId) : null;
    const sig = JSON.stringify([dockId, ss.map((x) => [x.id, x.title, vs(x)]), s && [s.running, s.api_error, startingSessions.has(s.id), startErrors.get(s.id) || '', s.exit_code]]);
    if (sig !== dockSig) {
      dockSig = sig;
      $('.dock-head', ov).innerHTML = dockHead(ss, s);
      $('.dock-empty', ov).innerHTML = ss.length
        ? `${bot()}<b>选择一个 Agent，直接在这里输入</b><span>单击上方 Agent 卡片或这一栏的会话名 · <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span>`
        : '<b>新建会话后，可以在这里直接与 Agent 对话</b><button class="dock-btn" data-dock-new="1">新建会话</button>';
    }
    $('.ov-dock', ov).classList.toggle('docked', !!s);
    if (!s || active !== 'OV' || !dockVisible) return;
    const moved = !terms.has(s.id) || terms.get(s.id).el.parentNode !== host;
    const t = mountTerm(s.id, host);
    if (moved) {
      t.el.classList.remove('term-in'); void t.el.offsetWidth; t.el.classList.add('term-in');
      fitTerm(s.id);
      requestAnimationFrame(() => fitTerm(s.id));
    }
  }

  /** 切换操作区会话：原终端回到页签容器（隐藏），新会话挂入；同一实例保留内容、滚动与未发送输入。 */
  function setDock(id, focus) {
    const host = $('#ovTerm');
    if (id !== dockId) {
      if (host) for (const x of terms.values()) if (x.el.parentNode === host) { x.el.hidden = true; $('#terms').appendChild(x.el); }
      dockId = id;
      write(DOCK_KEY, id);
    }
    if (host) syncDock();
    applyHighlight();
    if (focus && dockVisible && id && S.get(id)) terms.get(id)?.term.focus();
  }

  /** 拖动或方向键调整上下比例；终端至少保留可输入高度，关系图保留可读高度。 */
  function resizeSplit(ov, clientY) {
    const r = ov.getBoundingClientRect();
    const dock = Math.min(r.height - 120, Math.max(180, r.bottom - clientY));
    const ratio = Math.min(.85, Math.max(.15, dock / r.height));
    ov.style.setProperty('--dock', ratio * 100 + '%');
    return ratio;
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
      // 新关系只入场一次：实线用描边生长，虚线（运行、异常、子代理、同文件）淡入，避免改写虚线节奏。
      const fresh = intro(seenEdges, e.id);
      const dashed = e.kind === 'worker' || e.kind === 'conflict' || (e.kind === 'session' && ['run', 'tool', 'boot', 'err'].includes(e.state));
      const cls = fresh ? (dashed ? ' rel-fade' : ' rel-grow') : '';
      return `<path class="rel-edge ${e.kind} v-${e.state}${cls}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${d}"${cls === ' rel-grow' ? ' pathLength="1"' : ''}${fresh ? fresh.delay : ''}><title>${esc(e.label)}</title></path>${caption}`;
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
  /** 真实活动让会话和所属图短暂高亮并扩散一圈；同一对象的新活动重新起跳并延长显示，不累积定时器。 */
  function activity(s, a) {
    if (active !== 'OV') return;
    const ids = [sessionId(s.id)];
    if (a.flow) ids.push(nodeId('flow', a.flow));
    for (const id of ids) {
      clearTimeout(hot.get(id));
      applyHot(id, true);
      $$('#rel-graph .rel-node').forEach((el) => { if (el.dataset.rel === id) { el.classList.remove('ping'); void el.offsetWidth; el.classList.add('ping'); } });
      hot.set(id, setTimeout(() => { hot.delete(id); applyHot(id, false); }, 1400));
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
    const target = (id) => dockTarget(model.nodes.find((x) => x.id === id));
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-dock-toggle]')) { setDockVisible(!dockVisible); return; }
      if (e.target.closest('[data-rel-retry]')) { for (const [k, v] of loads) if (v.error) loads.delete(k); render(); return; }
      if (e.target.closest('[data-open]')) return;
      const pick = e.target.closest('[data-dock]');
      if (pick) { selected = sessionId(pick.dataset.dock); setDock(pick.dataset.dock, true); return; }
      const start = e.target.closest('[data-dock-start]');
      if (start) { startErrors.delete(start.dataset.dockStart); startSession(start.dataset.dockStart); terms.get(start.dataset.dockStart)?.term.focus(); return; }
      if (e.target.closest('[data-dock-new]')) { openNewBox(); return; }
      const n = e.target.closest('[data-rel]');
      if (n) { highlight(n.dataset.rel); const id = target(n.dataset.rel); if (id) setDock(id, true); }
      else if (e.target.closest('.rel-graph')) { selected = ''; applyHighlight(); }
    });
    ov.addEventListener('dblclick', (e) => {
      if (e.target.closest('.ov-split')) { ov.style.removeProperty('--dock'); write(SPLIT_KEY, ''); return; }
      const n = e.target.closest('[data-rel]'); if (n && !e.target.closest('[data-open]')) openNode(n.dataset.rel);
    });
    ov.addEventListener('keydown', (e) => {
      // 终端内的 Esc、Enter 属于 CLI（中断、发送），不交给关系图处理。
      if (e.target.closest('.ov-dock')) return;
      const split = e.target.closest('.ov-split');
      if (split && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const dock = $('.ov-dock', ov).getBoundingClientRect();
        write(SPLIT_KEY, String(resizeSplit(ov, dock.top + (e.key === 'ArrowUp' ? -24 : 24))));
        return;
      }
      const n = e.target.closest('[data-rel]');
      if (e.key === 'Escape') { selected = ''; applyHighlight(); }
      if (n && e.target === n && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        if (e.key === ' ') { highlight(n.dataset.rel); const id = target(n.dataset.rel); if (id) setDock(id, false); } else openNode(n.dataset.rel);
      }
    });
    ov.addEventListener('pointerdown', (e) => {
      const split = e.target.closest('.ov-split');
      if (!split || e.button !== 0) return;
      e.preventDefault();
      split.setPointerCapture(e.pointerId);
      split.classList.add('drag');
      let ratio = 0;
      const move = (ev) => { ratio = resizeSplit(ov, ev.clientY); };
      const up = () => { split.classList.remove('drag'); split.removeEventListener('pointermove', move); if (ratio) write(SPLIT_KEY, String(ratio)); };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', up, { once: true });
      split.addEventListener('pointercancel', up, { once: true });
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
