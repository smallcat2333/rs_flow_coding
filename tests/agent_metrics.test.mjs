// 会话信息侧栏：执行真实展示和布局逻辑；不启动 CLI，不修改用户任务目录。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../ui/agent_metrics.js', import.meta.url), 'utf8');

/** 提供固定控件、宽度及事件入口，核对显示数据和收起行为，不模拟 CSS 排版。 */
function setup(width = 1000) {
  const elements = new Map(), observers = [], flags = new Set();
  let focused = null;
  const element = () => ({
    hidden: false, innerHTML: '', attrs: {}, handlers: {},
    addEventListener(name, fn) { this.handlers[name] = fn; },
    setAttribute(name, value) { this.attrs[name] = value; },
    focus() { focused = this; },
  });
  const location = { open: true };
  const root = { ...element(), querySelectorAll: () => [location],
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); } };
  const body = { ...element(), clientWidth: width, classList: { toggle(name, on) { if (on) flags.add(name); else flags.delete(name); } } };
  const toggle = element();
  const ids = { agentMetrics: root, sessionBody: body, agentInfoToggle: toggle };
  const c = vm.createContext({
    window: { AgentInfoLayout: { init() { return { hideTip() {} }; } } }, document: { getElementById: id => ids[id] },
    ResizeObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    now: () => 9000, clock: ms => String(Math.max(0, ms)), ago: ms => String(ms),
    esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  });
  vm.runInContext(source, c);
  return { api: c.window.AgentMetrics, root, body, toggle, elements, flags, location,
    resize(value) { body.clientWidth = value; observers.forEach(fn => fn()); },
    focused: () => focused,
  };
}
const session = (extra = {}) => ({ id: 'one', running: true, status: 'idle', tool: '', turn: 0, done: 0, beat: 1000, since: 1000, workers: [], metrics: null, plan: null, ...extra });
const metrics = { input_tokens: 20000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 51000, used_tokens: 76000, capacity: 200000, used_percentage: 38 };

test('API 错误优先于旧工具和压缩状态，原因保留在状态提示中', () => {
  const { api, elements } = setup();
  const s = session({ status: 'apierr', api_error: 'Connection refused · Retrying in 13s · attempt 6/10', tool: 'Bash', compacting: true });
  assert.equal(api.describe(s).phase, 'API 错误');
  api.init(() => {}); api.render(s);
  assert.equal(elements.get('[data-am="phase"]').title, s.api_error);
  api.render(session({ status: 'run', beat: 9000 }));
  assert.equal(elements.get('[data-am="phase"]').title, '');
});

test('已中断优先于旧工具显示，耗时冻结且不显示已完成', () => {
  const { api } = setup();
  const s = session({ status: 'interrupted', tool: 'Bash', turn: 1000, since: 5000, done: 0 });
  assert.equal(api.describe(s, 9000).phase, '已中断');
  assert.equal(api.describe(s, 9000).duration, '4000');
  assert.equal(api.describe(s, 19000).duration, '4000');
  assert.equal(api.describe({ ...s, status: 'run', tool: '', turn: 10000 }, 19000).duration, '9000');
});

// 所有未知值保持未知，避免将旧会话或未上报分项绘制成零占用。
test('未上报上下文保持未知，不显示虚假零占用或猜测模型', () => {
  const { api } = setup();
  const d = api.describe(session());
  assert.equal(d.contextKnown, false); assert.equal(d.percentage, null);
  assert.equal(d.model, '模型待获取'); assert.equal(d.effort, '未上报');
});

test('上下文占比与容量来自同一快照，模型与推理档位分开显示', () => {
  const { api } = setup();
  const d = api.describe(session({ metrics: { ...metrics, model_id: 'model-id', model_name: '模型名称', effort: 'high' } }));
  assert.equal(d.model, '模型名称'); assert.equal(d.modelId, 'model-id'); assert.equal(d.effort, 'high');
  assert.equal(d.contextKnown, true); assert.equal(d.percentage, 38);
  assert.equal(d.used, '76,000'); assert.equal(d.capacity, '200,000');
});

test('堆叠分项使用原始 token 数，微小分项不放大且零值不占宽', () => {
  const { api, elements } = setup();
  const s = session({ metrics });
  const d = api.describe(s);
  assert.deepEqual(Array.from(d.contextParts, p => p.count), [20000, 5000, 51000, 124000]);
  assert.deepEqual(Array.from(d.contextParts, p => p.pct), [10, 2.5, 25.5, 62]);
  assert.equal(d.contextParts.reduce((sum, p) => sum + p.count, 0), 200000);
  assert.equal(d.usedCompact, '76k'); assert.equal(d.capacityCompact, '200k');
  api.init(() => {}); api.render(s);
  const panel = elements.get('[data-am="contextDetail"]');
  assert.match(panel.innerHTML, /flex-grow:5000/);
  assert.match(panel.innerHTML, /上下文用量明细/);
  api.render(session({ metrics: { ...metrics, input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, used_tokens: 1, used_percentage: 0.0005 } }));
  assert.match(panel.innerHTML, /flex-grow:1"/);
  assert.doesNotMatch(panel.innerHTML, /class="am-bar-seg seg-creation"/);
});

test('缺失分项保持未知，真实零输入显示全部剩余', () => {
  const { api } = setup();
  const m = { used_tokens: 76000, capacity: 200000, used_percentage: 38 };
  assert.equal(api.describe(session({ metrics: m })).contextKnown, false);
  assert.equal(api.describe(session({ metrics: m })).contextParts.length, 0);
  const d = api.describe(session({ metrics: { ...m, input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, used_tokens: 0, used_percentage: 0 } }));
  assert.equal(d.contextKnown, true); assert.equal(d.percentage, 0);
  assert.deepEqual(Array.from(d.contextParts, p => p.count), [0, 0, 0, 200000]);
});

test('相同上下文刷新不重建卡片，更新用量时才重画', () => {
  const { api, elements } = setup();
  const s = session({ metrics });
  api.init(() => {}); api.render(s);
  const panel = elements.get('[data-am="contextDetail"]');
  let writes = 0;
  Object.defineProperty(panel, 'innerHTML', { set() { writes++; } });
  api.render({ ...s, metrics: { ...metrics, updated_at: 7000 } });
  assert.equal(writes, 0);
  api.render({ ...s, metrics: { ...metrics, input_tokens: 30000, used_tokens: 86000, used_percentage: 43 } });
  assert.equal(writes, 1);
});

test('本轮完成后计时冻结，新一轮、等待权限和压缩状态分别展示', () => {
  const { api } = setup();
  let s = session({ turn: 1000, done: 5000 });
  assert.equal(api.describe(s, 9000).duration, '4000');
  assert.equal(api.describe(s, 19000).duration, '4000');
  assert.equal(api.describe(s).phase, '已完成');
  s = { ...s, status: 'run', turn: 6000 };
  assert.equal(api.describe(s, 9000).duration, '3000');
  assert.equal(api.describe({ ...s, tool: 'Bash' }).phase, '执行 Bash');
  assert.equal(api.describe({ ...s, status: 'wait', tool: 'Bash' }).phase, '等待确认');
  assert.equal(api.describe({ ...s, compacting: true }).phase, '压缩上下文');
  assert.equal(api.describe({ ...s, running: false, since: 8000 }, 19000).duration, '2000');
});

test('子代理显示实际记录与各自耗时，结束后不再增长', () => {
  const { api } = setup();
  const s = session({ workers: [{ id: 'a', desc: '检查实现', running: true, t0: 2000, t1: 0 }, { id: 'b', desc: '检查测试', running: false, t0: 1000, t1: 4000 }] });
  const d = api.describe(s, 9000);
  assert.equal(d.runningWorkers, 1); assert.equal(d.workers[0].duration, '7000'); assert.equal(d.workers[1].duration, '3000');
  assert.equal(api.describe(s, 19000).workers[1].duration, '3000');
  assert.equal(api.describe({ ...s, running: false, since: 10000 }).runningWorkers, 0);
});

test('实际目录与分支使用同次状态行数据，不拿启动目录充当当前目录', () => {
  const { api, elements } = setup();
  const s = session({ cwd: 'E:/启动目录', metrics: { current_dir: 'E:/实际目录/项目', git_branch: 'feature/中文分支' } });
  assert.equal(api.describe(s).currentDir, 'E:/实际目录/项目');
  assert.equal(api.describe(s).gitBranch, 'feature/中文分支');
  api.init(() => {}); api.render(s);
  assert.equal(elements.get('[data-am="currentDir"]').textContent, 'E:/实际目录/项目');
  assert.equal(elements.get('[data-am="gitBranch"]').textContent, 'feature/中文分支');
  api.render(session({ cwd: 'E:/启动目录' }));
  assert.equal(elements.get('[data-am="currentDir"]').textContent, '待获取');
  assert.equal(elements.get('[data-am="gitBranch"]').textContent, '未获取');
});

test('宽屏开关不重建侧栏，切换会话保留收起偏好，总览隐藏侧栏与入口', () => {
  const { api, root, toggle, elements, location } = setup();
  api.init(() => {}); const structure = root.innerHTML;
  api.render(session());
  assert.equal(root.hidden, false); assert.equal(toggle.hidden, false);
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  location.open = false;
  toggle.handlers.click();
  assert.equal(root.hidden, true);
  api.render(session({ id: 'two' }));
  assert.equal(root.hidden, true); assert.equal(root.innerHTML, structure);
  assert.equal(location.open, false);
  toggle.handlers.click();
  assert.equal(root.hidden, false);
  elements.get('[data-am="close"]').handlers.click();
  assert.equal(root.hidden, true);
  api.render(null);
  assert.equal(root.hidden, true); assert.equal(toggle.hidden, true);
});

test('窄窗口默认收起，手动以覆盖栏打开，变窄不会挤压终端', () => {
  const f = setup(700);
  f.api.init(() => {}); f.api.render(session());
  assert.equal(f.root.hidden, true); assert.equal(f.toggle.hidden, false);
  assert.equal(f.flags.has('info-narrow'), true);
  f.toggle.handlers.click();
  assert.equal(f.root.hidden, false);
  f.elements.get('[data-am="close"]').handlers.click();
  assert.equal(f.root.hidden, true); assert.equal(f.focused(), f.toggle);
  f.resize(1000);
  assert.equal(f.flags.has('info-narrow'), false); assert.equal(f.root.hidden, false);
  f.resize(700);
  assert.equal(f.root.hidden, true);
});

test('计划卡只同步 CLI 状态、计数与进行中文案，上一轮计划保留提示', () => {
  const { api, elements } = setup();
  const s = session({ turn: 2000, plan: { captured_at: 3000, updated_at: 1000, error: null, tasks: [
    { id: '1', subject: '核对需求', status: 'completed', activeForm: '' },
    { id: '2', subject: '实现侧栏', status: 'in_progress', activeForm: '正在实现侧栏' },
    { id: '3', subject: '<验证&结果>', status: 'pending', activeForm: '' },
  ] } });
  assert.equal(api.describe(s).completedTasks, 1); assert.equal(api.describe(s).previousPlan, true);
  api.init(() => {}); api.render(s);
  assert.equal(elements.get('[data-am="planCount"]').textContent, '1/3');
  assert.equal(elements.get('[data-am="planHint"]').hidden, false);
  const html = elements.get('[data-am="planList"]').innerHTML;
  assert.match(html, /正在实现侧栏/); assert.match(html, /aria-label="已完成"/);
  assert.match(html, /&lt;验证&amp;结果&gt;/); assert.doesNotMatch(html, /<验证/);
});

test('等待同步、空计划、读取错误分别显示，不静默伪造任务', () => {
  const { api, elements } = setup();
  api.init(() => {}); api.render(session());
  const list = elements.get('[data-am="planList"]');
  assert.match(list.innerHTML, /等待 CLI 同步/);
  api.render(session({ plan: { tasks: [], updated_at: 0, captured_at: 1000, error: null } }));
  assert.match(list.innerHTML, /暂无任务计划/);
  api.render(session({ plan: { tasks: [], updated_at: 0, captured_at: 2000, error: '记录损坏' } }));
  assert.match(list.innerHTML, /无法读取计划：记录损坏/);
  assert.equal(elements.get('[data-am="planCount"]').textContent, '');
});

test('采集时间改变但任务不变时不重建计划卡，任务状态更新时才重画', () => {
  const { api, elements } = setup();
  const s = session({ plan: { tasks: [{ id: '1', subject: '验证', status: 'pending' }], updated_at: 1000, captured_at: 2000, error: null } });
  api.init(() => {}); api.render(s);
  let writes = 0;
  Object.defineProperty(elements.get('[data-am="planList"]'), 'innerHTML', { set() { writes++; } });
  api.render({ ...s, plan: { ...s.plan, captured_at: 3000 } });
  assert.equal(writes, 0);
  api.render({ ...s, plan: { ...s.plan, tasks: [{ ...s.plan.tasks[0], status: 'completed' }] } });
  assert.equal(writes, 1);
});

test('累计用量：token、TPS、缓存命中、调用与均次费用按真实字段计算，缺失项显示未知', () => {
  const { api } = setup();
  const usage = { requests: 5210, input_tokens: 5303693, cache_creation_input_tokens: 685408, cache_read_input_tokens: 149228069, output_tokens: 452928, request_ms: 5206000 };
  const d = api.describe(session({ metrics: { ...metrics, cost_usd: 290.4, usage } }));
  const v = Object.fromEntries(Array.from(d.usage.items, x => [x.key, x.value]));
  assert.deepEqual(v, { tokens: '155.7M', tps: '87.0', cost: '$290', hit: '96.1%', calls: '5,210', avg: '$0.06' });
  assert.equal(api.describe(session({ metrics })).usage.known, false);
  const partial = api.describe(session({ metrics: { ...metrics, usage: { ...usage, request_ms: 0 } } })).usage;
  assert.equal(partial.known, true);
  assert.equal(partial.items.filter(x => !x.known).map(x => x.key).join(), 'tps,cost,avg');
});

test('六档强度按data-level识别，切到未知档位时清除旧色卡标记', () => {
  const { api, elements } = setup();
  api.init(() => {});
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    api.render(session({ metrics: { effort: level } }));
    assert.equal(elements.get('[data-am="effort"]').attrs['data-level'], level);
    assert.equal(elements.get('[data-am="effort"]').title, `推理强度：${level}`);
  }
  api.render(session());
  assert.equal(elements.get('[data-am="effort"]').attrs['data-level'], '');
  assert.equal(elements.get('[data-am="effort"]').textContent, '未上报');
});

test('分组结构稳定，紧凑用量保留六项可访问名称和精确提示，同快照不重画', () => {
  const { api, elements, root } = setup();
  api.init(() => {});
  assert.deepEqual([...root.innerHTML.matchAll(/data-am-group="([^"]+)"/g)].map(x => x[1]), ['run', 'usage', 'context', 'plan', 'links', 'workers', 'location']);
  const s = session({ metrics: { ...metrics, cost_usd: 0.39, usage: { requests: 43, input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000000, output_tokens: 100000, request_ms: 6849315 } } });
  api.render(s);
  const stats = elements.get('[data-am="stats"]');
  assert.equal((stats.innerHTML.match(/data-am-tip=/g) || []).length, 6);
  assert.equal((stats.innerHTML.match(/tabindex="0"/g) || []).length, 6);
  assert.match(stats.innerHTML, /aria-label="Token：3\.1M"/);
  assert.match(stats.innerHTML, /累计 3,110,000 token/);
  assert.doesNotMatch(stats.innerHTML, /<span>/);
  let writes = 0;
  Object.defineProperty(stats, 'innerHTML', { set() { writes++; } });
  api.render({ ...s, metrics: { ...s.metrics, updated_at: 8000 } });
  assert.equal(writes, 0);
});
