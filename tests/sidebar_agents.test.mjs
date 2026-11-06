// 主窗口 Agent 分组：执行实际侧栏函数；IPC 与菜单 DOM 使用最小模拟，不启动 CLI。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/sidebar.js', import.meta.url), 'utf8');
const exportLine = 'return { init, render, select, deselect, prune, isUnseen, setAutoTop, autoTop: () => prefs.auto_top, appName, featState };';

/** 暴露本模块的实际私有函数供单测；只替换重绘，菜单和归属判断保持原逻辑。 */
function setup() {
  let menu;
  const calls = [];
  const rows = [];
  const document = {
    getElementById: () => ({ querySelectorAll: () => rows }),
    createElement: () => ({ style: {}, setAttribute() {}, querySelector: () => ({ focus() {} }), remove() {}, offsetWidth: 120, offsetHeight: 80 }),
    body: { appendChild: element => { menu = element; } },
  };
  const context = vm.createContext({ window: { __TAURI__: { core: { invoke: async (cmd, args) => {
    calls.push({ cmd, args });
    return { ...session(args.id), archived_at: args.archived ? 1000 : 0 };
  } }, event: {} } }, document, ResizeObserver: class {}, MenuIcons: { forLabel: () => '' }, innerWidth: 1000, innerHeight: 800, sideMsg() {} });
  const injected = `return { _test: { agentSection, agentApp, newAgent, openAgentMenu, openDirectoryMenu, syncAgentSelection,
    seed(items, sessions, preferences = {}) { apps = items; agents.clear(); sessions.forEach(s => agents.set(s.id, s)); prefs = { collapsed: [], expanded_archives: [], include_archived: false, layout: 'tree', app_aliases: {}, ...preferences }; },
    search(value) { search = value; }, has(id) { return agents.has(id); }, silenceRender() { render = () => {}; }
  } };`;
  vm.runInContext(readFileSync(new URL('../ui/feat_state.js', import.meta.url), 'utf8'), context);
  assert.ok(source.includes(exportLine));
  vm.runInContext(source.replace(exportLine, injected), context);
  const api = context.window.Sidebar._test;
  api.silenceRender();
  return { api, calls, rows, menu: () => menu };
}
const app = (name) => ({ app: name, root: 'E:/root', flow_dir: `E:/root/${name}/docs/flow` });
const session = (id, extra = {}) => ({ id, title: id, cwd: 'E:/root', app: 'a', feat: '', feat_code: '', links: [], created: 1, archived_at: 0, ...extra });

test('当前 Agent 页签紫色选择随切换同步，重绘和归属色保持一致', () => {
  const { api, rows } = setup(), a = app('a');
  api.seed([a], [session('one'), session('two', { links: [{ flow: a.flow_dir + '/业务.drawio', node: '' }] })]);
  const row = id => ({ dataset: { agent: id }, active: false, attributes: {},
    classList: { toggle(_key, selected) { rows.find(r => r.dataset.agent === id).active = selected; } },
    setAttribute(key, value) { this.attributes[key] = value; } });
  rows.push(row('one'), row('two'));
  api.syncAgentSelection(JSON.stringify({ tabs: ['one', 'two'], active: 'one' }));
  assert.equal(rows[0].active, true);
  assert.equal(rows[1].active, false);
  assert.equal(rows[0].attributes['aria-current'], 'true');
  assert.match(api.agentSection(a), /agent-entry free active/);
  api.syncAgentSelection(JSON.stringify({ tabs: ['one', 'two'], active: 'two' }));
  assert.equal(rows[0].active, false);
  assert.equal(rows[1].active, true);
  assert.match(api.agentSection(a), /agent-entry bound active/);
  assert.doesNotMatch(api.agentSection(a), /agent-entry free active/);
});

test('总览、已关闭页签和损坏偏好清除 Agent 选择，归档会话不高亮', () => {
  const { api } = setup(), a = app('a');
  api.seed([a], [session('one'), session('archived', { archived_at: 1000 })], { expanded_archives: [a.flow_dir + '#agent#archive'] });
  for (const value of [JSON.stringify({ tabs: ['one'], active: 'OV' }), JSON.stringify({ tabs: [], active: 'one' }), 'broken JSON', 'null', null]) {
    api.syncAgentSelection(value);
    assert.doesNotMatch(api.agentSection(a), /agent-entry [^"]* active/);
  }
  api.syncAgentSelection(JSON.stringify({ tabs: ['archived'], active: 'archived' }));
  assert.doesNotMatch(api.agentSection(a), /agent-entry archived-entry active/);
});

/** 生成菜单的真实点击输入；菜单回调负责决定调用哪条 IPC。 */
const clickAction = (action) => ({ target: { closest: () => ({ dataset: { action } }) } });

test('绑定蓝、游离绿；归档默认折叠且不计入活跃数量', () => {
  const { api } = setup(), a = app('a');
  const sessions = [session('free'), session('bound', { links: [{ flow: a.flow_dir + '/业务.drawio', node: '' }] }), session('archived', { archived_at: 1000 })];
  api.seed([a], sessions);
  let html = api.agentSection(a);
  assert.match(html, /agent-entry free/);
  assert.match(html, /agent-entry bound/);
  assert.match(html, /sec-count">2</);
  assert.match(html, /已归档/);
  assert.ok(!html.includes('data-agent="archived"'));
  api.seed([a], sessions, { expanded_archives: [a.flow_dir + '#agent#archive'] });
  html = api.agentSection(a);
  assert.match(html, /agent-entry archived-entry/);
  assert.match(html, /180 天后清理/);
});

test('同扫描根的不同 APP 不串会话；绑定项按真实来源确定归属', () => {
  const { api } = setup(), a = app('a'), b = app('b');
  api.seed([a, b], [session('one'), session('two', { app: 'b' }), session('by-source', { app: 'a', feat: b.flow_dir.replace('/flow', '/feat') + '/Feat_1.md' })]);
  const first = api.agentSection(a), second = api.agentSection(b);
  assert.ok(first.includes('data-agent="one"') && !first.includes('data-agent="two"'));
  assert.ok(second.includes('data-agent="two"') && second.includes('data-agent="by-source"'));
});

test('搜索收纳取决于开关，搜索会话名安全转义', () => {
  const { api } = setup(), a = app('a'), archived = session('old', { title: '<旧需求>', archived_at: 1000 });
  api.seed([a], [archived]); api.search('旧需求');
  assert.equal(api.agentSection(a), '');
  api.seed([a], [archived], { include_archived: true });
  const html = api.agentSection(a);
  assert.ok(html.includes('&lt;旧需求&gt;'));
  assert.ok(!html.includes('<旧需求>'));
});

test('APP 新建入口只预填所选 APP，工作目录保持原值', async () => {
  const { api, calls } = setup(), a = app('a'), b = app('b');
  api.seed([a, b], []);
  await api.newAgent(b.flow_dir);
  assert.equal(calls[0].cmd, 'open_agent_window');
  assert.equal(calls[0].args.prefill.flowDir, b.flow_dir);
  assert.equal(calls[0].args.prefill.app, 'b');
  assert.equal(calls[0].args.prefill.root, 'E:/root');
});

test('右键删除单次点击直接移除，归档和恢复分别传入正确状态', async () => {
  const { api, calls, menu } = setup(), a = app('a');
  for (const [action, archived] of [['archive', true], ['restore', false], ['delete', null]]) {
    api.seed([a], [session('s', { archived_at: action === 'restore' ? 1000 : 0 })]);
    api.openAgentMenu({ dataset: { agent: 's' }, isConnected: false }, 5, 5);
    await menu().onclick(clickAction(action));
    const call = calls.at(-1);
    assert.equal(call.cmd, archived === null ? 'agent_remove' : 'agent_archive');
    assert.equal(call.args.id, 's');
    if (archived !== null) assert.equal(call.args.archived, archived);
    else assert.equal(api.has('s'), false);
  }
  assert.equal(calls.length, 3);
});
