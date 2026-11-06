// 执行真实页签、启动和刷新入口，IPC 仅模拟运行状态，不创建 CLI 进程。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/agent.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

/** 控制启动回执和渲染帧，验证状态过滤、持久化清理及停止后切回总览。 */
function setup({ sessions, tabs, active, invoke = async () => {} }) {
  const host = { innerHTML: '' }, frames = [], saved = [], events = [], messages = [];
  const c = vm.createContext({
    S: new Map(sessions.map(s => [s.id, s])), openTabs: tabs, active, invoke,
    $: selector => selector === '#tabs' ? host : null,
    window: { addEventListener() {} }, document: { hasFocus: () => false },
    ICON: { graph: '', plus: '', x: '' }, bot: () => '', esc: String,
    attnItems: () => [], vs: s => s.status, stText: s => s.status,
    saveTabs: () => saved.push({ tabs: [...c.openTabs], active: c.active }),
    renderPane: () => events.push(`pane:${c.active}`), renderRows() {},
    renderMix() {}, renderToday() {}, renderLanes() {}, renderTicker() {},
    renderOverview: () => events.push('overview'), renderHead() {}, updateMask() {},
    toast: text => messages.push(text), requestAnimationFrame: fn => frames.push(fn),
  });
  vm.runInContext(section('function renderTabs()', '// ---------------- 会话头')
    + section('const startingSessions =', '// ---------------- 总览')
    + section('let refreshQueued =', "listen('agent-update'"), c);
  return { c, host, saved, events, messages, paint() { while (frames.length) frames.shift()(); } };
}
const session = (id, extra = {}) => ({ id, title: id, running: false, started: true, archived_at: 0, status: 'off', ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('恢复页签时移除未运行、归档及已删除会话，并保存清理结果', () => {
  const f = setup({ sessions: [session('off'), session('run', { running: true, status: 'idle' }), session('old', { running: true, archived_at: 1 })], tabs: ['off', 'run', 'old', 'missing'], active: 'off' });
  f.c.renderTabs();
  assert.deepEqual([...f.c.openTabs], ['run']);
  assert.equal(f.c.active, 'OV');
  assert.ok(f.host.innerHTML.includes('data-tab="run"'));
  assert.ok(!f.host.innerHTML.includes('data-tab="off"'));
  assert.deepEqual(f.saved.at(-1), { tabs: ['run'], active: 'OV' });
});

test('已打开会话停止后移除页签并退出终端，不自动重启', () => {
  let starts = 0;
  const s = session('a', { running: true, status: 'idle' });
  const f = setup({ sessions: [s], tabs: ['a'], active: 'a', invoke: async () => { starts++; } });
  s.running = false; s.status = 'off';
  f.c.refreshAll(); f.paint();
  assert.deepEqual([...f.c.openTabs], []);
  assert.equal(f.c.active, 'OV');
  assert.deepEqual(f.events, ['pane:OV']);
  assert.equal(starts, 0);
});

test('手动启动期间保留页签和选择，启动成功后持续显示', async () => {
  let finish;
  const s = session('a');
  const f = setup({ sessions: [s], tabs: [], active: 'OV', invoke: () => new Promise(resolve => { finish = resolve; }) });
  f.c.openSession('a'); f.c.renderTabs();
  assert.deepEqual([...f.c.openTabs], ['a']);
  assert.equal(f.c.active, 'a');
  s.running = true; s.status = 'idle'; finish(); await flush(); f.paint();
  assert.deepEqual([...f.c.openTabs], ['a']);
  assert.equal(f.c.active, 'a');
});

test('启动失败后移除页签、显示原因，仍可从列表重试', async () => {
  let attempts = 0;
  const s = session('a');
  const f = setup({ sessions: [s], tabs: [], active: 'OV', invoke: async () => {
    if (++attempts === 1) throw 'CLI 不存在';
    s.running = true; s.status = 'idle';
  } });
  f.c.openSession('a'); await flush(); f.paint();
  assert.deepEqual([...f.c.openTabs], []);
  assert.equal(f.c.active, 'OV');
  assert.deepEqual(f.messages, ['连接失败：CLI 不存在']);
  f.c.openSession('a'); await flush(); f.paint();
  assert.equal(attempts, 2);
  assert.deepEqual([...f.c.openTabs], ['a']);
  assert.equal(f.c.active, 'a');
});
