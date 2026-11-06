// 执行真实时间线事件与预览队列，覆盖滚轮边界、松手前预览和异步读取的最新目标优先。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import * as scale from '../ui/timeline_scale.mjs';

const source = readFileSync(new URL('../ui/timeline.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  .replace("await import('./timeline_scale.mjs')", 'scale')
  .replace('  syncPath();\n})()', '  window.timelineTest = { tl, load, syncPath };\n  syncPath();\n})()');

/** 提供真实事件绑定所需的最小 DOM 与只读画布回执；可阻塞快照读取，重现快速连续拖动。 */
async function fixture({ read = async id => `snapshot-${id}`, count = 4 } = {}) {
  const elements = new Map(), calls = [], errors = [], listeners = new Map(), timers = new Set();
  const later = (callback, ms) => {
    const id = setTimeout(() => { timers.delete(id); callback(); }, ms);
    timers.add(id);
    return id;
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, clientWidth: 760, value: '', handlers: {},
      style: { setProperty() {} }, setAttribute() {}, prepend() {}, append() {}, appendChild() {},
      querySelector: name => element(name), querySelectorAll: () => [],
      addEventListener(name, callback) { this.handlers[name] = callback; },
    });
    return elements.get(id);
  };
  const rows = Array.from({ length: count }, (_, i) => ({ id: i + 1, ts: new Date(Date.now() - (count - i) * 3600000).toLocaleString('sv-SE'), source: 'user' }));
  element('tl-range').parentElement = element('track');
  const graph = { setEnabled(value) { calls.push(['enabled', value]); } };
  element('tl-frame').contentWindow = {
    fcBridge: { ui: { editor: { graph }, updateActionStates() {} } },
    postMessage(text) {
      const message = JSON.parse(text);
      calls.push(message);
      if (['load', 'merge'].includes(message.action)) queueMicrotask(() => c.window.timelineTest.tl.pending?.());
    },
  };
  const c = {
    scale, st: { cur: 'a.drawio' }, isDark: () => false, showIds: () => false,
    floatingStatus: text => errors.push(text), setTimeout: later, clearTimeout,
    document: { getElementById: element, createElement: () => element(Symbol()) },
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    window: { addEventListener() {}, __TAURI__: {
      event: { listen: (name, callback) => listeners.set(name, callback) },
      core: { async invoke(name, args) {
        if (name === 'history') return rows;
        if (name === 'snapshot_xml') { calls.push(['read', args.id]); return read(args.id); }
        if (name === 'diff') return [];
        throw new Error(`未模拟 ${name}`);
      } },
    } },
  };
  vm.runInNewContext(source, c);
  await delay(0);
  assert.deepEqual(errors, [], '时间线初始化失败');
  const { tl, load, syncPath } = c.window.timelineTest;
  tl.ready = Promise.resolve();
  return {
    tl, calls, errors, rows, load, syncPath, c, element,
    wheel(deltaY, modifiers = {}) {
      let prevented = false;
      element('flow-timeline').handlers.wheel({ deltaY, ...modifiers, preventDefault() { prevented = true; } });
      return prevented;
    },
    input(index) {
      element('tl-range').value = String(tl.rows[index].time);
      element('tl-range').handlers.input();
    },
    change() { element('tl-range').handlers.change(); },
    dispose() { timers.forEach(clearTimeout); },
  };
}

/** 等待真实预览队列完成，以期限约束异步回执失败，不依赖固定的载图时长。 */
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '时间线预览未在期限内完成');
    await delay(5);
  }
}

test('无快照时隐藏滑块圆点，有记录时显示并保留前段空白', async t => {
  for (const count of [0, 1, 4]) {
    const f = await fixture({ count });
    t.after(f.dispose);
    assert.equal(f.element('tl-range').hidden, count === 0);
    assert.equal(f.tl.domain.end - f.tl.domain.start, 14 * 86400000);
    assert.equal(f.tl.groups.length, count === 0 ? 0 : 1);
    assert.ok(f.tl.groups.every(group => group.x > f.tl.width * .9));
  }
});

test('滚轮逐份切换，最早版不越界，前进到最新版本退出只读预览', async t => {
  const f = await fixture();
  t.after(f.dispose);
  assert.equal(f.wheel(-120), true);
  assert.equal(f.tl.idx, 2);
  await until(() => !f.tl.busy);
  assert.equal(f.element('tl-view').hidden, false);
  assert.ok(f.calls.some(call => call.xml === 'snapshot-3'));
  f.wheel(-120); f.wheel(-120); f.wheel(-120);
  assert.equal(f.tl.idx, 0);
  await until(() => !f.tl.busy);
  f.wheel(120); f.wheel(120); f.wheel(120);
  assert.equal(f.tl.idx, 3);
  assert.equal(f.element('tl-view').hidden, true);
  assert.deepEqual(f.errors, []);
});

test('空历史、单份历史和缩放手势不消费滚轮', async t => {
  for (const count of [0, 1]) {
    const f = await fixture({ count });
    t.after(f.dispose);
    assert.equal(f.wheel(-120), false);
  }
  const f = await fixture();
  t.after(f.dispose);
  assert.equal(f.wheel(-120, { ctrlKey: true }), false);
  assert.equal(f.wheel(-120, { metaKey: true }), false);
  assert.equal(f.wheel(0), false);
  assert.equal(f.tl.idx, 3);
});

test('input 持续拖动期间即可载图，松手后预览仍停在选定版本', async t => {
  const f = await fixture();
  t.after(f.dispose);
  f.input(1);
  await until(() => f.calls.some(call => call.xml === 'snapshot-2') && !f.tl.busy);
  assert.equal(f.tl.dragging, true);
  assert.equal(f.element('tl-view').hidden, false);
  f.change();
  await until(() => !f.tl.busy);
  assert.equal(f.tl.dragging, false);
  assert.equal(f.tl.idx, 1);
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'enabled' && call[1] === false));
});

test('快速拖动合并目标；在途旧读取不覆盖最后选择', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture({ read: id => id === 2 ? blocked : Promise.resolve(`snapshot-${id}`) });
  t.after(f.dispose);
  f.input(1);
  await until(() => f.calls.some(call => Array.isArray(call) && call[0] === 'read' && call[1] === 2));
  f.input(0); f.input(2);
  await delay(100);
  release('snapshot-2');
  await until(() => f.calls.some(call => call.xml === 'snapshot-3') && !f.tl.busy);
  assert.equal(f.calls.some(call => call.xml === 'snapshot-2'), false);
  assert.equal(f.calls.some(call => call.xml === 'snapshot-1'), false);
  assert.equal(f.tl.idx, 2);
  assert.equal(f.tl.dragging, true);
  assert.deepEqual(f.errors, []);
});

test('拖至最新版本仍保持拖动态，历史刷新等松手后再应用', async t => {
  const f = await fixture();
  t.after(f.dispose);
  f.input(0);
  await until(() => f.calls.some(call => call.xml === 'snapshot-1') && !f.tl.busy);
  f.input(3);
  await until(() => f.element('tl-view').hidden);
  assert.equal(f.tl.dragging, true);
  await f.load();
  assert.equal(f.tl.refreshPending, true);
  f.change();
  await delay(0);
  assert.equal(f.tl.dragging, false);
  assert.equal(f.tl.refreshPending, false);
  assert.equal(f.tl.idx, 3);
});

test('方向键可打断拖动，Home、End 和 Escape 沿用原有预览行为', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const key = value => f.element('tl-range').handlers.keydown({ key: value, preventDefault() {}, stopPropagation() {} });
  f.input(0);
  key('ArrowRight');
  await until(() => f.calls.some(call => call.xml === 'snapshot-2') && !f.tl.busy);
  assert.equal(f.tl.idx, 1);
  assert.equal(f.tl.dragging, false);
  key('End');
  assert.equal(f.element('tl-view').hidden, true);
  key('Home');
  await until(() => f.calls.some(call => call.xml === 'snapshot-1') && !f.tl.busy);
  key('Escape');
  assert.equal(f.element('tl-view').hidden, true);
  assert.equal(f.tl.idx, 3);
});

test('松手前回到当前或切图，排队的旧历史不会重新出现', async t => {
  const f = await fixture();
  t.after(f.dispose);
  f.input(0);
  f.element('tl-now').onclick();
  await delay(100);
  assert.equal(f.calls.some(call => call.action === 'load'), false);
  assert.equal(f.element('tl-view').hidden, true);
  f.input(0);
  f.c.st.cur = 'b.drawio';
  f.syncPath();
  await delay(100);
  assert.equal(f.tl.path, 'b.drawio');
  assert.equal(f.calls.some(call => call.action === 'load'), false);
  assert.equal(f.element('tl-view').hidden, true);
});
