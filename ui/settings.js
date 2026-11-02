// 设置页：复用现有主题与项目目录命令；数据维护只触及本机历史和目录扫描缓存。
'use strict';

window.Settings = (() => {
  const $ = (id) => document.getElementById(id);
  const { invoke } = window.__TAURI__.core;
  let busy = false;

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

  /** 每个设置区域只显示自己的视图，保留尚未保存的项目目录输入。 */
  function tab(name) {
    document.querySelectorAll('[data-settings-tab]').forEach((button) => {
      const selected = button.dataset.settingsTab === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
    $('settings-msg').textContent = '';
    if (name === 'storage') act($('storage-refresh'), async () => { await usage(); return ''; });
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
    $('settings-dialog').showModal();
    tab('appearance');
    await act($('settings-project-save'), async () => {
      const cfg = await invoke('get_config');
      $('roots-text').value = cfg.roots.join('\n');
      return '';
    });
  }

  /** 初始化三个入口与设置行为；键盘和关闭均复用原生 dialog 焦点管理。 */
  function init() {
    $('btn-settings').onclick = open;
    $('settings-close').onclick = () => $('settings-dialog').close();
    $('settings-dialog').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
    document.querySelectorAll('[data-settings-tab]').forEach((button) => {
      button.onclick = () => { if (!busy) tab(button.dataset.settingsTab); };
      button.onkeydown = (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        if (busy) return;
        const buttons = [...document.querySelectorAll('[data-settings-tab]')];
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (buttons.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index].click(); buttons[index].focus();
      };
    });
    $('settings-theme').onchange = (e) => {
      localStorage.setItem('fc-theme', e.target.value);
      applyTheme();
      $('settings-msg').textContent = '外观已保存';
    };
    $('settings-project-save').onclick = (e) => act(e.currentTarget, async () => {
      const roots = $('roots-text').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const cfg = await invoke('set_roots', { roots });
      $('roots-text').value = cfg.roots.join('\n');
      if (!await refresh(true)) throw new Error($('side-msg').textContent);
      return '项目目录已保存并扫描';
    });
    $('btn-rescan').onclick = (e) => act(e.currentTarget, async () => {
      if (!await refresh(true)) throw new Error($('side-msg').textContent);
      return '全量扫描完成';
    });
    $('storage-refresh').onclick = (e) => act(e.currentTarget, async () => { await usage(); return '用量已更新'; });
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
    $('btn-search').onclick = () => {
      const visible = $('tree-filter').hidden;
      $('tree-filter').hidden = !visible;
      $('btn-search').setAttribute('aria-expanded', String(visible));
      if (visible) $('tree-search').focus();
      else { $('tree-search').value = ''; $('tree-search').dispatchEvent(new Event('input')); }
    };
    $('tree-search').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); $('btn-search').click(); $('btn-search').focus(); }
    });
  }

  return { init };
})();
