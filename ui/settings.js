// 设置页：复用现有主题与项目目录命令；数据维护只触及本机历史和目录扫描缓存。
'use strict';

window.Settings = (() => {
  const $ = (id) => document.getElementById(id);
  const { invoke } = window.__TAURI__.core;
  let busy = false;

  /** 内容更新偏好与主题一样保存在本机 localStorage，各窗口共享，未设置时默认开启。 */
  const keepFlowView = () => localStorage.getItem('fc-keep-flow-view') !== '0';
  const keepFeatPosition = () => localStorage.getItem('fc-keep-feat-position') !== '0';
  /** 链接另开页签默认关闭，各窗口共享本机偏好。 */
  const linksNewTab = () => localStorage.getItem('fc-links-new-tab') === '1';
  /** 不同 APP 默认分开页签，避免把不相关的图和档案并排组合。 */
  const projectsNewTab = () => localStorage.getItem('fc-projects-new-tab') !== '0';

  /** 字节显示使用二进制单位，零明确显示为 0 B。 */
  function bytes(value) {
    if (value < 1024) return `${value.toLocaleString()} B`;
    const unit = value < 1024 ** 2 ? 1 : value < 1024 ** 3 ? 2 : 3;
    return `${(value / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
  }

  /** 加载真实本机用量；只读刷新不会触发目录扫描或自动清理。 */
  async function usage() {
    const s = await invoke('get_storage_stats');
    $('storage-path').textContent = s.database_path;
    $('storage-size').textContent = bytes(s.database_bytes);
    $('storage-diagrams').textContent = s.diagrams.toLocaleString();
    $('storage-snapshots').textContent = s.snapshots.toLocaleString();
    $('storage-old').textContent = s.old_snapshots.toLocaleString();
    $('storage-nodes').textContent = s.node_states.toLocaleString();
    $('cache-dirs').textContent = s.cached_dirs.toLocaleString();
    $('cache-size').textContent = bytes(s.cache_bytes);
  }

  /** 设置动作串行执行，错误留在当前页；失败后仍可重试，不用侧栏隐藏错误。 */
  async function act(button, work) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    $('settings-msg').textContent = '处理中…';
    $('settings-msg').classList.remove('error');
    try { $('settings-msg').textContent = await work(); }
    catch (error) { $('settings-msg').textContent = String(error); $('settings-msg').classList.add('error'); }
    finally { busy = false; button.disabled = false; }
  }

  /** 选中一个叶子分类：只显示对应内容，保留尚未保存的项目目录输入；数据维护页进入时读取最新用量。 */
  function tab(name) {
    document.querySelectorAll('[data-settings-tab]').forEach((item) => {
      item.setAttribute('aria-selected', String(item.dataset.settingsTab === name));
    });
    focusNode(document.querySelector(`[data-settings-tab="${name}"]`), false);
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
    $('settings-msg').textContent = '';
    if (name === 'database' || name === 'cache') {
      act(document.querySelector(`[data-settings-panel="${name}"] [data-storage-refresh]`), async () => { await usage(); return ''; });
    }
  }

  /** 分类树当前可见的节点（收起的父节点下的子节点除外），供方向键移动。 */
  function visibleNodes() {
    return [...$('settings-nav').querySelectorAll('[role="treeitem"]')].filter((item) => !item.parentElement.closest('[aria-expanded="false"]'));
  }

  /** 树的漫游焦点：只有一个节点可 Tab 进入；move=true 时同时移动键盘焦点。 */
  function focusNode(item, move = true) {
    $('settings-nav').querySelectorAll('[role="treeitem"]').forEach((node) => { node.tabIndex = node === item ? 0 : -1; });
    if (move) item.focus();
  }

  /** 点击或回车：父节点展开/收起，叶子节点切换内容。 */
  function activate(item) {
    if (item.dataset.settingsTab) { if (!busy) tab(item.dataset.settingsTab); return; }
    item.setAttribute('aria-expanded', String(item.getAttribute('aria-expanded') !== 'true'));
    focusNode(item);
  }

  /** 树键盘操作：上下移动，左键收起或回到父节点，右键展开或进入首个子节点，Home/End 跳首尾。 */
  function treeKey(event) {
    const item = event.target.closest('[role="treeitem"]');
    if (!item) return;
    const nodes = visibleNodes(), index = nodes.indexOf(item);
    const parent = item.parentElement.closest('[role="treeitem"]');
    const expanded = item.getAttribute('aria-expanded');
    const actions = {
      ArrowDown: () => nodes[Math.min(index + 1, nodes.length - 1)],
      ArrowUp: () => nodes[Math.max(index - 1, 0)],
      Home: () => nodes[0],
      End: () => nodes[nodes.length - 1],
      ArrowRight: () => { if (expanded === 'false') { item.setAttribute('aria-expanded', 'true'); return item; } return expanded ? item.querySelector('[role="treeitem"]') : item; },
      ArrowLeft: () => { if (expanded === 'true') { item.setAttribute('aria-expanded', 'false'); return item; } return parent || item; },
    };
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(item); return; }
    if (!actions[event.key]) return;
    event.preventDefault();
    focusNode(actions[event.key]());
  }

  /** 清理前列明不可逆结果，只有明确确认才调用维护命令；取消不写数据。 */
  function confirmCleanup(title, message, action) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'lifecycle-dialog';
      const heading = document.createElement('h3'); heading.textContent = title;
      const detail = document.createElement('p'); detail.textContent = message;
      const form = document.createElement('form'); form.method = 'dialog';
      form.className = 'dlg-btns';
      form.innerHTML = '<button value="cancel">取消</button><button value="confirm" class="danger"></button>';
      form.lastElementChild.textContent = action;
      dialog.append(heading, detail, form);
      document.body.appendChild(dialog);
      dialog.addEventListener('close', () => { const ok = dialog.returnValue === 'confirm'; dialog.remove(); resolve(ok); }, { once: true });
      dialog.showModal();
    });
  }

  /** 显示设置并读取最新配置；多个窗口编辑后也以磁盘最新项目根为准。 */
  async function open() {
    $('settings-theme').value = themeSetting();
    $('settings-auto-top').checked = Sidebar.autoTop();
    $('settings-keep-flow-view').checked = keepFlowView();
    $('settings-keep-feat-position').checked = keepFeatPosition();
    $('settings-links-new-tab').checked = linksNewTab();
    $('settings-projects-new-tab').checked = projectsNewTab();
    $('settings-dialog').showModal();
    tab('appearance');
    await act($('settings-project-save'), async () => {
      const cfg = await invoke('get_config');
      $('roots-text').value = cfg.roots.join('\n');
      $('excluded-roots-text').value = (cfg.excluded_dirs || []).join('\n');
      return '';
    });
  }

  /** 初始化设置入口与设置行为；关闭复用原生 dialog 焦点管理。 */
  function init() {
    $('btn-settings').onclick = open;
    $('settings-close').onclick = () => $('settings-dialog').close();
    $('settings-dialog').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
    $('settings-nav').addEventListener('click', (e) => {
      const node = e.target.closest('.settings-node');
      if (node) activate(node.parentElement);
    });
    $('settings-nav').addEventListener('keydown', treeKey);
    $('settings-theme').onchange = (e) => {
      localStorage.setItem('fc-theme', e.target.value);
      applyTheme();
      $('settings-msg').textContent = '外观已保存';
    };
    $('settings-auto-top').onchange = (e) => {
      const box = e.currentTarget;
      act(box, async () => {
        await Sidebar.setAutoTop(box.checked);
        return box.checked ? '已开启更新自动置顶' : '已关闭更新自动置顶，现有顺序保持不变';
      });
    };
    for (const [id, key] of [['settings-keep-flow-view', 'fc-keep-flow-view'], ['settings-keep-feat-position', 'fc-keep-feat-position']]) {
      $(id).onchange = (e) => {
        localStorage.setItem(key, e.currentTarget.checked ? '1' : '0');
        $('settings-msg').textContent = '内容更新设置已保存';
      };
    }
    $('settings-projects-new-tab').onchange = (e) => {
      localStorage.setItem('fc-projects-new-tab', e.currentTarget.checked ? '1' : '0');
      $('settings-msg').textContent = '跨项目打开方式已保存';
    };
    $('settings-links-new-tab').onchange = (e) => {
      localStorage.setItem('fc-links-new-tab', e.currentTarget.checked ? '1' : '0');
      $('settings-msg').textContent = '链接打开方式已保存';
    };
    $('settings-project-save').onclick = (e) => act(e.currentTarget, async () => {
      const roots = $('roots-text').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const excludedDirs = $('excluded-roots-text').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const cfg = await invoke('set_roots', { roots, excludedDirs });
      $('roots-text').value = cfg.roots.join('\n');
      $('excluded-roots-text').value = (cfg.excluded_dirs || []).join('\n');
      if (!await refresh(true)) throw new Error($('side-msg').textContent);
      return '项目目录已保存并扫描';
    });
    $('btn-rescan').onclick = (e) => act(e.currentTarget, async () => {
      if (!await refresh(true)) throw new Error($('side-msg').textContent);
      return '全量扫描完成';
    });
    document.querySelectorAll('[data-storage-refresh]').forEach((button) => {
      button.onclick = (e) => act(e.currentTarget, async () => { await usage(); return '用量已更新'; });
    });
    $('database-clean').onclick = (e) => act(e.currentTarget, async () => {
      const stats = await invoke('get_storage_stats');
      if (!await confirmCleanup('清理数据库旧历史？', `将清理 ${stats.old_snapshots.toLocaleString()} 条旧快照及其节点记录，每张流程图保留最新快照。旧版本对比和回滚记录删除后无法恢复。项目文件保持原样。`, '清理旧历史')) return '已取消';
      const removed = await invoke('clean_database');
      await usage();
      return `已清理 ${removed.toLocaleString()} 条旧快照，每张图保留最新快照`;
    });
    $('cache-clean').onclick = (e) => act(e.currentTarget, async () => {
      if (!await confirmCleanup('清理目录扫描缓存？', '清空已发现的目录列表，下次刷新将重新遍历项目根目录。保留项目目录设置、APP 别名和侧栏偏好。', '清理缓存')) return '已取消';
      await invoke('clear_scan_cache');
      await usage();
      return '目录扫描缓存已清空，下次刷新自动重新扫描';
    });
  }

  return { init, keepFlowView, keepFeatPosition, linksNewTab, projectsNewTab };
})();
