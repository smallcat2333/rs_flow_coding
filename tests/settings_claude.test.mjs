// 设置页 Claude 测试：未保存配置、运行中锁定、失败恢复与修改后清除旧结论。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/settings.js', import.meta.url), 'utf8');
function setup(invoke, active = '') {
  const elements = new Map(), dialogs = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, textContent: '', hidden: true, disabled: false, dataset: {}, style: {},
      attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener() {}, reportValidity() { return true; }, classList: { remove() {} },
    });
    return elements.get(id);
  };
  /** 只模拟确认框所需的原生 DOM，让测试自行选择目标或取消。 */
  function element(tagName) {
    return { tagName, children: [], value: '', events: {}, append(...nodes) { this.children.push(...nodes); },
      addEventListener(name, fn) { this.events[name] = fn; }, close() {}, remove() {}, showModal() { dialogs.push(this); } };
  }
  const context = { floatingStatus() {}, localStorage: { getItem: () => JSON.stringify({ active }) },
    window: { __TAURI__: { core: { invoke } }, addEventListener() {} },
    document: { getElementById: $, querySelectorAll: () => [], createElement: element, body: { appendChild() {} } } };
  $.dialogs = dialogs;
  $.choose = (id, confirm = true) => {
    const dialog = dialogs.at(-1), select = dialog.children[1].children[0].children[0];
    if (id !== undefined) select.value = id;
    dialog.returnValue = confirm ? 'confirm' : 'cancel'; dialog.events.close();
  };
  vm.runInNewContext(source, context);
  context.window.Settings.init();
  return $;
}

const controls = ['settings-claude-test', 'settings-claude-save', 'settings-claude-restart', 'settings-claude-path', 'settings-claude-args', 'settings-claude-view', 'settings-claude-bypass'];
test('测试当前输入、不保存，运行中禁止重复请求，成功后恢复操作', async () => {
  let finish;
  const calls = [];
  const $ = setup((command, args) => {
    calls.push({ command, args });
    return new Promise(resolve => { finish = resolve; });
  });
  $('settings-claude-path').value = 'C:\\My CLI\\claude.exe';
  $('settings-claude-args').value = '--model opus';
  const request = $('settings-claude-test').onclick();
  assert.ok(controls.every(id => $(id).disabled));
  assert.equal($('settings-claude-result').dataset.state, 'running');
  await $('settings-claude-test').onclick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'agent_test_settings');
  assert.equal(calls[0].args.claudePath, 'C:\\My CLI\\claude.exe');
  assert.equal(calls[0].args.extraArgs, '--model opus');
  finish({ ok: true, message: 'Claude Code 可用', path: 'C:\\My CLI\\claude.exe', version: 'test-version', elapsedMs: 1250, detail: '回复：FLOW_CODING_OK' });
  await request;
  assert.ok(controls.every(id => !$(id).disabled));
  assert.equal($('settings-claude-result').dataset.state, 'success');
  assert.equal($('settings-claude-result').attributes['aria-busy'], 'false');
  assert.match($('settings-claude-result-meta').textContent, /1\.3 秒/);
  $('settings-claude-path').oninput();
  assert.equal($('settings-claude-result').hidden, true);
});

test('后端失败和 IPC 异常显示详情，保留输入并允许重试', async () => {
  let attempt = 0;
  const $ = setup(async () => {
    if (++attempt === 1) return { ok: false, message: '请求测试失败', detail: '<error>Not logged in</error>', elapsedMs: 40 };
    throw new Error('IPC unavailable');
  });
  $('settings-claude-args').value = '--model custom';
  await $('settings-claude-test').onclick();
  assert.equal($('settings-claude-result').dataset.state, 'error');
  assert.equal($('settings-claude-result-detail').textContent, '<error>Not logged in</error>');
  assert.equal($('settings-claude-args').value, '--model custom');
  assert.ok(controls.every(id => !$(id).disabled));
  await $('settings-claude-test').onclick();
  assert.match($('settings-claude-result-detail').textContent, /IPC unavailable/);
  assert.ok(controls.every(id => !$(id).disabled));
});

test('保存显示模式并回显后端结果，仅提交启动设置', async () => {
  const calls = [];
  const $ = setup(async (command, args) => {
    calls.push({ command, args });
    return { ...args, found: 'claude.exe' };
  });
  $('settings-claude-view').value = 'focus';
  await $('settings-claude-save').onclick({ currentTarget: $('settings-claude-save') });
  assert.equal(calls[0].command, 'agent_set_settings');
  assert.equal(calls[0].args.viewMode, 'focus');
  assert.equal($('settings-claude-view').value, 'focus');
  assert.match($('settings-msg').textContent, /之后启动/);
  $('settings-claude-view').value = 'default';
  await $('settings-claude-save').onclick({ currentTarget: $('settings-claude-save') });
  assert.equal(calls[1].args.viewMode, 'default');
  assert.equal(calls.length, 2, '保存不重启或停止正在运行的会话');
});

test('权限勾选独立保存，开关不改额外参数或触发会话启动', async () => {
  const calls = [];
  const $ = setup(async (command, args) => {
    calls.push({ command, args });
    return { ...args, found: 'claude.exe' };
  });
  assert.equal($('settings-claude-bypass').checked, false);
  $('settings-claude-args').value = '--model opus --permission-mode plan';
  $('settings-claude-bypass').checked = true;
  await $('settings-claude-save').onclick({ currentTarget: $('settings-claude-save') });
  assert.equal(calls[0].args.bypassPermissions, true);
  assert.equal(calls[0].args.extraArgs, '--model opus --permission-mode plan');
  assert.equal($('settings-claude-bypass').checked, true);
  $('settings-claude-bypass').checked = false;
  await $('settings-claude-save').onclick({ currentTarget: $('settings-claude-save') });
  assert.equal(calls[1].args.bypassPermissions, false);
  assert.equal($('settings-claude-bypass').checked, false);
  assert.deepEqual(calls.map(c => c.command), ['agent_set_settings', 'agent_set_settings']);
});

test('旧配置缺少显示模式时回显标准，保存失败保留当前选择', async () => {
  let fail = false;
  const $ = setup(async () => {
    if (fail) throw '写入失败';
    return { claudePath: '', extraArgs: '', found: 'claude.exe' };
  });
  await $('settings-claude-save').onclick({ currentTarget: $('settings-claude-save') });
  assert.equal($('settings-claude-view').value, 'default');
  assert.equal($('settings-claude-bypass').checked, false);
  fail = true;
  $('settings-claude-bypass').checked = true;
  $('settings-claude-view').value = 'focus';
  await $('settings-claude-save').onclick({ currentTarget: $('settings-claude-save') });
  assert.equal($('settings-claude-view').value, 'focus');
  assert.equal($('settings-claude-bypass').checked, true);
  assert.equal($('settings-claude-save').disabled, false);
});

test('空闲存活时间独立自动保存，允许小数与关闭，失败恢复最后成功值', async () => {
  const calls = [];
  let fail = false;
  const $ = setup(async (command, args) => {
    calls.push({ command, args });
    if (fail) throw '写入失败';
    return { idleHours: args.idleHours };
  });
  const input = $('settings-agent-idle-hours');
  input.value = '0.5';
  await input.onchange({ currentTarget: input });
  assert.equal(calls[0].command, 'agent_set_lifecycle');
  assert.equal(calls[0].args.idleHours, 0.5);
  assert.equal(input.disabled, false);
  fail = true;
  input.value = '2';
  await input.onchange({ currentTarget: input });
  assert.equal(input.value, 0.5);
  assert.equal(input.disabled, false);
  fail = false;
  input.value = '0';
  await input.onchange({ currentTarget: input });
  assert.match($('settings-msg').textContent, /已关闭/);
  for (const value of ['', '-1', 'Infinity', '8761']) {
    input.value = value;
    await input.onchange({ currentTarget: input });
    assert.equal(input.value, 0);
  }
  assert.equal(calls.length, 3, '无效输入不触发 IPC');
});

const running = id => ({ id, title: `会话 ${id}`, app: 'app', running: true, archived_at: 0, stored_at: 0 });

test('保存并重开当前会话：先确认目标，再保存设置，只重开选中的原会话', async () => {
  const calls = [];
  let finish;
  const $ = setup(async (command, args) => {
    calls.push({ command, args });
    if (command === 'agent_list') return [running('a'), running('b')];
    if (command === 'agent_restart') return new Promise(resolve => { finish = resolve; });
    return { ...args, found: 'claude.exe' };
  }, 'b');
  $('settings-claude-view').value = 'focus';
  $('settings-claude-bypass').checked = true;
  const button = $('settings-claude-restart'), pending = button.onclick({ currentTarget: button });
  await setImmediate();
  assert.equal($.dialogs.length, 1);
  assert.equal($.dialogs[0].children[1].children[0].children[0].value, 'b', '默认当前页签');
  assert.deepEqual(calls.map(call => call.command), ['agent_list'], '确认前不保存或停止');
  await button.onclick({ currentTarget: button });
  assert.equal(calls.length, 1, '确认中不接受重复操作');
  $.choose();
  await setImmediate(); await setImmediate();
  assert.ok(controls.every(id => $(id).disabled));
  assert.deepEqual(calls.map(call => call.command), ['agent_list', 'agent_set_settings', 'agent_restart']);
  assert.equal(calls[1].args.viewMode, 'focus');
  assert.equal(calls[1].args.bypassPermissions, true);
  assert.equal(calls[2].args.id, 'b');
  finish(); await pending;
  assert.ok(controls.every(id => !$(id).disabled));
  assert.match($('settings-msg').textContent, /新配置.*会话 b/);
});

test('取消重开不会保存设置或结束会话；未选中当前会话时要求选择目标', async () => {
  const calls = [];
  const $ = setup(async command => { calls.push(command); return [running('a'), running('b')]; }, 'OV');
  const button = $('settings-claude-restart'), pending = button.onclick({ currentTarget: button });
  await setImmediate();
  assert.equal($.dialogs[0].children[1].children[0].children[0].value, '');
  $.choose('', false); await pending;
  assert.deepEqual(calls, ['agent_list']);
  assert.match($('settings-msg').textContent, /已取消/);
  assert.equal(button.disabled, false);
});

test('没有运行中会话时不重开，收纳及归档不作为目标', async () => {
  const calls = [];
  const $ = setup(async command => {
    calls.push(command);
    return [{ ...running('a'), stored_at: 1 }, { ...running('b'), archived_at: 1 }, { ...running('c'), running: false }];
  });
  await $('settings-claude-restart').onclick({ currentTarget: $('settings-claude-restart') });
  assert.deepEqual(calls, ['agent_list']);
  assert.equal($.dialogs.length, 0);
  assert.match($('settings-msg').textContent, /没有运行中的会话/);
});

test('保存失败不重开；重开失败说明设置已保存并允许重试', async () => {
  for (const failedCommand of ['agent_set_settings', 'agent_restart']) {
    const calls = [];
    const $ = setup(async (command, args) => {
      calls.push(command);
      if (command === 'agent_list') return [running('a')];
      if (command === failedCommand) throw '故障详情';
      return { ...args, found: 'claude.exe' };
    });
    const button = $('settings-claude-restart'), pending = button.onclick({ currentTarget: button });
    await setImmediate(); $.choose(); await pending;
    assert.equal($('settings-claude-result').dataset.state, 'error');
    assert.equal($('settings-claude-result-detail').textContent, '故障详情');
    assert.match($('settings-claude-result-title').textContent, failedCommand === 'agent_set_settings' ? /未保存.*保持原样/ : /已保存.*未能重新开启/);
    assert.equal(calls.includes('agent_restart'), failedCommand === 'agent_restart');
    assert.ok(controls.every(id => !$(id).disabled));
  }
});
