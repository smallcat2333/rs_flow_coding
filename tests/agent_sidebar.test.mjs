// Agent 来源创建与侧栏：执行真实前端模块，后端 IPC 仅记录调用。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/agent_core.js', import.meta.url), 'utf8');
function setup(invoke) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', readOnly: false, dataset: {}, innerHTML: '', textContent: '', checked: false, disabled: false, classList: { add() {}, remove() {} }, setAttribute() {}, querySelectorAll: () => [] });
    return elements.get(selector);
  };
  const opened = [];
  const context = vm.createContext({
    window: { __TAURI__: { core: { invoke }, event: { listen() {}, emit() {} } } },
    document: { querySelector: element, querySelectorAll: () => [] },
    localStorage: { getItem: () => null }, matchMedia: () => ({ matches: true }),
    setTimeout() {}, openSession: id => opened.push(id), openFocusedSession: id => opened.push(id),
    upsert: s => context.add(s),
  });
  vm.runInContext(source + '\nObject.assign(globalThis, { list, expandedGroups, sourceOf, rowSummary, rowUpdated, createFromSource, renderNbChips, renderRows, add: s => S.set(s.id, s), setApps: v => { apps = v; }, setDraft: v => Object.assign(nb, v), get: id => S.get(id) });', context);
  context.setApps([{ app: 'app_orders', root: 'E:/orders', files: [], feats: [] }]);
  return { context, element, opened };
}
test('API 错误覆盖停滞和旧工具状态，列表保留错误原因并能恢复', () => {
  const { context: c, element } = setup(async () => {});
  const failed = session('api', { running: true, status: 'apierr', api_error: 'API error · Retrying in 0s · attempt 1/10', beat: 1, tool: 'Bash' });
  assert.equal(c.vs(failed), 'apierr');
  assert.equal(c.stText(failed), 'API 错误');
  c.add(failed); c.renderRows();
  assert.match(element('#rows').innerHTML, /row v-apierr/);
  assert.match(element('#rows').innerHTML, /API error · Retrying/);
  assert.doesNotMatch(element('#rows').innerHTML, /可能停滞/);
  c.renderToday();
  assert.match(element('#today').textContent, /1 个会话在线，1 个 API 错误/);
  const resumed = { ...failed, status: 'run', api_error: '', tool: '', beat: Date.now() };
  assert.equal(c.stText(resumed), '运行中');
});

const session = (id, extra = {}) => ({ id, title: id, app: 'app_orders', created: 1, acts: [], links: [], status: 'off', ...extra });

test('已中断停止执行显示，在线进程不再计作执行中', () => {
  const { context: c, element } = setup(async () => {});
  const s = session('interrupt', { running: true, status: 'interrupted', tool: 'Bash', turn: 100, since: 200, done: 0, beat: 1 });
  c.add(s); c.renderRows(); c.renderMix(); c.renderToday();
  assert.equal(c.vs(s), 'interrupted');
  assert.equal(c.stText(s), '已中断');
  assert.equal(c.laneSt({ s }), '已中断');
  assert.match(element('#rows').innerHTML, /row v-interrupted/);
  assert.match(element('#mix').innerHTML, /已中断/);
  assert.match(element('#today').textContent, /1 个会话在线/);
  assert.doesNotMatch(element('#today').textContent, /会话运行中/);
});

test('来源直接创建，连续点击只提交一次，不打开命名表单', async () => {
  let finish;
  const calls = [];
  const { context: c, element, opened } = setup((cmd, args) => {
    calls.push({ cmd, args });
    return new Promise(resolve => { finish = resolve; });
  });
  const pre = { root: 'E:/orders', links: [{ flow: 'E:/orders/docs/flow/订单.drawio', node: '' }] };
  const first = c.createFromSource(pre), second = c.createFromSource(pre);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'agent_create');
  assert.equal(calls[0].args.title, '');
  assert.equal(calls[0].args.cwd, 'E:/orders');
  assert.equal(element('#nbName').value, '');
  finish(session('new', { title: '订单', links: pre.links }));
  await Promise.all([first, second]);
  assert.deepEqual(opened, ['new']);
  await c.createFromSource(pre);
  assert.equal(calls.length, 1, '已有来源直接打开');
  assert.deepEqual(opened, ['new', 'new']);
});

test('Feat 直接创建保留来源与关联节点，不提交自定义名字', async () => {
  const calls = [];
  const { context: c } = setup(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'tagged_nodes') return [{ file: 'E:/orders/docs/flow/订单.drawio', id: 'n1', label: '订单入口' }];
    return session('feat-main', { title: '订单导出', feat: args.feat, links: args.links });
  });
  c.setApps([{ app: 'app_orders', root: 'E:/orders', flow_dir: 'E:/orders/docs/flow', feats: [] }]);
  await c.createFromSource({ root: 'E:/orders', feat: { id: 'Feat_261106_1', path: 'E:/orders/docs/feat/Feat_261106_1_订单导出.md', title: '订单导出' } });
  const created = calls.find(x => x.cmd === 'agent_create').args;
  assert.equal(created.title, '');
  assert.equal(created.featCode, 'Feat_261106_1');
  assert.equal(created.links[0].node, 'n1');
});

test('新建自动聚焦不滚动页面，面板提前关闭后不再抢焦点', async () => {
  const { context: c, element } = setup(async () => {});
  const timers = [], focused = [], classes = new Set();
  c.setTimeout = callback => timers.push(callback);
  element('#newwrap').classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  element('#nbName').focus = options => focused.push(options);
  await c.openNewBox(); timers.shift()();
  assert.equal(focused.length, 1);
  assert.equal(focused[0].preventScroll, true);
  await c.openNewBox(); c.closeNewBox(); timers.shift()();
  assert.equal(focused.length, 1, '快速取消后不聚焦隐藏输入框');
});

test('手动表单选来源锁定名字，解除关联恢复独立会话草稿', () => {
  const { context: c, element } = setup(async () => {});
  element('#nbName').value = '临时排查';
  c.setDraft({ feat: { id: 'Feat_1', title: '订单导出', path: 'f.md' }, links: [] });
  c.renderNbChips();
  assert.equal(element('#nbName').value, '订单导出');
  assert.equal(element('#nbName').readOnly, true);
  c.setDraft({ feat: null, links: [{ flow: 'E:/orders/docs/flow/支付流程.drawio', node: 'n1' }] });
  c.renderNbChips();
  assert.equal(element('#nbName').value, '支付流程');
  c.setDraft({ links: [] });
  c.renderNbChips();
  assert.equal(element('#nbName').readOnly, false);
  assert.equal(element('#nbName').value, '临时排查');
});

test('启用会话保留摘要字段，来源图标可定位且置顶不重复', () => {
  const { context: c, element } = setup(async () => {});
  c.add(session('free'));
  c.add(session('graph', { links: [{ flow: 'x.drawio', node: '' }], title: '<支付流程>' }));
  c.add(session('feat', { feat: 'f.md', feat_code: 'Feat_1', title: '订单导出', running: true, status: 'run', beat: Date.now(), workers: [{ running: true, desc: '检查导出' }] }));
  c.add(session('pinned', { pinned: true, pin_at: 1, title: '置顶来源', feat: 'g.md' }));
  c.add(session('archived', { archived_at: Date.now() }));
  c.renderRows();
  const html = element('#rows').innerHTML;
  assert.equal((html.match(/<li class="row /g) || []).length, 4, '每个可见会话恰好一个会话行，归档分组标题不计入');
  assert.ok(!html.includes('class="sep"'));
  assert.ok(!html.includes('Feat 主 Agent'));
  assert.ok(!html.includes('class="rs"') && !html.includes('class="wk'), '不展开辅助行和子代理行');
  assert.ok(html.indexOf('data-s="pinned"') < html.indexOf('data-s="feat"'));
  assert.equal((html.match(/data-s="pinned"/g) || []).length, 1);
  assert.ok(html.includes('data-feat="feat"'));
  assert.ok(html.includes('data-ref="x.drawio"'));
  assert.ok(html.includes('row v-run is-bound'));
  assert.equal((html.match(/class="row-status"/g) || []).length, 4);
  assert.equal((html.match(/class="row-time"/g) || []).length, 4);
  assert.equal((html.match(/class="row-summary/g) || []).length, 4);
  assert.ok(html.indexOf('class="row-time"') < html.indexOf('class="row-status"'));
  assert.ok(html.includes('执行中的子代理：检查导出'), '细节留在悬停提示中');
  assert.ok(html.includes('&lt;支付流程&gt;'));
  assert.ok(!html.includes('<支付流程>'));
  assert.equal(c.sourceOf(session('old', { feat: 'f.md' })).locked, true);
  assert.equal(c.sourceOf(session('old', { links: [{ flow: 'first.drawio' }, { flow: 'second.drawio' }] })).path, 'first.drawio');
});

test('收纳与归档默认折叠，不参与启用列表；展开后提供恢复入口', () => {
  const { context: c, element } = setup(async () => {});
  c.add(session('enabled'));
  c.add(session('stored', { stored_at: 1000, pinned: true }));
  c.add(session('archived', { stored_at: 1000, archived_at: 2000 }));
  c.renderRows();
  let html = element('#rows').innerHTML;
  assert.deepEqual([...c.list()].map(s => s.id), ['enabled']);
  assert.ok(html.includes('data-session-group="stored" aria-expanded="false"'));
  assert.ok(html.includes('data-session-group="archived" aria-expanded="false"'));
  assert.ok(!html.includes('data-s="stored"') && !html.includes('data-s="archived"'));
  c.expandedGroups.add('stored'); c.expandedGroups.add('archived'); c.renderRows();
  html = element('#rows').innerHTML;
  assert.equal((html.match(/data-s="stored"/g) || []).length, 1);
  assert.ok(html.includes('data-session-action="enable" data-id="stored"'));
  assert.ok(html.includes('data-session-action="restore" data-id="archived"'));
  assert.ok(!html.includes('删除'));
});

test('收纳来源再次点击复用原会话，不创建第二个主会话', async () => {
  let calls = 0;
  const { context: c, opened } = setup(async () => { calls++; });
  const links = [{ flow: 'E:/orders/docs/flow/订单.drawio', node: '' }];
  c.add(session('stored-main', { links, stored_at: 1000 }));
  await c.createFromSource({ root: 'E:/orders', links });
  assert.equal(calls, 0);
  assert.deepEqual(opened, ['stored-main']);
});

test('摘要只取当前轮提问首句，长提问在 tooltip 中保留，清空后不回显上一轮', () => {
  const { context: c, element } = setup(async () => {});
  const prompt = '请修复订单导出，并保留 <script> 标签文字。\n还需要验证大文件导出后的编码。';
  const s = session('summary', { turn: 200, turn_prompt: prompt, acts: [{ kind: 'prompt', text: '旧需求', t: 100 }], beat: 300 });
  assert.equal(c.rowSummary(s).text, '请修复订单导出，并保留 <script> 标签文字。');
  assert.equal(c.rowSummary(s).full, prompt.replace(/\s+/g, ' '));
  c.add(s); c.renderRows();
  const html = element('#rows').innerHTML;
  assert.ok(html.includes('还需要验证大文件导出后的编码。'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.equal(c.rowSummary(session('cleared', { turn: 0, acts: s.acts })).full, '');
  assert.equal(c.rowSummary(session('new-turn', { turn: 200, acts: s.acts })).full, '');
  assert.equal(c.rowSummary(session('old-payload', { turn: 100, acts: s.acts })).text, '旧需求');
});

test('更新时间取最新活动或状态变化，状态标签与机器人共用状态类', () => {
  const { context: c, element } = setup(async () => {});
  const timestamp = new Date(2026, 10, 6, 14, 8).getTime();
  const s = session('stamp', { created: timestamp - 60000, since: timestamp, beat: timestamp - 1000, done: timestamp - 2000, acts: [{ t: timestamp - 5000, kind: 'read', text: 'a.md' }], status: 'wait', running: true });
  assert.equal(c.rowUpdated(s), timestamp);
  c.add(s); c.renderRows();
  const html = element('#rows').innerHTML;
  assert.match(html, /class="row-time"[^>]*>14:08<\/time>/);
  assert.ok(html.includes('row v-wait'));
  assert.ok(html.includes('class="row-status">等你确认</span>'));
  assert.equal(c.rowUpdated(session('unknown', { created: 0 })), 0);
});
