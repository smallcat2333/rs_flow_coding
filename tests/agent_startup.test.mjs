// 执行真实 Agent 首屏入口：慢 APP 汇总不应挡住已有会话，来源新建仍保留完整关联信息。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const code = readFileSync(new URL('../ui/agent.js', import.meta.url), 'utf8').split('// ---------------- 启动 ----------------')[1];

/** 控制两条 IPC 的完成时机；只替换窗口/数据端口，启动排序执行真实源码。 */
function setup(search) {
  let resolveApps, resolveSessions, rejectSessions;
  const events = [], today = { textContent: '' };
  const c = vm.createContext({
    S: new Map(), URLSearchParams, location: { search }, $: selector => (selector === '#today' ? today : null),
    loadApps: () => new Promise(resolve => { resolveApps = () => { events.push('apps'); resolve(); }; }),
    invoke: () => new Promise((resolve, reject) => { resolveSessions = () => resolve([{ id: 'a' }]); rejectSessions = reject; }),
    openFocusedSession: id => events.push(`open:${id}`),
    createFromSource: pre => { events.push(`create:${pre.root}`); },
    renderMix() {}, renderToday() {}, renderLanes() {}, renderTicker() {}, renderTabs() {}, renderPane: () => events.push('pane'), renderRows() {},
    refreshAll: () => events.push('refresh'), requestAnimationFrame: () => events.push('frame'), frame() {}, setInterval() {},
    toast: message => events.push(`error:${message}`),
  });
  const boot = vm.runInContext(code, c);
  return { events, boot, today, apps: () => resolveApps(), sessions: () => resolveSessions(), fail: e => rejectSessions(e) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('APP 汇总未结束时先打开已有会话并启动动画', async () => {
  const s = setup('?focus=a');
  s.sessions();
  await s.boot;
  assert.deepEqual(s.events, ['open:a', 'frame']);
  s.apps(); await flush();
  assert.deepEqual(s.events, ['open:a', 'frame', 'apps', 'refresh']);
});

test('无会话先显示首屏，新建来源等 APP 汇总完成且只执行一次', async () => {
  const pre = encodeURIComponent(JSON.stringify({ root: 'E:/orders' }));
  const s = setup(`?new=${pre}`);
  s.sessions();
  await s.boot;
  assert.deepEqual(s.events, ['pane', 'frame']);
  s.apps(); await flush();
  assert.deepEqual(s.events, ['pane', 'frame', 'apps', 'refresh', 'create:E:/orders']);
});

test('服务启动中显示等待状态，就绪后再打开会话', async () => {
  const s = setup('?focus=a');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(s.today.textContent, /正在启动/);
  assert.deepEqual(s.events, []);
  s.sessions(); await s.boot;
  assert.deepEqual(s.events, ['open:a', 'frame']);
});

test('启动失败或超时显示具体原因，不打开会话也不按空列表新建', async () => {
  const pre = encodeURIComponent(JSON.stringify({ root: 'E:/orders' }));
  const s = setup(`?focus=a&new=${pre}`);
  s.fail('Agent 服务启动超时（30 秒），请稍后重试');
  await s.boot; s.apps(); await flush();
  assert.equal(s.today.textContent, 'Agent 启动失败：Agent 服务启动超时（30 秒），请稍后重试');
  assert.deepEqual(s.events, ['apps']);
});

test('APP 汇总先到时仍先载入会话再刷新，不丢失目标页签', async () => {
  const s = setup('?focus=a');
  s.apps(); await flush();
  assert.deepEqual(s.events, ['apps']);
  s.sessions(); await s.boot; await flush();
  assert.deepEqual(s.events, ['apps', 'open:a', 'frame', 'refresh']);
});
