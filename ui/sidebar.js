// 侧栏生命周期与收纳：Feat 状态来自 Markdown，Chart 启停来自项目元数据；这里只保存本机显示偏好。
'use strict';

window.Sidebar = (() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const PAGE_SIZE = 20;
  let prefs = { collapsed: [], expanded_archives: [], include_archived: false, app_aliases: {} };
  let apps = [], currentFlow = '', currentFeat = '', refresh;
  let search = '', menu = null, saveQueue = Promise.resolve();
  const limits = new Map();
  let editingApp = false;

  /** 偏好写入顺序与点击顺序一致；失败保留错误提示，不吞掉保存失败。 */
  function persist() {
    const sidebar = JSON.parse(JSON.stringify(prefs));
    saveQueue = saveQueue.catch(() => {}).then(() => invoke('save_sidebar', { sidebar }));
    saveQueue.catch((e) => { $('side-msg').textContent = '侧栏设置保存失败：' + e; });
    return saveQueue;
  }

  /** 切换一个折叠键；收纳区默认折叠，普通分组默认展开。 */
  function toggle(key, archived) {
    const field = archived ? 'expanded_archives' : 'collapsed';
    const set = new Set(prefs[field]);
    if (set.has(key)) set.delete(key); else set.add(key);
    prefs[field] = [...set];
    persist();
    render(apps, currentFlow, currentFeat);
  }

  /** 一行锁标签；生命周期标识与节点颜色徽标分开显示。 */
  function lockTag(lock) {
    return lock ? `<span class="lock-dot">${lock.owner === 'agent' ? 'Agent 编辑中' : '编辑中'}</span>` : '';
  }

  /** 流程图行：启用与停用均可查看，停用项不显示日常待办徽标。 */
  function flowRow(f) {
    return `<div class="file ${f.path === currentFlow ? 'active' : ''} ${f.enabled ? '' : 'archived-entry'}" data-path="${esc(f.path)}" tabindex="0" title="${esc(f.path)}">
      <span class="file-name">${esc(f.name.replace(/\.drawio$/i, ''))}</span>${lockTag(f.lock)}
      ${f.error ? `<span class="err" title="${esc(f.error)}">解析失败</span>` : f.enabled ? badges(f.counts) : ''}</div>`;
  }

  /** Feat 行：阶段仍保留，关闭与废弃单独标识，不以开发完成推断关闭。 */
  function featRow(f) {
    return `<div class="feat ${f.path === currentFeat ? 'active' : ''} ${f.archived ? 'archived-entry' : ''}" data-feat="${esc(f.path)}" data-id="${esc(f.id)}" tabindex="0" title="${esc(f.path)}">
      <div class="feat-line"><span class="file-name">${esc(f.title || f.id)}</span>${lockTag(f.lock)}
        ${!f.archived ? f.closable ? '<span class="closable" title="关联节点全部已实现">可关闭</span>' : badges(f.counts) : ''}</div>
      <div class="feat-meta"><span>${esc(f.id)}</span><span>${esc(f.status)}</span>${f.tasks_total ? `<span>T ${f.tasks_done}/${f.tasks_total}</span>` : ''}<span>${f.node_total} 节点</span></div></div>`;
  }

  /** 每组最多先显示 20 项；继续加载不改变文件状态。搜索时也分批，避免大历史一次撑满树。 */
  function page(list, key, row) {
    const limit = limits.get(key) || PAGE_SIZE;
    return list.slice(0, limit).map(row).join('') + (list.length > limit
      ? `<button class="show-more" data-more="${esc(key)}">再显示 ${Math.min(PAGE_SIZE, list.length - limit)} 项（还有 ${list.length - limit} 项）</button>` : '');
  }

  /** 收纳区按关闭/停用年份分组；日期缺失的旧档案归到「未注明年份」。 */
  function archive(list, key, row, label, dateField) {
    if (!list.length) return '';
    const expanded = prefs.expanded_archives.includes(key) || !!search;
    let content = '';
    if (expanded) {
      const years = new Map();
      for (const f of list) {
        const year = /^\d{4}/.exec(f[dateField])?.[0] || '未注明年份';
        if (!years.has(year)) years.set(year, []);
        years.get(year).push(f);
      }
      content = [...years.keys()].sort().reverse().map((year) => `<div class="archive-year">${esc(year)}</div>${page(years.get(year), key + '#' + year, row)}`).join('');
    }
    return `<div class="archive-section"><button class="archive-toggle" data-archive="${esc(key)}" aria-expanded="${expanded}"><span>${expanded ? '▾' : '▸'} ${label}</span><span>${list.length}</span></button>${expanded ? `<div class="archive-body">${content}</div>` : ''}</div>`;
  }

  /** 一类文档的活跃项与历史区，普通组的折叠偏好在搜索时暂时展开。 */
  function section(a, kind) {
    const flow = kind === 'flow';
    const all = flow ? a.files : a.feats;
    const matches = (f) => !search || `${f.name || ''} ${f.title || ''} ${f.id || ''} ${f.status || ''}`.toLowerCase().includes(search);
    const active = all.filter((f) => (flow ? f.enabled : !f.archived) && matches(f));
    const archived = all.filter((f) => (flow ? !f.enabled : f.archived) && matches(f) && (!search || prefs.include_archived));
    if (search && !active.length && !archived.length) return '';
    const key = a.flow_dir + '#' + kind;
    const collapsed = !search && prefs.collapsed.includes(key);
    const row = flow ? flowRow : featRow;
    const activeCount = all.filter((f) => flow ? f.enabled : !f.archived).length;
    const icon = flow
      ? '<rect x="6" y="1" width="6" height="5" rx="1"/><path d="M9 6v4M3 10h12M3 10v3M15 10v3"/><rect x="1" y="13" width="4" height="4" rx="1"/><rect x="13" y="13" width="4" height="4" rx="1"/>'
      : '<rect x="3" y="1" width="12" height="16" rx="2"/><path d="m6 6 1 1 2-2M10 6h2M6 11h6M6 14h4"/>';
    return `<div class="sec ${collapsed ? 'collapsed' : ''}" data-key="${esc(key)}">
      <div class="sec-head" role="button" tabindex="0" aria-expanded="${!collapsed}" title="${flow ? '流程图' : '功能需求档案'}">
        <svg class="sec-icon" viewBox="0 0 18 18" aria-hidden="true">${icon}</svg>
        <span class="sec-title">${flow ? 'Chart' : 'Feat'}</span><span class="sec-count" title="${flow ? '启用的流程图数量' : '开启的 Feat 数量'}">${activeCount}</span>
        <button class="${flow ? 'app-new' : 'feat-new'}" data-dir="${esc(flow ? a.flow_dir : a.feat_dir)}" title="${flow ? '新建流程图' : '新建 Feat 档案'}">＋</button></div>
      <div class="sec-body">${page(active, key, row) || `<div class="empty mini">${search ? '没有匹配的活跃项' : flow ? '暂无启用的流程图' : '暂无开启的 Feat'}</div>`}
      ${archive(archived, key + '#archive', row, flow ? '已停用' : '已收纳', flow ? 'disabled_at' : 'closed_at')}</div></div>`;
  }

  /** APP 只修改本机显示名，空值或原名恢复默认；写入失败恢复先前显示。 */
  async function renameApp(app) {
    if (editingApp) return;
    editingApp = true;
    const previous = prefs.app_aliases[app.flow_dir];
    try {
      const name = await ask('修改 APP 显示名（清空恢复原名）', previous || app.app);
      if (name === null) return;
      if (!name || name === app.app) delete prefs.app_aliases[app.flow_dir];
      else prefs.app_aliases[app.flow_dir] = name;
      try { await persist(); }
      catch (error) {
        if (previous) prefs.app_aliases[app.flow_dir] = previous;
        else delete prefs.app_aliases[app.flow_dir];
        throw error;
      }
      render(apps, currentFlow, currentFeat);
    } finally { editingApp = false; }
  }

  /** 重绘侧栏，合计继续使用后端只包含启用 Chart 的统计。 */
  function render(nextApps, flowPath, featPath) {
    closeMenu();
    apps = nextApps; currentFlow = flowPath; currentFeat = featPath;
    const total = {};
    let html = '', group = null;
    for (const a of apps) {
      for (const [k, v] of Object.entries(a.counts)) total[k] = (total[k] || 0) + v;
      const sections = section(a, 'flow') + section(a, 'feat');
      if (!sections) continue;
      if (a.group !== group) { group = a.group; html += `<div class="group">${esc(group || '未分组')}</div>`; }
      const collapsed = !search && prefs.collapsed.includes(a.flow_dir);
      const alias = prefs.app_aliases[a.flow_dir];
      html += `<div class="app ${collapsed ? 'collapsed' : ''}" data-key="${esc(a.flow_dir)}"><div class="app-head" role="button" tabindex="0" aria-expanded="${!collapsed}">
        <span class="app-toggle" aria-hidden="true">${collapsed ? '▸' : '▾'}</span>
        <span class="app-name" title="双击修改显示名；原目录：${esc(a.app)}"><span class="app-display">${esc(alias || a.app)}</span>${alias ? `<small class="app-original" title="${esc(a.app)}">${esc(a.app)}</small>` : ''}</span>
        ${badges(a.counts)}</div>${sections}</div>`;
    }
    $('tree').innerHTML = html || '<div class="empty mini">没有匹配项</div>';
    const count = whoCounts(total);
    $('t-user').textContent = count.user;
    $('t-agent').textContent = count.agent;
  }

  /** 关闭右键菜单并把焦点还给对应条目，避免滚动列表。 */
  function closeMenu() {
    if (!menu) return;
    const trigger = menu.trigger;
    menu.remove(); menu = null;
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  /** 在条目的右键位置显示状态菜单；菜单边界保持在窗口内，不改变当前打开文件。 */
  function openMenu(trigger, x, y) {
    closeMenu();
    const kind = trigger.classList.contains('file') ? 'flow' : 'feat';
    const path = kind === 'flow' ? trigger.dataset.path : trigger.dataset.feat;
    const app = apps.find((a) => (kind === 'flow' ? a.files : a.feats).some((f) => f.path === path));
    const f = (kind === 'flow' ? app.files : app.feats).find((f) => f.path === path);
    const actions = kind === 'flow' ? [[f.enabled ? 'disable' : 'enable', f.enabled ? '停用并收纳' : '重新启用']]
      : f.archived ? [['reopen', '重新开启']] : [['close', '关闭并收纳'], ['drop', '废弃并收纳']];
    menu = document.createElement('div');
    menu.className = 'entry-actions'; menu.setAttribute('role', 'menu'); menu.trigger = trigger;
    menu.innerHTML = actions.map(([action, name]) => `<button role="menuitem" data-action="${action}">${name}</button>`).join('');
    menu.onclick = (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      closeMenu();
      changeStatus(kind, f, action).catch((error) => { $('side-msg').textContent = String(error); });
    };
    document.body.appendChild(menu);
    menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4)) + 'px';
    menu.querySelector('button').focus();
  }

  /** 状态确认框：显示未完成项；重新开启时允许指定阶段。取消不会写文件。 */
  function confirmStatus(title, details, reopen) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'lifecycle-dialog';
      dialog.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><p>${esc(details)}</p>${reopen ? '<label>恢复阶段<select name="stage"><option>开发中</option><option>需求整理中</option><option>测试中</option></select></label>' : ''}<div class="dlg-btns"><button value="cancel">取消</button><button value="confirm">${reopen ? '重新开启' : '确认'}</button></div></form>`;
      document.body.appendChild(dialog);
      dialog.addEventListener('close', () => {
        const result = dialog.returnValue === 'confirm' ? (reopen ? dialog.querySelector('select').value : true) : null;
        dialog.remove(); resolve(result);
      }, { once: true });
      dialog.showModal();
    });
  }

  /** 用户确认后调用后端原子修改；读取哈希后如被其他编辑者改动则后端拒绝。 */
  async function changeStatus(kind, f, action) {
    const name = f.title || f.name || f.id;
    const doc = kind === 'feat' ? await invoke('read_md', { path: f.path }) : null;
    let details = '原文件和历史保留，可从收纳区恢复。';
    if (kind === 'flow') details = action === 'disable' ? '停用后移入收纳区，不再计入顶部待办。原图和关联 Feat 保留。' : '恢复到启用列表，重新计入顶部待办。';
    else if (action === 'close') {
      const pending = f.node_total - (f.counts.none || 0), tasks = f.tasks_total - f.tasks_done;
      details = `还有 ${tasks} 个开发任务、${pending} 个非无色节点。确认关闭后收纳档案，关联流程图保持当前状态。`;
    } else if (action === 'reopen') details = '恢复到开启列表并清空关闭日期，关联流程图保持当前状态。';
    const verb = { enable: '重新启用', disable: '停用', close: '关闭', drop: '废弃', reopen: '重新开启' }[action];
    const result = await confirmStatus(`${verb}「${name}」？`, details, action === 'reopen');
    if (!result) return;
    if (kind === 'flow') await invoke('set_chart_enabled', { path: f.path, enabled: action === 'enable' });
    else await invoke('set_feat_status', { path: f.path, status: action === 'reopen' ? result : action === 'close' ? '已关闭' : '已废弃', expectedHash: doc.hash });
    $('side-msg').textContent = '';
    await refresh();
  }

  /** 初始化本机偏好及事件；树中原有的打开文件/新建交互由 app.js 继续处理。 */
  async function init(onRefresh) {
    refresh = onRefresh;
    const config = await invoke('get_config');
    prefs = config.sidebar;
    $('search-archived').checked = prefs.include_archived;
    $('tree-search').oninput = (e) => { search = e.target.value.trim().toLowerCase(); limits.clear(); closeMenu(); render(apps, currentFlow, currentFeat); };
    $('search-archived').onchange = (e) => { prefs.include_archived = e.target.checked; persist(); render(apps, currentFlow, currentFeat); };
    $('tree').addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.file, .feat');
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      openMenu(row, e.clientX, e.clientY);
    }, true);
    $('tree').addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      const archived = e.target.closest('[data-archive]');
      const head = e.target.closest('.app-head, .sec-head');
      if (more) { e.stopImmediatePropagation(); limits.set(more.dataset.more, (limits.get(more.dataset.more) || PAGE_SIZE) + PAGE_SIZE); render(apps, currentFlow, currentFeat); }
      else if (archived) { e.stopImmediatePropagation(); toggle(archived.dataset.archive, true); }
      else if (head && !e.target.closest('.app-new, .feat-new')) {
        e.stopImmediatePropagation();
        // 名称留给双击编辑，不在第一次点击时重绘 DOM；小三角和空白处仍可单击折叠。
        if (head.classList.contains('app-head') && e.target.closest('.app-name')) return;
        toggle(head.parentElement.dataset.key, false);
      }
    }, true);
    $('tree').addEventListener('dblclick', (e) => {
      const head = e.target.closest('.app-head');
      if (!head || !e.target.closest('.app-name')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const app = apps.find((a) => a.flow_dir === head.parentElement.dataset.key);
      renameApp(app).catch((error) => { $('side-msg').textContent = '修改 APP 显示名失败：' + error; });
    }, true);
    $('tree').addEventListener('keydown', (e) => {
      if (e.target.matches('.app-head, .sec-head') && ['Enter', ' '].includes(e.key)) { e.preventDefault(); e.target.click(); }
      if (e.target.matches('.file, .feat') && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
        e.preventDefault();
        const box = e.target.getBoundingClientRect();
        openMenu(e.target, box.left + 12, box.bottom);
      }
    });
    document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu) { e.stopImmediatePropagation(); closeMenu(); } }, true);
    $('tree').addEventListener('wheel', closeMenu, { passive: true });
    window.addEventListener('resize', closeMenu);
  }

  return { init, render };
})();
