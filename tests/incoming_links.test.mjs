// 入链角标行为：计数、槽位、旧图清理、点击消息与外层来源行跳转。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const bridge = readFileSync(new URL('../ui/flow_bridge.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');

/** 截取已有函数到下一条职责注释，执行真实实现，避免复制生产分支。 */
function fn(text, name) {
  const start = text.indexOf('function ' + name + '(');
  const end = text.indexOf('\n  /**', start);
  return text.slice(start, end);
}

/** 提供 overlay 的最小图模型；记录添加、移除与点击消息，不修改图 XML。 */
function fixture({ outgoing = false, link = false } = {}) {
  const overlays = [], removed = [], sent = [];
  const cell = { id: 'n15' };
  const context = {
    fullPath: 'a/查询.drawio', incomingPath: 'a/查询.drawio', incomingRefs: { n15: [{ path: 'a/Feat.md', title: '来源', line: 12 }] },
    incomingMarks: {}, FEAT_TAG: /^Feat_\d+_\d+$/,
    tagsOf: () => outgoing ? ['Feat_261104_1'] : [], isFlowLink: () => link,
    plain: () => '追溯上一次投入', send: (m) => sent.push(m),
    markImage: (n, incoming) => ({ n, incoming }), mxConstants: { ALIGN_RIGHT: 'right', ALIGN_TOP: 'top' }, mxEvent: { CLICK: 'click' },
    mxPoint: class { constructor(x, y) { this.x = x; this.y = y; } },
    mxCellOverlay: class { constructor(image, tip, align, vertical, offset) { Object.assign(this, { image, tip, offset }); } addListener(_event, handler) { this.click = handler; } },
  };
  const graph = { model: { isVertex: () => true }, getLinkForCell() {},
    addCellOverlay: (_c, overlay) => overlays.push(overlay), removeCellOverlay: (_c, overlay) => removed.push(overlay), setSelectionCell() {} };
  vm.runInNewContext(fn(bridge, 'refreshIncomingMarks'), context);
  return { context, overlays, removed, sent, refresh: () => context.refreshIncomingMarks(graph, [cell]) };
}

test('仅正文引用也显示入链，无需节点 Feat 标签；重复刷新不重复添加', () => {
  const f = fixture();
  f.refresh(); f.refresh();
  assert.equal(f.overlays.length, 1);
  assert.equal(f.overlays[0].image.incoming, true);
  assert.equal(f.overlays[0].image.n, 1);
  assert.match(f.overlays[0].tip, /入链/);
  assert.equal(f.overlays[0].offset.x, -14);
  f.overlays[0].click();
  assert.equal(f.sent[0].event, 'fc-open-incoming');
  assert.equal(f.sent[0].source, 'a/查询.drawio');
  assert.equal(f.sent[0].cell.id, 'n15');
});

test('蓝色出链、图链接和深黄色入链使用不同槽位', () => {
  const f = fixture({ outgoing: true, link: true });
  f.refresh();
  assert.equal(f.overlays[0].offset.x, -56);
});

test('来源更新重建计数，移除引用和切图均清除旧入链', () => {
  const f = fixture();
  f.refresh();
  f.context.incomingRefs.n15.push({ path: 'a/Feat2.md', title: '第二个来源', line: 6 });
  f.refresh();
  assert.equal(f.overlays[1].image.n, 2);
  assert.equal(f.removed.length, 1);
  f.context.incomingRefs = {};
  f.refresh();
  assert.equal(f.removed.length, 2);
  assert.equal(Object.keys(f.context.incomingMarks).length, 0);
  f.context.incomingRefs = { n15: [{ path: 'a/Feat.md', title: '来源', line: 12 }] };
  f.context.fullPath = 'b/查询.drawio';
  f.refresh();
  assert.equal(f.overlays.length, 2);
});

test('入链只取当前 APP、当前图；相同节点 ID 不混入其他图或 APP', () => {
  const sources = [{ path: 'a/Feat.md', id: 'Feat_1', title: '当前来源', archived: false,
    references: [{ file: '查询.drawio', node: 'n15', line: 12 }, { file: '其他.drawio', node: 'n15', line: 8 }] }];
  let payload;
  const start = app.indexOf('function syncMenuFeats('), end = app.indexOf("$('tree').addEventListener", start);
  const c = { st: { ready: true, cur: 'a/查询.drawio' }, curEntry: () => ({ app: { feats: sources } }), post: (m) => { payload = m; } };
  vm.runInNewContext('let incomingFeats = {};\n' + app.slice(start, end), c);
  c.syncMenuFeats();
  assert.deepEqual(JSON.parse(JSON.stringify(payload.incoming)), { n15: [{ path: 'a/Feat.md', title: '当前来源', line: 12 }] });
  assert.equal(payload.path, 'a/查询.drawio');
});

test('入链来源行号在当前页签和新页签路由中均保留', () => {
  let newTab = false;
  const calls = [];
  const start = app.indexOf('function openLinked('), end = app.indexOf('/** 按当前图解析链接', start);
  const c = { SOLO: '', Settings: { linksNewTab: () => newTab }, routeFeat: (...x) => calls.push(x), Tabs: { openNew: (...x) => calls.push(x) } };
  vm.runInNewContext(app.slice(start, end), c);
  c.openLinked('feat', 'a/Feat.md', '', 12);
  assert.deepEqual(calls[0], ['a/Feat.md', '', 12]);
  newTab = true;
  c.openLinked('feat', 'a/Feat.md', '', 12);
  assert.equal(calls[1][2].line, 12);
});

test('单来源跳转指定行，多来源复用来源选择列表', () => {
  const calls = [];
  const start = app.indexOf('function openIncomingFeat(');
  const end = app.indexOf('/** 弹出出链', start);
  const c = { incomingFeats: { n15: [{ path: 'a/Feat.md', line: 12 }] }, openLinked: (...x) => calls.push(x), pickFeat: (...x) => calls.push(x) };
  vm.runInNewContext(app.slice(start, end), c);
  c.openIncomingFeat({ id: 'n15' });
  assert.deepEqual(calls[0], ['feat', 'a/Feat.md', '', 12]);
  c.incomingFeats.n15.push({ path: 'a/Feat2.md', line: 6 });
  c.openIncomingFeat({ id: 'n15' });
  assert.equal(calls[1][0].length, 2);
  assert.equal(calls[1][4], true);
});
