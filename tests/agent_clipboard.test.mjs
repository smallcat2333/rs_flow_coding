// 执行真实终端粘贴入口；只模拟 Windows 剪贴板 IPC 与终端输出，不启动 CLI。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/agent.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function clipboardFileRefs('), source.indexOf('/** 创建会话终端'));
const flush = () => new Promise(resolve => setImmediate(resolve));

/** 模拟一个已运行终端，捕获粘贴事件并记录 IPC、插入文字和可见错误。 */
function setup(invoke = async () => ({ kind: 'text' })) {
  const writes = [], messages = [], calls = [];
  const session = { running: true };
  let paste;
  const c = vm.createContext({
    S: new Map([['a', session]]), toast: message => messages.push(message),
    invoke: (cmd, args) => { calls.push({ cmd, args }); return invoke(cmd, args); },
  });
  vm.runInContext(code, c);
  c.bindTerminalPaste('a', { paste: text => writes.push(text) }, {
    addEventListener(type, listener, capture) { assert.equal(type, 'paste'); assert.equal(capture, true); paste = listener; },
  });
  return { session, writes, messages, calls, paste(text = '', items = []) {
    const events = [];
    paste({ clipboardData: { getData: () => text, items },
      preventDefault: () => events.push('prevent'), stopImmediatePropagation: () => events.push('stop') });
    assert.deepEqual(events, ['prevent', 'stop']);
  } };
}

test('普通文字和多行输入只经终端 paste 一次，不自动回车发送', async () => {
  const f = setup();
  f.paste('中文说明\n第二行'); await flush();
  assert.deepEqual(f.writes, ['中文说明\n第二行']);
  assert.deepEqual(f.calls.map(c => c.cmd), ['agent_clipboard']);
});

test('原生截图和浏览器图片均转发 Alt+V，不把 HTML 的替代文本混入输入', async () => {
  for (const [content, items] of [[{ kind: 'image' }, []], [{ kind: 'text' }, [{ type: 'image/png' }]]]) {
    const f = setup(async () => content);
    f.paste('不应插入的替代文字', items); await flush();
    assert.deepEqual(f.writes, []);
    assert.equal(f.calls[1].cmd, 'agent_write');
    assert.equal(f.calls[1].args.id, 'a');
    assert.equal(f.calls[1].args.data, '\x1bv');
  }
});

test('多文件原路径转为 @ 引用，中文空格路径保留，文件列表优先于缩略图', async () => {
  const f = setup(async () => ({ kind: 'files', paths: ['E:\\资料\\截图 1.png', 'E:\\src\\a.txt'] }));
  f.paste('忽略', [{ type: 'image/png' }]); await flush();
  assert.deepEqual(f.writes, ['@"E:/资料/截图 1.png" @E:/src/a.txt ']);
  assert.equal(f.calls.length, 1);
});

test('快速连续粘贴按触发顺序插入，即使后一次 IPC 更早完成', async () => {
  const pending = [];
  const f = setup(() => new Promise(resolve => pending.push(resolve)));
  f.paste('第一段'); f.paste('第二段');
  pending[1]({ kind: 'text' }); await flush();
  assert.deepEqual(f.writes, []);
  pending[0]({ kind: 'text' }); await flush();
  assert.deepEqual(f.writes, ['第一段', '第二段']);
});

test('剪贴板读取失败显示原因，后续粘贴仍可继续', async () => {
  let n = 0;
  const f = setup(async () => { if (++n === 1) throw '剪贴板被占用'; return { kind: 'text' }; });
  f.paste('不可丢弃后继续假装成功'); await flush();
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.messages, ['粘贴失败：剪贴板被占用']);
  f.paste('重试'); await flush();
  assert.deepEqual(f.writes, ['重试']);
});

test('未运行及等待剪贴板期间停止的会话均不写入或自动重启', async () => {
  let finish;
  const f = setup(() => new Promise(resolve => { finish = resolve; }));
  f.paste('旧会话文字'); await flush();
  f.session.running = false;
  finish({ kind: 'text' }); await flush();
  assert.deepEqual(f.writes, []);
  assert.match(f.messages[0], /会话已停止/);
  f.paste('仍停止'); await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.messages[1], '会话未运行，无法粘贴');
});
