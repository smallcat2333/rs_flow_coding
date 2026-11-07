// 画布上的 Agent：在 draw.io 画布节点旁显示正在处理它的 Claude Code 会话（机器人图标 + 状态），
// 节点按最近活动发光：4 秒内为“正在处理”，之后 1 分钟内逐渐淡出。
// 运行在 drawio iframe 里（index.html 由 fetch_drawio.py 注入），借用外层窗口的 window.__TAURI__：
// - 状态：agent_list 初始化，agent-update / agent-act / agent-removed 增量更新（后端 agent.rs 广播）；
// - 选中节点 / 打开 Feat：发 agent-main-select，Agent 窗口按“跟随主窗口”切会话；
// - Agent 窗口的“在主窗口定位”：收 agent-locate，用外层 FlowLink.reveal / Tabs.openNew 打开并选中。
// 当前图路径来自外层发给 iframe 的 fc-path 消息，Feat 来自 fc-highlight 消息（与 flow_bridge.js 共用同一消息）。
(function () {
  'use strict';
  var P = window.parent;
  var T = P && P !== window && P.__TAURI__;
  if (!T) return;
  var invoke = T.core.invoke, listen = T.event.listen, emit = T.event.emit;
  var LIVE = 4000, FADE = 60000, STALL = 60000;
  var SHOW = { run: 1, tool: 1, stall: 1, wait: 1, err: 1, boot: 1 };
  var STATE = { run: '运行中', tool: '执行中', stall: '可能停滞', wait: '等你确认', err: '异常退出', boot: '启动中' };
  var KC = { read: '#8c959f', edit: '#4493f8', cmd: '#3fb950', commit: '#3fb950', msg: '#4493f8', worker: '#3fb950' };
  var BOT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle class="ant" cx="8" cy="1.3" r="1.05"/><rect x="2.4" y="3.7" width="11.2" height="9.2" rx="2.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle class="eye" cx="5.9" cy="8.2" r="1.15"/><circle class="eye" cx="10.1" cy="8.2" r="1.15"/><path d="M.9 7.4v2.6M15.1 7.4v2.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

  var path = '';          // 当前图的绝对路径
  var lastTag = '';       // 主窗口当前 Feat（fc-highlight 的 tag）
  var sessions = {};      // id → 会话视图（acts 为最近活动）
  var graph = null, layer = null, badge = null;
  var zoomPreview = null;  // 正式坐标提交前，画布 CSS 缩放预览的比例与原点
  var glows = {};         // 节点 id → 发光框元素
  var suppress = { node: '', t: 0 };  // 刚被 Agent 窗口定位的节点：随后的选中事件不再回传
  var show = localStorage.getItem('fc-agent-overlay') !== '0';

  /** Windows 路径比较键。 */
  function key(p) { return String(p || '').replace(/\//g, '\\').toLowerCase(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function now() { return Date.now(); }
  /** 分:秒 计时。 */
  function clock(ms) { var t = Math.max(0, Math.floor(ms / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }

  /** 显示状态：run 细分为 tool（工具执行中，不算停滞）与 stall（60 秒没有 hook 活动）。 */
  function vs(s) {
    if (s.status === 'run') {
      if (s.tool) return 'tool';
      if (now() - s.beat > STALL) return 'stall';
    }
    return s.status;
  }
  /** 会话当前所在节点：flowctl focus 标记的位置，否则第一个关联节点。 */
  function pos(s) { return s.focus || (s.links && s.links[0]) || null; }
  function chipTime(s, v) {
    if (v === 'tool') return s.tool + ' ' + clock(now() - s.tool_since);
    if (v === 'stall') return '停滞 ' + clock(now() - s.beat);
    if (v === 'wait') return '等你 ' + clock(now() - s.since);
    if (v === 'err') return '异常退出';
    if (v === 'boot') return '启动中';
    return '';
  }

  // ---------------- 样式 ----------------
  var css = document.createElement('style');
  css.textContent = [
    '.fca-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:3;pointer-events:none}',
    '.fca-dock{position:absolute;display:flex;flex-direction:row-reverse;gap:4px;align-items:center;transform:translate(calc(-100% + 12px),-60%)}',
    '.fca-chip{--c:#8c959f;position:relative;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px 0 3px;border:1px solid var(--bd);border-radius:12px;background:var(--bg);color:var(--fg);box-shadow:0 2px 8px rgba(0,0,0,.18);font:12px "Microsoft YaHei UI",sans-serif;white-space:nowrap;cursor:pointer;pointer-events:auto}',
    '.fca-chip:hover{border-color:#4493f8}',
    '.fca-chip .nm{max-width:9em;overflow:hidden;text-overflow:ellipsis}',
    '.fca-chip .st{color:var(--c)}.fca-chip .st:empty{display:none}',
    '.fca-face{position:relative;display:grid;place-items:center;width:19px;height:19px;border-radius:50%;background:color-mix(in srgb,var(--c) 18%,transparent);color:var(--c)}',
    '.fca-face svg{width:14px;height:14px;overflow:visible}.fca-face .eye{fill:currentColor;transform-box:fill-box;transform-origin:center}.fca-face .ant{fill:transparent;stroke:currentColor;stroke-width:1}',
    '.fca-chip.wk{height:19px;padding:0 7px 0 2px;border-style:dashed;font-size:11px;box-shadow:none}.fca-chip.wk .fca-face{width:15px;height:15px}.fca-chip.wk .fca-face svg{width:11px;height:11px}.fca-chip.wk .nm{max-width:7em}',
    '.v-run,.v-tool,.v-boot{--c:#2da44e}.v-run,.v-tool{border-color:color-mix(in srgb,#2da44e 55%,var(--bd))}',
    '.v-run .fca-face,.v-tool .fca-face{animation:fca-bob 1.3s ease-in-out infinite}',
    '.v-run .fca-face::before,.v-tool .fca-face::before{content:"";position:absolute;inset:-3px;border:2px solid transparent;border-top-color:var(--c);border-radius:50%;animation:fca-spin 1.1s linear infinite}',
    '.v-tool .fca-face::before{animation-duration:.6s}.v-run .ant,.v-tool .ant{fill:var(--c);animation:fca-blink 1.4s ease-in-out infinite}',
    '.v-wait{--c:#bf8700;border-color:#d4a72c}.v-wait .fca-face::after{content:"!";position:absolute;top:-6px;right:-6px;width:13px;height:13px;border-radius:50%;background:#bf8700;color:#fff;font-size:10px;font-weight:700;line-height:13px;text-align:center;animation:fca-blink .9s steps(2) infinite}',
    '.v-stall{--c:#8c959f;border-style:dashed;box-shadow:none}.v-stall .eye{transform:scaleY(.18)}.v-stall .fca-face::after{content:"z";position:absolute;top:-9px;right:-5px;font-size:10px;font-weight:600;color:#8c959f;animation:fca-zz 2.4s ease-in-out infinite}',
    '.v-err{--c:#cf222e;border-color:#cf222e}.v-err .fca-face::after{content:"×";position:absolute;top:-6px;right:-6px;width:13px;height:13px;border-radius:50%;background:#cf222e;color:#fff;font-size:11px;font-weight:700;line-height:12px;text-align:center}',
    '.fca-say{position:absolute;right:0;bottom:calc(100% + 7px);padding:3px 8px;border-radius:6px;background:var(--fg);color:var(--bg);font-size:11.5px;white-space:nowrap;pointer-events:none;animation:fca-say 2.6s forwards}',
    '.fca-say.k-edit,.fca-say.k-msg{background:#0969da;color:#fff}.fca-say.k-commit{background:#1a7f37;color:#fff}',
    '.fca-glow{position:absolute;border:2px solid var(--hk,#4493f8);border-radius:8px;box-shadow:0 0 12px 2px var(--hk,#4493f8);pointer-events:none;opacity:0}',
    '.fca-glow.live{animation:fca-live 1.4s ease-in-out infinite}',
    '.fca-glow.wait{border-color:#bf8700;box-shadow:0 0 10px 2px #d4a72c}.fca-glow.stall{border:2px dashed #8c959f;box-shadow:none}.fca-glow.err{border-color:#cf222e;box-shadow:0 0 8px 1px #cf222e}',
    '.fca-ripple{position:absolute;border:2px solid var(--hk,#4493f8);border-radius:8px;pointer-events:none;animation:fca-rip .95s ease-out forwards}',
    '.fca-badge{position:fixed;z-index:10;display:flex;align-items:center;gap:0;border:1px solid var(--bd);border-radius:14px;background:var(--bg);color:var(--fg);box-shadow:0 2px 10px rgba(0,0,0,.18);font:12px "Microsoft YaHei UI",sans-serif;overflow:hidden}',
    '.fca-badge button{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:0;background:none;color:inherit;font:inherit;cursor:pointer}',
    '.fca-badge button:hover{background:color-mix(in srgb,var(--fg) 8%,transparent)}.fca-badge .eyeb{padding:0 8px;border-left:1px solid var(--bd);color:var(--mu)}',
    '.fca-badge svg{width:15px;height:15px}.fca-badge b{font-weight:600}.fca-badge .w{color:#bf8700}.fca-badge .e{color:#cf222e}',
    '@keyframes fca-bob{50%{transform:translateY(-1.5px)}}@keyframes fca-spin{to{transform:rotate(360deg)}}@keyframes fca-blink{50%{opacity:.25}}',
    '@keyframes fca-zz{0%{opacity:0;transform:translate(0,3px) scale(.8)}40%{opacity:1}100%{opacity:0;transform:translate(5px,-8px) scale(1.15)}}',
    '@keyframes fca-say{0%{opacity:0;transform:translateY(4px)}10%,82%{opacity:1;transform:none}100%{opacity:0}}',
    '@keyframes fca-live{50%{box-shadow:0 0 20px 5px var(--hk,#4493f8)}}@keyframes fca-rip{from{opacity:.9;transform:scale(1)}to{opacity:0;transform:scale(1.12,1.35)}}',
    '@media (prefers-reduced-motion:reduce){.fca-layer *,.fca-layer *::before,.fca-layer *::after{animation:none!important}}',
  ].join('\n');
  document.head.appendChild(css);

  /** 跟随外层主题设置颜色变量（draw.io 自己的深色模式只影响画布）。 */
  function applyTheme() {
    var dark = P.document.documentElement.dataset.theme === 'dark';
    var r = document.documentElement.style;
    r.setProperty('--bg', dark ? '#161b22' : '#ffffff');
    r.setProperty('--fg', dark ? '#e6edf3' : '#24292f');
    r.setProperty('--bd', dark ? '#30363d' : '#d0d7de');
    r.setProperty('--mu', dark ? '#7d8590' : '#8c959f');
  }

  // ---------------- 渲染 ----------------

  /** 节点在画布滚动内容中的边界（缩放后），节点不在当前页返回 null。 */
  function bounds(id) {
    var cell = graph.model.getCell(id);
    var st = cell && graph.view.getState(cell);
    if (!st) return null;
    var b = { x: st.x, y: st.y, w: st.width, h: st.height, rho: /rhombus/.test(st.style && st.style.shape || graph.model.getStyle(cell) || '') };
    if (zoomPreview) {
      var z = zoomPreview;
      b.x = z.x + (b.x - z.x) * z.factor;
      b.y = z.y + (b.y - z.y) * z.factor;
      b.w *= z.factor;
      b.h *= z.factor;
    }
    return b;
  }

  /** 缩放预览只移动现有元素，保留字号、动画、气泡与点击目标。 */
  function positionOverlays() {
    layer.querySelectorAll('.fca-dock,.fca-glow,.fca-ripple').forEach(function (el) {
      var b = bounds(el.dataset.node);
      if (!b) return;
      if (el.classList.contains('fca-dock')) {
        el.style.left = (b.rho ? b.x + b.w * .76 : b.x + b.w).toFixed(1) + 'px';
        el.style.top = (b.rho ? b.y + b.h * .2 : b.y).toFixed(1) + 'px';
      } else {
        el.style.left = (b.x - 4) + 'px';
        el.style.top = (b.y - 4) + 'px';
        el.style.width = (b.w + 8) + 'px';
        el.style.height = (b.h + 8) + 'px';
      }
    });
  }

  /** 重画机器人：按节点分组，worker 跟在父会话后面。 */
  function render() {
    if (!graph || !layer) return;
    applyTheme();
    var docks = {}, html = '';
    var here = Object.keys(sessions).map(function (id) { return sessions[id]; }).filter(function (s) {
      var p = pos(s);
      return show && SHOW[vs(s)] && p && p.node && key(p.flow) === key(path);
    });
    here.forEach(function (s) {
      var n = pos(s).node;
      (docks[n] = docks[n] || []).push(s);
    });
    Object.keys(docks).forEach(function (n) {
      var b = bounds(n);
      if (!b) return;
      var x = b.rho ? b.x + b.w * .76 : b.x + b.w, y = b.rho ? b.y + b.h * .2 : b.y;
      var chips = docks[n].map(function (s) {
        var v = vs(s);
        var ws = (s.workers || []).filter(function (w) { return w.running; }).map(function (w) {
          return '<span class="fca-chip wk v-run" data-sid="' + esc(s.id) + '" title="worker：' + esc(w.desc) + '"><span class="fca-face">' + BOT + '</span><span class="nm">' + esc(w.desc) + '</span></span>';
        }).join('');
        return '<span class="fca-chip v-' + v + '" data-sid="' + esc(s.id) + '" title="' + esc(s.title + '，' + (STATE[v] || v) + (s.wait_text ? '：' + s.wait_text : '') + '\n点击在 Agent 窗口打开') + '"><span class="fca-face">' + BOT + '</span><span class="nm">' + esc(s.title) + '</span><span class="st" data-st="' + esc(s.id) + '">' + esc(chipTime(s, v)) + '</span></span>' + ws;
      }).join('');
      html += '<div class="fca-dock" data-node="' + esc(n) + '" style="left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px">' + chips + '</div>';
    });
    // 保留正在显示的气泡：只替换机器人层，发光层单独维护
    var keep = {};
    layer.querySelectorAll('.fca-say').forEach(function (el) { keep[el.parentNode.dataset.sid] = el; });
    layer.querySelectorAll('.fca-dock').forEach(function (el) { el.remove(); });
    layer.insertAdjacentHTML('beforeend', html);
    Object.keys(keep).forEach(function (sid) {
      var c = layer.querySelector('.fca-chip:not(.wk)[data-sid="' + sid + '"]');
      if (c) c.appendChild(keep[sid]);
    });
    renderGlows();
    renderBadge();
  }

  /** 节点最近一次活动（当前图），用于发光强度。 */
  function lastTouches() {
    var out = {};
    Object.keys(sessions).forEach(function (id) {
      (sessions[id].acts || []).forEach(function (a) {
        if (!a.node || key(a.flow) !== key(path)) return;
        if (!out[a.node] || a.t > out[a.node].t) out[a.node] = a;
      });
    });
    return out;
  }

  /** 发光框：位置随画布重画，强度在 tick 里按时间衰减；有会话在等你 / 停滞 / 异常的节点用对应边框。 */
  function renderGlows() {
    var touch = lastTouches(), mark = {};
    if (show) {
      Object.keys(sessions).forEach(function (id) {
        var s = sessions[id], v = vs(s), p = pos(s);
        if (p && p.node && key(p.flow) === key(path) && (v === 'wait' || v === 'stall' || v === 'err')) {
          if (!mark[p.node] || v === 'wait') mark[p.node] = v;
        }
      });
    }
    var ids = {};
    Object.keys(touch).concat(Object.keys(mark)).forEach(function (n) { ids[n] = 1; });
    Object.keys(glows).forEach(function (n) { if (!ids[n]) { glows[n].remove(); delete glows[n]; } });
    Object.keys(ids).forEach(function (n) {
      var b = bounds(n);
      if (!b) return;
      var g = glows[n];
      if (!g) { g = glows[n] = document.createElement('div'); g.dataset.node = n; layer.insertBefore(g, layer.firstChild); }
      g.className = 'fca-glow' + (mark[n] ? ' ' + mark[n] : '');
      g.style.cssText = 'left:' + (b.x - 4) + 'px;top:' + (b.y - 4) + 'px;width:' + (b.w + 8) + 'px;height:' + (b.h + 8) + 'px';
      g._t = touch[n];
    });
    tickGlows();
  }

  /** 发光衰减：4 秒内满亮并呼吸，之后 1 分钟线性淡出；读取比编辑弱一些。 */
  function tickGlows() {
    var n = now();
    Object.keys(glows).forEach(function (id) {
      var g = glows[id], a = g._t, h = 0, live = false;
      if (g.classList.contains('wait') || g.classList.contains('stall') || g.classList.contains('err')) h = 1;
      else if (a && show) {
        var age = n - a.t, w = a.kind === 'read' ? .7 : 1;
        live = age < LIVE;
        h = live ? w : Math.max(0, .55 * w * (1 - (age - LIVE) / (FADE - LIVE)));
        g.style.setProperty('--hk', KC[a.kind] || KC.read);
      }
      g.style.opacity = h.toFixed(3);
      g.classList.toggle('live', live);
    });
  }

  /** 节点涟漪：一次活动发生在当前图的节点上时。 */
  function ripple(node, kind) {
    var b = show && bounds(node);
    if (!b || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var r = document.createElement('div');
    r.className = 'fca-ripple';
    r.dataset.node = node;
    r.style.cssText = 'left:' + (b.x - 4) + 'px;top:' + (b.y - 4) + 'px;width:' + (b.w + 8) + 'px;height:' + (b.h + 8) + 'px;--hk:' + (KC[kind] || KC.read);
    layer.appendChild(r);
    setTimeout(function () { r.remove(); }, 1000);
  }

  /** 机器人头上的短气泡（编辑、提交、协作消息）。 */
  function say(sid, text, kind) {
    var c = layer && layer.querySelector('.fca-chip:not(.wk)[data-sid="' + sid + '"]');
    if (!c) return;
    var old = c.querySelector('.fca-say');
    if (old) old.remove();
    var b = document.createElement('span');
    b.className = 'fca-say k-' + kind;
    b.textContent = text;
    c.appendChild(b);
    setTimeout(function () { b.remove(); }, 2700);
  }

  /** 左下角入口：本图会话计数，点击打开 Agent 窗口；眼睛按钮开关画布上的 Agent。 */
  function renderBadge() {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'fca-badge';
      badge.innerHTML = '<button class="open" title="打开 Agent 窗口"></button><button class="eyeb" title="显示 / 隐藏画布上的 Agent"></button>';
      document.body.appendChild(badge);
      badge.querySelector('.open').addEventListener('click', function () { invoke('open_agent_window', { focus: null }); });
      badge.querySelector('.eyeb').addEventListener('click', function () {
        show = !show;
        localStorage.setItem('fc-agent-overlay', show ? '1' : '0');
        render();
      });
    }
    var c = { run: 0, wait: 0, stall: 0, err: 0 }, all = 0;
    Object.keys(sessions).forEach(function (id) {
      var s = sessions[id], v = vs(s);
      if (s.running) all++;
      var p = pos(s);
      if (!p || key(p.flow) !== key(path)) return;
      if (v === 'run' || v === 'tool' || v === 'boot') c.run++; else if (c[v] != null) c[v]++;
    });
    var parts = [];
    if (c.run) parts.push('<b>' + c.run + '</b> 运行');
    if (c.wait) parts.push('<b class="w">' + c.wait + '</b> 等你');
    if (c.stall) parts.push('<b>' + c.stall + '</b> 停滞');
    if (c.err) parts.push('<b class="e">' + c.err + '</b> 异常');
    badge.querySelector('.open').innerHTML = BOT + 'Agent　' + (parts.length ? '本图 ' + parts.join(' · ') : all ? all + ' 个会话运行中' : '没有运行中的会话');
    badge.querySelector('.eyeb').innerHTML = show
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.7 8.5 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/></svg>';
    var box = graph.container.getBoundingClientRect();
    badge.style.left = (box.left + 10) + 'px';
    badge.style.top = (box.bottom - 38) + 'px';
    badge.hidden = !path;
  }

  // ---------------- 数据 ----------------

  function upsert(v) {
    if (v.archived_at) { delete sessions[v.id]; return; }
    var old = sessions[v.id];
    v.acts = old ? old.acts : (v.acts || []);
    sessions[v.id] = v;
  }

  function load() {
    invoke('agent_list').then(function (list) {
      sessions = {};
      list.forEach(upsert);
      render();
    }).catch(function (e) { console.error('agent_list', e); });
  }

  listen('agent-update', function (ev) { upsert(ev.payload); render(); });
  listen('agent-removed', function (ev) { delete sessions[ev.payload.id]; render(); });
  listen('agent-act', function (ev) {
    var s = sessions[ev.payload.id], a = ev.payload.act;
    if (!s) return;
    s.acts.push(a);
    if (s.acts.length > 300) s.acts.shift();
    if (a.node && key(a.flow) === key(path)) {
      ripple(a.node, a.kind);
      renderGlows();
    }
    if (a.kind === 'edit' || a.kind === 'commit' || a.kind === 'msg') say(s.id, a.text, a.kind);
  });
  listen('agent-locate', function (ev) {
    var m = ev.payload;
    if (m.feat) { if (P.Tabs) P.Tabs.openNew('feat', m.feat); return; }
    if (!m.path || !P.FlowLink) return;
    suppress = { node: m.node || '', t: now() };
    P.FlowLink.reveal(m.path, m.node || '');
  });

  // 外层发给 iframe 的消息：当前图路径、当前 Feat 高亮
  window.addEventListener('message', function (ev) {
    if (ev.source !== P || typeof ev.data !== 'string') return;
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.action === 'fc-path') {
      path = m.path || '';
      setTimeout(render, 60);
    } else if (m.action === 'fc-highlight') {
      var tag = m.tag || '';
      if (tag && tag !== lastTag && now() - suppress.t > 1500) emit('agent-main-select', { path: path, feat: tag });
      lastTag = tag;
    }
  });

  /** 等 flow_bridge 装好编辑器后挂上画布层与监听。 */
  function attach() {
    var b = window.fcBridge;
    if (!b || !b.ui || !b.ui.editor || !b.ui.editor.graph) return setTimeout(attach, 200);
    graph = b.ui.editor.graph;
    layer = document.createElement('div');
    layer.className = 'fca-layer';
    graph.container.appendChild(layer);
    layer.addEventListener('click', function (e) {
      var c = e.target.closest('.fca-chip');
      if (c) { e.stopPropagation(); invoke('open_agent_window', { focus: c.dataset.sid }); }
    });
    var redraw = 0;
    var schedule = function () { if (!redraw) redraw = requestAnimationFrame(function () { redraw = 0; render(); }); };
    // lazyZoom 会先 CSS 预览，稍后才提交 SCALE；在同一任务末尾读取最终原点，
    // 兼容滚轮连缩时 draw.io 在 zoomPreview 之后再次修正缩放原点。
    var previewPending = false;
    var syncPreview = function () {
      if (previewPending) return;
      previewPending = true;
      queueMicrotask(function () {
        previewPending = false;
        var pane = graph.view.modelCoordinates ? graph.view.getCanvas() : graph.view.getDrawPane();
        var scale = /^scale\(([^)]+)\)$/.exec(pane.style.transform);
        var origin = pane.style.transformOrigin.split(' ').map(parseFloat);
        zoomPreview = scale ? { factor: Number(scale[1]), x: origin[0], y: origin[1] } : null;
        positionOverlays();
      });
    };
    graph.addListener('zoomPreview', syncPreview);
    graph.addListener('zoomPreviewComplete', syncPreview);
    graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, schedule);
    graph.view.addListener(mxEvent.SCALE, schedule);
    graph.view.addListener(mxEvent.TRANSLATE, schedule);
    graph.model.addListener(mxEvent.CHANGE, schedule);
    window.addEventListener('resize', schedule);
    graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
      var cells = graph.getSelectionCells().filter(function (c) { return graph.model.isVertex(c); });
      if (cells.length !== 1 || !path) return;
      var id = cells[0].id;
      if (id === suppress.node && now() - suppress.t < 1500) return;
      var tags = (graph.getTagsForCell(cells[0]) || '').split(' ').filter(Boolean);
      emit('agent-main-select', { path: path, node: id, tags: tags });
    });
    load();
    // 计时文字与发光衰减每秒刷新；停滞是按时间推导的，状态变化时整体重画
    var lastV = '';
    setInterval(function () {
      var sig = Object.keys(sessions).map(function (id) { return id + vs(sessions[id]); }).join();
      if (sig !== lastV) { lastV = sig; render(); return; }
      layer.querySelectorAll('[data-st]').forEach(function (el) {
        var s = sessions[el.dataset.st];
        if (s) el.textContent = chipTime(s, vs(s));
      });
      tickGlows();
      renderBadge();
    }, 1000);
  }
  attach();
})();
