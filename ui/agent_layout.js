// Agent 侧栏分隔条：保持窗口内的最小宽度，记住用户选择，不重建会话或终端。
'use strict';

(() => {
  const app = document.querySelector('.app');
  const side = document.getElementById('agent-sidebar');
  const split = document.getElementById('agent-sidebar-split');
  const KEY = 'fc-agent-side-w', GAP = 5, MIN_SIDE = 260, MIN_WORK = 360;
  const wide = matchMedia('(min-width: 861px)');
  const saved = Number(localStorage.getItem(KEY));
  let preferred = Number.isFinite(saved) && saved > 0 ? saved : null;
  let drag = null;

  function limits() {
    return { min: MIN_SIDE, max: Math.max(MIN_SIDE, app.clientWidth - GAP - MIN_WORK) };
  }
  function apply(width = preferred ?? 280) {
    if (!wide.matches) return;
    const { min, max } = limits();
    const value = Math.round(Math.min(max, Math.max(min, width)));
    app.style.setProperty('--agent-side-width', `${value}px`);
    split.setAttribute('aria-valuemin', min);
    split.setAttribute('aria-valuemax', max);
    split.setAttribute('aria-valuenow', value);
    split.setAttribute('aria-valuetext', `侧栏宽度 ${value} 像素`);
    return value;
  }
  function save() { localStorage.setItem(KEY, String(preferred)); }
  function reset() {
    preferred = null;
    localStorage.removeItem(KEY);
    apply();
  }
  function finish(e) {
    if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
    const id = drag.id;
    drag = null;
    document.body.classList.remove('agent-resizing');
    if (split.hasPointerCapture(id)) split.releasePointerCapture(id);
    if (preferred != null) save();
  }
  split.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !wide.matches || drag) return;
    e.preventDefault();
    drag = { id: e.pointerId, offset: e.clientX - side.getBoundingClientRect().right };
    split.setPointerCapture(e.pointerId);
    document.body.classList.add('agent-resizing');
  });
  split.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    preferred = apply(e.clientX - app.getBoundingClientRect().left - drag.offset);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) split.addEventListener(event, finish);
  window.addEventListener('blur', finish);
  split.addEventListener('dblclick', reset);
  split.addEventListener('keydown', e => {
    if (!wide.matches || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const { min, max } = limits(), step = e.shiftKey ? 48 : 16;
    const value = e.key === 'Home' ? min : e.key === 'End' ? max : side.clientWidth + (e.key === 'ArrowLeft' ? -step : step);
    preferred = apply(value);
    save();
  });
  window.addEventListener('resize', () => {
    if (!wide.matches && drag) finish({});
    apply();
  });
  apply();
})();
