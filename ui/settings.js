// 设置页：复用现有主题与项目目录命令；数据维护只触及本机历史和目录扫描缓存。
'use strict';

window.Settings = (() => {
  const $ = (id) => document.getElementById(id);
  const { invoke } = window.__TAURI__.core;
  let busy = false;
  let claudeTesting = false;
  let terminalPreview = null;
  let terminalFit = null;
  let agentIdleHours = 1;
  let archiveRetentionDays = 180;
  let lifecycleSaving = false;

  /** 内容更新偏好与主题一样保存在本机 localStorage，各窗口共享，未设置时默认开启。 */
  const keepFlowView = () => localStorage.getItem('fc-keep-flow-view') !== '0';
  const keepFeatPosition = () => localStorage.getItem('fc-keep-feat-position') !== '0';
  /** 链接另开页签默认关闭，各窗口共享本机偏好。 */
  const linksNewTab = () => localStorage.getItem('fc-links-new-tab') === '1';
  /** 不同 APP 默认分开页签，避免把不相关的图和档案并排组合。 */
  const projectsNewTab = () => localStorage.getItem('fc-projects-new-tab') !== '0';
  /** 强制拆分默认关闭；开启时在主窗口为另一类内容保留空位。 */
  const forceSplit = () => localStorage.getItem('fc-force-split') === '1';
  /** 页签闲置关闭阈值（小时）；默认 0，不自动关闭，设置输入处校验范围。 */
  const tabLifetime = () => Number(localStorage.getItem('fc-tab-lifetime') || '0');

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

  /** 设置动作串行执行；异常共用顶部绘制层的悬浮状态，仍保留失败后重试能力。 */
  async function act(button, work) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    $('settings-msg').textContent = '处理中…';
    $('settings-msg').classList.remove('error');
    try { $('settings-msg').textContent = await work(); }
    catch (error) { $('settings-msg').textContent = ''; floatingStatus(String(error)); }
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
    if (name === 'terminal') showTerminalTheme();
    if (name === 'layout') document.querySelectorAll('input[name="settings-layout-mode"]').forEach((input) => { input.checked = input.value === Split.mode(); });
    if (name === 'agent-lifecycle') loadLifecycle();
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

  /** 与真实会话共用调色板和 ANSI 渲染；只在可见时创建并测量终端。 */
  function showTerminalTheme() {
    const themes = window.TerminalThemes;
    const select = $('settings-terminal-theme');
    if (!select.options.length) select.innerHTML = themes.choices.map(theme => `<option value="${theme.id}">${theme.name}</option>`).join('');
    select.value = themes.current();
    $('settings-terminal-description').textContent = themes.choices.find(theme => theme.id === select.value).description;
    const host = $('settings-terminal-preview');
    const theme = themes.resolve();
    host.style.background = theme.background;
    if (!terminalPreview) {
      terminalPreview = new Terminal({ fontFamily: themes.FONT, fontSize: 13, lineHeight: 1.4, cols: 40, rows: 7,
        disableStdin: true, allowProposedApi: true, scrollback: 0, minimumContrastRatio: 4.5, theme });
      terminalFit = new FitAddon.FitAddon();
      terminalPreview.loadAddon(terminalFit);
      terminalPreview.loadAddon(new Unicode11Addon.Unicode11Addon());
      terminalPreview.unicode.activeVersion = '11';
      terminalPreview.open(host);
      terminalPreview.textarea.tabIndex = -1;
      terminalPreview.write(themes.SAMPLE);
      new ResizeObserver(() => { if (!host.closest('section').hidden) terminalFit.fit(); }).observe(host);
      new MutationObserver(() => showTerminalTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } else terminalPreview.options.theme = theme;
    if (!host.closest('section').hidden) terminalFit.fit();
  }

  /** 进程策略由后端计时，关闭 Agent 窗口后仍生效。 */
  async function loadLifecycle() {
    const input = $('settings-agent-idle-hours'), days = $('settings-agent-archive-days');
    if (lifecycleSaving) return;
    input.disabled = days.disabled = true;
    try {
      const policy = await invoke('agent_get_lifecycle');
      agentIdleHours = policy.idleHours;
      archiveRetentionDays = policy.archiveRetentionDays;
      input.value = agentIdleHours;
      days.value = archiveRetentionDays;
      input.disabled = days.disabled = false;
    } catch (error) { floatingStatus(String(error)); }
  }

  /** 单项自动保存，失败还原最后成功值，避免显示与实际策略不一致。 */
  async function saveLifecycle(event) {
    const input = event.currentTarget, isDays = input.id === 'settings-agent-archive-days';
    if (lifecycleSaving) return;
    const value = Number(input.value), previous = isDays ? archiveRetentionDays : agentIdleHours;
    if (input.value.trim() === '' || !Number.isFinite(value) || value < 0 || value > (isDays ? 36500 : 8760) || (isDays && !Number.isInteger(value)) || !input.reportValidity()) {
      input.value = previous;
      return;
    }
    lifecycleSaving = true;
    const fields = [$('settings-agent-idle-hours'), $('settings-agent-archive-days')];
    fields.forEach((field) => { field.disabled = true; });
    $('settings-msg').textContent = '保存中…';
    try {
      const policy = await invoke('agent_set_lifecycle', { idleHours: isDays ? agentIdleHours : value, archiveRetentionDays: isDays ? value : archiveRetentionDays });
      agentIdleHours = policy.idleHours;
      archiveRetentionDays = policy.archiveRetentionDays;
      fields[0].value = agentIdleHours;
      fields[1].value = archiveRetentionDays;
      $('settings-msg').textContent = isDays
        ? (value === 0 ? '归档会话将永久保留' : `已保存：归档 ${archiveRetentionDays} 天后自动清理`)
        : (value === 0 ? '已关闭 CLI 空闲自动结束' : `已保存：CLI 连续空闲 ${agentIdleHours} 小时后自动结束`);
    } catch (error) {
      input.value = previous;
      $('settings-msg').textContent = '';
      floatingStatus(String(error));
    } finally { lifecycleSaving = false; fields.forEach((field) => { field.disabled = false; }); }
  }

  /** 填入 Claude Code 启动项；found 为按当前设置实际会启动的 claude，找不到时显示原因。 */
  function showClaude(v) {
    $('settings-claude-path').value = v.claudePath;
    $('settings-claude-args').value = v.extraArgs;
    $('settings-claude-view').value = v.viewMode || 'default';
    $('settings-claude-bypass').checked = v.bypassPermissions === true;
    const note = $('settings-claude-found');
    note.textContent = v.found ? `将启动：${v.found}` : v.error;
    note.style.color = v.found ? '' : 'var(--danger)';
  }

  /** 测试结果留在设置页，便于核对路径和错误；全部使用 textContent 展示 CLI 输出。 */
  function claudeResult(state, title, meta, detail) {
    const box = $('settings-claude-result');
    box.hidden = false;
    box.dataset.state = state;
    box.setAttribute('aria-busy', String(state === 'running'));
    $('settings-claude-result-title').textContent = title;
    $('settings-claude-result-meta').textContent = meta;
    $('settings-claude-result-detail').textContent = detail;
  }

  /** 收集当前输入；普通保存与重新开启会话使用同一份启动配置。 */
  function claudeInput() {
    return { claudePath: $('settings-claude-path').value, extraArgs: $('settings-claude-args').value, viewMode: $('settings-claude-view').value, bypassPermissions: $('settings-claude-bypass').checked };
  }

  /** 列明要重新开启的运行中会话；优先选中当前页签，目标不明确时由用户选择。 */
  function chooseRestartSession(sessions) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'lifecycle-dialog settings-restart-dialog';
      const title = document.createElement('h3'); title.textContent = '保存并重新开启会话';
      const label = document.createElement('label'); label.textContent = '会话'; label.htmlFor = 'settings-restart-session';
      const select = document.createElement('select'); select.id = 'settings-restart-session'; select.required = true;
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择要重新开启的会话';
      select.append(placeholder);
      for (const session of sessions) {
        const option = document.createElement('option'); option.value = session.id;
        option.textContent = `${session.title}（${session.app || session.cwd}，${session.id.slice(0, 8)}）`;
        select.append(option);
      }
      let active = '';
      try { active = JSON.parse(localStorage.getItem('fc-agent-tabs') || '{}').active || ''; } catch { /* 旧页签设置不可用时仍可手动选择 */ }
      select.value = sessions.some(session => session.id === active) ? active : sessions.length === 1 ? sessions[0].id : '';
      label.append(select);
      const detail = document.createElement('p');
      detail.textContent = '仅重新开启所选会话，用新设置续接已保存的对话。正在执行的任务会被中断，未发送输入会丢失。Flow Coding 程序和其他会话继续运行。';
      const form = document.createElement('form'); form.method = 'dialog';
      const actions = document.createElement('div'); actions.className = 'dlg-btns';
      const cancel = document.createElement('button'); cancel.value = 'cancel'; cancel.formNoValidate = true; cancel.textContent = '取消';
      const confirm = document.createElement('button'); confirm.value = 'confirm'; confirm.textContent = '保存并重新开启';
      actions.append(cancel, confirm); form.append(label, detail, actions); dialog.append(title, form);
      document.body.appendChild(dialog);
      let settled = false;
      /** 提交和取消立即结束设置动作，不依赖关闭动画后才派发的 close 事件。 */
      function finish(confirmed) {
        if (settled) return;
        settled = true;
        const id = confirmed ? select.value : '';
        dialog.close(); dialog.remove();
        resolve(sessions.find(session => session.id === id) || null);
      }
      form.addEventListener('submit', (event) => { event.preventDefault(); finish(event.submitter === confirm); });
      dialog.addEventListener('cancel', () => finish(false), { once: true });
      dialog.addEventListener('close', () => finish(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }

  /** 先取得明确目标和用户确认，再保存配置、等待旧进程退出并续接原会话。 */
  async function restartClaude(event) {
    if (busy || claudeTesting) return;
    return act(event.currentTarget, async () => {
      const sessions = (await invoke('agent_list')).filter(session => session.running && !session.archived_at && !session.stored_at);
      if (!sessions.length) return '没有运行中的会话，可先保存设置，下次启动时自动生效';
      const session = await chooseRestartSession(sessions);
      if (!session) return '已取消，设置和会话保持原样';
      const controls = ['settings-claude-test', 'settings-claude-save', 'settings-claude-restart', 'settings-claude-path', 'settings-claude-args', 'settings-claude-view', 'settings-claude-bypass'].map($);
      controls.forEach(control => { control.disabled = true; });
      let saved = false;
      try {
        showClaude(await invoke('agent_set_settings', claudeInput()));
        saved = true;
        $('settings-msg').textContent = `正在重新开启「${session.title}」…`;
        await invoke('agent_restart', { id: session.id });
        return `设置已保存，已用新配置重新开启「${session.title}」`;
      } catch (error) {
        claudeResult('error', saved ? '设置已保存，会话未能重新开启' : '设置未保存，会话保持原样', session.title, String(error));
        return saved ? '设置已保存，重新开启失败，可查看详情后重试' : '配置保存失败，会话保持原样';
      } finally { controls.forEach(control => { control.disabled = false; }); }
    });
  }

  /** 使用未保存的输入测试；测试期间固定配置，避免把旧结果误当成新配置可用。 */
  async function testClaude() {
    if (busy || claudeTesting) return;
    claudeTesting = true;
    const controls = ['settings-claude-test', 'settings-claude-save', 'settings-claude-restart', 'settings-claude-path', 'settings-claude-args', 'settings-claude-view', 'settings-claude-bypass'].map($);
    controls.forEach(control => { control.disabled = true; });
    $('settings-claude-test').textContent = '测试中…';
    claudeResult('running', '正在测试 Claude Code…', '先检查 CLI 版本，再发送简短请求，最长约 70 秒。', '可继续查看其他设置，结果会保留在这里。');
    try {
      const result = await invoke('agent_test_settings', { claudePath: $('settings-claude-path').value, extraArgs: $('settings-claude-args').value });
      const meta = [result.path, result.version, `耗时 ${(result.elapsedMs / 1000).toFixed(1)} 秒`].filter(Boolean).join('\n');
      claudeResult(result.ok ? 'success' : 'error', `${result.ok ? '✓' : '✕'} ${result.message}`, meta, result.detail);
    } catch (error) {
      claudeResult('error', '✕ 测试未完成', '', String(error));
    } finally {
      claudeTesting = false;
      controls.forEach(control => { control.disabled = false; });
      $('settings-claude-test').textContent = '测试连接';
    }
  }

  /** 显示设置并读取最新配置；多个窗口编辑后也以磁盘最新项目根为准。 */
  async function open() {
    $('settings-theme').value = themeSetting();
    $('settings-auto-top').checked = Sidebar.autoTop();
    $('settings-keep-flow-view').checked = keepFlowView();
    $('settings-keep-feat-position').checked = keepFeatPosition();
    $('settings-links-new-tab').checked = linksNewTab();
    $('settings-projects-new-tab').checked = projectsNewTab();
    $('settings-force-split').checked = forceSplit();
    $('settings-tab-lifetime').value = tabLifetime();
    $('settings-agent-follow').checked = localStorage.getItem('fc-agent-follow') !== '0';
    $('settings-agent-summary').checked = localStorage.getItem('fc-agent-summary') === '1';
    $('settings-float').checked = await invoke('get_float_enabled');
    // 设置文件损坏时只在本栏提示，不挡住整个设置页
    if (!claudeTesting) {
      $('settings-claude-result').hidden = true;
      try { showClaude(await invoke('agent_get_settings')); } catch (error) { $('settings-claude-found').textContent = String(error); }
    }
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
    // 侧栏工具入口：打开（或置前）独立的 Agent 窗口
    $('btn-agent').onclick = () => invoke('open_agent_window', { focus: null }).catch((e) => floatingStatus(String(e)));
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
    $('settings-terminal-theme').onchange = (e) => {
      window.TerminalThemes.save(e.currentTarget.value);
      showTerminalTheme();
      $('settings-msg').textContent = '终端主题已保存，Agent 窗口已同步';
    };
    window.addEventListener('storage', (e) => {
      if (terminalPreview && (e.key === null || e.key === window.TerminalThemes.KEY)) showTerminalTheme();
    });
    $('settings-agent-idle-hours').onchange = saveLifecycle;
    $('settings-agent-follow').onchange = (e) => {
      localStorage.setItem('fc-agent-follow', e.currentTarget.checked ? '1' : '0');
      $('settings-msg').textContent = e.currentTarget.checked ? 'Agent 已跟随主窗口' : 'Agent 将保留当前会话';
    };
    $('settings-agent-summary').onchange = (e) => {
      localStorage.setItem('fc-agent-summary', e.currentTarget.checked ? '1' : '0');
      $('settings-msg').textContent = e.currentTarget.checked ? '已开启双行摘要' : '会话列表已切换为单行';
    };
    $('settings-agent-archive-days').onchange = saveLifecycle;
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
    document.querySelectorAll('input[name="settings-layout-mode"]').forEach((input) => {
      input.onchange = (e) => {
        if (!e.currentTarget.checked) return;
        Split.setMode(e.currentTarget.value);
        $('settings-msg').textContent = '排布方式已保存';
      };
    });
    $('settings-force-split').onchange = (e) => {
      localStorage.setItem('fc-force-split', e.currentTarget.checked ? '1' : '0');
      Split.layout();
      $('settings-msg').textContent = '布局设置已保存';
    };
    $('settings-tab-lifetime').onchange = (e) => {
      const input = e.currentTarget;
      if (input.value === '' || !input.reportValidity()) { input.value = tabLifetime(); return; }
      localStorage.setItem('fc-tab-lifetime', input.value);
      Tabs.checkExpiry();
      $('settings-msg').textContent = '页签存活时间已保存';
    };
    /** 悬浮窗开关存在 Rust 侧（窗口焦点判定在后端），失败时复位勾选并提示。 */
    $('settings-float').onchange = (e) => {
      const box = e.currentTarget;
      act(box, async () => {
        try { await invoke('set_float_enabled', { enabled: box.checked }); }
        catch (error) { box.checked = !box.checked; throw error; }
        return box.checked ? '已开启悬浮窗，切到其他程序时显示' : '已关闭悬浮窗';
      });
    };
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
    $('settings-claude-test').onclick = testClaude;
    $('settings-claude-restart').onclick = restartClaude;
    for (const id of ['settings-claude-path', 'settings-claude-args']) {
      $(id).oninput = () => {
        $('settings-claude-result').hidden = true;
        $('settings-claude-found').textContent = '配置已修改，点击“测试连接”核对当前输入。';
        $('settings-claude-found').style.color = '';
      };
    }
    /** Claude Code 启动项：后端校验路径与参数，失败时保留输入并提示原因。 */
    $('settings-claude-save').onclick = (e) => act(e.currentTarget, async () => {
      showClaude(await invoke('agent_set_settings', claudeInput()));
      return 'Claude Code 设置已保存，之后启动的会话生效';
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

  return { init, keepFlowView, keepFeatPosition, linksNewTab, projectsNewTab, forceSplit, tabLifetime };
})();
