// Feat 推进树：在 Feat 右侧栏「推进」区自上而下显示当前档案的进度。
// 主干为 需求 → UI → 开发 → 测试 → 关闭 五个阶段，开发阶段下挂 §3.1 的 T，T 下挂 §3.2 的子 T；
// 每个 T 显示状态、依赖（依赖项按其自身状态着色）与开发记录日期，悬停 T 时高亮它依赖的和依赖它的 T。
// 数据来自 feat_progress（Rust 解析档案）；点阶段、T、子 T 经 onLine 回调定位到档案对应行。
// 依赖：app.js 暴露的 window.FlowLink（appOf 取档案所属 APP）。
'use strict';

window.FeatProgress = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const STAGES = [
    { k: 'req', name: '需求' },
    { k: 'ui', name: 'UI' },
    { k: 'dev', name: '开发' },
    { k: 'test', name: '测试' },
    { k: 'close', name: '关闭' },
  ];
  const STATE_NAME = { todo: '待开发', doing: '进行中', waiting: '待用户确认', done: '完成', paused: '暂缓', cancelled: '取消', unknown: '未识别' };
  /** 默认展开子任务的 T 状态：正在推进的展开，其余收起。 */
  const OPEN_BY_DEFAULT = new Set(['doing', 'waiting']);

  const st = {
    path: '',             // 当前档案路径
    data: null,           // 当前档案的 feat_progress 条目
    err: '',
    seq: 0,               // 加载序号：快速切换档案时丢弃过期结果
    timer: 0,
    onLine: null,         // 定位回调（行号 1 起）
    toggled: new Set(),   // 用户改变过默认展开状态的 T（档案路径 + '#' + T 编号）
  };

  /**
   * 依赖列取 T 编号：支持「T1、T2」与区间「T1～T7」「T1-T3」；「生命周期契约」等说明文字不单独成标签，只在悬停提示里显示原文。
   */
  function depsOf(t) {
    const out = [];
    for (const m of String(t.deps || '').matchAll(/T(\d+)(?:\.\d+)?(?:\s*[~～\-–—至到]\s*T?(\d+))?/g)) {
      const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
      for (let i = a; i <= Math.min(b, a + 50); i++) out.push('T' + i);
    }
    return [...new Set(out)];
  }
  /** 日期 YYYY-MM-DD 只显示月-日；起止相同时只显示一个。 */
  const span = (a, b) => (!b ? '' : a === b || !a ? b.slice(5) : `${a.slice(5)} → ${b.slice(5)}`);
  const subKey = (t) => st.path + '#' + t.id;
  const subsOpen = (t) => OPEN_BY_DEFAULT.has(t.state) !== st.toggled.has(subKey(t));

  /**
   * 阶段文字与进度。输入 Progress 与阶段下标；输出 { phase, label, ratio, warn, line }。
   * phase：past 已过 / now 当前 / next 未到 / skip 已废弃；需求、UI 只看文档是否有记录，开发、测试按实际计数。
   */
  function stageInfo(p, i) {
    const cur = STAGES.findIndex((s) => s.k === p.stage);
    let phase = i < cur ? 'past' : i === cur ? 'now' : 'next';
    let ratio = -1, label = '', warn = false;
    const k = STAGES[i].k;
    if (k === 'req') {
      label = p.req.total ? `验收 ${p.req.done}/${p.req.total} 已勾` : '未写验收标准';
    } else if (k === 'ui') {
      label = p.ui.has ? `控件 ${p.ui.controls} · 变更 ${p.ui.logs}` : '未记录 UI';
    } else if (k === 'dev') {
      const d = p.dev;
      label = d.total ? `${d.done}/${d.total} 完成` : '无执行任务';
      if (d.doing) label += ` · 进行中 ${d.doing}`;
      if (d.waiting) label += ` · 待确认 ${d.waiting}`;
      ratio = d.total ? d.done / d.total : 0;
      warn = d.waiting > 0 || d.unknown > 0;
    } else if (k === 'test') {
      const t = p.test, tot = t.auto_total + t.manual_total, pass = t.auto_pass + t.manual_pass;
      label = tot ? `自测 ${t.auto_pass}/${t.auto_total} · 人工 ${t.manual_pass}/${t.manual_total}` : '未建测试清单';
      if (t.auto_fail + t.manual_fail) label += ` · 不通过 ${t.auto_fail + t.manual_fail}`;
      if (t.auto_unknown + t.manual_unknown) label += ` · 未识别 ${t.auto_unknown + t.manual_unknown}`;
      if (t.issues_open) label += ` · 问题 ${t.issues_open}`;
      ratio = tot ? pass / tot : 0;
      warn = t.auto_fail + t.manual_fail > 0 || t.auto_unknown + t.manual_unknown > 0 || t.issues_open > 0;
    } else if (p.flag === 'dropped') { label = `已废弃 ${p.closed_at}`; phase = 'skip'; }
    else if (p.stage === 'close') { label = `已关闭 ${p.closed_at}`; phase = 'past'; }
    else label = p.close.release ? '发布说明已写' : '未关闭';
    return { phase, label, ratio, warn, line: p[k].line || 0 };
  }

  /** 子任务行。 */
  const subItem = (s) => `<li class="fp-s ${s.state}">
      <button class="fp-snode" data-line="${s.line}" title="${esc(s.id)} ${esc(s.title)}\n状态：${esc(s.status)}">
        <span class="fp-sid">${esc(s.id)}</span><span class="fp-sttl">${esc(s.title)}</span><span class="fp-sst">${STATE_NAME[s.state]}</span>
      </button></li>`;

  /**
   * T 行固定两行：第一行编号 + 任务名（单行省略）+ 重复标记；第二行状态、子任务开关、日期、依赖（放最后，超出时截断）。
   * 完整任务名、状态原文、依赖原文、记录与子任务统计放在整行悬停提示里；展开时列出子任务。
   */
  function taskItem(t, byId) {
    const deps = depsOf(t);
    const live = t.subs.filter((s) => !['paused', 'cancelled'].includes(s.state));
    const subDone = live.filter((s) => s.state === 'done').length;
    const open = t.subs.length && subsOpen(t);
    const date = span(t.first_date, t.last_date);
    const tip = [
      `${t.id} ${t.title}`,
      `状态：${t.status || '未填'}`,
      t.deps && t.deps.trim() !== '-' ? `依赖：${t.deps}` : '无依赖',
      t.records ? `开发记录 ${t.records} 条${date ? `（${date}）` : ''}` : '',
      t.subs.length ? `子任务 ${subDone}/${live.length} 完成` : '',
      t.dup ? '路线图中编号重复' : '',
    ].filter(Boolean).join('\n');
    return `<li class="fp-t ${t.state}" data-tid="${esc(t.id)}" data-deps="${esc(deps.join(' '))}" title="${esc(tip)}">
      <button class="fp-tnode" data-line="${t.record_line || t.line}">
        <span class="fp-tid">${esc(t.id)}</span><span class="fp-ttl">${esc(t.title)}</span>${t.dup ? '<span class="fp-dup">重复</span>' : ''}
      </button>
      <div class="fp-tmeta">
        <span class="fp-pill ${t.state}">${STATE_NAME[t.state]}</span>
        ${t.subs.length ? `<button class="fp-fold" aria-expanded="${!!open}" title="${open ? '收起' : '展开'}子任务">子 ${subDone}/${live.length}<span aria-hidden="true">${open ? '▾' : '▸'}</span></button>` : ''}
        ${date ? `<span class="fp-date">${esc(date)}</span>` : ''}
        ${deps.length ? `<span class="fp-deps"><span aria-hidden="true">←</span>${deps.map((d) => { const s = byId[d]?.state || 'unknown'; return `<button class="fp-dep ${s}" data-goto="${esc(d)}" title="依赖 ${esc(d)}：${byId[d] ? STATE_NAME[s] : '路线图中没有该编号'}">${esc(d)}</button>`; }).join('')}</span>` : ''}
      </div>
      ${open ? `<ol class="fp-subs">${t.subs.map(subItem).join('')}</ol>` : ''}
    </li>`;
  }

  /** 渲染推进树与区头摘要；保留滚动位置。 */
  function render() {
    const box = $('feat-progress');
    const sum = $('fp-sum');
    const p = st.data;
    if (!p) {
      sum.textContent = '';
      box.innerHTML = st.path ? `<div class="empty mini">${esc(st.err || '读取中…')}</div>` : '';
      return;
    }
    const { scrollTop } = box;
    sum.innerHTML = p.dev.total ? `${p.dev.done}/${p.dev.total}${p.dev.waiting ? ` · <b class="w">待确认 ${p.dev.waiting}</b>` : ''}` : '';
    const byId = Object.fromEntries(p.tasks.map((t) => [t.id, t]));
    const dates = p.tasks.filter((t) => t.last_date);
    const devSpan = dates.length ? span(dates.map((t) => t.first_date).sort()[0], dates.map((t) => t.last_date).sort().pop()) : '';
    box.innerHTML = `<div class="fp-status">${esc(p.status)}${p.flag === 'paused' ? '<span class="fp-flag">已暂停</span>' : ''}</div>
      <ol class="fp-tree">${STAGES.map((s, i) => {
        const x = stageInfo(p, i);
        const tasks = s.k === 'dev'
          ? (p.tasks.length ? `<ol class="fp-tasks">${p.tasks.map((t) => taskItem(t, byId)).join('')}</ol>` : '<div class="fp-note">§3.1 还没有任务路线图</div>')
          : '';
        return `<li class="fp-stage ${x.phase}${x.warn ? ' warn' : ''}">
          <button class="fp-node" data-line="${x.line}" title="${s.name}：${esc(x.label)}${x.line ? '\n点击定位到档案该章节' : ''}">
            <span class="fp-dot" aria-hidden="true"></span>
            <span class="fp-name">${s.name}</span>
            <span class="fp-label">${esc(x.label)}</span>
            ${s.k === 'dev' && devSpan ? `<span class="fp-span">${esc(devSpan)}</span>` : ''}
            ${x.ratio >= 0 && x.phase !== 'skip' ? `<span class="fp-bar" aria-hidden="true"><i style="width:${Math.round(Math.min(1, x.ratio) * 100)}%"></i></span>` : ''}
          </button>${tasks}</li>`;
      }).join('')}</ol>`;
    box.scrollTop = scrollTop;
  }

  /** 读取档案所属 APP 的进度，取出当前档案。 */
  async function load() {
    const seq = ++st.seq;
    const app = st.path && FlowLink.appOf(st.path);
    if (!app) { st.data = null; st.err = st.path ? '未找到档案所属 APP' : ''; render(); return; }
    try {
      const list = await invoke('feat_progress', { flowDir: app.flow_dir });
      if (seq !== st.seq) return;
      st.data = list.find((p) => p.path === st.path) || null;
      st.err = st.data ? '' : '没有解析到该档案的进度';
    } catch (e) {
      if (seq !== st.seq) return;
      st.data = null;
      st.err = '读取进度失败：' + e;
    }
    render();
  }

  /** 切换到档案 path（Feat 栏打开档案时调用）；同一档案只刷新。 */
  function show(path) {
    if (path !== st.path) { st.path = path || ''; st.data = null; st.err = ''; render(); }
    load();
  }

  /** 悬停或聚焦某个 T：高亮它依赖的 T（hi-dep）和依赖它的 T（hi-of），其余变淡。 */
  function focusTask(li) {
    const tree = $('feat-progress');
    tree.querySelectorAll('.hi-self, .hi-dep, .hi-of').forEach((e) => e.classList.remove('hi-self', 'hi-dep', 'hi-of'));
    tree.classList.toggle('fp-focus', !!li);
    if (!li) return;
    const id = li.dataset.tid, deps = li.dataset.deps.split(' ').filter(Boolean);
    li.classList.add('hi-self');
    tree.querySelectorAll('.fp-t').forEach((e) => {
      if (deps.includes(e.dataset.tid)) e.classList.add('hi-dep');
      if (e.dataset.deps.split(' ').includes(id)) e.classList.add('hi-of');
    });
  }

  /** 点击：子任务开关、依赖跳转、阶段 / T / 子 T 定位档案行。 */
  function onClick(e) {
    const fold = e.target.closest('.fp-fold');
    if (fold) {
      const t = st.data.tasks.find((x) => x.id === fold.closest('.fp-t').dataset.tid);
      const key = subKey(t);
      st.toggled.has(key) ? st.toggled.delete(key) : st.toggled.add(key);
      render();
      return;
    }
    const dep = e.target.closest('.fp-dep');
    if (dep) {
      const target = $('feat-progress').querySelector(`.fp-t[data-tid="${CSS.escape(dep.dataset.goto)}"]`);
      if (!target) return;
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
      return;
    }
    const at = e.target.closest('[data-line]');
    if (at && Number(at.dataset.line) && st.onLine) st.onLine(Number(at.dataset.line));
  }

  /** 绑定定位回调与事件；档案改动（含本窗口保存）后合并刷新。 */
  function bind(onLine) {
    st.onLine = onLine;
    const tree = $('feat-progress');
    tree.addEventListener('click', onClick);
    tree.addEventListener('pointerover', (e) => focusTask(e.target.closest('.fp-t')));
    tree.addEventListener('pointerleave', () => focusTask(null));
    tree.addEventListener('focusin', (e) => focusTask(e.target.closest('.fp-t')));
    tree.addEventListener('focusout', (e) => { if (!tree.contains(e.relatedTarget)) focusTask(null); });
    listen('md-changed', (ev) => {
      if (ev.payload.path !== st.path) return;
      clearTimeout(st.timer);
      st.timer = setTimeout(load, 400);
    });
  }

  return { bind, show };
})();
