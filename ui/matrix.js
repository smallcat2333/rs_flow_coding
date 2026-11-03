// 推进矩阵：按 APP 列出 Feat，每行显示 需求 → UI → 开发 → 测试 → 关闭 五段进度与流程图待办，
// 展开后列出 §3.1 的 T 与 §3.2 的子 T。数据来自 feat_progress（Rust 解析档案），节点计数来自侧栏汇总。
// 联动：打开 Feat / 流程图时矩阵跟随切到该 APP 并展开当前 Feat；在矩阵里选 Feat 会切换高亮，
// Feat 栏开着时同步切换档案；点阶段、T、子 T 打开档案并定位到对应行。
// 依赖：app.js 暴露的 window.FlowLink、layout.js 的 window.Split、sidebar.js 的 window.Sidebar。
'use strict';

window.MatrixPane = (() => {
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
  /** 流程图待办：除无色外的协作状态，顺序与侧栏统计一致。 */
  const PENDING = [['idea', '你的想法'], ['review', '起草待审'], ['confirmed', '已确认'], ['issue', '有问题'], ['plan_delete', '计划删除'], ['confirm_delete', '确认删除'], ['unknown', '未识别颜色']];

  const st = {
    flowDir: '',          // 当前 APP（flow_dir）
    data: [],             // feat_progress 结果
    expanded: new Set(),  // 展开的 Feat 路径
    subExpanded: new Set(), // 用户展开的子 T 清单（按档案路径 + T 编号）
    cur: '',              // 当前 Feat 路径
    all: localStorage.getItem('fc-mx-all') === '1',
    timer: 0,
    seq: 0,               // 加载序号：快速切换 APP 时丢弃过期结果
  };

  const apps = () => FlowLink.apps().filter((a) => a.feats.length);
  const appByDir = (dir) => FlowLink.apps().find((a) => a.flow_dir === dir) || null;

  /** 读取当前 APP 的进度并渲染。 */
  async function load() {
    const seq = ++st.seq;
    if (!st.flowDir) { st.data = []; render(); return; }
    try {
      const data = await invoke('feat_progress', { flowDir: st.flowDir });
      if (seq !== st.seq) return;
      st.data = data;
      $('mx-msg').textContent = '';
    } catch (e) {
      if (seq !== st.seq) return;
      st.data = [];
      $('mx-msg').textContent = '读取进度失败：' + e;
    }
    render();
  }

  /** 文件变化后合并刷新，等侧栏汇总先更新节点计数。 */
  function reloadSoon() {
    if (!Split.isOpen('mx')) return;
    clearTimeout(st.timer);
    st.timer = setTimeout(load, 700);
  }

  /** 切换到指定 APP（相同则不重载）。 */
  function setApp(flowDir) {
    if (!flowDir || flowDir === st.flowDir) return false;
    st.flowDir = flowDir;
    localStorage.setItem('fc-mx-app', flowDir);
    st.data = [];
    render();
    load();
    return true;
  }

  /** APP 下拉：只列有 Feat 的 APP，显示侧栏别名。 */
  function renderApps() {
    const list = apps();
    if (!st.flowDir || !list.some((a) => a.flow_dir === st.flowDir)) {
      const saved = localStorage.getItem('fc-mx-app');
      st.flowDir = (list.find((a) => a.flow_dir === saved) || list[0] || {}).flow_dir || '';
    }
    $('mx-app').innerHTML = list.length
      ? list.map((a) => `<option value="${esc(a.flow_dir)}" ${a.flow_dir === st.flowDir ? 'selected' : ''}>${esc(Sidebar.appName(a))}</option>`).join('')
      : '<option value="">没有含 Feat 的 APP</option>';
  }

  /** 阶段格：需求/UI 只显示文档记录状态；开发/测试的填充比例取实际任务计数。 */
  function stageCell(p, i) {
    const cur = STAGES.findIndex((s) => s.k === p.stage);
    let phase = i < cur ? 'past' : i === cur ? 'now' : 'next';
    let ratio = 0, label = '', warn = false;
    const k = STAGES[i].k;
    if (k === 'req') {
      label = p.req.total ? `${p.req.total} 条验收 · 已勾 ${p.req.done}` : '未写验收';
      ratio = p.req.total ? 1 : 0;
    } else if (k === 'ui') {
      label = p.ui.has ? '已有设计记录' : '未记录 UI';
      ratio = p.ui.has ? 1 : 0;
    } else if (k === 'dev') {
      const d = p.dev;
      label = d.total ? `${d.done}/${d.total} 完成` : '无执行任务';
      if (d.waiting) label += ` · 待确认 ${d.waiting}`;
      if (d.paused || d.cancelled) label += ` · 暂缓 ${d.paused} / 取消 ${d.cancelled}`;
      ratio = d.total ? d.done / d.total : 0;
      warn = d.waiting > 0 || d.unknown > 0;
    } else if (k === 'test') {
      const t = p.test, tot = t.auto_total + t.manual_total, pass = t.auto_pass + t.manual_pass, fail = t.auto_fail + t.manual_fail;
      label = tot ? `${pass}/${tot} 通过` : '未建清单';
      if (fail) label += ` · 不通过 ${fail}`;
      if (t.issues_open) label += ` · 问题 ${t.issues_open}`;
      ratio = tot ? pass / tot : 0;
      warn = fail > 0 || t.issues_open > 0;
    } else {
      if (p.flag === 'dropped') { label = `已废弃 ${p.closed_at}`; phase = 'skip'; }
      else if (p.stage === 'close') { label = `已关闭 ${p.closed_at}`; ratio = 1; phase = 'past'; }
      else label = p.close.release ? '发布说明已写' : '未关闭';
    }
    const line = p[k].line || 0;
    return `<td class="mx-stage ${phase}${warn ? ' warn' : ''}">
      <button class="mx-cell" data-line="${line}" title="${esc(STAGES[i].name)}：${esc(label)}${line ? '（点击打开档案该章节）' : ''}">
        <span class="mx-rail"><span class="mx-fill" style="width:${Math.round(Math.min(1, ratio) * 100)}%"></span></span>
        <span class="mx-label">${esc(label)}</span>
      </button></td>`;
  }

  /** 流程图待办列：取侧栏汇总中该 Feat 挂接节点的状态计数。 */
  function nodeCell(p) {
    const f = FlowLink.appOf(p.path)?.feats.find((x) => x.path === p.path);
    if (!f || !f.node_total) return '<td class="mx-nodes"><span class="mx-muted">未挂节点</span></td>';
    const parts = PENDING.filter(([k]) => f.counts[k]).map(([k, name]) => `<span class="mx-nd" title="${name} ${f.counts[k]}"><span class="sw s-${k}"></span>${f.counts[k]}</span>`);
    return `<td class="mx-nodes">${parts.length ? parts.join('') : `<span class="mx-ok" title="${f.node_total} 个节点全部无色">✓ 无待办</span>`}</td>`;
  }

  /** 展开行：T 列表（编号、任务、依赖、状态、子 T、活动日期）。 */
  function detail(p) {
    if (!p.tasks.length) return `<tr class="mx-detail"><td colspan="7"><div class="mx-empty">§3.1 还没有任务路线图，跑 /smallcat-feat-3-dev 建路线图后显示。</div></td></tr>`;
    const rows = p.tasks.map((t) => `
      <tr class="mx-t ${t.state}" data-line="${t.record_line || t.line}">
        <td class="mx-tid">${esc(t.id)}${t.dup ? '<span class="mx-dup" title="路线图中编号重复">重复</span>' : ''}</td>
        <td class="mx-ttitle" title="${esc(t.title)}"><button class="mx-task-link" data-line="${t.record_line || t.line}">${esc(t.title)}</button></td>
        <td class="mx-deps">${t.deps && t.deps !== '-' ? t.deps.split(/[,，、\s]+/).filter(Boolean).map((d) => `<span class="mx-dep">${esc(d)}</span>`).join('') : ''}</td>
        <td><span class="mx-pill ${t.state}" title="${esc(t.status)}">${STATE_NAME[t.state]}</span></td>
        <td class="mx-subs">${t.subs.length ? `<details data-sub-key="${esc(p.path + '#' + t.id)}" ${st.subExpanded.has(p.path + '#' + t.id) ? 'open' : ''}><summary>子任务 ${t.subs.filter((s) => s.state === 'done').length}/${t.subs.filter((s) => !['paused', 'cancelled'].includes(s.state)).length}</summary>${t.subs.map((s) => `<button class="mx-sub ${s.state}" data-line="${s.line}" title="${esc(s.status)}"><b>${esc(s.id)}</b> ${esc(s.title)}<span>${STATE_NAME[s.state]}</span></button>`).join('')}</details>` : '<span class="mx-muted">—</span>'}</td>
        <td class="mx-date">${t.last_date ? esc(t.first_date === t.last_date ? t.last_date.slice(5) : `${t.first_date.slice(5)} → ${t.last_date.slice(5)}`) : ''}</td>
      </tr>`).join('');
    return `<tr class="mx-detail"><td colspan="7"><table class="mx-tasks"><thead><tr><th>编号</th><th>任务</th><th>依赖</th><th>状态</th><th>子任务</th><th>活动</th></tr></thead><tbody>${rows}</tbody></table></td></tr>`;
  }

  /** 渲染矩阵与汇总。 */
  function render() {
    if (!Split.isOpen('mx')) return;
    const body = $('mx-body');
    const { scrollTop, scrollLeft } = body;
    renderApps();
    const list = st.data.filter((p) => st.all || !p.archived);
    $('mx-all').value = st.all ? 'all' : 'open';
    const active = st.data.filter((p) => !p.archived);
    const waiting = active.reduce((n, p) => n + p.dev.waiting, 0);
    const unknown = active.reduce((n, p) => n + p.dev.unknown, 0);
    $('mx-sum').innerHTML = `开启 <b>${active.length}</b>${waiting ? ` · 待用户确认 <b class="w">${waiting}</b>` : ''}${unknown ? ` · <span title="状态列开头不是规定状态词，见 feat-3-dev「路线图状态词」">未识别 <b>${unknown}</b></span>` : ''}`;
    if (!list.length) {
      $('mx-body').innerHTML = `<div class="mx-empty">${st.flowDir ? (st.data.length ? '没有开启中的 Feat，可切换到「全部」查看已关闭的。' : '这个 APP 还没有 Feat 档案。') : '还没有含 Feat 的 APP。'}</div>`;
      return;
    }
    $('mx-body').innerHTML = `<table class="mx-table">
      <colgroup><col style="width:220px">${STAGES.map(() => '<col>').join('')}<col style="width:140px"></colgroup>
      <thead><tr><th class="mx-feat-h">Feat</th>${STAGES.map((s) => `<th>${s.name}</th>`).join('')}<th>流程图待办</th></tr></thead>
      <tbody>${list.map((p) => {
        const expanded = st.expanded.has(p.path);
        const flag = p.flag === 'paused' ? '<span class="mx-flag">已暂停</span>' : '';
        return `<tr class="mx-row${p.path === st.cur ? ' active' : ''}${p.archived ? ' archived' : ''}" data-path="${esc(p.path)}" data-id="${esc(p.id)}">
          <td class="mx-feat"><div class="mx-feat-in"><button class="mx-toggle" aria-expanded="${expanded}" title="${expanded ? '收起' : '展开'}任务">${expanded ? '▾' : '▸'}</button>
            <div class="mx-name"><span class="mx-title" title="${esc(p.title)}">${esc(p.title)}</span>
            <span class="mx-id">${esc(p.id)} · ${esc(p.status)}${flag}</span></div>
            <button class="mx-open" title="打开档案">档案</button></div></td>
          ${STAGES.map((_, i) => stageCell(p, i)).join('')}
          ${nodeCell(p)}
        </tr>${expanded ? detail(p) : ''}`;
      }).join('')}</tbody></table>`;
    body.scrollTop = scrollTop;
    body.scrollLeft = scrollLeft;
  }

  /** Feat 栏是否可见（本窗口打开或已弹到独立窗口）。 */
  const featVisible = () => FlowLink.featVisible();

  /** 选中 Feat：Feat 栏可见时同步切换档案，否则只切换当前 Feat（流程图高亮跟随）。 */
  function select(path, id) {
    if (featVisible()) return FlowLink.openFeat(path, 0);
    FlowLink.setFeat(id, path);
  }

  /** 矩阵内的点击：展开、打开档案、阶段/T/子 T 定位、行选中。 */
  async function onClick(e) {
    if (e.target.closest('summary')) return;
    const row = e.target.closest('.mx-row');
    const detailRow = e.target.closest('.mx-detail');
    const owner = row || detailRow?.previousElementSibling;
    if (!owner) return;
    const { path, id } = owner.dataset;
    if (e.target.closest('.mx-toggle')) {
      st.expanded.has(path) ? st.expanded.delete(path) : st.expanded.add(path);
      render();
      return;
    }
    const at = e.target.closest('[data-line]');
    if (e.target.closest('.mx-open') || (at && Number(at.dataset.line))) {
      try { await FlowLink.openFeat(path, at ? Number(at.dataset.line) : 0); }
      catch (error) { $('mx-msg').textContent = String(error); }
      return;
    }
    if (row) {
      try { await select(path, id); }
      catch (error) { $('mx-msg').textContent = String(error); }
    }
  }

  /** 打开矩阵：默认跟随当前 Feat 或当前流程图所在 APP。 */
  function open() {
    Split.show('mx');
    localStorage.setItem('fc-mx-open', '1');
    const ctx = FlowLink.appOf(st.cur) || FlowLink.appOf(FlowLink.curFile());
    if (ctx) st.flowDir = ctx.flow_dir;
    renderApps();
    if (st.cur) st.expanded.add(st.cur);
    load();
  }

  /** 关闭矩阵。 */
  function close() {
    Split.hide('mx');
    localStorage.setItem('fc-mx-open', '0');
  }

  /** 当前 Feat 变化（applyFeat 调用）：切到其 APP、展开并高亮。 */
  function follow(path) {
    const changed = path !== st.cur;
    st.cur = path || '';
    if (!Split.isOpen('mx')) return;
    const a = path && FlowLink.appOf(path);
    if (changed && path) st.expanded.add(path);
    if (!(a && setApp(a.flow_dir))) render();
  }

  /** 打开流程图：当前没有本 APP 的 Feat 时矩阵切到该图所在 APP。 */
  function followFlow(path) {
    if (!Split.isOpen('mx')) return;
    const a = FlowLink.appOf(path);
    if (a && !(st.cur && FlowLink.appOf(st.cur) === a)) setApp(a.flow_dir);
  }

  /** 侧栏汇总刷新后重绘（节点计数、APP 列表变化）。 */
  function refreshed() {
    if (Split.isOpen('mx')) {
      const previous = st.flowDir;
      renderApps();
      if (previous !== st.flowDir) load();
      else render();
    }
  }

  /** 绑定控件；上次关闭前开着矩阵则恢复打开。 */
  function init() {
    $('mx-body').addEventListener('click', onClick);
    $('mx-body').addEventListener('toggle', (e) => {
      const key = e.target.dataset.subKey;
      if (key) e.target.open ? st.subExpanded.add(key) : st.subExpanded.delete(key);
    }, true);
    $('mx-app').onchange = (e) => setApp(e.target.value);
    $('mx-all').onchange = (e) => { st.all = e.target.value === 'all'; localStorage.setItem('fc-mx-all', st.all ? '1' : '0'); render(); };
    $('btn-mx-close').onclick = close;
    $('btn-feat-mx').onclick = open;
    listen('md-changed', reloadSoon);
    listen('flow-changed', reloadSoon);
    if (localStorage.getItem('fc-mx-open') === '1') open();
  }

  return { init, open, close, follow, followFlow, refreshed };
})();
