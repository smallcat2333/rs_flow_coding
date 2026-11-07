// 执行实际会话策略保存逻辑，验证保留期与空闲策略互不覆盖，失败恢复显示。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/settings.js', import.meta.url), 'utf8');
function setup(fail = false) {
  const elements = new Map(['settings-agent-idle-hours', 'settings-agent-archive-days', 'settings-msg'].map(id => [id, { id, value: '', disabled: false, textContent: '', reportValidity: () => true }]));
  let policy = { idleHours: 2.5, archiveRetentionDays: 180 };
  const calls = [], errors = [];
  const c = vm.createContext({
    $: id => elements.get(id), agentIdleHours: 1, archiveRetentionDays: 180, lifecycleSaving: false,
    floatingStatus: e => errors.push(e),
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'agent_set_lifecycle') {
        if (fail) throw '保存失败';
        policy = { ...policy, ...args };
      }
      return { ...policy };
    },
  });
  vm.runInContext(source.slice(source.indexOf('  async function loadLifecycle()'), source.indexOf('  /** 填入 Claude Code 启动项')), c);
  return { c, elements, calls, errors };
}

test('归档期限设为 0 时保留空闲策略，修改空闲策略时保留归档期限', async () => {
  const { c, elements, calls } = setup();
  await c.loadLifecycle();
  const days = elements.get('settings-agent-archive-days'), hours = elements.get('settings-agent-idle-hours');
  assert.equal(days.value, 180);
  days.value = '0'; await c.saveLifecycle({ currentTarget: days });
  assert.deepEqual({ ...calls.at(-1).args }, { idleHours: 2.5, archiveRetentionDays: 0 });
  assert.match(elements.get('settings-msg').textContent, /永久保留/);
  hours.value = '4'; await c.saveLifecycle({ currentTarget: hours });
  assert.deepEqual({ ...calls.at(-1).args }, { idleHours: 4, archiveRetentionDays: 0 });
  assert.equal(days.disabled, false);
});

test('保留天数拒绝小数、负数和空值，保存失败恢复最后成功值', async () => {
  const { c, elements, calls, errors } = setup(true);
  await c.loadLifecycle();
  const days = elements.get('settings-agent-archive-days');
  for (const invalid of ['1.5', '-1', '', '36501']) {
    days.value = invalid; await c.saveLifecycle({ currentTarget: days });
    assert.equal(days.value, 180);
  }
  assert.equal(calls.length, 1);
  days.value = '90'; await c.saveLifecycle({ currentTarget: days });
  assert.equal(days.value, 180);
  assert.equal(days.disabled, false);
  assert.deepEqual(errors, ['保存失败']);
});
