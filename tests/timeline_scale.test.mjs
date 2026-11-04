// node --test tests/timeline_scale.test.mjs：真实时间比例、近一年筛选和密集聚合的确定性验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotTime, yearWindow, historyWindow, visibleSnapshots, timeRatio, nearestSnapshot, clusterSnapshots, monthTicks, calendarTicks } from '../ui/timeline_scale.mjs';

const now = new Date(2026, 10, 4, 12).getTime();
const domain = yearWindow(now);
const row = (id, ts) => ({ id, ts, source: 'user' });

test('一年为日历年且闰日回退到二月最后一天，不删除输入历史', () => {
  assert.equal(new Date(yearWindow(new Date(2024, 1, 29, 12).getTime()).start).getDate(), 28);
  const original = [row(1, '2025-11-04 11:59:59'), row(2, '2025-11-04 12:00:00'), row(3, '2026-11-04 12:00:00'), row(4, '2026-11-04 12:00:01')];
  assert.deepEqual(visibleSnapshots(original, domain).map(r => r.id), [2, 3]);
  assert.equal(original.length, 4);
});

test('不足一年按已有历史展开，单份和空历史不会除零', () => {
  const start = now - 3 * 86400000;
  assert.deepEqual(historyWindow([{ time: start }], now), { start, end: now });
  assert.equal(historyWindow([{ time: domain.start - 86400000 }], now).start, domain.start);
  assert.equal(historyWindow([{ time: now }], now).end - historyWindow([{ time: now }], now).start, 1);
  assert.ok(Number.isFinite(timeRatio(now, historyWindow([], now))));
});

test('短跨度标时分，跨天标日期，不填充空白月份', () => {
  const start = snapshotTime('2026-11-04 10:00:00');
  const short = calendarTicks({ start, end: start + 3600000 }, 800);
  assert.ok(short.length > 0);
  assert.ok(short.every(tick => /^\d{2}:\d{2}$/.test(tick.label)));
  const days = calendarTicks({ start, end: start + 10 * 86400000 }, 800);
  assert.ok(days.length > 0);
  assert.ok(days.every(tick => /^\d{2}\/\d{2}$/.test(tick.label)));
});

test('比例由时间差决定，不因中间新增快照等距排列', () => {
  const a = snapshotTime('2026-01-01 00:00:00'), b = a + 1000, c = a + 86400000;
  const scale = { start: a, end: c };
  assert.equal(timeRatio(b, scale), 1000 / 86400000);
  assert.equal(timeRatio(c, scale), 1);
  assert.equal(snapshotTime('2026/1/1 00:00:00'), a);
  assert.throws(() => snapshotTime('2026-02-30 00:00:00'));
});

test('数千份同小时记录聚成一个显示短簇，仍可定位单份原始版本', () => {
  const base = now - 86400000;
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: i, time: base + i * 1000 }));
  for (const width of [200, 800, 1600]) {
    const groups = clusterSnapshots(rows, domain, width);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].to - groups[0].from + 1, 3000);
  }
  assert.equal(nearestSnapshot(rows, base + 1234000), 1234);
  assert.equal(rows.length, 3000);
});

test('跨月记录按实际宽度分组，不把间隔较大的组链式合并', () => {
  const rows = [0, 7, 14, 21, 50].map((time, id) => ({ id, time }));
  assert.deepEqual(clusterSnapshots(rows, { start: 0, end: 100 }, 100).map(g => [g.from, g.to]), [[0, 1], [2, 3], [4, 4]]);
  assert.equal(clusterSnapshots(rows, domain, 0).length, 0);
});

test('相同时间取最新 id，最近时间两侧正确，空历史可用', () => {
  const rows = [{ id: 1, time: 10 }, { id: 2, time: 10 }, { id: 3, time: 20 }];
  assert.equal(nearestSnapshot(rows, 10), 1);
  assert.equal(nearestSnapshot(rows, 15), 2);
  assert.equal(nearestSnapshot(rows, 1), 0);
  assert.equal(nearestSnapshot(rows, 100), 2);
  assert.equal(nearestSnapshot([], 100), -1);
});

test('日期标签间距随宽度避让，窄轨道不堆叠月份', () => {
  for (const width of [160, 500, 1200]) {
    const labels = monthTicks(domain, width);
    let previous = 60;
    for (const label of labels) {
      const x = label.ratio * width;
      assert.ok(x - previous >= 65);
      assert.ok(width - x >= 70);
      previous = x;
    }
  }
});
