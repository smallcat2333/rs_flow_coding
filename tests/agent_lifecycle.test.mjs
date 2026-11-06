// 按需连接：执行实际打开入口、启动去重及提示逻辑，IPC 不启动真实 CLI。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/agent.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function setup(invoke) {
  const sessions = new Map([['a', { id: 'a', running: false, status: 'off' }]]);
  let mask = null;
  const handlers = {};
  const host = { appendChild(element) { mask = element; } };
  const context = vm.createContext({
    S: sessions, active: 'a', openTabs: [], invoke,
    activate(id) { context.active = id; },
    $: selector => selector === '#terms' ? host : selector === '#terms .offmask' ? mask
      : selector === '#tabs' ? { addEventListener: (type, handler) => { handlers[type] = handler; } } : null,
    document: { createElement: () => ({ innerHTML: '', className: '', setAttribute() {}, remove() { mask = null; } }) },
    vs: s => s.status,
    toast() {}, refreshAll() {},
    esc: text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  vm.runInContext(section('function openSession(id)', 'function closeTab(id)')
    + section('function updateMask(id)', 'function showTerm(id)')
    + section('const startingSessions =', '// ---------------- 总览')
    + section("$('#tabs').addEventListener('click'", "/** 会话头的“＋ 关联”"), context);
  return { context, sessions, handlers, mask: () => mask };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('点击待命会话自动启动，连续点击去重，运行中不重复启动', async () => {
  const calls = [];
  let finish;
  const { context: c, sessions, mask } = setup((cmd, args) => {
    calls.push({ cmd, args });
    return new Promise(resolve => { finish = resolve; });
  });
  c.openSession('a'); c.openSession('a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'agent_start');
  assert.match(mask().innerHTML, /正在连接 CLI/);
  sessions.get('a').running = true;
  finish(); await flush();
  assert.equal(mask(), null);
  c.openFocusedSession('a');
  assert.equal(calls.length, 1);
  c.openSession('unknown');
  assert.equal(calls.length, 1);
});

test('空闲回收后的刷新不自动重启，从列表重新点击时才恢复', async () => {
  let calls = 0;
  const { context: c, sessions, handlers, mask } = setup(async () => {
    calls++;
    sessions.get('a').running = true;
    sessions.get('a').status = 'idle';
  });
  c.openSession('a'); await flush();
  sessions.get('a').running = false;
  sessions.get('a').status = 'off';
  c.updateMask('a'); c.updateMask('a');
  assert.equal(calls, 1);
  assert.equal(mask(), null, '待命不显示手动续接提示');
  c.openFocusedSession('a');
  await flush();
  assert.equal(calls, 2, '从列表重新点击时恢复');
  handlers.click({ target: { closest: selector => selector === '[data-tab]' ? { dataset: { tab: 'OV' } } : null } });
  assert.equal(c.active, 'OV');
  assert.equal(calls, 2, '总览不启动进程');
});

test('连接失败安全显示原因，切换会话后不误盖新页，允许重试', async () => {
  let attempts = 0;
  const { context: c, sessions, mask } = setup(async () => {
    if (++attempts === 1) throw '<missing CLI>';
    sessions.get('a').running = true;
  });
  c.openSession('a'); await flush();
  assert.match(mask().innerHTML, /&lt;missing CLI&gt;/);
  assert.match(mask().innerHTML, /重试/);
  c.active = 'OV';
  const previous = mask().innerHTML;
  c.updateMask('a');
  assert.equal(mask().innerHTML, previous);
  c.openSession('a'); await flush();
  assert.equal(attempts, 2);
  assert.equal(mask(), null);
});
