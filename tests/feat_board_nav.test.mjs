// Feat 看板左侧导航回归：各阶段章节目录默认全部直接展开，无需点击某阶段才展开；点击任意章节跨阶段跳转。
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
  const mockBox = {
    hidden: false,
    scrollTop: 0,
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
    get html() { return innerHtml; },
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

test('概览无编号，0 为探讨 / Exp；R 目录与待确认角标归属第 0 章', () => {
  const nav = setupBoard(WITH_TALKS).html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)[0];
  const items = nav.split('<div class="fb-stage-item ');
  const overview = items.find(item => item.includes('data-tab="overview"'));
  const exp = items.find(item => item.includes('data-tab="0"'));
  assert.ok(overview && exp);
  assert.ok(overview.includes('概览'));
  assert.ok(overview.includes('/ Ovw'));
  assert.ok(!overview.includes('fb-stage-no'));
  assert.ok(!overview.includes('R1 2026-11-04'));
  assert.ok(!overview.includes('1 待确认'));
  assert.ok(exp.includes('fb-stage-no">0.'));
  assert.ok(exp.includes('探讨'));
  assert.ok(exp.includes('/ Exp'));
  assert.ok(exp.includes('R1 2026-11-04'));
  assert.ok(exp.includes('1 待确认'));
  assert.ok(nav.indexOf('data-tab="overview"') < nav.indexOf('data-tab="0"'));
  assert.ok(nav.indexOf('data-tab="0"') < nav.indexOf('data-tab="1"'));
});

test('概览保留阶段汇总，探讨页只展示第 0 章记录，两页独立切换', () => {
  const board = setupBoard(WITH_TALKS);
  const overview = openTab(board, 'overview');
  assert.ok(overview.includes('tab-overview'));
  assert.ok(overview.includes('阶段进度'));
  assert.ok(!overview.includes('R1 2026-11-04'));
  const exp = openTab(board, '0');
  assert.ok(exp.includes('tab-0'));
  assert.ok(exp.includes('探讨记录'));
  assert.ok(exp.includes('R1 2026-11-04'));
  assert.ok(!exp.includes('阶段进度'));
});

test('从概览点击 R 记录会进入探讨页并定位原行号', () => {
  const board = setupBoard(WITH_TALKS);
  openTab(board, 'overview');
  const line = WITH_TALKS.split('\n').indexOf('### R1 2026-11-04') + 1;
  board.click({ dataset: { jump: String(line), stage: '0' }, matches: selector => selector === '[data-jump]' });
  assert.ok(board.html.includes('tab-0'));
  assert.deepEqual(board.located, [line]);
});

test('探讨中但尚无第 0 章时展示探讨空态，原文定位也映射到第 0 章', () => {
  const empty = setupBoard(SAMPLE_MD.replace('> 状态：开发中', '> 状态：探讨中'));
  assert.ok(empty.html.includes('tab-0'));
  assert.ok(empty.html.includes('还没有探讨记录'));
  const board = setupBoard(WITH_TALKS);
  openTab(board, 'overview');
  board.fb.revealLine(WITH_TALKS.split('\n').indexOf('### R1 2026-11-04') + 1);
  assert.ok(board.html.includes('tab-0'));
});

test('左侧导航各阶段章节目录全部直接展开，不依赖当前选中的阶段', () => {
  const html = setupBoard().html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)[0];

  // 需求（1）、原型（2）、开发（3）、测试（4）的章节目录均直接渲染在 HTML 中
  assert.ok(html.includes('1.1 背景'), '应展开 1.1 背景');
  assert.ok(html.includes('1.2 目标'), '应展开 1.2 目标');
  assert.ok(html.includes('2.1 界面总纲'), '非激活阶段 2 的 2.1 界面总纲也应直接展开');
  assert.ok(html.includes('2.2 控件清单'), '非激活阶段 2 的 2.2 控件清单也应直接展开');
  assert.ok(html.includes('3.1 路线图'), '非激活阶段 3 的 3.1 路线图也应直接展开');
  assert.ok(html.includes('4.1 程序自测'), '非激活阶段 4 的 4.1 程序自测也应直接展开');

  // 各章节按钮带有 data-stage 标识所属阶段
  assert.ok(html.includes('data-stage="1"'), '需求章节包含 data-stage="1"');
  assert.ok(html.includes('data-stage="2"'), '原型章节包含 data-stage="2"');
  assert.ok(html.includes('data-stage="3"'), '开发章节包含 data-stage="3"');
  assert.ok(html.includes('data-stage="4"'), '测试章节包含 data-stage="4"');
});

test('点击非激活阶段的子章节可跨阶段跳转并定位目标卡片', () => {
  const { mockBox, click, located } = setupBoard();
  const targetLine = SAMPLE_MD.split('\n').indexOf('### 2.1 界面总纲') + 1;

  // 当前激活页签是当前阶段（初始为 '3' 开发中，因为 SAMPLE_MD 状态是开发中）
  assert.ok(mockBox.innerHTML.includes('tab-3'), '初始渲染在开发阶段 tab-3');

  // 点击未激活的原型章节，定位必须命中新页面中由真实行号生成的卡片。
  click({
    dataset: { jump: String(targetLine), stage: '2' },
    matches(sel) { return sel === '[data-jump]'; },
  });

  // 应切换到原型阶段 tab-2
  assert.ok(mockBox.innerHTML.includes('tab-2'), '点击 2.1 后应自动切到原型阶段 tab-2');
  assert.deepEqual(located, [targetLine], '切换后应滚动到目标章节卡片');
});
