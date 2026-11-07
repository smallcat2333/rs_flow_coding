// 执行主窗口机器人真实状态判断，不创建 CLI 或修改业务数据。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../ui/agent_bots.js', import.meta.url), 'utf8');
const start = source.indexOf('  const RANK =');
const end = source.indexOf('  /** 一组会话里');
assert.ok(start >= 0 && end > start);
const c = vm.createContext({});
vm.runInContext(source.slice(start, end) + '\nglobalThis.state = stateOf;', c);

test('主窗口中断机器人保持静止语义，不算成功、等待或子代理运转', () => {
  const interrupted = { running: true, status: 'interrupted', done: 100, seen: 0, workers: [{ running: true }, { running: true }] };
  assert.equal(c.state(interrupted), 'interrupted');
  assert.equal(c.state({ ...interrupted, running: false, status: 'off', done: 0 }), 'has');
  assert.equal(c.state({ ...interrupted, status: 'apierr' }), 'apierr');
  assert.equal(c.state({ ...interrupted, status: 'wait' }), 'wait');
  assert.equal(c.state({ ...interrupted, status: 'run' }), 'multi');
  assert.equal(c.state({ ...interrupted, status: 'idle' }), 'done');
});
