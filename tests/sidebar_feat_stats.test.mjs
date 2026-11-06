// Feat 统计：执行实际状态归组与分层/平铺筛选，不读取用户档案。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/sidebar.js', import.meta.url), 'utf8');
const exportLine = 'return { init, render, select, deselect, prune, isUnseen, setAutoTop, autoTop: () => prefs.auto_top, appName, featState };';
const states = ['已关闭', '已废弃', '探讨中', '需求中', 'UI设计中', '开发中', '待测试', '测试中', '待验收', '已暂停', '待明确'];
const counts = () => ({ none: 0, review: 0, confirmed: 0, confirm_delete: 0, issue: 0 });
const feat = (status, i) => ({ path: `/app/docs/feat/f${i}.md`, id: `Feat_1_${i}`, title: `档案${i}`, status, archived: /已关闭|已废弃/.test(status), closed_at: '2026-11-01', tasks_total: 0, node_total: 0 });
const app = (feats) => ({ app: 'app', group: '', flow_dir: '/app/docs/flow', feat_dir: '/app/docs/feat', counts: counts(), files: [{ path: '/app/docs/flow/main.drawio', name: 'main.drawio', enabled: true, counts: { ...counts(), review: 1 } }], feats });
function setup(items) {
  const elements = new Map();
  const context = vm.createContext({
    window: { __TAURI__: { core: {}, event: {} } },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { innerHTML: '' }); return elements.get(id); } },
    ResizeObserver: class {}, MenuIcons: { forLabel: () => '' }, badges: () => '',
    STATUS: Object.keys(counts()).map(key => ({ key, name: key })),
  });
  vm.runInContext(readFileSync(new URL('../ui/feat_state.js', import.meta.url), 'utf8'), context);
  assert.ok(source.includes(exportLine));
  vm.runInContext(source.replace(exportLine, `return { featState, featGroup, featStats, renderFeatStats, treeHtml, flatHtml, pinnedHtml,
    seed(value) { apps = value; prefs = { layout: 'tree', bumped: {}, unseen: [], pinned: [], collapsed: [], expanded_archives: [], app_order: [], group_order: [], app_aliases: {}, group_aliases: {}, include_archived: false }; },
    filter(feat, chart = '') { featFilter = feat; statusFilter = chart; },
    search(value) { search = value; },
    preferences(value) { Object.assign(prefs, value); }
  };`), context);
  const api = context.window.Sidebar;
  api.seed(items);
  return { api, html: () => elements.get('status-bars').innerHTML };
}

test('六组互斥覆盖全部标签，分组沿用状态开头规则并包含已收纳档案', () => {
  const { api } = setup([app(states.map(feat))]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.featStats())), { closed: 2, planning: 2, design: 1, dev: 1, test: 3, other: 2 });
  assert.equal(api.featGroup(feat('开发中，完成后待验收', 99)), 'dev');
  assert.equal(api.featGroup({ status: '正文说明已关闭', archived: false }), 'other');
  assert.equal(api.featGroup({ status: '', archived: true }), 'closed');
  assert.equal(api.featGroup(feat('测试完成，等用户确认', 99)), 'test');
  assert.equal(api.featGroup(feat('**需求整理中**', 99)), 'planning');
});

test('关闭与其他只显示数值，四条统计条共享最大值，零数据不画假进度', () => {
  const rows = [...states.map(feat), ...Array.from({ length: 30 }, (_, i) => feat('已关闭', 100 + i))];
  const { api, html } = setup([app(rows)]);
  api.renderFeatStats();
  const rendered = html();
  assert.equal((rendered.match(/class="status-fill"/g) || []).length, 4);
  assert.match(rendered, /data-feat-status="test"[^]*?width:100%/);
  assert.match(rendered, /data-feat-status="closed"[^]*?status-track none/);
  assert.match(rendered, /data-feat-status="other"[^]*?status-track none/);
  assert.match(rendered, /待测试、测试中、待验收/);
  api.seed([app([])]); api.renderFeatStats();
  assert.equal((html().match(/width:0%/g) || []).length, 4);
  assert.ok(!/NaN|Infinity/.test(html()));
});

test('分层与平铺筛选包含关闭档案并展开结果，计数不随搜索或置顶重复', () => {
  const { api } = setup([app(states.map(feat))]);
  api.preferences({ collapsed: ['/app/docs/flow', '/app/docs/flow#feat'], pinned: ['/app/docs/feat/f0.md', '/app/docs/flow/main.drawio'] });
  api.filter('closed');
  for (const render of [api.treeHtml, api.flatHtml]) {
    const html = render();
    assert.match(html, /data-feat="\/app\/docs\/feat\/f0.md"/);
    assert.match(html, /data-feat="\/app\/docs\/feat\/f1.md"/);
    assert.ok(!html.includes('data-path=') && !html.includes('data-feat="/app/docs/feat/f2.md"'));
    assert.ok(!html.includes('sec collapsed'));
  }
  const pinned = api.pinnedHtml();
  assert.ok(pinned.includes('f0.md') && !pinned.includes('main.drawio'));
  api.search('档案0');
  assert.ok(api.treeHtml().includes('f0.md') && !api.treeHtml().includes('f1.md'));
  assert.equal(api.featStats().closed, 2);
});

test('测试组同时匹配三个阶段，切回 Chart 筛选仍仅显示启用图', () => {
  const { api } = setup([app(states.map(feat))]);
  api.filter('test');
  for (const render of [api.treeHtml, api.flatHtml]) {
    const html = render();
    for (const i of [6, 7, 8]) assert.ok(html.includes(`data-feat="/app/docs/feat/f${i}.md"`));
    assert.ok(!html.includes('data-path=') && !html.includes('f5.md'));
  }
  api.filter('', 'review');
  for (const render of [api.treeHtml, api.flatHtml]) {
    const html = render();
    assert.ok(html.includes('data-path="/app/docs/flow/main.drawio"'));
    assert.ok(!html.includes('data-feat='));
  }
});
