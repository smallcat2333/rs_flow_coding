// 信息分组交互：实际事件处理器与内存存储，验证拖放/键盘排序、折叠及跨窗口恢复。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../ui/agent_info_layout.js', import.meta.url), 'utf8');
const KEY = 'fc-agent-info-groups';
const ids = ['run', 'usage', 'context', 'plan', 'links', 'workers', 'location'];

function setup(storage = new Map()) {
  const handlers = {}, windowHandlers = {}, messages = [];
  const classList = () => { const values = new Set(); return { add(...names) { names.forEach(n => values.add(n)); }, remove(...names) { names.forEach(n => values.delete(n)); }, contains: n => values.has(n) }; };
  const nodes = ids.map(id => ({ dataset: { amGroup: id }, open: true, classList: classList(), matches: selector => selector === '.am-group', getBoundingClientRect: () => ({ top: 20, height: 40 }) }));
  const byId = new Map(nodes.map(n => [n.dataset.amGroup, n]));
  for (const node of nodes) {
    Object.defineProperties(node, {
      previousElementSibling: { get: () => nodes[nodes.indexOf(node) - 1] || null },
      nextElementSibling: { get: () => nodes[nodes.indexOf(node) + 1] || null },
    });
    node.heading = { parentElement: node, focused: false, focus() { this.focused = true; }, closest(selector) {
      if (selector === '.am-group > summary') return this;
      return selector === '.am-group' ? node : null;
    } };
    node.closest = selector => selector === '.am-group' ? node : null;
  }
  const tooltip = { id: 'agentMetricTip', hidden: true, style: {}, getBoundingClientRect: () => ({ width: 200, height: 80 }) };
  const scroll = {
    querySelectorAll: () => nodes,
    append(node) { nodes.splice(nodes.indexOf(node), 1); nodes.push(node); },
    insertBefore(node, target) { nodes.splice(nodes.indexOf(node), 1); nodes.splice(target ? nodes.indexOf(target) : nodes.length, 0, node); },
  };
  const root = { querySelector: selector => selector === '.am-scroll' ? scroll : tooltip, addEventListener(name, fn) { handlers[name] = fn; } };
  const context = vm.createContext({
    window: { addEventListener(name, fn) { windowHandlers[name] = fn; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    innerWidth: 800, innerHeight: 600, toast: text => messages.push(text),
  });
  vm.runInContext(source, context);
  context.window.AgentInfoLayout.init(root);
  const event = (target, extra = {}) => ({ target, clientY: 21, preventDefault() { this.prevented = true; }, dataTransfer: { setData() {} }, ...extra });
  return { nodes, byId, handlers, windowHandlers, storage, messages, tooltip, event, order: () => nodes.map(n => n.dataset.amGroup) };
}

test('布局缺省或损坏时恢复默认，未知/重复分组忽略，缺少的分组补全', () => {
  assert.deepEqual(setup().order(), ids);
  assert.deepEqual(setup(new Map([[KEY, '{broken']])).order(), ids);
  const prefs = { order: ['location', 'usage', 'location', 'obsolete'], closed: ['plan', 'plan', 'obsolete'] };
  const f = setup(new Map([[KEY, JSON.stringify(prefs)]]));
  assert.deepEqual(f.order(), ['location', 'usage', 'run', 'context', 'plan', 'links', 'workers']);
  assert.equal(f.byId.get('plan').open, false);
  assert.equal(f.byId.get('usage').open, true);
});

test('拖放后立即保存顺序，重新打开时复用同一全局布局', () => {
  const f = setup(), location = f.byId.get('location'), usage = f.byId.get('usage');
  f.handlers.dragstart(f.event(location.heading));
  f.handlers.dragover(f.event(usage.heading));
  assert.equal(usage.classList.contains('am-drop-before'), true);
  f.handlers.drop(f.event(usage.heading));
  const expected = ['run', 'location', 'usage', 'context', 'plan', 'links', 'workers'];
  assert.deepEqual(f.order(), expected);
  assert.deepEqual(JSON.parse(f.storage.get(KEY)).order, expected);
  assert.equal(location.classList.contains('am-dragging'), false);
  assert.equal(usage.classList.contains('am-drop-before'), false);
  assert.deepEqual(setup(f.storage).order(), expected);
});

test('折叠状态保存到全局布局，跨窗口偏好变化同步顺序与折叠', () => {
  const f = setup(), plan = f.byId.get('plan');
  plan.open = false;
  f.handlers.toggle({ target: plan });
  assert.deepEqual(JSON.parse(f.storage.get(KEY)).closed, ['plan']);
  assert.equal(setup(f.storage).byId.get('plan').open, false);
  f.storage.set(KEY, JSON.stringify({ order: ['context', 'run'], closed: ['usage'] }));
  f.windowHandlers.storage({ key: KEY });
  assert.equal(f.order()[0], 'context');
  assert.equal(plan.open, true);
  assert.equal(f.byId.get('usage').open, false);
});

test('Alt方向键移动分组并保存，边界不越界，保留标题焦点', () => {
  const f = setup(), run = f.byId.get('run');
  f.handlers.keydown(f.event(run.heading, { altKey: true, key: 'ArrowUp' }));
  assert.deepEqual(f.order(), ids);
  f.handlers.keydown(f.event(run.heading, { altKey: true, key: 'ArrowDown' }));
  assert.deepEqual(f.order().slice(0, 3), ['usage', 'run', 'context']);
  assert.deepEqual(JSON.parse(f.storage.get(KEY)).order, f.order());
  assert.equal(run.heading.focused, true);
});

test('取消拖拽或外部拖入不改布局，掉落在分组下半部则插在其后', () => {
  const f = setup(), run = f.byId.get('run'), usage = f.byId.get('usage');
  f.handlers.drop(f.event(usage.heading));
  assert.equal(f.storage.has(KEY), false);
  f.handlers.dragstart(f.event(run.heading));
  f.handlers.dragover(f.event(usage.heading));
  f.handlers.dragend();
  assert.deepEqual(f.order(), ids);
  assert.equal(f.storage.has(KEY), false);
  f.handlers.dragstart(f.event(run.heading));
  f.handlers.dragover(f.event(usage.heading, { clientY: 59 }));
  f.handlers.drop(f.event(usage.heading));
  assert.deepEqual(f.order().slice(0, 2), ['usage', 'run']);
});

test('指标悬停或聚焦展示名称与口径，提示位置约束在窗口内，移开即隐藏', () => {
  const f = setup();
  const attrs = {};
  const stat = { dataset: { amTip: 'Token：3.1M\n累计输入与输出' },
    closest: selector => selector === '[data-am-tip]' ? stat : null,
    setAttribute: (key, value) => { attrs[key] = value; }, removeAttribute: key => { delete attrs[key]; },
    contains: () => false, getBoundingClientRect: () => ({ right: 100, top: 100, bottom: 120 }),
  };
  f.handlers.mouseover({ target: stat });
  assert.equal(f.tooltip.hidden, false);
  assert.match(f.tooltip.textContent, /Token：3.1M/);
  assert.equal(f.tooltip.style.left, '8px');
  assert.equal(attrs['aria-describedby'], 'agentMetricTip');
  f.handlers.mouseout({ relatedTarget: null });
  assert.equal(f.tooltip.hidden, true);
  assert.equal(attrs['aria-describedby'], undefined);
  f.handlers.focusin({ target: stat });
  assert.equal(f.tooltip.hidden, false);
  f.handlers.scroll();
  assert.equal(f.tooltip.hidden, true);
});
