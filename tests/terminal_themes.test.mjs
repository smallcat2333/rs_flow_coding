// 默认主题、恢复原生、跨窗口切换及系统深浅色变化，不启动 CLI。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/terminal_themes.js', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../ui/agent.js', import.meta.url), 'utf8');
function setup() {
  const storage = new Map(), handlers = {}, system = {};
  const root = { dataset: { theme: 'dark' } }, style = {};
  const context = vm.createContext({
    // 实际页面由 agent_core.js 提供，storage 监听器同时处理跟随设置。
    FOLLOW_KEY: 'fc-agent-follow', follow: true,
    window: { addEventListener: (name, handler) => { handlers[name] = handler; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { documentElement: root },
    matchMedia: () => ({ matches: true, addEventListener: (name, handler) => { system[name] = handler; } }),
    $: () => ({ style: { setProperty: (key, value) => { style[key] = value; } } }),
    terms: new Map([['a', { term: { options: {}, buffer: '正在输入', scroll: 12 } }], ['b', { term: { options: {}, buffer: '另一个会话', scroll: 8 } }]]),
  });
  vm.runInContext(source, context);
  const start = agent.indexOf('function termTheme('), end = agent.indexOf('/** 创建会话终端', start);
  vm.runInContext(agent.slice(start, end), context);
  const eventsStart = agent.indexOf("window.addEventListener('storage'");
  const eventsEnd = agent.indexOf('// ---------------- 事件：左栏', eventsStart);
  vm.runInContext(agent.slice(eventsStart, eventsEnd), context);
  return { context, themes: context.window.TerminalThemes, storage, root, handlers, system, style };
}

test('无设置、未知主题均回退原生；返回独立调色板，切回原生不残留自定义颜色', () => {
  const { themes, storage } = setup();
  assert.equal(themes.current(), 'native');
  const original = themes.resolve();
  for (const { id } of themes.choices) {
    themes.save(id);
    assert.equal(themes.current(), id);
    const theme = themes.resolve();
    assert.ok(theme.background && theme.foreground && theme.cursor && theme.selectionBackground);
    assert.equal(Object.keys(theme).length, Object.keys(original).length);
    theme.red = '#000000';
    assert.notEqual(themes.resolve().red, '#000000');
  }
  themes.save('native');
  assert.deepEqual(themes.resolve(), original);
  storage.set(themes.KEY, 'removed-theme');
  assert.equal(themes.current(), 'native');
  assert.deepEqual(themes.resolve('removed-theme'), original);
});

test('原生跟随深浅色，自定义主题保持自身配色', () => {
  const { themes } = setup();
  assert.notEqual(themes.resolve('native', true).background, themes.resolve('native', false).background);
  for (const { id } of themes.choices.filter(theme => theme.id !== 'native')) {
    assert.deepEqual(themes.resolve(id, true), themes.resolve(id, false));
  }
  assert.equal(new Set(themes.choices.map(({ id }) => themes.resolve(id).background)).size, themes.choices.length);
});

test('主题事件更新所有已打开终端及边缘背景，不清空内容、不改变滚动位置', () => {
  const { themes, storage, handlers, context, style } = setup();
  const snapshots = [...context.terms.values()].map(({ term }) => ({ buffer: term.buffer, scroll: term.scroll }));
  themes.save('forest');
  handlers.storage({ key: themes.KEY });
  for (const { term } of context.terms.values()) assert.deepEqual(term.options.theme, themes.resolve('forest'));
  assert.equal(style['--t-bg'], themes.resolve('forest').background);
  storage.clear();
  handlers.storage({ key: null });
  for (const { term } of context.terms.values()) assert.deepEqual(term.options.theme, themes.resolve('native'));
  assert.deepEqual([...context.terms.values()].map(({ term }) => ({ buffer: term.buffer, scroll: term.scroll })), snapshots);
});

test('跟随系统时原生随系统变化，手动界面主题不被系统事件覆盖', () => {
  const { themes, storage, system, root, context } = setup();
  system.change({ matches: false });
  assert.equal(root.dataset.theme, 'light');
  for (const { term } of context.terms.values()) assert.deepEqual(term.options.theme, themes.resolve('native', false));
  storage.set('fc-theme', 'light');
  system.change({ matches: true });
  assert.equal(root.dataset.theme, 'light');
});
