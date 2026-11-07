// 验证真实 addon 的边界、结束恢复和资源释放；DOM 尺寸由固定几何夹具提供。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/agent_ime.js', import.meta.url), 'utf8');
function setup() {
  const style = initial => {
    const values = new Map(Object.entries(initial));
    return {
      getPropertyValue: name => values.get(name) || '',
      getPropertyPriority: () => '',
      setProperty: (name, value) => values.set(name, value),
      removeProperty: name => values.delete(name),
      get left() { return values.get('left') || ''; },
    };
  };
  let active = true, width = 800, natural = 100;
  const screen = { getBoundingClientRect: () => ({ width }) };
  const view = {
    style: style({ left: '780px' }),
    classList: { contains: () => active },
    get scrollWidth() { return Math.ceil(natural); },
    getBoundingClientRect: () => ({ width: Math.min(natural, parseFloat(view.style.getPropertyValue('max-width')) || natural) }),
    scrollLeft: 0,
  };
  const events = new Map(), subscriptions = new Map();
  const textarea = {
    value: '中文原始输入', style: style({ left: '780px', width: '100px' }),
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name),
  };
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const subscribe = name => callback => {
    subscriptions.set(name, callback);
    return { dispose: () => subscriptions.delete(name) };
  };
  const term = {
    element: { querySelector: selector => selector === '.xterm-screen' ? screen : view },
    textarea, onRender: subscribe('render'), onResize: subscribe('resize'),
  };
  const window = {};
  vm.runInNewContext(source, { window, MutationObserver: Observer, ResizeObserver: Observer });
  const addon = new window.AgentImeAddon();
  addon.activate(term);
  return {
    addon, view, textarea, events, observers, subscriptions,
    sync: () => events.get('compositionupdate')(),
    active: value => { active = value; },
    size: value => { width = value; },
    natural: value => { natural = value; },
  };
}
const css = (element, name) => element.style.getPropertyValue(name);

test('行尾预编辑和候选锚点一起左移，普通位置保持原锚点，内容不变', () => {
  const s = setup();
  s.sync();
  assert.equal(css(s.view, 'transform'), 'translateX(-80px)');
  assert.equal(css(s.textarea, 'transform'), 'translateX(-80px)');
  assert.equal(css(s.textarea, 'max-width'), '100px');
  s.view.style.setProperty('left', '200px');
  s.textarea.style.setProperty('left', '200px');
  s.observers[0].callback(); // xterm 重绘覆盖原始 left 后仍保持正常锚点
  assert.equal(css(s.view, 'transform'), 'translateX(0px)');
  assert.equal(s.textarea.value, '中文原始输入');
});

test('超长组合串约束整行宽度，缩窄和隐藏页签恢复时重新计算', () => {
  const s = setup();
  s.natural(1200);
  s.sync();
  assert.equal(css(s.view, 'max-width'), '800px');
  assert.equal(css(s.view, 'transform'), 'translateX(-780px)');
  assert.equal(s.view.scrollLeft, 1200);
  s.size(0); s.observers[1].callback();
  assert.equal(css(s.view, 'max-width'), '800px', '隐藏终端不按 0 宽度布局');
  s.size(360); s.observers[1].callback();
  assert.equal(css(s.view, 'max-width'), '360px');
  assert.equal(css(s.textarea, 'max-width'), '360px');
});

test('提交、取消或 xterm 移除 active 后清理适配样式，不改 xterm 位置', () => {
  const s = setup();
  for (const end of ['compositionend', 'mutation']) {
    s.active(true); s.sync();
    s.active(false);
    if (end === 'mutation') s.observers[0].callback();
    else s.events.get(end)();
    assert.equal(css(s.view, 'transform'), '');
    assert.equal(css(s.view, 'max-width'), '');
    assert.equal(css(s.view, 'overflow'), '');
    assert.equal(css(s.view, 'white-space'), '');
    assert.equal(css(s.textarea, 'transform'), '');
    assert.equal(css(s.textarea, 'max-width'), '');
    assert.equal(css(s.view, 'left'), '780px');
    assert.equal(css(s.textarea, 'width'), '100px');
  }
});

test('终端销毁时解除事件、观察器和订阅并恢复布局', () => {
  const s = setup();
  s.sync(); s.addon.dispose();
  assert.equal(s.events.size, 0);
  assert.equal(s.subscriptions.size, 0);
  assert.ok(s.observers.every(observer => !observer.connected));
  assert.equal(css(s.view, 'transform'), '');
  assert.equal(css(s.textarea, 'transform'), '');
});
