// 会话信息分组：全会话共用折叠与排序偏好，原生拖放和键盘调整后立即保存。
'use strict';
window.AgentInfoLayout = (() => {
  const KEY = 'fc-agent-info-groups';
  const GROUPS = ['run', 'usage', 'context', 'plan', 'links', 'workers', 'location'];

  function readPrefs() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { /* 损坏或不可用时使用默认布局。 */ }
    const known = values => Array.isArray(values) ? values.filter(id => GROUPS.includes(id)) : [];
    return { order: [...new Set([...known(saved?.order), ...GROUPS])], closed: [...new Set(known(saved?.closed))] };
  }

  function init(root) {
    const scroll = root.querySelector('.am-scroll');
    const groups = () => [...scroll.querySelectorAll(':scope > .am-group')];
    let dragging = null, dropTarget = null, dropAfter = false, tipTarget = null;
    const tooltip = root.querySelector('[data-am="tooltip"]');

    function apply() {
      const prefs = readPrefs(), byId = new Map(groups().map(group => [group.dataset.amGroup, group]));
      for (const id of prefs.order) {
        const group = byId.get(id);
        if (group) { group.open = !prefs.closed.includes(id); scroll.append(group); }
      }
    }
    function save() {
      const nodes = groups();
      const value = JSON.stringify({ order: nodes.map(group => group.dataset.amGroup), closed: nodes.filter(group => !group.open).map(group => group.dataset.amGroup) });
      try { if (localStorage.getItem(KEY) !== value) localStorage.setItem(KEY, value); }
      catch { if (typeof toast === 'function') toast('分组布局未能保存，下次打开将恢复原布局'); }
    }
    function hideTip() {
      tooltip.hidden = true;
      if (tipTarget) tipTarget.removeAttribute('aria-describedby');
      tipTarget = null;
    }
    function showTip(target) {
      if (!target) return;
      hideTip();
      tipTarget = target;
      tooltip.textContent = target.dataset.amTip;
      tooltip.hidden = false;
      target.setAttribute('aria-describedby', tooltip.id);
      const r = target.getBoundingClientRect(), t = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.max(8, Math.min(innerWidth - t.width - 8, r.right - t.width))}px`;
      tooltip.style.top = `${Math.max(8, r.bottom + t.height + 14 < innerHeight ? r.bottom + 6 : r.top - t.height - 6)}px`;
    }
    function clearDrop() {
      for (const group of groups()) group.classList.remove('am-drop-before', 'am-drop-after', 'am-dragging');
      dragging = dropTarget = null;
    }
    function move(group, target, after) {
      scroll.insertBefore(group, after ? target.nextElementSibling : target);
      save();
    }

    apply();
    root.addEventListener('toggle', event => {
      if (event.target.matches('.am-group')) { hideTip(); save(); }
    }, true);
    root.addEventListener('dragstart', event => {
      const heading = event.target.closest('.am-group > summary');
      if (!heading || event.target.closest('button, input, a')) { event.preventDefault(); return; }
      dragging = heading.parentElement;
      dragging.classList.add('am-dragging');
      hideTip();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragging.dataset.amGroup);
    });
    root.addEventListener('dragover', event => {
      const target = event.target.closest('.am-group');
      if (!dragging || !target || target === dragging) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      for (const group of groups()) group.classList.remove('am-drop-before', 'am-drop-after');
      const rect = target.getBoundingClientRect();
      dropTarget = target;
      dropAfter = event.clientY > rect.top + rect.height / 2;
      target.classList.add(dropAfter ? 'am-drop-after' : 'am-drop-before');
    });
    root.addEventListener('drop', event => {
      if (!dragging) return;
      event.preventDefault();
      if (dropTarget && event.target.closest('.am-group') === dropTarget) move(dragging, dropTarget, dropAfter);
      clearDrop();
    });
    root.addEventListener('dragend', clearDrop);
    root.addEventListener('keydown', event => {
      const heading = event.target.closest('.am-group > summary');
      if (!heading || event.target !== heading || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const group = heading.parentElement;
      const target = event.key === 'ArrowUp' ? group.previousElementSibling : group.nextElementSibling;
      if (target) { move(group, target, event.key === 'ArrowDown'); heading.focus(); }
    });
    root.addEventListener('mouseover', event => showTip(event.target.closest('[data-am-tip]')));
    root.addEventListener('focusin', event => showTip(event.target.closest('[data-am-tip]')));
    for (const name of ['mouseout', 'focusout']) root.addEventListener(name, event => {
      if (tipTarget && !tipTarget.contains(event.relatedTarget)) hideTip();
    });
    root.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
    window.addEventListener('storage', event => {
      if (event.key === null || event.key === KEY) { hideTip(); apply(); }
    });
    return { hideTip };
  }
  return { init };
})();
