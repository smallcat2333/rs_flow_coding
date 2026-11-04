// 同 APP 配对回归：执行生产打开路由与页签恢复，不把强制拆分当成跨 APP 配对许可。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const tabsSource = readFileSync(new URL('../ui/tabs.js', import.meta.url), 'utf8');
const flowRoute = appSource.slice(appSource.indexOf('async function routeDiagram('), appSource.indexOf('/** 右上角挂载标记'));
const featRoute = appSource.slice(appSource.indexOf('async function routeFeat('), appSource.indexOf('/** 页签接口'));

/** 为生产路由提供两个不同 APP，记录保存关闭和打开顺序；可注入慢读取重现交错点击。 */
function fixture({ flow = '', feat = '', newTab = false, read = async () => {} } = {}) {
  const apps = { a: {}, b: {} }, calls = [];
  let featPath = feat;
  const c = {
    SOLO: '', st: { cur: flow, loaded: !!flow, saving: false, pendingXml: null },
    flowNavigating: false, selCells: [], flowBack: [],
    Settings: { projectsNewTab: () => newTab }, Sidebar: { select() {} },
    Tabs: { isOtherProject: () => true, openNew: (...args) => calls.push(['new', ...args]) },
    ownsFlow: () => true, ownsFeat: () => true,
    appOf: (p) => apps[p.split('/')[0]],
    renderCurrentBar() {}, freezeDiagram: async () => {}, setDiagramLoading() {}, saveState() {}, post() {},
    invoke: async (_name, { path }) => read(path),
    FeatPane: {
      curPath: () => featPath,
      async close() { calls.push(['save-close-feat', featPath]); featPath = ''; },
      async open(path) { featPath = path; calls.push(['feat', path]); },
    },
    async closeFlow() { calls.push(['save-close-flow', c.st.cur]); c.st.cur = ''; c.st.loaded = false; c.flowNavigating = false; },
    async openDiagram(path) { c.st.cur = path; c.st.loaded = true; c.flowNavigating = false; calls.push(['flow', path]); },
  };
  vm.runInNewContext('let contentRoute = Promise.resolve();\n' + flowRoute + featRoute, c);
  return { c, calls, feat: () => featPath };
}

test('替换为异 APP 图时先保存关闭旧 Feat', async () => {
  const f = fixture({ flow: 'a/old.drawio', feat: 'a/feat.md' });
  await f.c.routeDiagram('b/new.drawio');
  assert.equal(f.feat(), '');
  assert.deepEqual(f.calls, [['save-close-feat', 'a/feat.md'], ['flow', 'b/new.drawio']]);
});

test('替换为异 APP Feat 时先关闭旧图', async () => {
  const f = fixture({ flow: 'a/old.drawio', feat: 'a/feat.md' });
  await f.c.routeFeat('b/new.md');
  assert.equal(f.c.st.cur, '');
  assert.deepEqual(f.calls, [['save-close-flow', 'a/old.drawio'], ['feat', 'b/new.md']]);
});

test('同 APP 图和 Feat 可以保持并排', async () => {
  const f = fixture({ flow: 'a/old.drawio', feat: 'a/feat.md' });
  await f.c.routeDiagram('a/new.drawio');
  await f.c.routeFeat('a/new.md');
  assert.equal(f.c.st.cur, 'a/new.drawio');
  assert.equal(f.feat(), 'a/new.md');
  assert.equal(f.calls.length, 2);
});

test('跨 APP 新页签设置开启时保留原配对', async () => {
  const f = fixture({ flow: 'a/old.drawio', feat: 'a/feat.md', newTab: true });
  await f.c.routeFeat('b/new.md');
  assert.equal(f.c.st.cur, 'a/old.drawio');
  assert.equal(f.feat(), 'a/feat.md');
  assert.equal(f.calls[0][0], 'new');
});

test('慢图读取与异 APP Feat 交错打开仍不能混配', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const f = fixture({ read: () => blocked });
  const flow = f.c.routeDiagram('a/new.drawio');
  const feat = f.c.routeFeat('b/new.md');
  release();
  await Promise.all([flow, feat]);
  assert.equal(f.c.st.cur, '');
  assert.equal(f.feat(), 'b/new.md');
});

test('目标图读取失败时保留原来的同 APP 配对', async () => {
  const f = fixture({ flow: 'a/old.drawio', feat: 'a/feat.md', read: async () => { throw new Error('文件不可读'); } });
  await f.c.routeDiagram('b/missing.drawio');
  assert.equal(f.c.st.cur, 'a/old.drawio');
  assert.equal(f.feat(), 'a/feat.md');
  assert.deepEqual(f.calls, []);
});

/** 执行完整 tabs.js 的启动恢复，仅模拟页签所需 DOM 和已存在文件目录。 */
async function restore(saved) {
  const storage = new Map([['fc-tabs', JSON.stringify(saved)]]), nodes = new Map();
  const doc = { addEventListener() {}, hidden: false };
  doc.getElementById = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      innerHTML: '', contentDocument: doc, addEventListener() {}, querySelector: () => null,
    });
    return nodes.get(id);
  };
  const c = {
    window: { __TAURI__: { event: { listen() {} } }, addEventListener() {} }, document: doc,
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    Settings: { tabLifetime: () => 0 }, Sidebar: { isUnseen: () => false }, setInterval() {},
  };
  vm.runInNewContext(tabsSource, c);
  await c.window.Tabs.init({
    exists: () => true, project: (p) => p.split('/')[0], label: (_kind, p) => p,
    async begin() {}, end() {}, async openFlow() {}, async openFeat() {}, async closeFlow() {}, async closeFeat() {},
  });
  return { saved: JSON.parse(storage.get('fc-tabs')), html: nodes.get('tabbar').innerHTML };
}

test('恢复旧的异 APP 组合时拆开两项，保留颜色和活动页签', async () => {
  const result = await restore({ tabs: [{ flow: 'a/old.drawio', feat: 'b/feat.md', color: 'blue', lastActive: Date.now() }], active: 0 });
  assert.equal(result.saved.tabs.length, 2);
  assert.equal(result.saved.tabs[0].flow, 'a/old.drawio');
  assert.equal(result.saved.tabs[0].feat, '');
  assert.equal(result.saved.tabs[1].flow, '');
  assert.equal(result.saved.tabs[1].feat, 'b/feat.md');
  assert.equal(result.saved.tabs[1].color, 'blue');
  assert.equal(result.saved.active, 0);
  assert.ok(result.html.indexOf('id="tab-new"') < result.html.indexOf('class="tab '));
});

test('同 APP 组合不拆开；前方旧混配拆分后仍保持原活动页签', async () => {
  const result = await restore({ tabs: [
    { flow: 'a/old.drawio', feat: 'b/feat.md', lastActive: Date.now() },
    { flow: 'b/own.drawio', feat: 'b/own.md', lastActive: Date.now() },
  ], active: 1 });
  assert.equal(result.saved.tabs.length, 3);
  assert.equal(result.saved.active, 2);
  assert.equal(result.saved.tabs[2].feat, 'b/own.md');
});
