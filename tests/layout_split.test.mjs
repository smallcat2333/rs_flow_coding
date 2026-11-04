// 主区布局回归：实际打开的内容与保留空位分开计数，独立窗口不受强制拆分影响。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/layout.js', import.meta.url), 'utf8');

/** 为真实 layout.js 提供最小 DOM，返回布局接口、元素与可切换的本机偏好。 */
function fixture({ force = false, solo = '', mode = 'row' } = {}) {
  const flags = { force };
  const nodes = {};
  /** 构造布局使用的元素接口；保留隐藏、网格与按钮状态供行为断言。 */
  function element() {
    return {
      hidden: false, style: {}, dataset: {},
      // 这些测试只检查布局结果，不模拟样式渲染。
      classList: { toggle() {} },
      // 布局按钮状态与栏头分别存放，不把控件是否存在作为被测逻辑。
      setAttribute() {},
      querySelector(selector) { return selector === '.pane-bar' ? this.bar : this.button; },
    };
  }
  for (const id of ['panes', 'flow-pane', 'feat-pane', 'feat-body', 'split-a', 'empty', 'feat-empty']) {
    nodes[id] = element();
    nodes[id].bar = element();
    nodes[id].button = element();
  }
  nodes['feat-pane'].hidden = true;
  const context = {
    window: {}, URLSearchParams, location: { search: solo ? '?solo=' + solo : '' },
    // 配置输入只有本测试所需的布局字段，其余由生产代码的默认值填充。
    localStorage: { getItem() { return JSON.stringify({ mode }); } },
    Settings: { forceSplit() { return flags.force; } },
    document: {
      getElementById(id) { return nodes[id]; },
      querySelectorAll() { return []; },
    },
  };
  vm.runInNewContext(source, context);
  return { split: context.window.Split, nodes, flags };
}

// 初次只开 Feat 时，首页流程图占位不应挤占正文。
test('单独打开 Feat 默认占满主区', () => {
  const { split, nodes } = fixture();
  split.layout();
  split.show('feat');
  assert.equal(nodes['flow-pane'].hidden, true);
  assert.equal(nodes['feat-pane'].hidden, false);
  assert.equal(nodes.panes.style.gridTemplateColumns, 'minmax(0, 1fr)');
  assert.equal(split.isOpen('flow'), false);
});

// 最后一张图关闭后，即使保留首页提示，也不能把它视作实际打开的图。
test('关闭最后一张图再打开 Feat 不留下空白图栏', () => {
  const { split, nodes } = fixture();
  split.show('flow');
  split.hide('flow');
  assert.equal(nodes['flow-pane'].hidden, false);
  assert.equal(split.isOpen('flow'), false);
  split.show('feat');
  assert.equal(nodes['flow-pane'].hidden, true);
});

// 开关必须只改变可见空位，不改变实际文件的打开状态。
test('强制拆分保留对侧空位且可立即关闭', () => {
  const { split, nodes, flags } = fixture({ force: true });
  split.show('feat');
  assert.equal(nodes['flow-pane'].hidden, false);
  assert.equal(nodes['feat-pane'].hidden, false);
  assert.equal(nodes['split-a'].hidden, false);
  assert.equal(split.isOpen('flow'), false);
  flags.force = false;
  split.layout();
  assert.equal(nodes['flow-pane'].hidden, true);
  assert.equal(nodes['split-a'].hidden, true);
});

// 只开图时的预留 Feat 不得露出上次编辑的正文或标题。
test('图单独打开时，强制拆分的 Feat 空位不显示旧内容', () => {
  const { split, nodes } = fixture({ force: true });
  split.show('feat');
  split.show('flow');
  split.hide('feat');
  assert.equal(nodes['feat-pane'].hidden, false);
  assert.equal(nodes['feat-pane'].bar.hidden, true);
  assert.equal(nodes['feat-body'].hidden, true);
  assert.equal(split.isOpen('feat'), false);
});

// 反复打开和关闭两类内容时，占位与栏头必须互斥，不能覆盖编辑器或露出旧工具。
test('两侧空态随真实打开状态切换，关闭后恢复引导', () => {
  const { split, nodes } = fixture({ force: true });
  split.layout();
  assert.equal(nodes.empty.hidden, false);
  assert.equal(nodes['feat-empty'].hidden, false);
  for (const [kind, empty] of [['flow', 'empty'], ['feat', 'feat-empty']]) {
    split.show(kind);
    assert.equal(nodes[empty].hidden, true);
    assert.equal(nodes[kind + '-pane'].bar.hidden, false);
    split.hide(kind);
    assert.equal(nodes[empty].hidden, false);
    assert.equal(nodes[kind + '-pane'].bar.hidden, true);
  }
});

// 上下布局同样使用两条轨道，关闭强制拆分后归为一栏。
test('上下排布遵循强制拆分设置', () => {
  const { split, nodes } = fixture({ force: true, mode: 'col' });
  split.show('flow');
  assert.match(nodes.panes.style.gridTemplateRows, /5px/);
  assert.equal(nodes.panes.style.gridTemplateColumns, 'minmax(0, 1fr)');
});

// 主窗口的强制拆分偏好不能使独立 Feat 窗口出现流程图区。
test('独立窗口始终仅显示所属内容', () => {
  const { split, nodes } = fixture({ force: true, solo: 'feat' });
  split.show('feat');
  assert.equal(nodes['flow-pane'].hidden, true);
  assert.equal(nodes['feat-pane'].hidden, false);
  assert.equal(nodes['split-a'].hidden, true);
});
