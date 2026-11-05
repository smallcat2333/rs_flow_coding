// 操作提示回归：运行真实提示函数，验证区域归属、独立计时与关闭清理。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const feat = readFileSync(new URL('../ui/feat.js', import.meta.url), 'utf8');

/** 提供提示节点与可控计时器，只加载真实提示入口，不模拟业务实现。 */
function fixture() {
  const nodes = Object.fromEntries(['floating-status', 'flow-floating-status', 'feat-floating-status', 'side-msg', 'save-state', 'md-state'].map((id) => [id, {
    textContent: '', className: '', open: false,
    showPopover() { this.open = true; },
    hidePopover() { this.open = false; },
  }]));
  const timers = new Map();
  let nextTimer = 0;
  const context = {
    $: (id) => nodes[id],
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(app.slice(app.indexOf('const floatingStatusTimers'), app.indexOf('/** 简易输入对话框')), context);
  vm.runInNewContext(feat.slice(feat.indexOf('  function setState('), feat.indexOf('  /** 同步当前档案')), context);
  return { context, nodes, timers };
}

test('Feat复制、流程图复制与侧栏通知进入各自提示区域', () => {
  const { context: c, nodes } = fixture();
  c.setState('已复制档案绝对路径');
  assert.equal(nodes['feat-floating-status'].textContent, '已复制档案绝对路径');
  assert.equal(nodes['feat-floating-status'].open, true);
  assert.equal(nodes['flow-floating-status'].open, false);
  assert.equal(nodes['floating-status'].open, false);
  c.saveState('已复制流程图绝对路径');
  assert.equal(nodes['flow-floating-status'].textContent, '已复制流程图绝对路径');
  assert.equal(nodes['feat-floating-status'].open, true);
  c.sideMsg('扫描失败');
  assert.equal(nodes['floating-status'].textContent, '扫描失败');
  assert.equal(nodes['flow-floating-status'].open, true);
});

test('连续提示复用本区域计时器，不取消另一区域提示', () => {
  const { context: c, nodes, timers } = fixture();
  c.setState('已复制命令');
  c.saveState('已复制引用');
  const first = [...timers.keys()][0];
  c.setState('复制失败：权限不足', true);
  assert.equal(timers.has(first), false);
  assert.equal(timers.size, 2);
  assert.equal(nodes['feat-floating-status'].className, 'floating-status error');
  assert.equal(nodes['flow-floating-status'].className, 'floating-status success');
  assert.equal(nodes['flow-floating-status'].open, true);
  for (const { fn, delay } of [...timers.values()]) {
    assert.equal(delay, 6000);
    fn();
  }
  assert.equal(nodes['feat-floating-status'].open, false);
  assert.equal(nodes['flow-floating-status'].open, false);
});

test('切换或关闭内容时清除本区域提示，不影响另一区域', () => {
  const { context: c, nodes, timers } = fixture();
  c.setState('已复制档案绝对路径');
  c.saveState('已复制流程图绝对路径');
  c.setState('');
  assert.equal(nodes['feat-floating-status'].open, false);
  assert.equal(nodes['flow-floating-status'].open, true);
  assert.equal(timers.size, 1);
  c.saveState('');
  assert.equal(nodes['flow-floating-status'].open, false);
  assert.equal(timers.size, 0);
});
