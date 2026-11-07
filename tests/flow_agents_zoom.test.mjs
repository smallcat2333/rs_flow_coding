// 执行真实坐标投影与缩放监听，验证同一任务内跟随，不等待 lazyZoom 提交。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/flow_agents.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function setup(modelCoordinates = true) {
  const states = {
    rect: { x: 200, y: 300, width: 120, height: 80, style: {} },
    diamond: { x: 400, y: 500, width: 100, height: 60, style: { shape: 'rhombus' } },
  };
  const element = (node, type) => ({
    dataset: { node }, style: {},
    classList: { contains: name => name === type },
  });
  const elements = [element('rect', 'fca-dock'), element('diamond', 'fca-dock'),
    element('rect', 'fca-glow'), element('diamond', 'fca-ripple')];
  const pane = { style: { transform: '', transformOrigin: '' } };
  const listeners = new Map(), microtasks = [];
  const graph = {
    model: { getCell: id => id in states ? { id } : null, getStyle: () => '' },
    view: { modelCoordinates, getCanvas: () => pane, getDrawPane: () => pane,
      getState: cell => states[cell.id] },
    addListener: (name, callback) => listeners.set(name, callback),
  };
  const layer = { querySelectorAll: () => elements };
  const context = vm.createContext({ graph, layer, zoomPreview: null, queueMicrotask: cb => microtasks.push(cb) });
  vm.runInContext(section('  function bounds(id)', '  /** 重画机器人')
    + section('    var previewPending =', '    graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE'), context);
  return {
    states, elements, pane, context, microtasks,
    fire: name => listeners.get(name)(),
    flush: () => { while (microtasks.length) microtasks.shift()(); },
  };
}
const value = (el, name) => parseFloat(el.style[name]);

test('预览开始同一任务内同步矩形、菱形、发光和涟漪，字号与内容不缩放', () => {
  for (const modelCoordinates of [true, false]) {
    const s = setup(modelCoordinates);
    s.pane.style = { transform: 'scale(1.5)', transformOrigin: '100px 200px' };
    s.fire('zoomPreview');
    assert.equal(s.microtasks.length, 1);
    s.flush();
    const [rect, diamond, glow, ripple] = s.elements;
    assert.equal(value(rect, 'left'), 430);
    assert.equal(value(rect, 'top'), 350);
    assert.equal(value(diamond, 'left'), 664);
    assert.equal(value(diamond, 'top'), 668);
    assert.deepEqual(glow.style, { left: '246px', top: '346px', width: '188px', height: '128px' });
    assert.deepEqual(ripple.style, { left: '546px', top: '646px', width: '158px', height: '98px' });
    assert.equal(rect.style.transform, undefined);
    assert.equal(rect.style.fontSize, undefined);
    assert.equal(s.microtasks.length, 0, '空闲无持续轮询');
  }
});

test('同任务多次缩放合并一次，并读取 draw.io 在事件之后修正的最终原点', () => {
  const s = setup();
  s.pane.style = { transform: 'scale(1.1)', transformOrigin: '100px 200px' };
  s.fire('zoomPreview');
  s.pane.style = { transform: 'scale(1.5)', transformOrigin: '140px 260px' };
  s.fire('zoomPreview');
  assert.equal(s.microtasks.length, 1);
  s.pane.style.transformOrigin = '160px 280px';
  s.flush();
  assert.equal(value(s.elements[0], 'left'), 400);
  assert.equal(value(s.elements[0], 'top'), 310);
});

test('缩放提交后使用新节点坐标，移除预览投影，节点原始状态从不被改写', () => {
  const s = setup();
  s.pane.style = { transform: 'scale(1.5)', transformOrigin: '100px 200px' };
  const before = structuredClone(s.states);
  s.fire('zoomPreview'); s.flush();
  assert.deepEqual(s.states, before);
  Object.assign(s.states.rect, { x: 250, y: 350, width: 180, height: 120 });
  s.pane.style = { transform: '', transformOrigin: '' };
  s.fire('zoomPreviewComplete'); s.flush();
  assert.equal(s.context.zoomPreview, null);
  assert.equal(value(s.elements[0], 'left'), 430);
  assert.equal(value(s.elements[0], 'top'), 350);
  assert.equal(value(s.elements[2], 'width'), 188);
});

test('连续任务中的每个缩放步骤都同步，预览中新增标记读取同一投影', () => {
  const s = setup();
  for (const factor of [1.1, 1.3, .7]) {
    s.pane.style = { transform: `scale(${factor})`, transformOrigin: '100px 200px' };
    s.fire('zoomPreview'); s.flush();
    assert.ok(Math.abs(value(s.elements[0], 'left') - (100 + 220 * factor)) < .1);
    const bounds = s.context.bounds('rect');
    assert.equal(bounds.w, 120 * factor);
    assert.equal(bounds.y, 200 + 100 * factor);
  }
  assert.equal(s.context.bounds('missing'), null);
});
