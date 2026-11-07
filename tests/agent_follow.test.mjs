// 执行真实跟随入口，验证页面来源匹配及“待命不跟随”；不启动 CLI、不触碰用户会话。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const agent = readFileSync(new URL('../ui/agent.js', import.meta.url), 'utf8');
const core = readFileSync(new URL('../ui/agent_core.js', import.meta.url), 'utf8');
const followSource = agent.slice(agent.indexOf('function followSession('), agent.indexOf('function locate('));
const sourceOf = core.slice(core.indexOf('function sourceOf('), core.indexOf('function sourceBadge('));
const root = 'E:/work/app_a';
const flow = `${root}/docs/flow/查询.drawio`;
const feat = `${root}/docs/feat/Feat_261106_1.md`;

/** 会话夹具可明确表示运行、待命和停用状态，来源使用真实完整路径。 */
function session(id, extra = {}) {
  return { id, title: id, running: true, status: 'idle', archived_at: 0, stored_at: 0, feat: '', feat_code: '', links: [], acts: [], ...extra };
}

/** 只模拟窗口切换与通知边界，生产代码负责匹配、开关和待命判定。 */
function setup(sessions, follow = true) {
  const opened = [], messages = [], handlers = {}, storage = new Map();
  const app = { root, feats: [{ id: 'Feat_261106_1', title: '查询需求', path: feat }] };
  const c = vm.createContext({
    S: new Map(sessions.map(s => [s.id, s])), apps: [app], active: 'OV', mainSel: null,
    follow, FOLLOW_KEY: 'fc-agent-follow', WINDOW: 300000,
    key: path => String(path || '').replace(/\//g, '\\').toLowerCase(),
    base: path => path.split(/[\\/]/).at(-1), flowName: () => '查询', now: () => 1000000,
    appOfPath: () => app, featEntry: path => app.feats.find(f => f.path === path),
    byUrgency: (a, b) => Number(b.running) - Number(a.running),
    refsOf: s => s.links, list: () => [...c.S.values()].filter(s => !s.archived_at && !s.stored_at),
    openSession: id => { opened.push(id); c.active = id; },
    toast: text => messages.push(text), createFromSource() { throw new Error('跟随不能创建会话'); },
    renderRows() {}, renderOverview() {}, renderHead() {}, $$: () => [],
    window: { TerminalThemes: { KEY: 'fc-terminal-theme' }, addEventListener: (event, fn) => { handlers[event] = fn; } },
    localStorage: { getItem: key => storage.get(key) ?? null },
  });
  vm.runInContext(sourceOf + followSource, c);
  const start = agent.indexOf("window.addEventListener('storage'");
  vm.runInContext(agent.slice(start, agent.indexOf("\nmatchMedia('(prefers-color-scheme", start)), c);
  return { c, opened, messages, handlers, storage };
}

test('整图页面精确匹配图主，不选关联同图的 Feat 会话或其他 APP 同名图', async () => {
  const f = setup([
    session('feat', { feat, links: [{ flow, node: 'n1' }] }),
    session('other-app', { links: [{ flow: 'E:/work/app_b/docs/flow/查询.drawio', node: '' }] }),
    session('owner', { links: [{ flow, node: '' }] }),
  ]);
  await f.c.onMainSelect({ path: flow.toUpperCase().replace(/\//g, '\\'), page: 'flow' });
  assert.deepEqual(f.opened, ['owner']);
});

test('纯 Feat 页面按档案完整路径跟随，无需画布或节点标签', async () => {
  const f = setup([session('same-id-other-app', { feat: 'E:/work/app_b/docs/feat/Feat_261106_1.md' }), session('owner', { feat })]);
  await f.c.onMainSelect({ path: feat, page: 'feat' });
  assert.deepEqual(f.opened, ['owner']);
  assert.equal(f.c.mainSel.featPath, feat);
});

test('图主或 Feat 主处于待命时保留当前会话，不启动、不提示新建', async () => {
  const f = setup([session('flow', { running: false, status: 'off', links: [{ flow, node: '' }] }), session('feat', { running: false, status: 'off', feat })]);
  await f.c.onMainSelect({ path: flow, page: 'flow' });
  await f.c.onMainSelect({ path: feat, page: 'feat' });
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.messages, []);
  assert.equal(f.c.active, 'OV');
});

test('原有节点与 Feat 跟随同样跳过待命，空闲及运行会话仍可跟随', async () => {
  const owner = session('owner', { running: false, status: 'off', feat, feat_code: 'Feat_261106_1', links: [{ flow, node: 'n1' }] });
  const f = setup([owner]);
  await f.c.onMainSelect({ path: flow, node: 'n1', tags: [] });
  await f.c.onMainSelect({ path: flow, feat: 'Feat_261106_1' });
  assert.deepEqual(f.opened, []);
  for (const status of ['idle', 'run']) {
    owner.running = true; owner.status = status; f.c.active = 'OV';
    await f.c.onMainSelect({ path: flow, node: 'n1', tags: [] });
  }
  assert.deepEqual(f.opened, ['owner', 'owner']);
});

test('关闭跟随后页面仍不切换；设置的跨窗口修改立即生效', async () => {
  const f = setup([session('owner', { feat })], false);
  await f.c.onMainSelect({ path: feat, page: 'feat' });
  assert.deepEqual(f.opened, []);
  assert.match(f.messages[0], /已锁定/);
  f.storage.set('fc-agent-follow', '1');
  f.handlers.storage({ key: 'fc-agent-follow' });
  await f.c.onMainSelect({ path: feat, page: 'feat' });
  assert.deepEqual(f.opened, ['owner']);
  f.storage.set('fc-agent-follow', '0');
  f.handlers.storage({ key: 'fc-agent-follow' });
  assert.equal(f.c.follow, false);
});

test('缺少会话、收纳/归档会话均不跟随，不创建或恢复；同一会话不重复切换', async () => {
  const f = setup([session('stored', { feat, stored_at: 1 }), session('archived', { links: [{ flow, node: '' }], archived_at: 1 })]);
  await f.c.onMainSelect({ path: feat, page: 'feat' });
  await f.c.onMainSelect({ path: flow, page: 'flow' });
  assert.deepEqual(f.opened, []);
  f.c.S.set('owner', session('owner', { feat }));
  await f.c.onMainSelect({ path: feat, page: 'feat' });
  await f.c.onMainSelect({ path: feat, page: 'feat' });
  assert.deepEqual(f.opened, ['owner']);
});
