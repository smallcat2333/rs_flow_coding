// 总览关系建模：真实路径隔离、无 Feat 会话、标签节点、子代理以及协作/同文件提醒。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/agent_overview.js', import.meta.url), 'utf8');
const at = 10_000_000;
const key = (s) => String(s || '').replace(/\//g, '\\').toLowerCase();
const base = (s) => s.split(/[\\/]/).pop();
const rank = { wait: 0, err: 1, run: 2, idle: 3, off: 4 };
const context = vm.createContext({
  window: {}, key, base, now: () => at, WINDOW: 300_000,
  byUrgency: (a, b) => rank[a.status] - rank[b.status], vs: (s) => s.status, stText: (s) => s.status,
  refsOf: (s) => [...(s.focus ? [s.focus] : []), ...s.links],
});
vm.runInContext(source, context);
const build = context.window.AgentOverview.build;
/** 最小真实会话视图；测试只覆盖建模，不启动 CLI。 */
const session = (id, patch = {}) => ({ id, title: id, app: 'app_a', status: 'run', running: true, links: [], acts: [], workers: [], feat: '', ...patch });
const nodes = (m, kind) => m.nodes.filter((n) => n.kind === kind);
const edges = (m, kind) => m.edges.filter((n) => n.kind === kind);

test('无 Feat 会话直接连接流程图；大小写和分隔符差异去重', () => {
  const s = session('s1', { links: [{ flow: 'C:/app/a.drawio', node: 'n1' }, { flow: 'c:\\APP\\a.drawio', node: 'n2' }] });
  const m = build([s], [], new Map(), null, at);
  assert.equal(nodes(m, 'flow').length, 1);
  assert.equal(nodes(m, 'feat').length, 0);
  assert.equal(edges(m, 'session').length, 1);
  assert.equal(edges(m, 'session')[0].from, 'flow:c:\\app\\a.drawio');
});

test('不同 APP 的相同 Feat 编号按完整路径隔离，单个 Feat 可关联多个会话', () => {
  const fa = 'C:/a/docs/feat/Feat_1.md', fb = 'C:/b/docs/feat/Feat_1.md';
  const catalog = [{ app: 'a', feats: [{ id: 'Feat_1', title: 'A', path: fa, status: '开发中' }] }, { app: 'b', feats: [{ id: 'Feat_1', title: 'B', path: fb, status: '开发中' }] }];
  const m = build([session('s1', { feat: fa }), session('s2', { feat: fb }), session('s3', { feat: fa })], catalog, new Map(), null, at);
  assert.equal(nodes(m, 'feat').length, 2);
  assert.equal(edges(m, 'session').length, 3);
  assert.equal(nodes(m, 'feat').find((n) => n.label === 'A').owners.size, 2);
});

test('未显式关联流程图时，仍使用 Feat 标签节点补齐图与 Feat 关系', () => {
  const f = 'C:/a/Feat_1.md';
  const m = build([session('s1', { feat: f })], [], new Map([[key(f), [{ flow: 'C:/a/b.drawio', node: 'n1' }]]]), null, at);
  assert.equal(nodes(m, 'flow').length, 1);
  assert.equal(edges(m, 'association').length, 1);
  assert.equal(edges(m, 'session').length, 1);
});

test('不同父会话下同名同号 worker 不合并，近期完成保留，过期完成移除', () => {
  const worker = { id: 'toolu_same', desc: '检查', running: true, t0: at - 1000 };
  const a = session('s1', { workers: [worker, { ...worker, id: 'done', running: false, t1: at - 100 }, { ...worker, id: 'old', running: false, t1: at - 400_000 }] });
  const b = session('s2', { workers: [worker] });
  const m = build([a, b], [], new Map(), null, at);
  assert.equal(nodes(m, 'worker').length, 3);
  assert.equal(new Set(nodes(m, 'worker').map((w) => w.id)).size, 3);
  assert.equal(edges(m, 'worker').length, 3);
});

test('三个会话修改同一个文件提醒全部配对；单会话重复编辑不产生自连', () => {
  const edit = { kind: 'edit', path: 'C:/app/shared.py', t: at - 1000 };
  const ss = ['a', 'b', 'c'].map((id) => session(id, { acts: [edit, edit] }));
  assert.equal(edges(build(ss, [], new Map(), null, at), 'conflict').length, 3);
  assert.equal(edges(build([ss[0]], [], new Map(), null, at), 'conflict').length, 0);
});

test('协作按 peer ID 连接，同名会话和互相回报不重复、不误连', () => {
  const a = session('a', { title: '同名', acts: [{ kind: 'msg', peer: 'b', text: '发给对方', t: at - 1 }] });
  const b = session('b', { title: '同名', acts: [{ kind: 'msg', peer: 'a', text: '来自对方', t: at }] });
  const c = session('c', { title: '同名', acts: [{ kind: 'msg', text: '没有明确 peer 的旧活动', t: at }] });
  const es = edges(build([a, b, c], [], new Map(), null, at), 'collab');
  assert.equal(es.length, 1);
  assert.equal(es[0].from, 'session:a');
  assert.equal(es[0].to, 'session:b');
});

test('过期活动和已移除的协作对象不会留下幽灵连线', () => {
  const a = session('a', { acts: [{ kind: 'edit', path: 'C:/x', t: at - 1_800_001 }, { kind: 'msg', peer: 'gone', text: '已移除', t: at }] });
  const b = session('b', { acts: [{ kind: 'edit', path: 'C:/x', t: at }, { kind: 'msg', peer: 'a', text: '过期', t: at - 1_800_001 }] });
  const m = build([a, b], [], new Map(), null, at);
  assert.equal(edges(m, 'collab').length, 0);
  assert.equal(edges(m, 'conflict').length, 0);
});

test('空会话保持空态，主窗口对象可出现但不虚构会话', () => {
  assert.equal(build([], [], new Map(), null, at).nodes.length, 0);
  const m = build([], [], new Map(), { path: 'C:/a.drawio', node: 'n1' }, at);
  assert.equal(nodes(m, 'flow').length, 1);
  assert.equal(m.sessions.length, 0);
});
