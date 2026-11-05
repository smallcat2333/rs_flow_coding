// 主窗口栏顶的 Agent 机器人：Feat 栏一个「主」机器人；流程图栏一个「主」机器人加一个「客」计数。
// - 主会话：Feat 的主会话是关联该 Feat 的会话；流程图的主会话是没有 Feat、关联了这张图（整图或其中节点）的会话。
//   后端保证每个 Feat / 每张图只有一个主会话（agent.rs main_conflict）；规则之前留下的重复以最早创建的为主。
// - 客会话：带 Feat、关联或正在处理这张图节点的会话；「客 N」的 N 是其中正在运行的个数。
// - 颜色（多个会话取最紧急）：红 异常 > 黄 等你确认 > 紫 多个 subagent 运行中 > 蓝 运行中 > 绿 运行完成未查看 > 白 有会话 > 灰 无会话。
// - 单击：有会话切到 Agent 窗口的该会话；没有会话时打开 Agent 窗口并预填新建面板。
// 数据：agent_list 初始化，agent-update / agent-removed 增量；当前图取 app.js 的 st.cur，当前 Feat 取 FeatPane。
'use strict';

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  /** 会话 id → 视图（与 Agent 窗口同源，只用状态与关联字段）。 */
  const sessions = new Map();
  const RANK = { err: 0, wait: 1, multi: 2, run: 3, done: 4, has: 5, none: 6 };
  const TEXT = { err: '异常退出', wait: '等你确认', multi: '多个 subagent 运行中', run: '运行中', done: '运行完成，还没查看', has: '空闲', none: '还没有会话' };
  const SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="an" d="M8 1.7v2"/><circle class="ab" cx="8" cy="1.4" r="1"/>'
    + '<rect class="hd" x="2.4" y="3.7" width="11.2" height="9.4" rx="2.7"/><circle class="ey" cx="5.9" cy="8.3" r="1.1"/><circle class="ey" cx="10.1" cy="8.3" r="1.1"/>'
    + '<path class="ar" d="M.9 7.4v2.6M15.1 7.4v2.6"/></svg>';
  const key = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

  /** 单个会话的颜色状态；输入为后端会话视图，输出为 RANK 的键（none 除外）。 */
  function stateOf(s) {
    if (s.status === 'err') return 'err';
    if (s.running && s.status === 'wait') return 'wait';
    if (s.running && (s.status === 'run' || s.status === 'boot')) {
      return (s.workers || []).filter((w) => w.running).length >= 2 ? 'multi' : 'run';
    }
    return s.done > s.seen ? 'done' : 'has';
  }
  /** 一组会话里最紧急的那个（并列取最早创建）；空组返回 null。 */
  function urgent(list) {
    return [...list].sort((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)] || a.created - b.created)[0] || null;
  }
  const oldest = (list) => [...list].sort((a, b) => a.created - b.created)[0] || null;
  const touches = (s, flow) => (s.links || []).some((l) => key(l.flow) === flow) || (s.focus && key(s.focus.flow) === flow);

  /** 当前 Feat 的主会话。 */
  function featMain(path) {
    const k = key(path);
    return oldest([...sessions.values()].filter((s) => key(s.feat) === k));
  }
  /** 当前流程图的主会话与客会话。 */
  function flowParts(path) {
    const k = key(path), all = [...sessions.values()];
    return {
      main: oldest(all.filter((s) => !s.feat && (s.links || []).some((l) => key(l.flow) === k))),
      guests: all.filter((s) => s.feat && touches(s, k)),
    };
  }

  /** 把按钮画成某状态；内容没变不动 DOM（避免悬停提示闪动）。 */
  function paint(btn, st, title, text) {
    const sig = st + '|' + title + '|' + (text ?? '');
    if (btn.dataset.sig === sig) return;
    btn.dataset.sig = sig;
    btn.dataset.state = st;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = SVG + (text == null ? '' : `<span>${text}</span>`);
  }

  /** 刷新三个按钮：Feat 主、图主、图客。 */
  function render() {
    const featPath = window.FeatPane?.curPath() || '';
    const fb = document.getElementById('btn-feat-bot');
    fb.disabled = !featPath;
    const fm = featPath ? featMain(featPath) : null;
    paint(fb, fm ? stateOf(fm) : 'none', fm ? `主会话「${fm.title}」：${TEXT[stateOf(fm)]}，点击打开` : '这个 Feat 还没有会话，点击新建');

    const flowPath = st.cur || '';
    const mb = document.getElementById('btn-flow-bot'), gb = document.getElementById('btn-flow-guest');
    mb.disabled = !flowPath;
    const { main, guests } = flowPath ? flowParts(flowPath) : { main: null, guests: [] };
    paint(mb, main ? stateOf(main) : 'none', main ? `主会话「${main.title}」：${TEXT[stateOf(main)]}，点击打开` : '这张图还没有主会话，点击新建');
    gb.hidden = !guests.length;
    if (guests.length) {
      const running = guests.filter((s) => ['run', 'multi', 'wait'].includes(stateOf(s))).length;
      const lines = guests.map((s) => `「${s.title}」${s.feat_code ? ' ' + s.feat_code : ''}：${TEXT[stateOf(s)]}`);
      paint(gb, stateOf(urgent(guests)), `客会话（来自 Feat，处理本图节点），${running} 个运行中：\n${lines.join('\n')}\n点击打开最需要处理的一个`, `客 ${running}`);
    }
  }

  /** 打开会话；没有会话时打开 Agent 窗口并预填新建面板。 */
  function open(s, prefill) {
    invoke('open_agent_window', s ? { focus: s.id } : { prefill }).catch((e) => console.error('打开 Agent 窗口失败', e));
  }
  document.getElementById('btn-feat-bot').addEventListener('click', () => {
    const path = FeatPane.curPath();
    const f = appOf(path)?.feats.find((x) => x.path === path);
    open(featMain(path), { root: appOf(path)?.root, feat: { id: FeatPane.curId() || f?.id || '', title: f?.title || '', path }, links: [] });
  });
  document.getElementById('btn-flow-bot').addEventListener('click', () => {
    open(flowParts(st.cur).main, { root: appOf(st.cur)?.root, links: [{ flow: st.cur, node: '' }] });
  });
  document.getElementById('btn-flow-guest').addEventListener('click', () => open(urgent(flowParts(st.cur).guests)));

  invoke('agent_list').then((list) => { for (const s of list) sessions.set(s.id, s); render(); }).catch((e) => console.error('读取 Agent 会话失败', e));
  listen('agent-update', (e) => { sessions.set(e.payload.id, e.payload); render(); });
  listen('agent-removed', (e) => { sessions.delete(e.payload.id); render(); });
  // 当前图 / Feat 切换没有统一事件，按秒轮询；内容不变时 paint 不改 DOM
  setInterval(render, 1000);
  render();
})();
