// 设置页 Claude 测试：未保存配置、运行中锁定、失败恢复与修改后清除旧结论。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/settings.js', import.meta.url), 'utf8');
function setup(invoke) {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: true, disabled: false, dataset: {}, style: {},
      attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener() {}, reportValidity() { return true; }, classList: { remove() {} },
    });
    return elements.get(id);
  };
  const context = { floatingStatus() {}, window: { __TAURI__: { core: { invoke } }, addEventListener() {} }, document: { getElementById: $, querySelectorAll: () => [] } };
  vm.runInNewContext(source, context);
  context.window.Settings.init();
  return $;
}

const controls = ['settings-claude-test', 'settings-claude-save', 'settings-claude-path', 'settings-claude-args'];
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
