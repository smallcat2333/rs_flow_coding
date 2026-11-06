// 遥测条展示规则：直接执行模块；时间格式返回毫秒，便于核对计时边界，不启动 CLI。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../ui/agent_metrics.js', import.meta.url), 'utf8');

/** 构造最小 DOM，仅用于验证同会话更新不会替换详情结构；数值规则使用真实 describe。 */
function setup() {
  const elements = new Map(), details = Array.from({ length: 6 }, () => ({ open: false }));
  const root = { hidden: true, innerHTML: '', addEventListener() {}, querySelectorAll: () => details,
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, {}); return elements.get(selector); } };
  const c = vm.createContext({ window: {}, document: { getElementById: () => root, addEventListener() {} },
    ResizeObserver: class { observe() {} }, now: () => 9000, clock: ms => String(Math.max(0, ms)), ago: ms => String(ms),
    esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  vm.runInContext(source, c);
  return { api: c.window.AgentMetrics, root, details, elements };
}
const session = (extra = {}) => ({ id: 'one', running: true, status: 'idle', tool: '', turn: 0, done: 0, beat: 1000, since: 1000, workers: [], metrics: null, ...extra });

test('未上报上下文保持未知，不显示虚假零占用或猜测模型', () => {
  const { api } = setup();
  const d = api.describe(session());
  assert.equal(d.contextKnown, false);
  assert.equal(d.percentage, null);
  assert.equal(d.model, '模型待获取');
  assert.equal(d.effort, '未上报');
});

test('上下文占比与容量来自同一快照，模型与推理档位分开显示', () => {
  const { api } = setup();
  const d = api.describe(session({ metrics: { model_id: 'model-id', model_name: '模型名称', effort: 'high', used_tokens: 76000, capacity: 200000, used_percentage: 38, updated_at: 5000 } }));
  assert.equal(d.model, '模型名称'); assert.equal(d.modelId, 'model-id'); assert.equal(d.effort, 'high');
  assert.equal(d.contextKnown, true); assert.equal(d.percentage, 38);
  assert.equal(d.used, '76,000'); assert.equal(d.capacity, '200,000');
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

test('同一会话刷新保留展开详情，切换会话关闭旧详情，总览隐藏遥测条', () => {
  const { api, root, details } = setup();
  api.init(() => {}); const structure = root.innerHTML;
  api.render(session()); details[1].open = true;
  api.render(session({ beat: 8000 }));
  assert.equal(details[1].open, true); assert.equal(root.innerHTML, structure);
  api.render(session({ id: 'two' }));
  assert.equal(details.some(x => x.open), false);
  api.render(null); assert.equal(root.hidden, true);
});
