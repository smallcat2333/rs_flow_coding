// 主窗口顶部页签：每个页签记一张图和 / 或一个 Feat 档案（任一可为空），类似 Obsidian：
// 侧栏点已打开的图或 Feat 时跳到已有页签；未打开时替换当前页签同类内容，Ctrl+点击新开页签；页签可拖动排序。
// 点 ＋ 新建空白页签并切过去，之后点的内容填进新页签。
// 切换页签时打开页签里的图与档案，并关闭页签里没有的那一类；draw.io 只有一个 iframe，切图即重新载入那张图。
// 页签列表与当前页签存 localStorage（fc-tabs），启动时恢复；独立窗口不显示页签。
// 依赖：app.js 在 init 时传入的打开 / 关闭 / 取名接口（见 init 注释）。
'use strict';

window.Tabs = (() => {
  const $ = (id) => document.getElementById(id);
  const { listen } = window.__TAURI__.event;
  const KEY = 'fc-tabs';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const blank = () => ({ flow: '', feat: '', lastActive: Date.now(), color: '' });
  const COLORS = { blue: '蓝色', purple: '紫色', orange: '橙色', red: '红色' };
  /** 页签前缀图标：与侧栏 Chart / Feat 区头同一图形（sidebar.js 的 ICON_FLOW / ICON_FEAT）。 */
  const ICON = {
    flow: '<rect x="6" y="1" width="6" height="5" rx="1"/><path d="M9 6v4M3 10h12M3 10v3M15 10v3"/><rect x="1" y="13" width="4" height="4" rx="1"/><rect x="13" y="13" width="4" height="4" rx="1"/>',
    feat: '<rect x="3" y="1" width="12" height="16" rx="2"/><path d="m6 6 1 1 2-2M10 6h2M6 11h6M6 14h4"/>',
  };

  let api = null;      // app.js 提供的接口；未初始化前 note / render 不生效
  let tabs = [];       // [{ flow: 图路径或 '', feat: 档案路径或 '' }]
  let active = 0;      // 当前页签下标
  let busy = false;    // 正在切换页签：期间打开 / 关闭引起的 note 不改页签
  let frozen = false;  // 主窗口退出中：关栏不清空页签记录，下次启动照样恢复
  let drag = null;     // 指针拖动的起点、页签下标与插入位置；未拖动时为 null
  let menu = null;     // 页签右键菜单，重绘或外部点击时关闭

  /** 按 Windows 文件路径匹配已打开内容；优先当前页签，兼容分隔符与大小写差异。 */
  function find(kind, path) {
    const key = (p) => p.replace(/\\/g, '/').toLowerCase();
    if (key(tabs[active]?.[kind] || '') === key(path)) return active;
    return tabs.findIndex((t) => key(t[kind]) === key(path));
  }

  /** 读取保存的页签；记录缺失或损坏时从一个空白页签开始。 */
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      tabs = (saved.tabs || [blank()]).map((t) => ({ flow: t.flow || '', feat: t.feat || '', lastActive: t.lastActive || Date.now(), color: Object.hasOwn(COLORS, t.color) ? t.color : '' }));
      active = saved.active || 0;
    } catch { tabs = [blank()]; }
    active = tabs.length ? Math.min(Math.max(active, 0), tabs.length - 1) : 0;
  }
  const save = () => localStorage.setItem(KEY, JSON.stringify({ tabs, active }));
  let activitySave = null;

  /** 当前页签有用户操作时更新活动时间；合并一秒内的写盘，切换和退出另行立即保存。 */
  function touch() {
    if (!api || busy || frozen || !tabs[active]) return;
    tabs[active].lastActive = Date.now();
    if (activitySave === null) activitySave = setTimeout(() => {
      activitySave = null;
      if (!frozen) save();
    }, 1000);
  }

  /** 读取小时阈值判断闲置时长；0 表示停用，外部文件更新不计作用户活动。 */
  function isExpired(t, now) {
    const hours = Settings.tabLifetime();
    return hours > 0 && now - t.lastActive >= hours * 3600000;
  }

  /** 一次清理过期页签；当前页签过期时沿用正常切换的保存流程，全部过期则关闭两栏。 */
  async function expire() {
    if (!api || busy || frozen || drag) return;
    const now = Date.now(), current = tabs[active];
    const kept = tabs.filter((t) => !isExpired(t, now));
    if (kept.length === tabs.length) return;
    if (!kept.length) return closeAll();
    const next = kept.includes(current) ? kept.indexOf(current) : Math.min(active, kept.length - 1);
    if (kept.includes(current)) {
      tabs = kept;
      active = next;
      save();
      render();
    } else {
      // activate 的 begin 会保存当前编辑内容，记录数组可先筛掉过期项。
      tabs = kept;
      await activate(next);
    }
  }

  /** 定时、恢复焦点和修改设置共用清理入口，异常使用现有悬浮提示。 */
  function checkExpiry() {
    return expire().catch((error) => floatingStatus('自动关闭页签失败：' + error));
  }

  /** 主文档与 draw.io 内都统计点击、键盘和滚轮；普通刷新和外部内容同步不刷新活动时间。 */
  function bindActivity(doc) {
    for (const event of ['pointerdown', 'keydown', 'wheel']) doc.addEventListener(event, touch, { capture: true, passive: true });
  }

  /** 页签里的一项：类别图标 + 名称（图名 / Feat 标题）；图标带无障碍名称，不只靠图形区分。 */
  const part = (kind, path) => `<span class="tab-part"><svg class="tab-icon" viewBox="0 0 18 18" role="img" aria-label="${kind === 'flow' ? '流程图' : 'Feat'}">${ICON[kind]}</svg><span class="tab-name">${esc(api.label(kind, path))}</span></span>`;

  /** 重绘页签栏：图与 Feat 同时存在时以「+」连接，都为空显示「新页签」；悬停显示完整路径。 */
  function render() {
    if (!api || drag?.moved) return;
    closeMenu();
    const bar = $('tabbar');
    bar.innerHTML = tabs.map((t, i) => {
      const parts = [t.flow && part('flow', t.flow), t.feat && part('feat', t.feat)].filter(Boolean);
      const unseen = Sidebar.isUnseen(t.flow) || Sidebar.isUnseen(t.feat);
      const title = ([t.flow, t.feat].filter(Boolean).join('\n') || '空白页签：在左侧点图或 Feat 填入') + (unseen ? '\n有未查看更新' : '');
      return `<div class="tab ${i === active ? 'active' : ''} ${unseen ? 'unseen' : ''}" data-tab="${i}"${t.color ? ` data-color="${t.color}"` : ''}>
        <button class="tab-main" role="tab" aria-selected="${i === active}" data-i="${i}" title="${esc(title)}">${t.color ? `<span class="tab-color-mark" aria-label="${COLORS[t.color]}标记"></span>` : ''}${parts.join('<span class="tab-join">+</span>') || '<span class="tab-empty">新页签</span>'}</button>
        <button class="tab-close" data-close="${i}" title="关闭页签（中键单击页签也可关闭）" aria-label="关闭页签">×</button></div>`;
    }).join('') + '<button id="tab-new" title="新建空白页签" aria-label="新建空白页签">＋</button>';
    bar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    for (const kind of ['flow', 'feat']) $('btn-' + kind + '-tab').disabled = !canSplit(kind);
  }

  /** 当前页签的某一类内容变化（app.js 在打开 / 关闭图或档案时调用）：path 为空表示该类已关闭。 */
  function note(kind, path) {
    if (!api || busy || frozen) return;
    if (!tabs.length) {
      if (!path) return;
      tabs.push(blank());
      active = 0;
    }
    const t = tabs[active];
    if (t[kind] === (path || '')) return;
    t[kind] = path || '';
    touch();
    save();
    render();
  }

  /** 切到第 i 个页签并按其内容打开 / 关闭两栏：先打开再关闭，避免中途两栏都关掉时布局跳回默认栏。 */
  async function activate(i, position = {}) {
    if (busy) return;
    busy = true;
    try {
      await api.begin();
      active = i;
      tabs[i].lastActive = Date.now();
      save();
      render();
      const t = tabs[i];
      if (t.flow) await api.openFlow(t.flow, position.node);
      if (t.feat) await api.openFeat(t.feat, position.node, position.line);
      if (!t.flow) await api.closeFlow();
      if (!t.feat) await api.closeFeat();
    } finally {
      busy = false;
      api.end();
      render();
    }
  }

  /** 新建空白页签放在当前页签右侧并切过去。 */
  const add = () => {
    const next = tabs.length ? active + 1 : 0;
    tabs.splice(next, 0, blank());
    activate(next);
  };

  /** 侧栏查找已有内容；返回是否已处理，未打开的文件继续沿用侧栏原有打开方式。 */
  async function reveal(kind, path) {
    if (!api) return false;
    if (busy) return true;
    const i = find(kind, path);
    if (i < 0) return false;
    if (i !== active) await activate(i);
    return true;
  }

  /** 按 APP 路径判断目标是否跨项目；切页签载入期间不重定向，避免递归新建。 */
  function isOtherProject(path) {
    if (!api || busy || frozen) return false;
    const project = api.project(path);
    return !!project && ['flow', 'feat'].some((kind) => {
      const p = tabs[active]?.[kind];
      const other = p && api.project(p);
      return other && other !== project;
    });
  }

  /** 在当前页签右侧打开目标；已有页签直接复用，可定位节点引用或正文行。 */
  function openNew(kind, path, position = {}) {
    if (!api || busy) return;
    const i = find(kind, path);
    if (i >= 0) return activate(i, position);
    const next = tabs.length ? active + 1 : 0;
    tabs.splice(next, 0, { ...blank(), [kind]: path });
    return activate(next, position);
  }

  /** 清除拖动标识与落点提示，取消拖动时不改变页签顺序。 */
  function clearDrag() {
    drag = null;
    document.body.classList.remove('tab-dragging');
    $('tabbar').querySelectorAll('.dragging, .drop-before, .drop-after').forEach((el) => {
      el.classList.remove('dragging', 'drop-before', 'drop-after');
    });
  }

  /** 指针拖动排序：移动超过 6px 才开始，按目标左右半边插入；取消或移出栏外不改顺序。 */
  function bindDrag(bar) {
    let suppressClick = false;
    bar.addEventListener('pointerdown', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (e.button !== 0 || busy || drag || !tab || e.target.closest('.tab-close')) return;
      drag = { from: Number(tab.dataset.tab), x: e.clientX, y: e.clientY, pointer: e.pointerId, moved: false, to: -1 };
    });
    document.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointer) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
        drag.moved = true;
        bar.setPointerCapture(e.pointerId);
        document.body.classList.add('tab-dragging');
        bar.querySelector(`[data-tab="${drag.from}"]`).classList.add('dragging');
      }
      e.preventDefault();
      bar.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
      drag.to = -1;
      const box = bar.getBoundingClientRect();
      if (e.clientY < box.top || e.clientY > box.bottom || e.clientX < box.left || e.clientX > box.right) return;
      if (e.clientX < box.left + 28) bar.scrollLeft -= 20;
      else if (e.clientX > box.right - 28) bar.scrollLeft += 20;
      const tab = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-tab]');
      if (!tab) { drag.to = tabs.length; return; }
      const target = tab.getBoundingClientRect(), before = e.clientX < target.left + target.width / 2;
      drag.to = Number(tab.dataset.tab) + (before ? 0 : 1);
      if (Number(tab.dataset.tab) !== drag.from) tab.classList.add(before ? 'drop-before' : 'drop-after');
    });
    /** 松开时提交顺序，保持当前页签对象；拖动产生的随后单击必须吞掉，避免意外切页签。 */
    const end = (e) => {
      if (!drag || e.pointerId !== drag.pointer) return;
      const { from, to, moved, pointer } = drag, current = tabs[active];
      if (bar.hasPointerCapture(pointer)) bar.releasePointerCapture(pointer);
      clearDrag();
      if (!moved) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (e.type === 'pointerup' && to >= 0 && !busy) {
        const index = to > from ? to - 1 : to;
        tabs.splice(index, 0, tabs.splice(from, 1)[0]);
        active = tabs.indexOf(current);
        save();
      }
      render();
    };
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    bar.addEventListener('click', (e) => {
      if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); suppressClick = false; }
    }, true);
  }

  /** 组合页签可拆分其中一类；单独页签无需重复拆分。 */
  function canSplit(kind) {
    const t = tabs[active];
    return !!(api && !busy && t?.[kind] && t[kind === 'flow' ? 'feat' : 'flow']);
  }

  function split(kind, position = {}) {
    if (!canSplit(kind)) return;
    const path = tabs[active][kind];
    tabs[active][kind] = '';
    return openNew(kind, path, position);
  }

  /** 关闭第 i 个页签；关的是当前页签时切到右侧相邻页签（没有则左侧），全部关完留一个空白页签。 */
  function close(i) {
    if (busy) return;
    tabs.splice(i, 1);
    if (!tabs.length) tabs.push(blank());
    if (i === active) return activate(Math.min(i, tabs.length - 1));
    if (i < active) active--;
    save();
    render();
  }

  /** 批量关闭先保存并关闭当前两栏，再清空记录，保留新建按钮。 */
  async function closeAll() {
    if (busy) return;
    busy = true;
    try {
      await api.begin();
      await api.closeFlow();
      await api.closeFeat();
      tabs = [];
      active = 0;
      save();
    } finally {
      busy = false;
      api.end();
      render();
    }
  }

  /** 以右键点中的页签为准，保留其图与档案组合。 */
  function closeOthers(i) {
    if (busy || tabs.length < 2) return;
    const keep = tabs[i], current = tabs[active];
    tabs = [keep];
    if (keep !== current) return activate(0);
    active = 0;
    save();
    render();
  }

  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
  }

  function openMenu(tab, x, y) {
    closeMenu();
    if (busy) return;
    const i = Number(tab.dataset.tab);
    menu = document.createElement('div');
    menu.className = 'entry-actions tab-actions';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '页签操作');
    menu.innerHTML = `<div class="tab-colors" role="group" aria-label="页签标色">${Object.entries(COLORS).map(([color, label]) => `<button role="menuitemradio" aria-checked="${tabs[i].color === color}" data-tab-color="${color}" title="${label}" aria-label="标为${label}"><span class="tab-color-dot"></span></button>`).join('')}<button role="menuitemradio" aria-checked="${!tabs[i].color}" data-tab-color="" title="清除标色" aria-label="清除标色"><span class="tab-color-dot" aria-hidden="true"></span></button></div>` +
      [['all', '全部关闭'], ['others', '关闭其他']].map(([action, label]) =>
      `<button role="menuitem" data-tab-action="${action}"${action === 'others' && tabs.length < 2 ? ' disabled' : ''}>${MenuIcons.forLabel(label)}<span>${label}</span></button>`).join('');
    menu.onclick = (e) => {
      const color = e.target.closest('[data-tab-color]');
      if (color) {
        tabs[i].color = color.dataset.tabColor;
        tabs[i].lastActive = Date.now();
        save();
        render();
        $('tabbar').querySelector(`[data-tab="${i}"] .tab-main`).focus({ preventScroll: true });
        return;
      }
      const button = e.target.closest('[data-tab-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.tabAction;
      closeMenu();
      Promise.resolve(action === 'all' ? closeAll() : closeOthers(i)).catch((error) => floatingStatus('关闭页签失败：' + error));
    };
    menu.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); tab.querySelector('.tab-main')?.focus(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    document.body.appendChild(menu);
    menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4)) + 'px';
    menu.querySelector('button').focus();
  }

  /** 弹出内容已关闭后移除原来的空页签；组合页签保留另一项，最后一项移出后只留新建按钮。 */
  function closeEmpty() {
    if (!api || busy || !tabs.length || tabs[active].flow || tabs[active].feat) return;
    if (tabs.length > 1) return close(active);
    tabs = [];
    active = 0;
    save();
    render();
  }

  /** 文件改名后同步页签里的路径。 */
  listen('rename-finished', ({ payload: p }) => {
    if (p.error || !api) return;
    let changed = false;
    for (const t of tabs) for (const k of ['flow', 'feat']) if (t[k] === p.oldPath) { t[k] = p.path; changed = true; }
    if (changed) { save(); render(); }
  });

  /**
   * 初始化并恢复上次的页签。a 为 app.js 提供的接口：
   * openFlow(path) / openFeat(path) 在主窗口打开（已弹到独立窗口时转给独立窗口），
   * closeFlow() / closeFeat() 关闭主窗口里的该栏，exists(kind, path) 判断文件是否还在项目里，
 * label(kind, path) 返回页签上显示的名称。
   */
  function init(a) {
    api = a;
    load();
    // 启动前先剔除闲置已超时的记录，不能因恢复页签而刷新其活动时间。
    const current = tabs[active], now = Date.now();
    tabs = tabs.filter((t) => !isExpired(t, now));
    active = tabs.includes(current) ? tabs.indexOf(current) : 0;
    // 上次退出后被删除或移出项目的文件不再恢复。
    for (const t of tabs) for (const k of ['flow', 'feat']) if (t[k] && !api.exists(k, t[k])) t[k] = '';
    save();
    bindActivity(document);
    const editor = $('editor');
    editor.addEventListener('load', () => bindActivity(editor.contentDocument));
    if (editor.contentDocument) bindActivity(editor.contentDocument);
    setInterval(checkExpiry, 60000);
    window.addEventListener('focus', checkExpiry);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkExpiry(); });
    window.addEventListener('storage', (e) => { if (e.key === 'fc-tab-lifetime') checkExpiry(); });
    window.addEventListener('pagehide', () => { if (api) save(); });
    const bar = $('tabbar');
    bar.hidden = false;
    bindDrag(bar);
    bar.addEventListener('contextmenu', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (!tab) return;
      e.preventDefault();
      openMenu(tab, e.clientX, e.clientY);
    });
    document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); });
    bar.addEventListener('scroll', closeMenu, { passive: true });
    let lastWheel = -Infinity;
    // 每个滚轮步进切换一项；触控板惯性事件短暂节流，活动项由 render 滚入视口。
    bar.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta || busy || drag || performance.now() - lastWheel < 160) return;
      const next = Math.min(tabs.length - 1, Math.max(0, active + Math.sign(delta)));
      if (next < 0 || next === active) return;
      lastWheel = performance.now();
      activate(next).catch((error) => floatingStatus('切换页签失败：' + error));
    }, { passive: false });
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
    bar.addEventListener('click', (e) => {
      if (e.target.closest('#tab-new')) { add(); return; }
      const x = e.target.closest('[data-close]');
      if (x) { close(Number(x.dataset.close)); return; }
      const t = e.target.closest('[data-i]');
      if (t && Number(t.dataset.i) !== active) activate(Number(t.dataset.i));
    });
    bar.addEventListener('auxclick', (e) => {
      const t = e.button === 1 && e.target.closest('.tab');
      if (t) { e.preventDefault(); close(Number(t.querySelector('[data-i]').dataset.i)); }
    });
    if (!tabs.length) { render(); return; }
    return activate(active);
  }

  return {
    init,
    note,
    reveal,
    isOtherProject,
    openNew,
    split,
    closeEmpty,
    render,
    checkExpiry,
    /** 主窗口退出前保存最新活动时间；之后关栏不再改页签记录。 */
    freeze: () => { save(); frozen = true; },
  };
})();
