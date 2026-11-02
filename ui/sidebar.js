// 侧栏生命周期与收纳：Feat 状态来自 Markdown，Chart 启停来自项目元数据；这里只保存本机显示偏好
// （折叠、别名、分组/APP 顺序、更新置顶与未查看标记）。
'use strict';

window.Sidebar = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** 置顶与未查看标记用的路径键：统一分隔符并忽略大小写（Windows 路径）。 */
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  /** 分组键：分组目录路径（APP 目录的父目录）；未分组的 APP 合并为空串一组。 */
  const groupKey = (a) => a.group ? a.flow_dir.replace(/[\\/][^\\/]+[\\/]docs[\\/]flow$/i, '') : '';
  const PAGE_SIZE = 20;
  /** 一次写盘常触发多次文件通知，同一条目在该时间内只置顶一次（毫秒）。 */
  const BUMP_DEBOUNCE_MS = 1500;
  const ICON_EXPAND = 'm7 9 5-5 5 5M7 15l5 5 5-5';
  const ICON_COLLAPSE = 'm7 4 5 5 5-5M7 20l5-5 5 5';
  let prefs;
  let apps = [], currentFlow = '', currentFeat = '', refresh;
  let search = '', menu = null, saveQueue = Promise.resolve();
  const limits = new Map();
  let editing = false, drag = null;

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

  /** 全部展开/收纳只更新折叠偏好；清除搜索的强制展开，分页仍按每批20项显示。 */
  function setAllExpanded(expanded) {
    const keys = apps.flatMap((a) => [a.flow_dir, a.flow_dir + '#flow', a.flow_dir + '#feat']);
    prefs.collapsed = expanded ? [] : keys;
    prefs.expanded_archives = expanded ? apps.flatMap((a) => [a.flow_dir + '#flow#archive', a.flow_dir + '#feat#archive']) : [];
    persist();
    $('tree-search').value = '';
    setSearch('');
  }

  /** 顶部单个展开/收纳按钮：有折叠项时执行「全部展开」，否则执行「全部收纳」，图标与提示随之切换。 */
  function syncToggleAll() {
    const expand = prefs.collapsed.length > 0;
    const label = expand ? '全部展开' : '全部收纳';
    $('btn-toggle-all').title = label;
    $('btn-toggle-all').setAttribute('aria-label', label);
    $('toggle-all-icon').setAttribute('d', expand ? ICON_EXPAND : ICON_COLLAPSE);
  }

  /** 按偏好顺序排列：分组按 group_order，组内 APP 按 app_order；未列出的保持扫描顺序排在后面（稳定排序）。 */
  function ordered() {
    const rank = (order, key) => { const i = order.indexOf(key); return i < 0 ? Infinity : i; };
    const groups = new Map();
    for (const a of apps) {
      const key = groupKey(a);
      if (!groups.has(key)) groups.set(key, { key, name: a.group, apps: [] });
      groups.get(key).apps.push(a);
    }
    const list = [...groups.values()].sort((x, y) => rank(prefs.group_order, x.key) - rank(prefs.group_order, y.key));
    for (const g of list) g.apps.sort((x, y) => rank(prefs.app_order, x.flow_dir) - rank(prefs.app_order, y.flow_dir));
    return list;
  }

  /** 列表内最近置顶的条目在前（时间倒序），从未置顶的保持原顺序。 */
  function byBump(list) {
    const at = (f) => prefs.bumped[norm(f.path)] || 0;
    return [...list].sort((x, y) => at(y) - at(x));
  }

  /** Agent/外部改动时置顶：条目记置顶时间与未查看标记，所属 APP 与分组移到最前。
   *  仅主窗口处理（独立窗口不显示侧栏，避免多窗口重复写偏好）；关闭自动置顶或当前正打开的条目不标未查看。 */
  function bump(path) {
    if (SOLO || !prefs.auto_top) return;
    const key = norm(path), now = Date.now();
    if (now - (prefs.bumped[key] || 0) < BUMP_DEBOUNCE_MS) return;
    prefs.bumped[key] = now;
    if (key !== norm(currentFlow) && key !== norm(currentFeat) && !prefs.unseen.includes(key)) prefs.unseen.push(key);
    const dir = key.replace(/\/[^/]+$/, '');
    const app = apps.find((a) => norm(a.flow_dir) === dir || norm(a.feat_dir) === dir);
    if (app) {
      const groups = ordered(), group = groupKey(app);
      prefs.app_order = [app.flow_dir, ...groups.flatMap((g) => g.apps.map((a) => a.flow_dir)).filter((k) => k !== app.flow_dir)];
      prefs.group_order = [group, ...groups.map((g) => g.key).filter((k) => k !== group)];
    }
    persist();
    render(apps, currentFlow, currentFeat);
  }

  /** 去掉一条未查看标记；返回是否有变化。 */
  function markSeen(path) {
    const key = norm(path);
    if (!path || !prefs.unseen.includes(key)) return false;
    prefs.unseen = prefs.unseen.filter((k) => k !== key);
    return true;
  }

  /** 刷新后清理已不存在文件的置顶时间与未查看标记（文件删除、重命名后不再累积）。 */
  function prune(list) {
    if (SOLO) return;
    const live = new Set(list.flatMap((a) => [...a.files, ...a.feats].map((f) => norm(f.path))));
    const stale = Object.keys(prefs.bumped).filter((k) => !live.has(k));
    stale.forEach((k) => delete prefs.bumped[k]);
    const unseen = prefs.unseen.filter((k) => live.has(k));
    if (!stale.length && unseen.length === prefs.unseen.length) return;
    prefs.unseen = unseen;
    persist();
  }

  /** 一行锁标签；生命周期标识与节点颜色徽标分开显示。 */
  function lockTag(lock) {
    return lock ? `<span class="lock-dot">${lock.owner === 'agent' ? 'Agent 编辑中' : '编辑中'}</span>` : '';
  }

  /** 条目行公共类名：当前打开、收纳灰显、更新未查看淡蓝底。 */
  function rowClass(f, current, archived) {
    return `${f.path === current ? 'active' : ''} ${archived ? 'archived-entry' : ''} ${prefs.unseen.includes(norm(f.path)) ? 'unseen' : ''}`;
  }

  /** 流程图行：启用与停用均可查看，停用项不显示日常待办徽标。 */
  function flowRow(f) {
    return `<div class="file ${rowClass(f, currentFlow, !f.enabled)}" data-path="${esc(f.path)}" tabindex="0" title="${esc(f.path)}">
      <span class="file-name">${esc(f.name.replace(/\.drawio$/i, ''))}</span>${lockTag(f.lock)}
      ${f.error ? `<span class="err" title="${esc(f.error)}">解析失败</span>` : f.enabled ? badges(f.counts) : ''}</div>`;
  }

  /** Feat 行：阶段仍保留，关闭与废弃单独标识，不以开发完成推断关闭。 */
  function featRow(f) {
    return `<div class="feat ${rowClass(f, currentFeat, f.archived)}" data-feat="${esc(f.path)}" data-id="${esc(f.id)}" tabindex="0" title="${esc(f.path)}">
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

  /** 一类文档的活跃项与历史区，普通组的折叠偏好在搜索时暂时展开；活跃项按最近置顶排序。 */
  function section(a, kind) {
    const flow = kind === 'flow';
    const all = flow ? a.files : a.feats;
    const matches = (f) => !search || `${f.name || ''} ${f.title || ''} ${f.id || ''} ${f.status || ''}`.toLowerCase().includes(search);
    const active = byBump(all.filter((f) => (flow ? f.enabled : !f.archived) && matches(f)));
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

  /** 原位编辑 APP 或分组显示名：Enter/失焦保存、Esc 取消；空值或填回原名恢复默认，写入失败恢复旧别名。
   *  field 为 prefs 中的别名表（app_aliases / group_aliases），key 为对应键，original 为目录原名。 */
  async function rename(field, key, original, element, label) {
    if (editing) return;
    editing = true;
    const aliases = prefs[field];
    const previous = aliases[key];
    const input = document.createElement('input');
    input.className = 'app-rename';
    input.type = 'text';
    input.value = previous || original;
    input.setAttribute('aria-label', label);
    element.closest('[draggable]').draggable = false;
    element.replaceChildren(input);
    input.focus();
    input.select();
    try {
      const name = await new Promise((resolve) => {
        let finished = false;
        /** 每次编辑只提交一次，禁用输入产生的 blur 不重复写入。 */
        function finish(save) {
          if (finished) return;
          finished = true;
          const value = save ? input.value.trim() : null;
          input.disabled = true;
          resolve(value);
        }
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.isComposing) return;
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            finish(e.key === 'Enter');
          }
        });
        input.addEventListener('blur', () => finish(true));
      });
      if (name === null) return;
      if (!name || name === original) delete aliases[key];
      else aliases[key] = name;
      try { await persist(); }
      catch (error) {
        if (previous) aliases[key] = previous;
        else delete aliases[key];
        throw error;
      }
    } finally {
      editing = false;
      render(apps, currentFlow, currentFeat);
    }
  }

  /** APP 行固定显示三个优先统计（含零值），绿色确认和确认删除合计为待 Agent 实现。 */
  function appBadges(counts) {
    const primary = [
      { key: 'review', name: '起草待审', value: counts.review },
      { key: 'confirmed', name: '待 Agent 实现', value: counts.confirmed + counts.confirm_delete },
      { key: 'issue', name: '有问题', value: counts.issue },
    ];
    const fixed = primary.map((s) => `<span class="badge s-${s.key}" data-status="${s.key}" title="${s.name}" aria-label="${s.name} ${s.value}">${s.value}</span>`).join('');
    const other = STATUS.filter((s) => !['none', 'review', 'confirmed', 'confirm_delete', 'issue'].includes(s.key) && counts[s.key] > 0)
      .map((s) => `<span class="badge app-badge-other s-${s.key}" data-status="${s.key}" title="${s.name}" hidden>${counts[s.key]}</span>`).join('');
    return `<span class="badges app-badges">${fixed}${other}</span>`;
  }

  /** 按实际宽度放入其他徽标，预留名称空间；三个优先统计始终完整且不换行。 */
  function fitAppBadges() {
    for (const head of $('tree').querySelectorAll('.app-head')) {
      const name = head.querySelector('.app-name');
      const display = name.querySelector('.app-display, .app-rename');
      const original = name.querySelector('.app-original');
      const group = head.querySelector('.app-badges');
      const other = [...group.querySelectorAll('.app-badge-other')];
      other.forEach((badge) => { badge.hidden = true; });
      const style = getComputedStyle(head);
      const width = head.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const toggle = head.querySelector('.app-toggle').offsetWidth;
      const gap = parseFloat(style.columnGap);
      const wanted = display.scrollWidth + (original ? Math.min(original.scrollWidth, 48) + 6 : 0);
      const reserved = Math.min(wanted, (width - toggle - gap * 2) / 2);
      let free = width - toggle - gap * 2 - reserved - group.getBoundingClientRect().width;
      const badgeGap = parseFloat(getComputedStyle(group).columnGap);
      for (const badge of other) {
        badge.hidden = false;
        const needed = badge.getBoundingClientRect().width + badgeGap;
        if (needed <= free) free -= needed;
        else badge.hidden = true;
      }
    }
  }
  const appResize = new ResizeObserver(() => fitAppBadges());

  /** 重绘侧栏：按偏好顺序输出分组与 APP，合计继续使用后端只包含启用 Chart 的统计。
   *  当前打开的条目视为已查看，主窗口顺带清除其未查看标记。 */
  function render(nextApps, flowPath, featPath) {
    apps = nextApps; currentFlow = flowPath; currentFeat = featPath;
    // 后台刷新只更新数据，编辑结束再绘制，避免原位输入被替换。
    if (editing) return;
    if (!SOLO && (markSeen(flowPath) | markSeen(featPath))) persist();
    closeMenu();
    appResize.disconnect();
    const total = {};
    for (const a of apps) for (const [k, v] of Object.entries(a.counts)) total[k] = (total[k] || 0) + v;
    let html = '';
    for (const g of ordered()) {
      let body = '';
      for (const a of g.apps) {
        const sections = section(a, 'flow') + section(a, 'feat');
        if (!sections) continue;
        const collapsed = !search && prefs.collapsed.includes(a.flow_dir);
        const alias = prefs.app_aliases[a.flow_dir];
        const unseen = [...a.files, ...a.feats].some((f) => prefs.unseen.includes(norm(f.path)));
        body += `<div class="app ${collapsed ? 'collapsed' : ''}" data-key="${esc(a.flow_dir)}" data-group="${esc(g.key)}"><div class="app-head ${unseen ? 'unseen' : ''}" role="button" tabindex="0" aria-expanded="${!collapsed}" draggable="true" title="拖动调整 APP 顺序">
          <span class="app-toggle" aria-hidden="true">${collapsed ? '▸' : '▾'}</span>
          <span class="app-name"><span class="app-display">${esc(alias || a.app)}</span>${alias ? `<small class="app-original">${esc(a.app)}</small>` : ''}</span>
          ${appBadges(a.counts)}</div>${sections}</div>`;
      }
      if (!body) continue;
      const alias = prefs.group_aliases[g.key];
      html += `<div class="group-block" data-group="${esc(g.key)}"><div class="group" draggable="true" title="拖动调整分组顺序，双击名称修改显示名">
        <span class="group-name"><span class="group-display">${esc(alias || g.name || '未分组')}</span>${alias ? `<small class="group-original">${esc(g.name || '未分组')}</small>` : ''}</span></div>${body}</div>`;
    }
    $('tree').innerHTML = html || '<div class="empty mini">没有匹配项</div>';
    fitAppBadges();
    $('tree').querySelectorAll('.app-head').forEach((head) => appResize.observe(head));
    renderStatusStats(total);
    syncToggleAll();
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
      : f.archived ? [['reopen', '重新开启']] : [['close', '关闭（走 skill）'], ['drop', '废弃（走 skill）']];
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

  /** 关闭/废弃需同步发布说明、CHANGELOG、README 并提交，只给出 skill 命令供复制，不写文件。 */
  function showSkillCommand(f, action) {
    const close = action === 'close';
    const command = close ? `/smallcat-feat-5-close ${f.id}` : `/smallcat-feat-drop ${f.id} <废弃原因>`;
    const pending = f.node_total - (f.counts.none || 0), tasks = f.tasks_total - f.tasks_done;
    const details = close
      ? `当前还有 ${tasks} 个开发任务、${pending} 个非无色节点。关闭需生成发布说明、写 CHANGELOG、更新 README 并提交，请在 Agent 会话中运行：`
      : '废弃需记录原因、清理本 Feat 草图节点、更新 README 并提交，请在 Agent 会话中运行：';
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'lifecycle-dialog';
      dialog.innerHTML = `<form method="dialog"><h3>${close ? '关闭' : '废弃'}「${esc(f.title || f.id)}」</h3><p>${esc(details)}</p><p><code>${esc(command)}</code></p><div class="dlg-btns"><button value="cancel">取消</button><button value="copy">复制命令</button></div></form>`;
      document.body.appendChild(dialog);
      dialog.addEventListener('close', () => {
        const copy = dialog.returnValue === 'copy';
        dialog.remove();
        if (!copy) return resolve();
        navigator.clipboard.writeText(command).then(() => { $('side-msg').textContent = '已复制：' + command; resolve(); });
      }, { once: true });
      dialog.showModal();
    });
  }

  /** 用户确认后调用后端原子修改；读取哈希后如被其他编辑者改动则后端拒绝。 */
  async function changeStatus(kind, f, action) {
    if (kind === 'feat' && action !== 'reopen') return showSkillCommand(f, action);
    const name = f.title || f.name || f.id;
    const doc = kind === 'feat' ? await invoke('read_md', { path: f.path }) : null;
    let details = '原文件和历史保留，可从收纳区恢复。';
    if (kind === 'flow') details = action === 'disable' ? '停用后移入收纳区，不再计入顶部待办。原图和关联 Feat 保留。' : '恢复到启用列表，重新计入顶部待办。';
    else if (action === 'reopen') details = '恢复到开启列表并清空关闭日期，关联流程图保持当前状态。';
    const verb = { enable: '重新启用', disable: '停用', reopen: '重新开启' }[action];
    const result = await confirmStatus(`${verb}「${name}」？`, details, action === 'reopen');
    if (!result) return;
    if (kind === 'flow') await invoke('set_chart_enabled', { path: f.path, enabled: action === 'enable' });
    else await invoke('set_feat_status', { path: f.path, status: result, expectedHash: doc.hash });
    $('side-msg').textContent = '';
    await refresh();
  }

  /** 悬浮搜索框：放大镜切换显示；关闭时保留搜索词，放大镜高亮提示仍在筛选。 */
  function showSearch(open) {
    $('tree-filter').hidden = !open;
    $('btn-search').setAttribute('aria-expanded', String(open));
    if (open) { $('tree-search').focus(); $('tree-search').select(); }
  }

  /** 搜索词变化：重置分页并重绘；放大镜在有搜索词时高亮，提示当前筛选内容。 */
  function setSearch(value) {
    search = value.trim().toLowerCase();
    limits.clear();
    closeMenu();
    $('btn-search').classList.toggle('filtering', !!search);
    $('btn-search').title = search ? `正在搜索「${value.trim()}」，点击修改` : '搜索名称或 Feat 编号';
    render(apps, currentFlow, currentFeat);
  }

  /** 拖动落点：分组只能落在分组区块上，APP 只能落在同一分组内的其他 APP 上；返回目标元素与键。 */
  function dropTarget(e) {
    if (!drag) return null;
    const block = e.target.closest('.group-block');
    if (drag.type === 'group') return block && block.dataset.group !== drag.key ? { el: block, key: block.dataset.group } : null;
    const app = e.target.closest('.app');
    return app && app.dataset.group === drag.group && app.dataset.key !== drag.key ? { el: app, key: app.dataset.key } : null;
  }

  /** 清除拖动落点提示线。 */
  function clearDrop() {
    $('tree').querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }

  /** 把 key 移到 target 前/后，返回新顺序。 */
  function moveKey(list, key, target, before) {
    const out = list.filter((k) => k !== key);
    out.splice(out.indexOf(target) + (before ? 0 : 1), 0, key);
    return out;
  }

  /** 分组与 APP 上下拖动排序：顺序写入本机偏好；APP 不跨分组（分组由目录决定）。 */
  function bindDrag() {
    const tree = $('tree');
    tree.addEventListener('dragstart', (e) => {
      const head = e.target.closest('.app-head'), group = e.target.closest('.group');
      if (editing || (!head && !group)) return;
      closeMenu();
      drag = head ? { type: 'app', key: head.parentElement.dataset.key, group: head.parentElement.dataset.group }
        : { type: 'group', key: group.parentElement.dataset.group };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', drag.key);
      (head || group).classList.add('dragging');
    });
    tree.addEventListener('dragover', (e) => {
      const target = dropTarget(e);
      clearDrop();
      if (!target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const box = target.el.getBoundingClientRect();
      target.el.classList.add(e.clientY < box.top + box.height / 2 ? 'drop-before' : 'drop-after');
    });
    tree.addEventListener('drop', (e) => {
      const target = dropTarget(e);
      if (!target) return;
      e.preventDefault();
      const before = target.el.classList.contains('drop-before');
      const groups = ordered();
      if (drag.type === 'group') prefs.group_order = moveKey(groups.map((g) => g.key), drag.key, target.key, before);
      else prefs.app_order = moveKey(groups.flatMap((g) => g.apps.map((a) => a.flow_dir)), drag.key, target.key, before);
      drag = null;
      persist();
      render(apps, currentFlow, currentFeat);
    });
    tree.addEventListener('dragend', () => {
      drag = null;
      clearDrop();
      tree.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    });
  }

  /** 开关更新自动置顶；关闭后已有顺序保持不变，只是不再新增置顶和未查看标记。 */
  function setAutoTop(enabled) {
    prefs.auto_top = enabled;
    return persist();
  }

  /** 初始化本机偏好及事件；树中原有的打开文件/新建交互由 app.js 继续处理。 */
  async function init(onRefresh) {
    refresh = onRefresh;
    const config = await invoke('get_config');
    prefs = config.sidebar;
    $('search-archived').checked = prefs.include_archived;
    $('btn-toggle-all').onclick = () => setAllExpanded(prefs.collapsed.length > 0);
    $('btn-search').onclick = () => showSearch($('tree-filter').hidden);
    $('tree-search').oninput = (e) => setSearch(e.target.value);
    $('tree-search').addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      $('tree-search').value = '';
      setSearch('');
      showSearch(false);
      $('btn-search').focus();
    });
    $('search-archived').onchange = (e) => { prefs.include_archived = e.target.checked; persist(); render(apps, currentFlow, currentFeat); };
    // 点搜索框外（含树中的搜索结果）收起悬浮框，搜索词保留。
    document.addEventListener('pointerdown', (e) => {
      if (!$('tree-filter').hidden && !e.target.closest('#tree-filter, #btn-search')) showSearch(false);
    });
    if (!SOLO) {
      listen('flow-changed', (ev) => { if (ev.payload.hash && ev.payload.source !== 'user') bump(ev.payload.path); });
      listen('md-changed', (ev) => { if (ev.payload.hash && ev.payload.source !== 'user') bump(ev.payload.path); });
    }
    bindDrag();
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
      const row = e.target.closest('.file, .feat');
      if (more) { e.stopImmediatePropagation(); limits.set(more.dataset.more, (limits.get(more.dataset.more) || PAGE_SIZE) + PAGE_SIZE); render(apps, currentFlow, currentFeat); }
      else if (archived) { e.stopImmediatePropagation(); toggle(archived.dataset.archive, true); }
      else if (head && !e.target.closest('.app-new, .feat-new')) {
        e.stopImmediatePropagation();
        // 名称留给双击编辑，不在第一次点击时重绘 DOM；小三角和空白处仍可单击折叠。
        if (head.classList.contains('app-head') && e.target.closest('.app-name')) return;
        toggle(head.parentElement.dataset.key, false);
      } else if (row && markSeen(row.dataset.path || row.dataset.feat)) {
        // 点开即视为已查看；打开文件仍交给 app.js 的冒泡处理，本次点击结束后再重绘 APP 行标记。
        row.classList.remove('unseen');
        persist();
        setTimeout(() => render(apps, currentFlow, currentFeat));
      }
    }, true);
    $('tree').addEventListener('dblclick', (e) => {
      const appName = e.target.closest('.app-name'), groupName = e.target.closest('.group-name');
      if (!appName && !groupName) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const fail = (error) => { $('side-msg').textContent = '修改显示名失败：' + error; };
      if (groupName) {
        const key = groupName.closest('.group-block').dataset.group;
        const g = ordered().find((x) => x.key === key);
        rename('group_aliases', key, g.name || '未分组', groupName, '分组显示名').catch(fail);
      } else {
        const app = apps.find((a) => a.flow_dir === appName.closest('.app').dataset.key);
        rename('app_aliases', app.flow_dir, app.app, appName, 'APP 显示名').catch(fail);
      }
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

  return { init, render, prune, setAutoTop, autoTop: () => prefs.auto_top };
})();
