// 时间线纯计算：近一年日历范围、真实时间映射与按屏幕距离聚合；不读取 DOM、不删历史。

/** 解析本地快照时间，接受后端 YYYY-MM-DD HH:mm:ss 和预览层 YYYY/M/D HH:mm:ss；无效时间明确报错。 */
export function snapshotTime(text) {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`无效的快照时间：${text}`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
      hour > 23 || minute > 59 || second > 59) throw new Error(`无效的快照时间：${text}`);
  return date.getTime();
}

/** 最近一个日历年，截止传入的 now（毫秒）；闰年 2/29 的前一年按 2/28 截止。 */
export function yearWindow(now) {
  const start = new Date(now), month = start.getMonth();
  start.setFullYear(start.getFullYear() - 1);
  if (start.getMonth() !== month) start.setDate(0);
  return { start: start.getTime(), end: now };
}

/** 将快照按真实时间排序后筛进近一年，同一秒以 id 排序；原始记录不修改。 */
export function visibleSnapshots(rows, domain) {
  return rows.map(row => ({ ...row, time: snapshotTime(row.ts) }))
    .filter(row => row.time >= domain.start && row.time <= domain.end)
    .sort((a, b) => a.time - b.time || a.id - b.id);
}

/** 按已有历史展开，截止 now，最短 14 天、最长一个日历年；较早的空白日期不补快照。 */
export function historyWindow(rows, now) {
  const cutoff = yearWindow(now).start;
  return { start: Math.max(cutoff, Math.min(rows[0]?.time ?? now, now - 14 * 86400000)), end: now };
}

/** 时间在实际历史范围中的位置（0~1）；仅用于范围内的记录与日历刻度。 */
export function timeRatio(time, domain) {
  return (time - domain.start) / (domain.end - domain.start);
}

/** 找到最近快照的下标；等距离选较新版本，同一秒选最新 id；空数组返回 -1。 */
export function nearestSnapshot(rows, time) {
  if (!rows.length) return -1;
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  if (lo === rows.length) return lo - 1;
  return time - rows[lo - 1].time < rows[lo].time - time ? lo - 1 : lo;
}

/**
 * 按实际像素聚合：与本组第一点的间距不足 gap 的记录归一组，避免相邻点链式合并整条轨道。
 * 返回首尾下标与显示中心位置；记录原封不动，键盘仍可逐版访问。
 */
export function clusterSnapshots(rows, domain, width, gap = 8) {
  if (width <= 0) return [];
  const groups = [];
  rows.forEach((row, index) => {
    const x = timeRatio(row.time, domain) * width, group = groups.at(-1);
    if (group && x - group.startX < gap) {
      group.to = index;
      group.endX = x;
      group.x = (group.startX + x) / 2;
    } else groups.push({ from: index, to: index, x, startX: x, endX: x });
  });
  return groups;
}

/** 按轨道宽度筛选月初刻度（含年份），两端预留空间放起止日期；不会因快照密度改变月份位置。 */
export function monthTicks(domain, width) {
  const first = new Date(domain.start);
  first.setDate(1);
  first.setHours(0, 0, 0, 0);
  first.setMonth(first.getMonth() + 1);
  const ticks = [];
  let previous = 60;
  for (const date = first; date.getTime() < domain.end; date.setMonth(date.getMonth() + 1)) {
    const ratio = timeRatio(date.getTime(), domain), x = ratio * width;
    if (x - previous < 65 || width - x < 70) continue;
    previous = x;
    ticks.push({ ratio, label: date.getMonth() === 0 ? `${date.getFullYear()}年` : `${date.getMonth() + 1}月` });
  }
  return ticks;
}

/** 根据实际跨度选择月、日或时分刻度，并按宽度避让两端；短历史不会出现空白月份。 */
export function calendarTicks(domain, width) {
  const span = domain.end - domain.start;
  if (span > 90 * 86400000) return monthTicks(domain, width);
  const target = Math.max(1, Math.floor(width / 90));
  const steps = [1000, 5000, 10000, 30000, 60000, 300000, 900000, 1800000, 3600000, 10800000, 21600000, 43200000, 86400000, 259200000, 604800000, 1209600000, 2592000000];
  const step = steps.find(value => value >= span / target) ?? steps.at(-1);
  const ticks = [];
  let previous = 70;
  for (let time = Math.ceil(domain.start / step) * step; time < domain.end; time += step) {
    const ratio = timeRatio(time, domain), x = ratio * width;
    if (x - previous < 75 || width - x < 90) continue;
    previous = x;
    const d = new Date(time), two = n => String(n).padStart(2, '0');
    const label = span > 2 * 86400000 ? `${two(d.getMonth() + 1)}/${two(d.getDate())}` :
      `${two(d.getHours())}:${two(d.getMinutes())}${span < 120000 ? `:${two(d.getSeconds())}` : ''}`;
    ticks.push({ ratio, label });
  }
  return ticks;
}
