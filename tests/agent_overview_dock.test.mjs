// 总览下方操作区：执行真实终端挂载、输出订阅与卡片归属逻辑；xterm 与 IPC 为最小替身，不启动 CLI。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const agent = readFileSync(new URL('../ui/agent.js', import.meta.url), 'utf8');
const overview = readFileSync(new URL('../ui/agent_overview.js', import.meta.url), 'utf8');
const section = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

/** 只模拟挂载需要的父子关系、隐藏状态与尺寸。 */
function node(id) {
  return {
    id, hidden: false, className: '', children: [], parentNode: null, clientWidth: 800, style: { setProperty() {} },
    appendChild(child) {
      if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
      this.children.push(child); child.parentNode = this; return child;
    },
    addEventListener() {},
  };
}

function setup() {
  const hosts = { '#terms': node('terms'), '#ovTerm': node('ovTerm'), '#pane': node('pane') };
  const created = [], calls = [], starts = [], handlers = {};
  class Terminal {
    constructor() { created.push(this); this.cols = 100; this.rows = 20; this.writes = []; this.scrolls = []; this.buffer = { active: { viewportY: 0, baseY: 0 } }; this.unicode = {}; this.options = {}; }
    loadAddon() {} open(el) { this.element = el; } onData(fn) { this.data = fn; } attachCustomKeyEventHandler(fn) { this.key = fn; }
    write(d) { this.writes.push(d); } focus() {} reset() {} dispose() {}
    scrollToLine(y) { this.scrolls.push(y); } scrollToBottom() { this.scrolls.push('bottom'); }
  }
  const sessions = new Map([['a', { id: 'a', running: true }], ['b', { id: 'b', running: false }]]);
  const c = vm.createContext({
    terms: new Map(), S: sessions, active: 'OV', Terminal, starts,
    FitAddon: { FitAddon: class { fit() {} } }, Unicode11Addon: { Unicode11Addon: class {} }, AgentImeAddon: class {},
    window: { TerminalThemes: { FONT: 'mono' } }, termTheme: () => ({ background: '#000' }),
    $: (s) => hosts[s], document: { createElement: () => node('term') },
    invoke: async (cmd, args) => { calls.push([cmd, args]); return cmd === 'agent_buffer' ? { data: '回放', seq: 3 } : undefined; },
    bindTerminalPaste() {}, startSession: (id) => starts.push(id), requestAnimationFrame() {},
    startingSessions: new Set(), startErrors: new Map(), vs: () => 'idle',
    listen: (name, fn) => { handlers[name] = fn; },
  });
  vm.runInContext(section(agent, 'function ensureTerm(', '// 同一会话启动请求未完成时')
    + section(agent, "listen('agent-output'", "listen('agent-reset'"), c);
  return { c, hosts, created, calls, starts, handlers };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('总览与会话页签之间移动同一个终端实例，不新建 xterm、不重复回放', async () => {
  const f = setup();
  const t = f.c.mountTerm('a', f.hosts['#ovTerm']);
  await tick();
  assert.equal(f.created.length, 1);
  assert.equal(t.el.parentNode, f.hosts['#ovTerm']);
  assert.equal(f.calls.filter(([cmd]) => cmd === 'agent_buffer').length, 1);
  const same = f.c.mountTerm('a', f.hosts['#terms']);
  assert.equal(same, t);
  assert.equal(t.el.parentNode, f.hosts['#terms']);
  assert.equal(f.hosts['#ovTerm'].children.length, 0);
  f.c.mountTerm('a', f.hosts['#ovTerm']);
  assert.equal(f.created.length, 1);
  assert.equal(f.calls.filter(([cmd]) => cmd === 'agent_buffer').length, 1, '移动容器不会重新取回放');
  assert.deepEqual(t.term.writes, ['回放']);
});

test('同一容器只显示所选终端，另一个容器中的终端不被隐藏', () => {
  const f = setup();
  const a = f.c.mountTerm('a', f.hosts['#terms']);
  const b = f.c.mountTerm('b', f.hosts['#ovTerm']);
  assert.equal(a.el.hidden, false, '页签中的终端不受总览挂载影响');
  assert.equal(b.el.hidden, false);
  f.c.mountTerm('b', f.hosts['#terms']);
  assert.equal(a.el.hidden, true);
  assert.equal(b.el.hidden, false);
});

test('换容器后恢复原滚动行；原本在底部的继续跟随最新输出', () => {
  const f = setup();
  const t = f.c.mountTerm('a', f.hosts['#terms']);
  Object.assign(t.term.buffer.active, { viewportY: 40, baseY: 100 });
  f.c.mountTerm('a', f.hosts['#ovTerm']);
  f.c.fitTerm('a');
  assert.deepEqual(t.term.scrolls, [40]);
  f.c.fitTerm('a');
  assert.deepEqual(t.term.scrolls, [40], '只恢复一次，不干扰之后的手动滚动');
  Object.assign(t.term.buffer.active, { viewportY: 100, baseY: 100 });
  f.c.mountTerm('a', f.hosts['#terms']);
  f.c.fitTerm('a');
  assert.deepEqual(t.term.scrolls, [40, 'bottom']);
});

test('输入沿用会话通道：运行中写入 PTY，Shift+Enter 发送换行，待命会话按 Enter 按需启动', () => {
  const f = setup();
  const a = f.c.mountTerm('a', f.hosts['#ovTerm']);
  a.term.data('未发送草稿');
  assert.equal(a.term.key({ type: 'keydown', shiftKey: true, key: 'Enter' }), false);
  a.term.data('\r');
  assert.deepEqual(f.calls.filter(([cmd]) => cmd === 'agent_write').map(([, args]) => args.data), ['未发送草稿', '\x1b\r', '\r']);
  const b = f.c.mountTerm('b', f.hosts['#ovTerm']);
  b.term.data('x');
  assert.deepEqual(f.starts, []);
  b.term.data('\r');
  assert.deepEqual(f.starts, ['b']);
});

test('输出按序号只写入一次，挂载位置变化不影响订阅', async () => {
  const f = setup();
  const t = f.c.mountTerm('a', f.hosts['#ovTerm']);
  await tick();
  const out = (data, seq) => f.handlers['agent-output']({ payload: { id: 'a', data, seq } });
  out('旧', 3);
  out('新', 4);
  f.c.mountTerm('a', f.hosts['#terms']);
  out('新', 4);
  out('页签期间', 5);
  f.c.mountTerm('a', f.hosts['#ovTerm']);
  assert.deepEqual(t.term.writes, ['回放', '新', '页签期间']);
});

test('卡片归属：会话对应自身，子代理归入父会话，流程图与 Feat 没有输入通道', () => {
  const exportLine = 'return { build, render, activity, init, invalidate };';
  assert.ok(overview.includes(exportLine));
  const c = vm.createContext({ window: {}, localStorage: { getItem: () => null } });
  vm.runInContext(overview.replace(exportLine, 'return { dockTarget };'), c);
  const { dockTarget } = c.window.AgentOverview;
  assert.equal(dockTarget({ kind: 'session', session: 's1' }), 's1');
  assert.equal(dockTarget({ kind: 'worker', session: 's1', worker: 'w' }), 's1');
  assert.equal(dockTarget({ kind: 'flow', path: 'a.drawio' }), '');
  assert.equal(dockTarget({ kind: 'feat', path: 'f.md' }), '');
  assert.equal(dockTarget(undefined), '');
});

/** 加载真实底栏显隐与挂载逻辑，用共享存储模拟关闭页面后重新打开。 */
function visibilityHarness(storage = new Map()) {
  const elements = Object.fromEntries(['#ov', '#ovTerm', '#terms', '.ov-dock', '.ov-split', '[data-dock-toggle]', '.dock-head', '.dock-empty'].map(selector => [selector, {
    ...node(selector), innerHTML: '', classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { this[name] = value; },
  }]));
  const terms = new Map(), created = [], fits = [], frames = [];
  const s = sessionForDock();
  const c = vm.createContext({
    window: {}, active: 'OV', S: new Map([[s.id, s]]), terms,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    $: selector => elements[selector] || null, list: () => [s], byUrgency: () => 0,
    startingSessions: new Set(), startErrors: new Map(), vs: () => 'idle', stText: () => '空闲', timeText: () => '', esc: String, bot: () => '', ICON: { tabOpen: '' },
    mountTerm(id, host) {
      if (!terms.has(id)) {
        const t = { el: { classList: { remove() {}, add() {} }, offsetWidth: 800 }, term: { focus() {} }, draft: '未发送草稿', scroll: 24 };
        terms.set(id, t); created.push(t);
      }
      const t = terms.get(id); t.el.parentNode = host; return t;
    },
    fitTerm: id => fits.push(id), requestAnimationFrame: fn => frames.push(fn),
  });
  vm.runInContext(overview.replace('return { build, render, activity, init, invalidate };', 'return { setDock, syncDock, setDockVisible, isVisible: () => dockVisible };'), c);
  return { api: c.window.AgentOverview, elements, terms, created, fits, storage, flush: () => { while (frames.length) frames.shift()(); } };
}

/** 提供显示中的最小真实会话字段，不启动 CLI。 */
function sessionForDock() { return { id: 'a', title: '模块 A', running: true, exit_code: null }; }

test('底栏隐藏不销毁终端或草稿，刷新仍隐藏，显示后恢复同一实例与尺寸', () => {
  const f = visibilityHarness();
  assert.equal(f.api.isVisible(), true);
  f.api.setDock('a', false);
  f.flush();
  const terminal = f.terms.get('a'), fitCount = f.fits.length;
  f.api.setDockVisible(false);
  f.api.syncDock();
  f.flush();
  assert.equal(f.elements['.ov-dock'].hidden, true);
  assert.equal(f.elements['.ov-split'].hidden, true);
  assert.equal(f.elements['[data-dock-toggle]'].textContent, '显示底栏');
  assert.equal(f.elements['[data-dock-toggle]']['aria-expanded'], 'false');
  assert.equal(f.fits.length, fitCount, '隐藏时不把 PTY 缩成零尺寸');
  f.api.setDockVisible(true);
  f.flush();
  assert.equal(f.elements['.ov-dock'].hidden, false);
  assert.equal(f.elements['.ov-split'].hidden, false);
  assert.equal(f.elements['[data-dock-toggle]'].textContent, '隐藏底栏');
  assert.equal(f.terms.get('a'), terminal);
  assert.equal(f.created.length, 1);
  assert.equal(terminal.draft, '未发送草稿');
  assert.equal(terminal.scroll, 24);
  assert.ok(f.fits.length > fitCount);
});

test('底栏显隐选择跨页面重建保留，隐藏时选 Agent 不挂载或唤起终端', () => {
  const storage = new Map(), first = visibilityHarness(storage);
  first.api.setDockVisible(false);
  const restored = visibilityHarness(storage);
  assert.equal(restored.api.isVisible(), false);
  restored.api.setDockVisible(restored.api.isVisible(), false);
  restored.api.setDock('a', true);
  assert.equal(restored.created.length, 0);
  assert.equal(restored.elements['.ov-dock'].hidden, true);
  restored.api.setDockVisible(true);
  const shown = visibilityHarness(storage);
  assert.equal(shown.api.isVisible(), true);
});
