// Feat 正文滚轮切章与 R 记录小块：验证真实事件委托、边界与手势隔离。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/feat_board.js', import.meta.url), 'utf8');

const SAMPLE_MD = `
# Feat_261104_1 测试档案

> 状态：开发中
> 应用：app_test
> 创建：2026-11-04　　关闭：-

## 1. 需求
### 1.1 背景
测试背景说明

### 1.2 目标
测试目标说明

### 1.3 验收标准
- [ ] 验收项 1

### 1.4 初步路线
测试路线

## 2. 原型
### 2.1 界面总纲
界面总纲内容

### 2.2 控件清单
| 序号 | 控件 | 类型 |
| --- | --- | --- |
| 1 | btn | QPushButton |

## 3. 开发
### 3.1 路线图
- [x] T1 任务一
- [ ] T2 任务二

### 3.2 难点与关键决策
无

## 4. 测试
### 4.1 程序自测
- [ ] 自测项 1
`;

const WITH_TALKS = SAMPLE_MD.replace('## 1. 需求', `## 0. 探讨记录
### R1 2026-11-04
- 决策：拆分概览与探讨
- 依据：章节号对齐档案
- 待确认：核对侧栏

## 1. 需求`);

/** 构造最小 DOM 环境并初始化 FeatBoard，可传入探讨中或缺少第 0 章的档案。 */
function setupBoard(text = SAMPLE_MD) {
  let innerHtml = '';
  const located = [];
  const listeners = {};
  let clock = 1000;
  const mockBox = {
    hidden: false,
    scrollTop: 0,
    clientHeight: 300,
    scrollHeight: 1000,
    clientWidth: 800,
    contains: () => false,
    classList: { toggle: () => {} },
    addEventListener(type, cb) { (listeners[type] ||= []).push(cb); },
    get innerHTML() { return innerHtml; },
    set innerHTML(html) { innerHtml = html; },
    querySelector(sel) {
      const line = /^\.fb-page \[data-line="(\d+)"\]$/.exec(sel)?.[1];
      if (!line || !innerHtml.includes(`data-line="${line}"`)) return null;
      return {
        scrollIntoView() { located.push(Number(line)); },
        classList: { add() {}, remove() {} },
      };
    },
    querySelectorAll(sel) {
      return [];
    },
  };
  const mockNotices = { innerHTML: '' };
  const mockDoc = {
    getElementById(id) {
      if (id === 'feat-board') return mockBox;
      if (id === 'feat-notices') return mockNotices;
      return null;
    },
  };

  const context = {
    window: { addEventListener() {}, removeEventListener() {} },
    document: mockDoc,
    Sidebar: { featState() { return { tone: 'dev', label: '开发中' }; } },
    performance: { now: () => clock },
    getComputedStyle: el => ({ overflowY: el.overflowY || 'visible' }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
  };

  vm.runInNewContext(source, context);
  const fb = context.window.FeatBoard;
  fb.init({
    path: () => 'docs/feat/Feat_261104_1.md',
    id: () => 'Feat_261104_1',
    text: () => text,
    readOnly: () => false,
    nodes: () => [],
    openFlow() {},
    showDoc() {},
    notify() {},
  });

  fb.shown();

  return {
    fb,
    mockBox,
    located,
    document: mockDoc,
    get html() { return innerHtml; },
    wheel(deltaY, { gap = 200, target, ...rest } = {}) {
      clock += gap;
      let prevented = false;
      const main = { parentElement: mockBox, closest: selector => selector === '.fb-main' ? main : null };
      listeners.wheel?.forEach(cb => cb({ deltaY, deltaX: 0, target: target || main, preventDefault() { prevented = true; }, ...rest }));
      return prevented;
    },
    click(target) {
      const e = {
        target: {
          closest(sel) {
            return target.matches?.(sel) ? target : null;
          },
        },
      };
      listeners.click?.forEach((cb) => cb(e));
    },
  };
}

/** 通过真实事件委托切换页签，返回右侧内容，避免把侧栏中的记录名误当成页面内容。 */
function openTab(board, key) {
  board.click({ dataset: { tab: key }, matches: selector => selector === '[data-tab]' });
  return board.html.slice(board.html.indexOf('<div class="fb-page '));
}

test('探讨导航只展示 R 小块，完整标题留在提示中并保留待确认状态', () => {
  const text = WITH_TALKS.replace('## 1. 需求', '### R2 2026-11-05\n- 决策：确认布局\n\n### R3 2026-11-05\n- 待确认：确认滚动\n\n## 1. 需求');
  const nav = setupBoard(text).html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)[0];
  const chips = nav.match(/<div class="fb-tchips fb-rchips">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...chips.matchAll(/>(R\d+)<\/button>/g)].map(m => m[1]), ['R1', 'R2', 'R3']);
  assert.ok(chips.includes('title="R1 2026-11-04（待确认）"'));
  assert.ok(chips.includes('class="fb-tchip t-waiting"'));
  assert.ok(!nav.match(/<ol class="fb-toc">[\s\S]*?R1 2026-11-04/));
});

test('正文中间正常滚动，到底后向下切下一章并从顶部阅读', () => {
  const board = setupBoard();
  board.mockBox.scrollTop = 100;
  assert.equal(board.wheel(120), false);
  assert.ok(board.html.includes('tab-3'));
  board.mockBox.scrollTop = 700;
  assert.equal(board.wheel(120), true);
  assert.ok(board.html.includes('tab-4'));
  assert.equal(board.mockBox.scrollTop, 0);
});

test('顶部向上切上一章并落在该章末尾，概览与发布不循环', () => {
  const board = setupBoard();
  assert.equal(board.wheel(-120), true);
  assert.ok(board.html.includes('tab-2'));
  assert.equal(board.mockBox.scrollTop, 700);
  const first = board.html.match(/data-tab="([^"]+)"/)[1];
  openTab(board, first);
  assert.equal(board.wheel(-120), false);
  assert.ok(board.html.includes(`tab-${first}`));
  openTab(board, '5');
  board.mockBox.scrollTop = 700;
  assert.equal(board.wheel(120), false);
  assert.ok(board.html.includes('tab-5'));
});

test('连续滚轮手势只切一章，停顿后允许再次切章', () => {
  const board = setupBoard();
  board.mockBox.scrollTop = 700;
  board.wheel(120);
  board.mockBox.scrollTop = 700;
  assert.equal(board.wheel(90, { gap: 20 }), true);
  assert.ok(board.html.includes('tab-4'));
  board.wheel(90, { gap: 200 });
  assert.ok(board.html.includes('tab-5'));
});

test('侧栏、横向滚动、缩放手势与内部仍可滚动的区域不触发切章', () => {
  const board = setupBoard();
  board.mockBox.scrollTop = 700;
  assert.equal(board.wheel(120, { target: { closest: () => null } }), false);
  assert.equal(board.wheel(120, { deltaX: 180 }), false);
  assert.equal(board.wheel(120, { ctrlKey: true }), false);
  const inner = { scrollHeight: 600, clientHeight: 100, scrollTop: 0, overflowY: 'auto', parentElement: board.mockBox, closest: selector => selector === '.fb-main' ? inner : null };
  assert.equal(board.wheel(120, { target: inner }), false);
  assert.ok(board.html.includes('tab-3'));
});

test('输入控件获得焦点时不滚轮切章，避免打断未提交备注', () => {
  const board = setupBoard();
  board.mockBox.scrollTop = 700;
  board.mockBox.contains = () => true;
  board.document.activeElement = { matches: () => true };
  assert.equal(board.wheel(120), false);
  assert.ok(board.html.includes('tab-3'));
});
