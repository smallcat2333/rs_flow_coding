// 执行真实注释模块，验证全局开关独立保存、选点恢复及跨画布同步。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../ui/flow_notes.js', import.meta.url), 'utf8');

/** 最小 DOM：保留实际模块创建的节点和事件，供点击真实按钮及检查当前卡片使用。 */
class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.attrs = {}; this.events = {};
    this.className = ''; this.clientWidth = 1000; this.clientHeight = 700;
    this.classList = {
      add: (name) => { this.className += ' ' + name; },
      toggle: (name, on) => { this.className = this.className.split(' ').filter(x => x !== name).concat(on ? [name] : []).join(' '); },
    };
  }
  appendChild(node) { this.children.push(node); node.parent = this; return node; }
  replaceChildren() { this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(key, handler) { this.events[key] = handler; }
  getBoundingClientRect() { return { left: 40, top: 60, width: 380, height: 250 }; }
  querySelectorAll(selector) {
    return this.children.flatMap(c => [c, ...c.querySelectorAll(selector)]).filter(c =>
      selector.startsWith('.') ? c.className.split(' ').includes(selector.slice(1)) : selector === '[contenteditable="true"]' && c.contentEditable === 'true');
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
}

/** 两个可选节点与共享本机存储；每次 fixture 相当于新建画布或应用重启。 */
function fixture(storage = new Map(), selected = null) {
  const body = new Element(), windowEvents = {}, selection = {};
  const nodes = [{ id: 'n1', vertex: true, children: [] }, { id: 'n2', vertex: true, children: [] }];
  let current = selected === null ? null : nodes[selected];
  const model = {
    isVertex: c => !!c?.vertex, isEdge: () => false, getStyle: () => '', getParent: () => null,
    isVisible: () => true, contains: c => nodes.includes(c), getRoot: () => ({}), getDescendants: () => nodes,
    beginUpdate() {}, endUpdate() {},
  };
  const graph = {
    model, container: new Element(), view: {}, isEnabled: () => true, isCellEditable: () => true, isCellLocked: () => false,
    isCellFoldable() {}, isHtmlLabel: () => false, convertValueToString: c => c.id,
    refresh() {}, addListener() {}, getSelectionModel: () => ({ addListener: (_name, fn) => { selection.change = fn; } }),
    getSelectionCell: () => current,
  };
  const context = {
    window: { innerWidth: 1600, innerHeight: 1000, addEventListener: (name, fn) => { windowEvents[name] = fn; } },
    document: { head: new Element(), body, createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('text'), { textContent: text }), addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    ResizeObserver: class { observe() {} }, mxEvent: { CHANGE: 'change', FIRE_MOUSE_EVENT: 'mouse' },
  };
  vm.runInNewContext(source, context);
  const notes = context.window.installFlowNotes({ editor: { graph }, addListener() {}, menus: { createPopupMenu() {} } });
  return {
    notes, nodes, storage,
    panel: () => body.children.find(c => c.className.split(' ').includes('fc-notes')),
    select(index) { current = index === null ? null : nodes[index]; selection.change(); },
    anchor() { return body.querySelector('.fc-notes-anchor'); },
    storageEvent(key, value) { if (value === null) storage.delete(key); else storage.set(key, value); windowEvents.storage({ key, newValue: value }); },
    removeTarget(index) { nodes.splice(index, 1); notes.refresh(); },
  };
}

test('默认关闭；主动打开和固定后，新画布选点自动恢复两项状态', () => {
  const first = fixture();
  first.select(0);
  assert.equal(first.notes.isOpen(), false);
  first.notes.open(first.nodes[0]);
  first.anchor().onclick();
  assert.equal(first.storage.get('fc-notes-open'), '1');
  assert.equal(first.storage.get('fc-notes-anchored'), '1');
  const next = fixture(first.storage);
  assert.equal(next.notes.isOpen(), false);
  next.select(1);
  assert.equal(next.notes.isOpen(), true);
  const title = next.panel().children[0].children[0];
  assert.equal(title.textContent, 'n2');
  assert.equal(title.title, '节点注释 · n2\nn2');
  assert.equal(next.anchor().getAttribute('aria-pressed'), 'true');
});

test('主动关闭只保存关闭状态，固定偏好保留；重启和选点不自动再打开', () => {
  const first = fixture(new Map([['fc-notes-open', '1'], ['fc-notes-anchored', '1']]), 0);
  assert.equal(first.notes.isOpen(), true);
  first.notes.close();
  const next = fixture(first.storage, 1);
  assert.equal(next.notes.isOpen(), false);
  assert.equal(first.storage.get('fc-notes-open'), '0');
  assert.equal(first.storage.get('fc-notes-anchored'), '1');
  next.notes.open(next.nodes[1]);
  assert.equal(next.anchor().getAttribute('aria-pressed'), 'true');
  next.anchor().onclick();
  assert.equal(next.storage.get('fc-notes-anchored'), '0');
});

test('宿主失效临时隐藏不关闭全局开关，选择新宿主后恢复', () => {
  const f = fixture(new Map([['fc-notes-open', '1']]), 0);
  f.removeTarget(0);
  assert.equal(f.notes.isOpen(), false);
  assert.equal(f.storage.get('fc-notes-open'), '1');
  f.select(0);
  assert.equal(f.notes.isOpen(), true);
});

test('跨窗口开关与固定状态同步，不需要重新载入画布', () => {
  const f = fixture(undefined, 0);
  f.storageEvent('fc-notes-open', '1');
  assert.equal(f.notes.isOpen(), true);
  f.storageEvent('fc-notes-anchored', '1');
  assert.equal(f.anchor().getAttribute('aria-pressed'), 'true');
  f.storageEvent('fc-notes-open', '0');
  assert.equal(f.notes.isOpen(), false);
  f.select(1);
  assert.equal(f.notes.isOpen(), false);
});
