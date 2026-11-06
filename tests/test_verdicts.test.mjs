// 使用 Rust/JS 共用的输入表验证真实 Feat 解析器，按测试项计数，不混入子用例数量。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = { window: {} };
vm.runInNewContext(readFileSync(new URL('../ui/feat_board.js', import.meta.url), 'utf8'), context);
const cases = JSON.parse(readFileSync(new URL('./fixtures/test_verdicts.json', import.meta.url), 'utf8'));

/** 生成只含结果列差异的自测/人工表，保证测试经过真实 Markdown 解析与统计链路。 */
function documentWithResults(results) {
  const rows = results.map((value, i) => `| ${i + 1} | 检查 | ${value} |`).join('\n');
  return `# Feat_261105_1 结果识别\n\n> 状态：测试中\n\n## 4. 测试记录\n\n### 4.1 程序自测\n| # | 自测项 | 结果 |\n| --- | --- | --- |\n${rows}\n\n### 4.2 人工确认\n| # | 测试项 | 结果 |\n| --- | --- | --- |\n${rows}\n`;
}

for (const item of cases) {
  test(`结果 ${JSON.stringify(item.text)} → ${item.verdict || '未填'}`, () => {
    const stats = context.window.FeatBoard.model(documentWithResults([item.text])).stats;
    for (const kind of ['auto', 'manual']) {
      const row = stats[kind];
      assert.equal(row.total, 1);
      assert.equal(row.pass, Number(item.verdict === 'pass'));
      assert.equal(row.fail, Number(item.verdict === 'fail'));
      assert.equal(row.unknown, Number(item.verdict === 'other'));
      assert.equal(row.filled, Number(item.verdict !== ''));
    }
  });
}

test('实际档案的12个测试组统计为4通过8不通过，未识别单独计数', () => {
  const values = ['17 通过', '2 通过', '3 通过、5 失败', '2 失败', '4 失败', '1 失败', '4 通过、2 失败', '1 通过、4 失败', '1 失败', '2 失败', '通过（有限验证）', '通过'];
  const { auto } = context.window.FeatBoard.model(documentWithResults(values)).stats;
  assert.deepEqual(JSON.parse(JSON.stringify(auto)), { total: 12, pass: 4, fail: 8, unknown: 0, filled: 12 });
});
