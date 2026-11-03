// 视频与配乐共用的时间轴：画面（scene.mjs）和配乐（music.mjs）都从这里取时间，保证音画对齐。
// 节拍 100 BPM，一小节 2.4 秒；场景切换落在小节线上，事件时间单位为秒。
export const BPM = 100;
export const BAR = 60 / BPM * 4;
export const bar = (n) => Math.round(n * BAR * 1000) / 1000;
export const DURATION = bar(81);

/** 场景（章节）：title 为左上角章节名，空则不显示。 */
export const SCENES = [
  { id: 'intro', title: '', a: 0, b: bar(5) },
  { id: 'problem', title: '为什么', a: bar(5), b: bar(10) },
  { id: 'setup', title: '开始使用', a: bar(10), b: bar(16) },
  { id: 'graph', title: '流程图', a: bar(16), b: bar(22) },
  { id: 'palette', title: '节点颜色', a: bar(22), b: bar(28) },
  { id: 'loop', title: '协作循环', a: bar(28), b: bar(44) },
  { id: 'stats', title: '状态统计', a: bar(44), b: bar(51) },
  { id: 'feat', title: 'Feat 档案', a: bar(51), b: bar(59) },
  { id: 'link', title: '图间链接', a: bar(59), b: bar(64) },
  { id: 'lock', title: 'Agent 加锁', a: bar(64), b: bar(71) },
  { id: 'history', title: '历史对比', a: bar(71), b: bar(76) },
  { id: 'outro', title: '', a: bar(76), b: bar(81) },
];

/** 关键事件时间（秒）。 */
export const T = {
  titleHit: bar(2),
  islands: [12.6, 13.2, 13.8],
  connect: [18.0, 18.3, 18.6],
  core: 19.2,
  typeA: 25.4, typeB: 28.0, scanClick: 28.8, scan: 29.0, treeRow0: 29.6, treeStep: 0.32,
  nodeFlash: [41.0, 42.2, 43.4, 44.6, 45.8],
  palette0: 53.6, paletteStep: 0.9,
  loop: [
    { t: bar(29), who: 'you', node: 'C', state: 'idea', desc: '提出想法或改动' },
    { t: bar(31), who: 'agent', node: 'C', state: 'review', desc: '方案写好了，等你审' },
    { t: bar(33), who: 'you', node: 'C', state: 'confirmed', desc: '同意，下一轮执行' },
    { t: bar(35), who: 'agent', node: 'C', state: 'none', desc: '代码改完，回到无色' },
    { t: bar(37), who: 'you', node: 'D', state: 'issue', desc: '写在节点里，或用便签连过去' },
    { t: bar(39), who: 'agent', node: 'D', state: 'review', desc: '修正后重新提交审核' },
    { t: bar(40.5), who: 'agent', node: 'E', state: 'plan_delete', desc: '建议删掉这一步' },
    { t: bar(42), who: 'you', node: 'E', state: 'confirm_delete', desc: '同意，Agent 删除节点和代码' },
  ],
  shatter: bar(43),
  bars: 106.4, statClick: 112.8, filter: 113.2,
  attachClick: 124.8, bookmark: 125.0, bookmarkClick: 127.6, featIn: 128.0, tasks: [130.4, 131.4, 132.4], featBeam: 134.0,
  linkBadge: 142.4, linkClick: 144.0, dive: [144.2, 146.0], backClick: 149.6, back: [149.8, 151.6], portal: [145.1, 150.7],
  lockType: [154.6, 156.4], locked: 156.6, shield: 156.8, agentEdit: 159.6, unlockType: [161.6, 163.0], unlocked: 163.2, merged: 164.4,
  snaps: 170.8, pick: [173.6, 174.2], diff: 175.0, diffRows: [175.6, 176.0, 176.4],
  book: bar(77),
};

/** 底部字幕：[开始, 结束, 文字]。 */
export const CAPTIONS = [
  [12.4, 17.6, '需求在文档里，代码在仓库里，Agent 在终端里'],
  [18.4, 23.4, 'Flow Coding 把三者接到同一张图上'],
  [24.6, 29.2, '填好项目目录，点「保存并扫描」'],
  [29.6, 37.8, '按 APP 收齐流程图和 Feat 档案'],
  [38.8, 45.2, '一张图，就是一份需求'],
  [45.6, 52.2, '每个节点对应一段代码，改动立即写盘'],
  [53.2, 59.2, '颜色，就是协作协议'],
  [59.6, 66.6, '谁来标记、下一步做什么，一看就懂'],
  [106.0, 112.2, '待办多少，一眼看清'],
  [112.6, 121.8, '点一行，只看含该状态的图'],
  [122.8, 128.0, '节点挂上 Feat 档案'],
  [128.4, 141.0, '点书签打开档案，任务和关联节点同屏'],
  [142.0, 149.2, '图间链接，从一张图跳到另一张'],
  [149.6, 153.0, '返回箭头，逐层回到来源图'],
  [154.0, 160.8, 'Agent 改图，先加锁'],
  [161.2, 169.8, '解锁后自动合并，不会互相覆盖'],
  [170.8, 175.6, '每次保存，都留历史'],
  [176.0, 181.8, '勾两个版本，按节点看变化'],
];

/** 音效事件：type 见 music.mjs 的音效合成器；riser 从 t 开始、持续 len 秒后到顶；音高均取 A 小调内的音。 */
export const SFX = (() => {
  const s = [];
  const add = (t, type, o = {}) => s.push({ t, type, ...o });
  add(bar(1), 'riser', { len: bar(1) });
  add(T.titleHit, 'impact');
  for (const x of [11.2, 23.6, 38.0, 52.4, 66.8, 105.2, 122.0, 141.8, 153.2, 170.0, 182.0]) add(x, 'whoosh');
  for (const x of [88.0, 96.4]) add(x, 'whoosh', { gain: .5 });
  T.islands.forEach((x) => add(x, 'pop'));
  T.connect.forEach((x, i) => add(x, 'zap', { pan: i - 1 }));
  add(T.core, 'impact', { gain: .55 });
  for (let x = T.typeA; x < T.typeB; x += 0.11) add(x, 'tick', { gain: .35 });
  add(T.scanClick, 'click');
  add(T.scan, 'sweep');
  for (let i = 0; i < 9; i++) add(T.treeRow0 + i * T.treeStep, 'tick', { gain: .5, pitch: 1 + i * .04 });
  T.nodeFlash.forEach((x, i) => add(x, 'chime', { note: 76 + [0, 3, 5, 8, 12][i], gain: .35 }));
  for (let i = 0; i < 7; i++) add(T.palette0 + i * T.paletteStep, 'chime', { note: 72 + [0, 2, 4, 5, 7, 9, 11][i] });
  const LOOP_NOTE = [81, 76, 84, 79, 86, 81, 74, 88];
  T.loop.forEach((e, i) => {
    if (e.who === 'you') { add(e.t, 'click'); add(e.t + .45, 'chime', { note: LOOP_NOTE[i] }); }
    else { add(e.t - 1, 'swish', { len: 1 }); add(e.t, 'chime', { note: LOOP_NOTE[i] }); }
  });
  add(T.shatter, 'shatter');
  for (let i = 0; i < 7; i++) add(T.bars + i * .12, 'tick', { gain: .5, pitch: 1 + i * .08 });
  add(T.statClick, 'click');
  add(T.filter, 'drop');
  add(T.filter + 1, 'chime', { note: 81 });
  add(T.attachClick, 'click');
  add(T.bookmark, 'pop');
  add(T.bookmarkClick, 'click');
  add(T.featIn, 'swish');
  T.tasks.forEach((x, i) => add(x, 'chime', { note: [76, 79, 84][i] }));
  add(T.featBeam, 'zap');
  add(T.linkBadge, 'pop');
  add(T.linkClick, 'click');
  add(T.dive[0], 'riser', { len: T.portal[0] - T.dive[0] });
  add(T.portal[0], 'impact', { gain: .6 });
  add(T.backClick, 'click');
  add(T.back[0], 'riser', { len: T.portal[1] - T.back[0], gain: .7 });
  add(T.portal[1], 'impact', { gain: .45 });
  for (let x = T.lockType[0]; x < T.lockType[1]; x += 0.09) add(x, 'tick', { gain: .3 });
  add(T.locked, 'lock');
  add(T.shield, 'sweep');
  add(T.agentEdit - 1, 'swish', { len: 1 });
  add(T.agentEdit, 'chime', { note: 74 });
  for (let x = T.unlockType[0]; x < T.unlockType[1]; x += 0.09) add(x, 'tick', { gain: .3 });
  add(T.unlocked, 'lock', { gain: .7 });
  add(T.unlocked + .2, 'shatter', { gain: .5 });
  add(T.merged, 'chime', { note: 84 });
  for (let i = 0; i < 4; i++) add(T.snaps + i * .35, 'tick', { gain: .5 });
  T.pick.forEach((x) => add(x, 'click'));
  add(T.diff, 'swish');
  T.diffRows.forEach((x, i) => add(x, 'tick', { gain: .5, pitch: 1.2 + i * .1 }));
  add(T.book - 2.2, 'riser', { len: 2.2 });
  add(T.book, 'impact');
  return s.sort((a, b) => a.t - b.t);
})();

/** 配乐分段（按小节）：每段开启的声部。 */
export const MUSIC = [
  { from: 0, to: 5, parts: ['pad'] },
  { from: 5, to: 10, parts: ['pad', 'arp'] },
  { from: 10, to: 22, parts: ['pad', 'arp', 'kick', 'hat', 'bass'] },
  { from: 22, to: 28, parts: ['pad', 'arp', 'hat', 'bass'] },
  { from: 28, to: 44, parts: ['pad', 'arp', 'kick', 'hat', 'bass', 'clap', 'lead'] },
  { from: 44, to: 51, parts: ['pad', 'arp'] },
  { from: 51, to: 71, parts: ['pad', 'arp', 'kick', 'hat', 'bass', 'clap'] },
  { from: 71, to: 76, parts: ['pad', 'arp', 'hat', 'bass'] },
  { from: 76, to: 81, parts: ['pad'] },
];
