// 主区布局：流程图 / Feat 两栏，可左右或上下排布，每栏可固定或悬浮。
// 所有栏始终是 #panes 的直接子元素，只用 CSS Grid 位置和悬浮定位改变排布：
// 移动 iframe 所在的 DOM 节点会让 draw.io 整页重载，因此这里从不重排 DOM。
// 布局偏好（排布方式、栏顺序、分隔比例、悬浮位置）存 localStorage，各窗口共享；独立窗口只显示一栏。
'use strict';

window.Split = (() => {
  const $ = (id) => document.getElementById(id);
  const IDS = { flow: 'flow-pane', feat: 'feat-pane' };
  const KEY = 'fc-layout';
  const solo = new URLSearchParams(location.search).get('solo') || '';
  const opened = { flow: false, feat: false }; // 实际打开的内容，不把首页提示或强制拆分空位计为已打开。
  const floating = (k) => !solo && opened[k] && !!pref.float[k];
  const GAP = 5;            // 分隔条宽度（px）
  const MIN = 160;          // 固定栏最小边长（px）
  const MODES = ['row', 'col'];

  /**
   * 布局偏好。mode：row 左右 / col 上下；
   * order：固定栏的先后；w：各排布下的分隔权重，键为 `<mode><栏数>`；
   * float：悬浮栏的位置与尺寸（相对 #panes，px），未悬浮为 null。
   */
  const pref = (() => {
    const base = { mode: 'row', order: ['flow', 'feat'], w: {}, float: { flow: null, feat: null } };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      const p = { ...base, ...saved, float: { flow: saved.float?.flow || null, feat: saved.float?.feat || null } };
      if (!MODES.includes(p.mode)) p.mode = 'row';
      p.order = [...new Set([...(p.order || []).filter((k) => IDS[k]), ...base.order])];
      return p;
    } catch { return base; }
  })();
  const save = () => localStorage.setItem(KEY, JSON.stringify(pref));
  const pane = (k) => $(IDS[k]);
  const isOpen = (k) => opened[k];
  let zTop = 30;

  /** 权重数组：缺省等分；栏数变化时各自独立记忆。 */
  function weights(key, n) {
    const w = pref.w[key];
    return Array.isArray(w) && w.length === n && w.every((x) => x > 0) ? w : Array(n).fill(1);
  }
  const track = (w) => w.map((x) => `minmax(0, ${x}fr)`).join(` ${GAP}px `);

  /** 把悬浮栏限制在主区内，至少露出标题栏便于拖回。 */
  function clampFloat(k) {
    const r = $('panes').getBoundingClientRect();
    const f = pref.float[k];
    f.w = Math.min(Math.max(f.w, 280), r.width);
    f.h = Math.min(Math.max(f.h, 180), r.height);
    f.x = Math.min(Math.max(f.x, 0), Math.max(0, r.width - f.w));
    f.y = Math.min(Math.max(f.y, 0), Math.max(0, r.height - f.h));
    const el = pane(k);
    Object.assign(el.style, { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' });
  }

  /** 设置一个分隔条：axis x 为左右拖动、y 为上下拖动；a / b 为两侧栏，key / i 指向要改的权重。 */
  function placeSplitter(el, axis, col, row, a, b, key, i, n) {
    el.hidden = false;
    el.style.gridColumn = col;
    el.style.gridRow = row;
    el.classList.toggle('y', axis === 'y');
    Object.assign(el.dataset, { axis, a, b, key, i, n });
  }

  /**
   * 按实际内容重排：默认单栏占满，强制拆分时保留两栏空位；全部关闭时保留首页提示。
   * 悬浮偏好只应用于已打开内容，独立窗口始终只展示其所属一栏。
   */
  function layout() {
    const box = $('panes');
    const force = !solo && Settings.forceSplit();
    const hasContent = Object.keys(IDS).some(isOpen);
    for (const k of Object.keys(IDS)) {
      pane(k).hidden = solo ? k !== solo : !force && !opened[k] && (hasContent || k !== 'flow');
    }
    // 两侧空位统一隐藏旧标题和正文，显示各自的同款引导；不改动 iframe 所在的 DOM。
    for (const k of Object.keys(IDS)) pane(k).querySelector('.pane-bar').hidden = !opened[k];
    $('empty').hidden = opened.flow;
    $('feat-empty').hidden = opened.feat;
    $('feat-body').hidden = !opened.feat;
    const docked = pref.order.filter((k) => !pane(k).hidden && !floating(k));
    const sa = $('split-a');
    sa.hidden = true;
    for (const k of Object.keys(IDS)) {
      const el = pane(k);
      const isFloating = !el.hidden && floating(k);
      el.classList.toggle('floating', isFloating);
      if (isFloating) {
        el.style.gridColumn = el.style.gridRow = '';
        clampFloat(k);
      } else {
        for (const p of ['left', 'top', 'width', 'height', 'zIndex']) el.style[p] = '';
      }
      const btn = el.querySelector('.pane-float');
      if (btn) {
        btn.classList.toggle('on', isFloating);
        btn.title = isFloating ? '固定到主区' : '悬浮';
        btn.setAttribute('aria-pressed', String(isFloating));
      }
    }
    const n = docked.length;
    const mode = pref.mode;
    box.dataset.mode = mode;
    if (n <= 1) {
      box.style.gridTemplateColumns = box.style.gridTemplateRows = 'minmax(0, 1fr)';
      if (n) Object.assign(pane(docked[0]).style, { gridColumn: '1', gridRow: '1' });
    } else {
      const key = mode + n;
      const t = track(weights(key, n));
      box.style.gridTemplateColumns = mode === 'row' ? t : 'minmax(0, 1fr)';
      box.style.gridTemplateRows = mode === 'col' ? t : 'minmax(0, 1fr)';
      docked.forEach((k, i) => {
        const cell = String(i * 2 + 1);
        Object.assign(pane(k).style, mode === 'row' ? { gridColumn: cell, gridRow: '1' } : { gridColumn: '1', gridRow: cell });
      });
      placeSplitter(sa, mode === 'row' ? 'x' : 'y', mode === 'row' ? '2' : '1', mode === 'row' ? '1' : '2', docked[0], docked[1], key, 0, n);
    }
  }

  /** 拖动分隔条：按两侧栏当前像素尺寸换算新的权重，两栏之和不变，各自不小于 MIN。 */
  function dragSplitter(el, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('pane-dragging');
    const { axis, a, b, key } = el.dataset;
    const i = Number(el.dataset.i), n = Number(el.dataset.n);
    const ra = pane(a).getBoundingClientRect(), rb = pane(b).getBoundingClientRect();
    const start = axis === 'x' ? ra.left : ra.top;
    const sum = axis === 'x' ? ra.width + rb.width : ra.height + rb.height;
    const min = Math.min(MIN, sum / 2);
    const w = [...weights(key, n)];
    const pair = w[i] + w[i + 1];
    const move = (ev) => {
      const pos = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      const pa = Math.min(Math.max(pos, min), sum - min);
      w[i] = pair * pa / sum;
      w[i + 1] = pair - w[i];
      pref.w[key] = w;
      layout();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('pane-dragging');
      save();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** 双击分隔条：该排布恢复等分。 */
  function resetSplitter(el) {
    delete pref.w[el.dataset.key];
    save();
    layout();
  }

  /** 标题栏上的可交互控件不触发拖动。 */
  const isControl = (t) => !!t.closest('button, input, select, textarea, a, label');

  /** 悬浮栏置顶。 */
  function raise(k) { pane(k).style.zIndex = String(++zTop); }

  /**
   * 拖动标题栏：悬浮栏移动位置；固定栏拖到另一固定栏上松开即交换两者位置（拖动超过 6px 才生效）。
   */
  function dragBar(k, e) {
    if (e.button !== 0 || isControl(e.target) || document.body.classList.contains('solo')) return;
    const el = pane(k);
    const bar = e.currentTarget;
    bar.setPointerCapture(e.pointerId);
    const floating = !!pref.float[k];
    if (floating) raise(k);
    const sx = e.clientX, sy = e.clientY;
    const f0 = floating ? { ...pref.float[k] } : null;
    let active = false, target = null;
    const clearTarget = () => { if (target) pane(target).classList.remove('drop-target'); target = null; };
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!active) {
        if (Math.hypot(dx, dy) < 6) return;
        active = true;
        bar.setPointerCapture(e.pointerId);
        document.body.classList.add('pane-dragging');
        el.classList.add('moving');
      }
      if (floating) {
        Object.assign(pref.float[k], { x: f0.x + dx, y: f0.y + dy });
        clampFloat(k);
        return;
      }
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pane');
      const hk = hit && Object.keys(IDS).find((x) => IDS[x] === hit.id);
      const next = hk && hk !== k && !pref.float[hk] ? hk : null;
      if (next !== target) { clearTarget(); target = next; if (target) pane(target).classList.add('drop-target'); }
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      document.body.classList.remove('pane-dragging');
      el.classList.remove('moving');
      if (target) {
        const o = pref.order, i = o.indexOf(k), j = o.indexOf(target);
        [o[i], o[j]] = [o[j], o[i]];
      }
      clearTarget();
      if (active) { save(); layout(); }
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  }

  /** 悬浮栏右下角拖动改尺寸。 */
  function dragGrip(k, e) {
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('pane-dragging');
    raise(k);
    const sx = e.clientX, sy = e.clientY, f0 = { ...pref.float[k] };
    const move = (ev) => { Object.assign(pref.float[k], { w: f0.w + ev.clientX - sx, h: f0.h + ev.clientY - sy }); clampFloat(k); };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      document.body.classList.remove('pane-dragging');
      save();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  /** 悬浮 / 固定切换：首次悬浮放在主区右下，尺寸为主区的一半。 */
  function toggleFloat(k) {
    if (pref.float[k]) pref.float[k] = null;
    else {
      const r = $('panes').getBoundingClientRect();
      const w = Math.round(r.width * 0.5), h = Math.round(r.height * 0.6);
      pref.float[k] = { x: r.width - w - 24, y: r.height - h - 24, w, h };
      raise(k);
    }
    save();
    layout();
  }

  /** 绑定分隔条、标题栏、悬浮按钮与尺寸手柄；窗口尺寸变化时把悬浮栏限制回主区。 */
  function init() {
    const split = $('split-a');
    split.addEventListener('pointerdown', (e) => dragSplitter(split, e));
    split.ondblclick = () => resetSplitter(split);
    for (const k of Object.keys(IDS)) {
      const el = pane(k);
      el.querySelector('.pane-bar').addEventListener('pointerdown', (e) => dragBar(k, e));
      el.querySelector('.pane-float').onclick = () => toggleFloat(k);
      el.querySelector('.pane-grip').addEventListener('pointerdown', (e) => dragGrip(k, e));
      el.addEventListener('pointerdown', () => { if (pref.float[k]) raise(k); }, true);
    }
    window.addEventListener('resize', () => layout());
    window.addEventListener('storage', (e) => { if (e.key === 'fc-force-split') layout(); });
    layout();
  }

  return {
    /** 设置页沿用原有排布偏好，不重置栏顺序、分隔比例或悬浮位置。 */
    mode: () => pref.mode,
    setMode(mode) {
      if (!MODES.includes(mode)) return false;
      pref.mode = mode;
      save();
      layout();
      return true;
    },
    /** 记录实际打开的内容并更新布局（flow / feat）。 */
    show(k) { opened[k] = true; layout(); },
    /** 清除实际内容；是否保留空位由强制拆分和首页规则决定。 */
    hide(k) { opened[k] = false; layout(); },
    isOpen,
    layout,
    init,
  };
})();
