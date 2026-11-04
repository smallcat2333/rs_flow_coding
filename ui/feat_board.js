// Feat 控件页：把档案按章节解析成专用控件（左侧档案头状态 + 竖向阶段导航，右侧下一步 + 各章节卡片），与文档视图共用同一个 CodeMirror 文本。
// 控件只改对应原文片段（§1.3 勾选框、§4.2 结果 / 备注单元格、§4.3 复测段），经 FeatPane 提供的 edit() 进入编辑器，
// 保存、加锁、撤销与磁盘同步沿用文档视图；档案头状态、§3.1 状态等由 skill 写入的字段只读，给出可复制的 skill 命令。
// 判定词与 progress.rs 同口径：结果列以「通过 / PASS」「不通过 / 失败 / FAIL」开头，T 状态以路线图状态词开头，
// 复测以「复测：通过」为闭环；解析前把 HTML 注释替换为等长空白，模板示例不计入、偏移不变。
// 依赖：live_markdown.js 的 LiveMarkdown.render（Markdown 安全渲染）；feat.js 调用 init(api) 接入编辑器。
'use strict';

window.FeatBoard = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** 阶段页签：k 为章节号；skill 为该章节的生成方，空章节显示其命令。§0 仅在档案有该章节时显示。 */
  const STAGES = [
    { k: '0', name: '探讨', skill: 'smallcat-feat-1-new' },
    { k: '1', name: '需求', skill: 'smallcat-feat-1-new' },
    { k: '2', name: '原型', skill: 'smallcat-feat-2-ui' },
    { k: '3', name: '开发', skill: 'smallcat-feat-3-dev' },
    { k: '4', name: '测试', skill: 'smallcat-feat-4-test' },
    { k: '5', name: '发布', skill: 'smallcat-feat-5-close' },
  ];
  /** 档案头状态 → 样式类（§2.11.4 词表），词表外为 unknown。 */
  const STATUS_CLS = [['探讨中', 'talk'], ['需求整理中', 'req'], ['开发中', 'dev'], ['测试中', 'test'], ['已暂停', 'paused'], ['已关闭', 'closed'], ['已废弃', 'dropped']];
  /** 路线图状态词（与 progress.rs task_state 同序：先判「待用户确认」）。 */
  const TASK_WORDS = [['待用户确认', 'waiting'], ['待开发', 'todo'], ['进行中', 'doing'], ['完成', 'done'], ['暂缓', 'paused'], ['取消', 'cancelled']];
  const TASK_NAME = { waiting: '待用户确认', todo: '待开发', doing: '进行中', done: '完成', paused: '暂缓', cancelled: '取消', unknown: '未识别' };
  const VERDICT_WORD = /^(不通过|失败|FAIL|通过|PASS)/i;
  const ICON_SRC = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 2h5v5M14 2 7 9"/></svg>';
  const ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';

  let api = null;          // feat.js 提供的接口，见 init 注释
  const st = {
    path: '',              // 当前渲染的档案；换档案时页签回到当前阶段
    tab: '',               // 当前页签章节号
    selectedT: '',         // 开发页选中的 T；只控制详情区，开发记录始终完整显示
    onlyTodo: false,       // 测试页：§4.2 只看未填
    open: new Set(),       // 展开的开发记录（记录标题行号）；空表示默认展开最新一条
    openTouched: false,    // 用户手动展开 / 收起过记录后不再套用默认
    focusKey: '',          // 下次渲染后要聚焦的控件 data-key
    dirty: true,           // 隐藏期间文本变化，显示时重绘
    raf: 0,                // 待执行的重绘定时器
    holdRender: false,     // 备注输入未提交时推迟重绘，避免打断输入
  };
  let acts = [];           // 本次渲染登记的控件动作，data-act 为下标
  let mds = [];            // 本次渲染待填入的 Markdown 片段

  // ---------------- 解析 ----------------

  /** HTML 注释替换为等长空白（保留换行）：模板示例不参与解析，字符偏移与原文一致。 */
  const mask = (text) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

  /** 占位或空：去掉空行与以 `<` 开头的模板占位后没有内容（与 progress.rs meaningful 同口径）。 */
  const meaningful = (body) => (body || []).filter((l) => l.t.trim() && !l.t.trim().startsWith('<')).length;

  /**
   * 解析档案结构。输入原文，输出 { title, status, statusN, app, created, closed, h2: {章}, sec: {小节} }：
   * h2 键为章节号（'0'–'5'），body 为到下一个二级标题前的行；sec 键为 '1.3' 这类小节号，body 到下一个编号小节或二级标题前；
   * 非编号的三级标题（§0 / §2.1 的 R<N>、§3.2 的日期记录）归入所在小节。每行 { t, from, n, code }：
   * t 为注释已抹掉的文本，from 为行首偏移，n 为 1 起行号，code 表示位于 ``` / ~~~ 代码块内。
   */
  function parse(text) {
    const d = { text, title: '', status: '', statusN: 0, app: '', created: '', closed: '', h2: {}, sec: {} };
    let from = 0, fence = '', h2 = null, h3 = null;
    mask(text).split('\n').forEach((t, i) => {
      const l = { t, from, n: i + 1, code: false };
      from += t.length + 1;
      const f = t.match(/^\s*(```|~~~)/);
      if (fence || f) {
        l.code = true;
        if (f) fence = fence ? (fence === f[1] ? '' : fence) : f[1];
      } else {
        const hd = t.match(/^(#{1,3})\s+(.*?)\s*$/);
        if (hd && hd[1] === '#' && !d.title) { d.title = hd[2]; return; }
        if (hd && hd[1] === '##') {
          const k = (hd[2].match(/^(\d+)\./) || [])[1];
          h2 = k ? (d.h2[k] = { k, title: hd[2], n: l.n, body: [] }) : null;
          h3 = null;
          return;
        }
        const k3 = hd && hd[1] === '###' && (hd[2].match(/^(\d+\.\d+)\s/) || hd[2].match(/^(\d+\.\d+)$/) || [])[1];
        if (k3) { h3 = d.sec[k3] = { k: k3, title: hd[2], n: l.n, body: [] }; if (h2) h2.body.push(l); return; }
        const kv = !h2 && t.match(/^>\s*(状态|应用|创建)[：:]\s*(.*)$/);
        if (kv) {
          if (kv[1] === '状态') { d.status = kv[2].trim(); d.statusN = l.n; }
          else if (kv[1] === '应用') d.app = kv[2].trim();
          else {
            const c = kv[2].match(/^(.*?)\s*关闭[：:]\s*(.*)$/);
            d.created = (c ? c[1] : kv[2]).trim();
            d.closed = c ? c[2].trim() : '';
          }
          return;
        }
      }
      if (h2) h2.body.push(l);
      if (h3) h3.body.push(l);
    });
    return d;
  }

  /** 小节的行；小节不存在时为空数组。 */
  const body = (d, k) => (d.sec[k] || { body: [] }).body;

  /**
   * 拆一行表格为单元格：[{ text, from, to, raw }]，from/to 为两侧竖线之间（含空白）的文档偏移，
   * raw 为原文该段（写回前用来确认内容未变），text 为去空白并还原 `\|` 的显示文本；末尾竖线后的空段不计。
   */
  function splitRow(d, l) {
    const s = l.t, cells = [];
    let a = s.indexOf('|') + 1;
    for (let i = a; i <= s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (i === s.length || s[i] === '|') {
        cells.push({ text: s.slice(a, i).trim().replace(/\\\|/g, '|'), from: l.from + a, to: l.from + i, raw: d.text.slice(l.from + a, l.from + i) });
        a = i + 1;
      }
    }
    if (cells.length && !cells[cells.length - 1].text && /\|\s*$/.test(s)) cells.pop();
    return cells;
  }

  /** 区间内的表格：[{ head: [列名], n: 表头行号, rows: [{ n, cells }] }]；分隔行跳过，首列以 `<` 开头的模板占位行不计。 */
  function tables(d, lines) {
    const out = [];
    let cur = null;
    for (const l of lines) {
      if (l.code || !l.t.trim().startsWith('|')) { cur = null; continue; }
      const cells = splitRow(d, l);
      if (!cur) { cur = { head: cells.map((c) => c.text), n: l.n, rows: [] }; out.push(cur); continue; }
      if (cells.every((c) => /^:?-+:?$/.test(c.text))) continue;
      if (cells[0]?.text.startsWith('<')) continue;
      cur.rows.push({ n: l.n, cells });
    }
    return out;
  }

  /** 列名中含 word 的列下标；没有时为 fallback。 */
  const col = (head, word, fallback = -1) => { const i = head.findIndex((h) => h.includes(word)); return i >= 0 ? i : fallback; };

  /** 列表项（`- ` / `* ` / `+ ` 开头，不含勾选框）：[{ n, from, text }]，text 为符号后的内容。 */
  function bullets(lines) {
    return lines.filter((l) => !l.code && /^\s*[-*+]\s+(?!\[[ xX]\])/.test(l.t))
      .map((l) => ({ n: l.n, from: l.from, text: l.t.replace(/^\s*[-*+]\s+/, '').trim() }))
      .filter((b) => b.text && !b.text.startsWith('<'));
  }

  /** 勾选框：[{ n, done, pos, text }]，pos 为方括号内字符的偏移；`<` 开头的模板占位不计。 */
  function checks(lines) {
    const out = [];
    for (const l of lines) {
      const m = !l.code && l.t.match(/^(\s*[-*+]\s+\[)([ xX])\]\s*(.*)$/);
      if (m && m[3].trim() && !m[3].trim().startsWith('<')) out.push({ n: l.n, done: m[2] !== ' ', mark: m[2], pos: l.from + m[1].length, text: m[3].trim() });
    }
    return out;
  }

  /** 测试结果：pass / fail / other（有字但不是判定词）/ ''（未填），与 progress.rs verdict 同口径。 */
  function verdict(s) {
    const c = s.trim(), u = c.toUpperCase();
    if (c.startsWith('不通过') || c.startsWith('失败') || u.startsWith('FAIL')) return 'fail';
    if (c.startsWith('通过') || u.startsWith('PASS')) return 'pass';
    return c ? 'other' : '';
  }

  /** 路线图状态词：允许前导 `*` 与空白，其他开头为 unknown。 */
  function taskState(raw) {
    const s = raw.trim().replace(/^\*+/, '').trim();
    return (TASK_WORDS.find(([w]) => s.startsWith(w)) || [, 'unknown'])[1];
  }

  /** 从文本取 T 编号（含子号），去重保序。 */
  const tids = (s) => [...new Set(String(s).match(/T\d+(?:\.\d+)?/g) || [])];

  /** 依赖列取父 T 编号：支持「T1、T2」与区间「T1～T7」「T1-T3」；「生命周期契约」等说明文字只保留在原文中。 */
  function depIds(s) {
    const out = [];
    for (const m of String(s).matchAll(/T(\d+)(?:\.\d+)?(?:\s*[~～\-–—至到]\s*T?(\d+))?/g)) {
      const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
      for (let i = a; i <= Math.min(b, a + 50); i++) out.push('T' + i);
    }
    return [...new Set(out)];
  }

  /** 「键：值」形式的记录条目（§0 决策 / 依据 / 待确认，§2.1 共识 / 否决 / 待定，§3.2 方案 / 结果）。 */
  function kvItems(lines) {
    return bullets(lines).map((b) => {
      const m = b.text.match(/^([^：:]{1,8})[：:]\s*(.*)$/);
      return m ? { key: m[1].trim(), value: m[2], n: b.n } : { key: '', value: b.text, n: b.n };
    });
  }

  /** 按非编号三级标题切出记录：[{ n, title, lines }]；标题须匹配 re，标题前的行忽略。 */
  function records(lines, re) {
    const out = [];
    let cur = null;
    for (const l of lines) {
      const m = !l.code && l.t.match(/^###\s+(.*?)\s*$/);
      if (m && re.test(m[1])) { cur = { n: l.n, title: m[1], lines: [] }; out.push(cur); continue; }
      if (cur) cur.lines.push(l);
    }
    return out;
  }

  /** 「待确认 / 待定」类条目是否仍有内容：空、无、- 视为已收敛。 */
  const isPending = (v) => !!v && !/^(无|没有|-|—|\/|无。)$/.test(v.trim());

  /**
   * 汇总控件页需要的数据：在 parse 结果上补 §1.3 勾选、§3.1 T、§3.2 记录、§4.1 / §4.2 表、§4.3 问题与各阶段统计。
   */
  function model(text) {
    const d = parse(text);
    d.checks = checks(body(d, '1.3'));
    d.talks = d.h2['0'] ? records(d.h2['0'].body, /^R\d+/).map((r) => ({ ...r, items: kvItems(r.lines) })) : [];
    d.uiTalks = records(body(d, '2.1'), /^R\d+/).map((r) => ({ ...r, items: kvItems(r.lines) }));

    const road = tables(d, body(d, '3.1'))[0];
    d.tasks = road ? road.rows.filter((r) => /^T\d+$/.test(r.cells[0]?.text || '')).map((r) => {
      const c = (i) => r.cells[i]?.text || '';
      const raw = c(col(road.head, '状态', road.head.length - 1));
      const depRaw = c(col(road.head, '依赖', 2));
      return { id: c(0), title: c(1), deps: depIds(depRaw), depRaw, par: tids(c(col(road.head, '并行', 3))), raw, state: taskState(raw), n: r.n };
    }) : [];

    d.devs = records(body(d, '3.2'), /^\d{4}-\d{2}-\d{2}/).map((r) => {
      const m = r.title.match(/^(\d{4}-\d{2}-\d{2})\s*((?:\[[^\]]*\]\s*)*)(.*)$/);
      const subs = new Map();
      for (const t of tables(d, r.lines)) {
        if (!t.head.some((h) => h.includes('子任务'))) continue;
        const si = col(t.head, '状态', t.head.length - 1), gi = col(t.head, '目标', 2), ei = col(t.head, '执行', 1);
        for (const row of t.rows) {
          const id = row.cells[0]?.text || '';
          if (!/^T\d+\.\d+$/.test(id)) continue;
          const raw = row.cells[si]?.text || '';
          subs.delete(id);  // 同一子号多行时以最后一行为准，并排到末尾
          subs.set(id, { id, goal: row.cells[gi]?.text || '', who: row.cells[ei]?.text || '', raw, state: taskState(raw), n: row.n });
        }
      }
      const rest = r.lines.filter((l) => !l.t.trim().startsWith('|'));
      return { n: r.n, date: m ? m[1] : r.title, ts: m ? tids(m[2]) : [], title: m ? m[3].trim() : '', items: kvItems(rest), subs: [...subs.values()], lines: rest };
    });

    d.auto = tables(d, body(d, '4.1'))[0] || null;
    d.manual = tables(d, body(d, '4.2'))[0] || null;
    d.issues = bullets(body(d, '4.3')).map((b) => {
      const line = d.text.slice(b.from, d.text.indexOf('\n', b.from) < 0 ? d.text.length : d.text.indexOf('\n', b.from)).replace(/\s+$/, '');
      const head = b.text.match(/^(\d{4}-\d{2}-\d{2})\s*(.*)$/);
      const parts = (head ? head[2] : b.text).split(/\s*->\s*/);
      const re = /复测[：:]\s*/g;
      let hit = null, m;
      while ((m = re.exec(line))) hit = m;
      const retest = hit ? { from: b.from + hit.index + hit[0].length, to: b.from + line.length } : null;
      if (retest) retest.raw = d.text.slice(retest.from, retest.to);
      const value = retest ? retest.raw.trim() : '';
      if (parts.length && /^复测[：:]/.test(parts[parts.length - 1])) parts.pop();
      return { n: b.n, date: head ? head[1] : '', problem: parts[0] || '', fix: parts.slice(1).join(' -> '), retest, value, closed: /复测[：:]\s*通过/.test(line) };
    });

    const tally = (t) => {
      const ri = t ? col(t.head, '结果') : -1;
      const s = { total: t ? t.rows.length : 0, pass: 0, fail: 0, filled: 0 };
      if (ri >= 0) for (const r of t.rows) {
        const v = verdict(r.cells[ri]?.text || '');
        s.pass += v === 'pass'; s.fail += v === 'fail'; s.filled += !!v;
      }
      return s;
    };
    const live = d.tasks.filter((t) => !['paused', 'cancelled'].includes(t.state));
    d.stats = {
      checks: { total: d.checks.length, done: d.checks.filter((c) => c.done).length },
      tasks: { total: live.length, done: live.filter((t) => t.state === 'done').length, waiting: d.tasks.filter((t) => t.state === 'waiting').length },
      auto: tally(d.auto), manual: tally(d.manual),
      issues: { total: d.issues.length, open: d.issues.filter((i) => !i.closed).length },
      talks: d.talks.filter((r) => r.items.some((it) => it.key.startsWith('待') && isPending(it.value))).length,
    };
    d.stage = currentStage(d);
    return d;
  }

  /** 档案当前阶段对应的页签：按档案头状态，暂停 / 废弃 / 词表外按已有内容推断（与 progress.rs 同口径）。 */
  function currentStage(d) {
    const s = d.status, ui = meaningful(body(d, '2.1')) > 0;
    if (s.startsWith('探讨中')) return d.h2['0'] ? '0' : '1';
    if (s.startsWith('需求整理中')) return ui ? '2' : '1';
    if (s.startsWith('开发中')) return '3';
    if (s.startsWith('测试中')) return '4';
    if (s.startsWith('已关闭')) return '5';
    return d.stats.auto.total + d.stats.manual.total ? '4' : d.tasks.length ? '3' : ui ? '2' : '1';
  }

  // ---------------- 渲染工具 ----------------

  /** 登记一个控件动作，返回 data-act 属性；只读时渲染后统一禁用。 */
  const act = (fn) => { acts.push(fn); return `data-act="${acts.length - 1}"`; };

  /** Markdown 片段占位，渲染后由 LiveMarkdown.render 填入；inline 时去掉单段落外层 <p>。 */
  function md(text, inline = false) {
    mds.push({ text, inline });
    return `<div class="fb-md${inline ? ' inline' : ''}" data-md="${mds.length - 1}"></div>`;
  }

  /** 行内显示的表格单元格（含行内格式与节点引用）。 */
  const cell = (text) => text ? md(text, true) : '<span class="fb-none">—</span>';

  /** 定位原文按钮：切到文档视图并跳到该行。 */
  const src = (n) => `<button class="fb-src" data-line="${n}" title="在文档视图中定位原文（第 ${n} 行）" aria-label="定位原文">${ICON_SRC}</button>`;

  /** 可复制的 skill 命令。 */
  const cmd = (text) => `<button class="fb-cmd" data-copy="${esc(text)}" title="复制命令，粘贴给 Agent 执行"><code>${esc(text)}</code>${ICON_COPY}</button>`;

  /** 小节卡片：标题 + 定位原文 + 内容；sec 不存在时标题仍显示，内容为空状态。 */
  function card(d, k, name, inner, extra = '') {
    const s = d.sec[k];
    return `<section class="fb-card" data-line="${s ? s.n : ''}">
      <header class="fb-card-head"><h3><span class="fb-no">§${k}</span>${esc(name)}</h3>${extra}<span class="spacer"></span>${s ? src(s.n) : ''}</header>
      ${inner}</section>`;
  }

  /** 空状态：说明由哪个 skill 生成，并给出命令。 */
  const empty = (text, skill) => `<div class="fb-empty"><span>${esc(text)}</span>${skill ? cmd(`/${skill} ${api.id()}`) : ''}</div>`;

  /** 普通 Markdown 小节：有内容渲染原文，否则空状态。 */
  function mdBody(d, lines, skill) {
    const text = lines.map((l) => l.t).join('\n');
    return meaningful(lines) ? `<div class="fb-prose">${md(text)}</div>` : empty('尚未填写', skill);
  }

  /** 进度环：done / total，total 为 0 时显示空环。 */
  function ring(done, total, tone = 'ok') {
    const r = 15, c = 2 * Math.PI * r, p = total ? done / total : 0;
    return `<span class="fb-ring ${tone}" role="img" aria-label="${done} / ${total}"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="${r}"/><circle class="v" cx="18" cy="18" r="${r}" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}"/></svg><b>${done}<i>/${total}</i></b></span>`;
  }

  /** 状态药丸：cls 决定颜色，text 为显示文字，title 为完整原文。 */
  const pill = (cls, text, title = '') => `<span class="fb-pill ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

  /**
   * 写回原文：先确认 [from, to) 仍是渲染时的 expect，否则说明文本已变，重绘后放弃本次操作；
   * Agent 持锁只读时不写。成功返回 true。
   */
  function edit(from, to, expect, insert) {
    if (api.readOnly()) { api.notify('Agent 正在编辑，暂时不能修改', true); return false; }
    if (api.text().slice(from, to) !== expect) { api.notify('档案内容已变化，已刷新，请重试', true); schedule(); return false; }
    api.edit({ from, to, insert });
    return true;
  }

  /** 写一个表格单元格：竖线转义、换行压成空格，两侧各留一个空格。 */
  const writeCell = (c, value) => edit(c.from, c.to, c.raw, ` ${String(value).replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|')} `);

  // ---------------- 档案头与下一步 ----------------

  /** 下一步建议：[{ tone, text, cmd }]，按档案头状态与各阶段统计给出；状态流转只给 skill 命令，不直接改档案头。 */
  function nextSteps(d) {
    const id = api.id(), s = d.status, x = d.stats, out = [];
    const add = (tone, text, command = '') => out.push({ tone, text, command });
    if (s.startsWith('已废弃')) add('muted', 'Feat 已废弃，档案仅供追溯。');
    else if (s.startsWith('已关闭')) add('ok', 'Feat 已关闭，可以生成功能介绍页。', `/smallcat-feat-7-showcase ${id}`);
    else if (s.startsWith('已暂停')) add('warn', 'Feat 已暂停；恢复推进时回到当前阶段对应的 skill。');
    else if (s.startsWith('探讨中')) {
      add('info', x.talks ? `探讨记录里还有 ${x.talks} 条待确认，继续探讨收敛需求。` : '探讨已收敛，可以整理成正式需求。', `/smallcat-feat-1-new ${id}`);
    } else if (s.startsWith('需求整理中')) {
      if (!x.checks.total) add('warn', '§1.3 验收标准还没写，先补全需求。', `/smallcat-feat-1-new ${id}`);
      else {
        add('info', '需求已整理：有界面改动先探讨 UI，', `/smallcat-feat-2-ui ${id}`);
        add('info', '否则直接拆开发任务。', `/smallcat-feat-3-dev ${id}`);
      }
    } else if (s.startsWith('开发中')) {
      const live = d.tasks.filter((t) => !['paused', 'cancelled'].includes(t.state));
      const waiting = d.tasks.filter((t) => t.state === 'waiting');
      const doneIds = new Set(d.tasks.filter((t) => t.state === 'done').map((t) => t.id));
      if (!d.tasks.length) add('info', '还没有任务路线图，先拆解 T。', `/smallcat-feat-3-dev ${id}`);
      if (waiting.length) add('warn', `${waiting.map((t) => t.id).join('、')} 待你确认：验证后在开发页复制确认命令交给 Agent。`);
      if (live.length && live.every((t) => t.state === 'done')) add('ok', '开发任务已全部完成，可以开始测试。', `/smallcat-feat-4-test ${id}`);
      else {
        const ready = live.find((t) => ['doing', 'todo'].includes(t.state) && t.deps.every((p) => doneIds.has(p)));
        if (ready) add('info', `下一个可推进：${ready.id} ${ready.title}（${TASK_NAME[ready.state]}）`, `/smallcat-feat-3-dev ${id} ${ready.id}`);
      }
    } else if (s.startsWith('测试中')) {
      const m = x.manual, a = x.auto;
      if (m.total > m.filled) add('warn', `人工确认还剩 ${m.total - m.filled} 项未填，在测试页逐项点 OK / NG。`);
      if (m.fail || a.fail) add('err', `有 ${m.fail + a.fail} 项不通过：先交给 feat-4-test 记入 §4.3，再在新会话修复。`, `/smallcat-feat-4-test ${id}`);
      else if (x.issues.open) add('err', `§4.3 还有 ${x.issues.open} 个问题未复测通过，修复后复测。`, `/smallcat-feat-3-dev ${id}`);
      else if (m.total && m.filled === m.total && a.pass === a.total) add('ok', '测试全部通过，可以关闭 Feat。', `/smallcat-feat-5-close ${id}`);
    } else add('warn', `档案头状态「${s || '空'}」不在词表中，请在文档视图修正。`);
    return out;
  }

  /**
   * 阶段内的章节目录：§0 列 R 记录，§1–§4 列编号小节（去掉括号里的补充说明），§5 不列。
   * 输出 [{ n: 标题行号（与卡片 data-line 一致）, title, filled: 是否有内容 }]。
   */
  function chapters(d, k) {
    if (k === '0') return d.talks.map((r) => ({ n: r.n, title: r.title, filled: true }));
    if (k === '5') return [];
    return Object.values(d.sec).filter((s) => s.k.split('.')[0] === k).sort((a, b) => a.n - b.n)
      .map((s) => ({ n: s.n, title: s.title.replace(/[（(].*$/, '').trim(), filled: meaningful(s.body) > 0 }));
  }

  /** 按下一步建议生成两组 HTML：纯状态提示在正文外悬浮，带复制命令的建议保留在正文内。 */
  function nexts(d) {
    const steps = nextSteps(d);
    /** 保留提示颜色与命令按钮的现有结构，正文外只渲染无交互的提示。 */
    const item = (x) => `<div class="fb-next ${x.tone}"><span class="fb-next-dot" aria-hidden="true"></span><span class="fb-next-text">${esc(x.text)}</span>${x.command ? cmd(x.command) : ''}</div>`;
    const notices = steps.filter((x) => !x.command).map(item).join('');
    const commands = steps.filter((x) => x.command).map(item).join('');
    return { notices, commands: commands ? `<div class="fb-nexts" aria-label="下一步">${commands}</div>` : '' };
  }

  /**
   * 左侧阶段导航：顶部为档案头状态徽标与应用 / 创建 / 关闭，下方为竖向阶段轴（点 + 连线，已过为绿、当前为蓝）。
   * 每个阶段一行名称 + 角标、一行摘要；点击切换右侧页面。角标在待确认时标黄，有不通过或未闭环问题时标红。
   */
  function rail(d) {
    const x = d.stats, cur = STAGES.findIndex((s) => s.k === d.stage);
    const cls = (STATUS_CLS.find(([w]) => d.status.startsWith(w)) || [, 'unknown'])[1];
    const controls = tables(d, body(d, '2.2'))[0]?.rows.length || 0;
    const issues = x.manual.fail + x.auto.fail + x.issues.open;
    /** 各阶段：[角标, 角标色, 摘要]。 */
    const info = {
      0: [x.talks ? `${x.talks} 待确认` : '', 'warn', d.talks.length ? `记录 ${d.talks.length} 条` : '无记录'],
      1: [x.checks.total ? `${x.checks.done}/${x.checks.total}` : '', '', x.checks.total ? '验收标准' : '验收未写'],
      2: [controls ? String(controls) : '', '', controls ? '控件' : meaningful(body(d, '2.1')) ? '已有总纲' : '未开始'],
      3: [x.tasks.total ? `${x.tasks.done}/${x.tasks.total}` : '', x.tasks.waiting ? 'warn' : '', x.tasks.total ? (x.tasks.waiting ? `待确认 ${x.tasks.waiting}` : '任务完成') : '未拆任务'],
      4: [x.manual.total ? `${x.manual.filled}/${x.manual.total}` : '', issues ? 'err' : x.manual.filled < x.manual.total ? 'warn' : '',
        x.manual.total + x.auto.total ? [x.manual.total ? '人工确认' : '程序自测', x.manual.fail + x.auto.fail ? `NG ${x.manual.fail + x.auto.fail}` : '', x.issues.open ? `问题 ${x.issues.open}` : ''].filter(Boolean).join(' · ') : '未开始'],
      5: [meaningful(d.h2['5']?.body) ? '✓' : '', '', meaningful(d.h2['5']?.body) ? '已生成' : '未生成'],
    };
    const meta = [['应用', d.app], ['创建', d.created], ['关闭', d.closed]].filter(([, v]) => v)
      .map(([k, v]) => `<div class="fb-meta-item"><i>${k}</i>${esc(v)}</div>`).join('');
    const stages = STAGES.filter((s) => s.k !== '0' || d.h2['0']).map((s) => {
      const i = STAGES.indexOf(s), [b, tone, sum] = info[s.k];
      const pos = i < cur ? 'past' : i === cur ? 'current' : 'future';
      // 开发阶段常驻 T 状态小标签（点击跳到路线图对应节点）；当前选中的阶段下列出章节，点击滚动到该卡片。
      const chips = s.k === '3' && d.tasks.length ? `<div class="fb-tchips">${d.tasks.map((t) => `<button class="fb-tchip t-${t.state}" data-tjump="${esc(t.id)}" title="${esc(`${t.id} ${t.title}\n${TASK_NAME[t.state]}${t.raw && t.raw !== TASK_NAME[t.state] ? '：' + t.raw : ''}`)}">${esc(t.id)}</button>`).join('')}</div>` : '';
      const toc = st.tab === s.k ? chapters(d, s.k) : [];
      return `<div class="fb-stage-item ${pos}">
        <button class="fb-stage ${pos}${st.tab === s.k ? ' on' : ''}" role="tab" aria-selected="${st.tab === s.k}" data-tab="${s.k}" title="${pos === 'current' ? '当前阶段' : pos === 'past' ? '已过阶段' : '未到阶段'}">
        <span class="fb-stage-dot" aria-hidden="true"></span>
        <span class="fb-stage-name">${s.name}${b ? `<span class="fb-badge ${tone}">${esc(b)}</span>` : ''}</span>
        <span class="fb-stage-sum">${esc(sum)}</span></button>
        ${chips}${toc.length ? `<ol class="fb-toc">${toc.map((c) => `<li><button class="${c.filled ? '' : 'blank'}" data-jump="${c.n}" title="${esc(c.title)}${c.filled ? '' : '（未填写）'}">${esc(c.title)}</button></li>`).join('')}</ol>` : ''}
      </div>`;
    }).join('');
    // 外层撑满高度画背景与分隔线，内层吸顶：内容区滚动时导航保持可见。
    return `<nav class="fb-rail" aria-label="Feat 阶段"><div class="fb-rail-in">
      <div class="fb-rail-head"><span class="fb-status s-${cls}" data-line="${d.statusN}" title="${esc(d.status)}">${esc(d.status || '无状态')}</span>${d.statusN ? src(d.statusN) : ''}</div>
      ${meta ? `<div class="fb-meta">${meta}</div>` : ''}
      <div class="fb-stages" role="tablist" aria-orientation="vertical">${stages}</div>
    </div></nav>`;
  }

  // ---------------- 各阶段页 ----------------

  /** R<N> 记录卡片（§0 / §2.1）：最新在前；「待…」条目仍有内容时整卡标黄并显示待办。 */
  function talkCards(list) {
    return `<div class="fb-timeline">${[...list].reverse().map((r) => {
      const pending = r.items.some((it) => it.key.startsWith('待') && isPending(it.value));
      return `<article class="fb-talk${pending ? ' pending' : ''}" data-line="${r.n}">
        <header><b>${esc(r.title)}</b>${pending ? pill('warn', '待确认') : ''}<span class="spacer"></span>${src(r.n)}</header>
        <dl>${r.items.map((it) => `<dt class="${it.key.startsWith('待') && isPending(it.value) ? 'warn' : ''}">${esc(it.key || '·')}</dt><dd>${cell(it.value)}</dd>`).join('')}</dl></article>`;
    }).join('')}</div>`;
  }

  /** 探讨页（§0）。 */
  function page0(d) {
    const s = d.h2['0'];
    return `<section class="fb-card" data-line="${s.n}"><header class="fb-card-head"><h3><span class="fb-no">§0</span>探讨记录</h3><span class="spacer"></span>${src(s.n)}</header>
      ${d.talks.length ? talkCards(d.talks) : empty('还没有探讨记录', 'smallcat-feat-1-new')}</section>`;
  }

  /** §1.4 中出现的流程图与节点引用 → 标签；节点颜色取挂了本 Feat 标签的节点状态。 */
  function flowChips(d) {
    const text = body(d, '1.4').map((l) => l.t).join('\n');
    const nodes = api.nodes();
    const seen = new Set(), chips = [];
    for (const m of text.matchAll(/([\w一-龥.-]+\.drawio)(?:#([\w-]+))?/g)) {
      const name = m[1].split('/').pop(), id = m[2] || '', key = name + '#' + id;
      if (seen.has(key)) continue;
      seen.add(key);
      const node = id && nodes.find((n) => n.id === id && n.file.split(/[\\/]/).pop() === name);
      chips.push(`<button class="fb-flow" ${act(() => api.openFlow(name, id))} title="${esc(id ? `${name}#${id}${node ? '\n' + (node.label || '') : ''}` : '打开流程图 ' + name)}">
        <span class="sw s-${node ? node.status : id ? 'none' : 'file'}"></span><span class="fb-flow-name">${esc(name.replace(/\.drawio$/, ''))}</span>${id ? `<span class="fb-flow-id">#${esc(id)}</span>${node?.label ? `<span class="fb-flow-label">${esc(node.label)}</span>` : ''}` : ''}</button>`);
    }
    return chips.length ? `<div class="fb-flows">${chips.join('')}</div>` : '';
  }

  /** 需求页（§1）：背景、目标卡（上下排列，内容常含长表格）、验收清单（可勾选）、初步路线与影响的流程图。 */
  function page1(d) {
    const x = d.stats.checks;
    const list = d.checks.length ? `<ul class="fb-checks">${d.checks.map((c, i) => `<li class="${c.done ? 'done' : ''}" data-line="${c.n}">
      <button class="fb-check" role="checkbox" aria-checked="${c.done}" data-key="chk-${i}" ${act(() => edit(c.pos, c.pos + 1, c.mark, c.done ? ' ' : 'x'))} title="${c.done ? '取消勾选' : '勾选'}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8 3 3 5-6"/></svg></button>
      ${cell(c.text)}</li>`).join('')}</ul>` : empty('还没有验收标准', 'smallcat-feat-1-new');
    return `${card(d, '1.1', '背景', mdBody(d, body(d, '1.1'), 'smallcat-feat-1-new'))}
      ${card(d, '1.2', '目标', mdBody(d, body(d, '1.2'), 'smallcat-feat-1-new'))}
      ${card(d, '1.3', '验收标准', list, x.total ? ring(x.done, x.total) : '')}
      ${card(d, '1.4', '初步路线', flowChips(d) + mdBody(d, body(d, '1.4'), 'smallcat-feat-1-new'))}`;
  }

  /** 原型页（§2）：设计总纲 + UI 探讨记录、控件清单、交互说明、变更时间线、截图。 */
  function page2(d) {
    const s21 = body(d, '2.1');
    const cut = s21.findIndex((l) => /^#{3,4}\s+(UI 探讨记录|R\d+)/.test(l.t));
    const main = cut < 0 ? s21 : s21.slice(0, cut);
    const ctl = tables(d, body(d, '2.2'))[0];
    const controls = ctl && ctl.rows.length ? `<div class="fb-controls">${ctl.rows.map((r) => `<div class="fb-control" data-line="${r.n}">
      <code>${esc(r.cells[0]?.text || '')}</code>${r.cells[1]?.text ? `<span class="fb-type">${esc(r.cells[1].text)}</span>` : ''}<span class="fb-use">${cell(r.cells.slice(2).map((c) => c.text).filter(Boolean).join('；'))}</span></div>`).join('')}</div>`
      : empty('控件清单为空', 'smallcat-feat-2-ui');
    const logs = bullets(body(d, '2.4'));
    const timeline = logs.length ? `<ol class="fb-log">${[...logs].reverse().map((b) => {
      const m = b.text.match(/^(\d{4}-\d{2}-\d{2})\s*(.*)$/);
      return `<li data-line="${b.n}"><time>${esc(m ? m[1] : '')}</time><div>${cell(m ? m[2] : b.text)}</div></li>`;
    }).join('')}</ol>` : empty('还没有 UI 变更', '');
    const shots = body(d, '2.5');
    return `${card(d, '2.1', '设计总纲', mdBody(d, main, 'smallcat-feat-2-ui') + (d.uiTalks.length ? `<h4 class="fb-sub">UI 探讨记录</h4>${talkCards(d.uiTalks)}` : ''))}
      ${card(d, '2.2', '控件清单', controls, ctl ? pill('muted', `${ctl.rows.length} 个`) : '')}
      ${card(d, '2.3', '交互说明', mdBody(d, body(d, '2.3'), 'smallcat-feat-2-ui'))}
      ${card(d, '2.4', 'UI 变更日志', timeline)}
      ${card(d, '2.5', '截图', meaningful(shots) ? `<div class="fb-prose">${md(shots.map((l) => l.t).join('\n'))}</div><p class="fb-hint">截图为本地文件，在文件夹中查看。</p>` : empty('开发 / 测试阶段补充截图', ''))}`;
  }

  /** 依赖图排版尺寸：节点保留两行标题，窄栏转为纵向并按可用宽度折行，不缩小字体。 */
  const G = { w: 188, h: 74, gap: 32, rowGap: 14, pad: 12 };

  /**
   * 输出依赖图节点与连线，保留依赖深度、排序与两端下标；实际坐标由 layoutGraph 根据图容器宽度计算。
   * 同编号行全部显示，依赖连到最后一行；缺失依赖不画线，循环依赖用访问集合终止递归。
   * 点击只切换任务详情，不筛选开发记录。
   */
  function taskGraph(d) {
    const list = d.tasks, at = new Map(list.map((t, i) => [t.id, i]));
    const depth = [], visiting = new Set();
    /** 从前置任务递归计算层次，回访环内节点时结束当前分支。 */
    const deep = (i) => {
      if (depth[i] != null) return depth[i];
      if (visiting.has(i)) return 0;
      visiting.add(i);
      const ds = list[i].deps.map((p) => at.get(p)).filter((j) => j != null && j !== i);
      depth[i] = ds.length ? 1 + Math.max(...ds.map(deep)) : 0;
      visiting.delete(i);
      return depth[i];
    };
    list.forEach((_, i) => deep(i));
    const edges = [];
    list.forEach((t, i) => t.deps.forEach((p) => {
      const j = at.get(p);
      if (j == null || j === i) return;
      const tone = list[j].state === 'done' ? 'done' : ['cancelled', 'paused', 'unknown'].includes(list[j].state) ? 'muted' : 'pending';
      edges.push(`<path class="fb-edge ${tone}" data-from="${esc(p)}" data-to="${esc(t.id)}" data-source="${j}" data-target="${i}" marker-end="url(#fb-arrow-${tone})"/>`);
    }));
    const marker = (tone) => `<marker id="fb-arrow-${tone}" class="${tone}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8z"/></marker>`;
    const nodes = list.map((t, i) => {
      const tip = [`${t.id} ${t.title}`, `状态：${t.raw || '未填'}`, t.depRaw && t.depRaw !== '-' ? `依赖：${t.depRaw}` : '无依赖', '点击查看任务详情，再点取消选中'].join('\n');
      return `<button class="fb-node t-${t.state}${st.selectedT === t.id ? ' on' : ''}" data-level="${depth[i]}" data-node="${esc(t.id)}" data-deps="${esc(t.deps.join(' '))}" data-line="${t.n}" data-key="task-${esc(t.id)}" aria-pressed="${st.selectedT === t.id}" title="${esc(tip)}" ${act(() => selectTask(t.id))}>
        <span class="fb-node-head"><b>${esc(t.id)}</b><span class="fb-node-st">${TASK_NAME[t.state]}</span></span>
        <span class="fb-node-title">${esc(t.title)}</span></button>`;
    }).join('');
    return `<div class="fb-graph" role="group" aria-label="任务依赖关系图"><div class="fb-graph-in">
      <svg aria-hidden="true"><defs>${['done', 'pending', 'muted'].map(marker).join('')}</defs>${edges.join('')}</svg>${nodes}</div></div>
      <div class="fb-legend"><span><i class="done"></i>前置已完成</span><span><i class="pending"></i>前置未完成</span><span><i class="muted"></i>前置暂缓 / 取消 / 未识别</span></div>`;
  }

  /** 沿跨层通道连接非重合的拐点，用二次贝塞尔圆角过渡；短线段的圆角最多占其一半。 */
  function roundedRoute(points) {
    let d = `M${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1];
      const incoming = Math.hypot(x - px, y - py), outgoing = Math.hypot(nx - x, ny - y);
      const radius = Math.min(10, incoming / 2, outgoing / 2);
      d += ` L${x + (px - x) * radius / incoming} ${y + (py - y) * radius / incoming}` +
        ` Q${x} ${y} ${x + (nx - x) * radius / outgoing} ${y + (ny - y) * radius / outgoing}`;
    }
    const last = points[points.length - 1];
    return `${d} L${last[0]} ${last[1]}`;
  }

  /**
   * 用实际图宽重排节点与连线：横向能放下全部依赖层时从左到右，否则从上到下，同一层按宽度折为多行。
   * 只更新几何，不重建控件或改变选中状态；ResizeObserver 和每次渲染后调用。隐藏或零宽度时等下次可见再排。
   */
  function layoutGraph() {
    const graph = $('feat-board').querySelector('.fb-graph');
    if (!graph || !graph.clientWidth) return;
    const nodes = [...graph.querySelectorAll('.fb-node')], width = graph.clientWidth;
    const levels = [];
    nodes.forEach((node, i) => (levels[Number(node.dataset.level)] ||= []).push(i));
    const horizontal = levels.length * G.w + (levels.length - 1) * G.gap + G.pad * 2 <= width;
    const cols = Math.max(1, Math.min(3, Math.floor((width - G.pad * 2 + G.rowGap) / (150 + G.rowGap))));
    const nodeW = horizontal ? G.w : Math.min(300, (width - G.pad * 2 - (cols - 1) * G.rowGap) / cols);
    const positions = [];
    let y = G.pad, height = 0;
    levels.forEach((level, li) => {
      if (!level) return;
      level.forEach((i, order) => {
        if (horizontal) positions[i] = { x: G.pad + li * (G.w + G.gap), y: G.pad + order * (G.h + G.rowGap) };
        else {
          const row = Math.floor(order / cols), inRow = Math.min(cols, level.length - row * cols);
          const left = (width - inRow * nodeW - (inRow - 1) * G.rowGap) / 2;
          positions[i] = { x: left + (order % cols) * (nodeW + G.rowGap), y: y + row * (G.h + G.rowGap) };
        }
      });
      if (!horizontal) y += Math.ceil(level.length / cols) * (G.h + G.rowGap) - G.rowGap + G.gap;
    });
    nodes.forEach((node, i) => {
      const p = positions[i];
      Object.assign(node.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${nodeW}px`, height: `${G.h}px` });
      height = Math.max(height, p.y + G.h + G.pad);
    });
    const inside = graph.querySelector('.fb-graph-in'), svg = inside.querySelector('svg');
    inside.style.height = `${height}px`;
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    graph.dataset.direction = horizontal ? 'horizontal' : 'vertical';
    // 4px 中心距让 2.4px 高亮线仍留出 1px 以上空隙；边缘通道用满后循环复用。
    const lanePitch = 4, laneCount = Math.floor((G.pad - 4) / lanePitch) + 1;
    let crossLane = 0;
    graph.querySelectorAll('.fb-edge').forEach((edge) => {
      const a = positions[Number(edge.dataset.source)], b = positions[Number(edge.dataset.target)];
      const x1 = horizontal ? a.x + nodeW : a.x + nodeW / 2, y1 = horizontal ? a.y + G.h / 2 : a.y + G.h;
      const x2 = horizontal ? b.x - 3 : b.x + nodeW / 2, y2 = horizontal ? b.y + G.h / 2 : b.y - 3;
      const bend = Math.max(16, (horizontal ? x2 - x1 : y2 - y1) / 2);
      // 跨层依赖共用左侧（横向图为上侧）通道，圆角接入与转出，避开中间节点。
      const skip = Number(nodes[Number(edge.dataset.target)].dataset.level) - Number(nodes[Number(edge.dataset.source)].dataset.level) > 1;
      if (skip) {
        const lane = crossLane++ % laneCount;
        const lead = G.gap / 2 + (lane - (laneCount - 1) / 2) * lanePitch, rail = 2 + lane * lanePitch;
        edge.setAttribute('d', roundedRoute(horizontal
          ? [[x1, y1], [x1 + lead, y1], [x1 + lead, rail], [x2 - lead, rail], [x2 - lead, y2], [x2, y2]]
          : [[x1, y1], [x1, y1 + lead], [rail, y1 + lead], [rail, y2 - lead], [x2, y2 - lead], [x2, y2]]));
      } else edge.setAttribute('d', horizontal ? `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`
        : `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`);
    });
  }

  /** 选中或取消 T：更新独立详情，保持开发记录不变，把详情区移到可见范围。 */
  function selectTask(id) {
    st.selectedT = st.selectedT === id ? '' : id;
    render();
    $('feat-board').querySelector('.fb-task-panel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** 未选中时的全部任务概览：完整名称、状态、依赖和记录数量，点击任一行展开对应详情。 */
  function taskOverview(d) {
    return `<section class="fb-card fb-task-panel"><header class="fb-card-head"><h3>任务详情</h3><span class="fb-badge">全部 ${d.tasks.length} 项</span></header>
      <div class="fb-task-list">${d.tasks.map((t) => {
        const count = d.devs.filter((r) => r.ts.includes(t.id) || r.subs.some((s) => s.id.startsWith(t.id + '.'))).length;
        return `<button class="fb-task-row" ${act(() => selectTask(t.id))}>
          <span class="fb-tid sm">${esc(t.id)}</span><span class="fb-task-summary"><strong>${esc(t.title)}</strong>
          <span>${t.depRaw && t.depRaw !== '-' ? `前置 ${esc(t.depRaw)} · ` : ''}${count ? `${count} 条开发记录` : '暂无开发记录'}</span></span>${pill(t.state, TASK_NAME[t.state], t.raw)}</button>`;
      }).join('')}</div></section>`;
  }

  /**
   * 选中 T 的详情区块（路线图与开发记录之间）：完整任务名、状态原文、前置 / 后续 / 可并行（点击切换选中）、
   * 开发记录条数与日期、各记录中该 T 的子任务（同一子号以最后出现为准），以及按状态给出的命令。
   * 编号重复时取路线图最后一行，并提示重复；编号已不在路线图中时显示提示并可清除选中。
   */
  function taskDetail(d, id) {
    const rows = d.tasks.filter((t) => t.id === id);
    const close = `<button class="fb-detail-back" ${act(() => selectTask(id))} aria-label="返回全部任务">全部任务</button>`;
    if (!rows.length) return `<section class="fb-card fb-task-panel fb-detail"><header class="fb-card-head"><h3>${esc(id)} 详情</h3><span class="spacer"></span>${close}</header>${empty('路线图中已没有该编号', '')}</section>`;
    const t = rows[rows.length - 1];
    const state = (p) => d.tasks.filter((x) => x.id === p).pop()?.state || 'unknown';
    const chip = (p) => `<button class="fb-tchip t-${state(p)}" ${act(() => selectTask(p))} title="${esc(p)}：${TASK_NAME[state(p)]}">${esc(p)}</button>`;
    const after = [...new Set(d.tasks.filter((x) => x.deps.includes(id)).map((x) => x.id))];
    const recs = d.devs.filter((r) => r.ts.some((x) => x === id || x.startsWith(id + '.')) || r.subs.some((s) => s.id.startsWith(id + '.')));
    const subs = new Map();
    for (const r of d.devs) for (const s of r.subs) if (s.id.startsWith(id + '.')) { subs.delete(s.id); subs.set(s.id, s); }
    const dates = recs.map((r) => r.date).sort();
    const doneIds = new Set(d.tasks.filter((x) => x.state === 'done').map((x) => x.id));
    const blocked = t.deps.filter((p) => !doneIds.has(p));
    const command = t.state === 'waiting' ? cmd(`/smallcat-feat-3-dev ${api.id()} ${id} 用户确认通过`)
      : ['todo', 'doing'].includes(t.state) && !blocked.length ? cmd(`/smallcat-feat-3-dev ${api.id()} ${id}`) : '';
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
    return `<section class="fb-card fb-task-panel fb-detail t-${t.state}" data-line="${t.n}">
      <header class="fb-card-head"><h3>任务详情 <span class="fb-tid sm">${esc(id)}</span></h3><span class="spacer"></span>${src(t.n)}${close}</header>
      <div class="fb-detail-heading"><h4>${esc(t.title)}</h4>${pill(t.state, TASK_NAME[t.state], t.raw)}${rows.length > 1 ? pill('warn', `编号重复 ${rows.length} 行`) : ''}</div>
      <dl class="fb-detail-grid">
        ${row('状态', esc(t.raw || '未填'))}
        ${row('前置', t.deps.length ? `<span class="fb-chips">${t.deps.map(chip).join('')}</span>${blocked.length ? `<span class="fb-detail-note warn">未完成：${esc(blocked.join('、'))}</span>` : ''}` : '<span class="fb-none">无</span>')}
        ${t.depRaw && t.depRaw !== '-' && t.depRaw !== t.deps.join('、') ? row('依赖原文', esc(t.depRaw)) : ''}
        ${row('后续', after.length ? `<span class="fb-chips">${after.map(chip).join('')}</span>` : '<span class="fb-none">无</span>')}
        ${t.par.length ? row('可并行', `<span class="fb-chips">${t.par.map(chip).join('')}</span>`) : ''}
        ${row('开发记录', recs.length ? `${recs.length} 条 · ${esc(dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} → ${dates[dates.length - 1]}`)}` : '<span class="fb-none">还没有</span>')}
      </dl>
      ${subs.size ? `<h4 class="fb-sub">子任务 ${[...subs.values()].filter((s) => s.state === 'done').length}/${subs.size}</h4><ul class="fb-subs">${[...subs.values()].map((s) => `<li data-line="${s.n}"><span class="fb-tid sm">${esc(s.id)}</span><span class="fb-sub-goal">${cell(s.goal)}</span><span class="fb-who">${esc(s.who)}</span>${pill(s.state, TASK_NAME[s.state], s.raw)}</li>`).join('')}</ul>` : ''}
      ${command ? `<div class="fb-detail-cmd"><span>${t.state === 'waiting' ? '验证后交给 Agent 确认：' : '交给 Agent 推进：'}</span>${command}</div>` : ''}
    </section>`;
  }

  /** 开发页：依赖图、任务详情（默认全部 T 概览，选中后单项详情）、始终完整的开发记录。 */
  function page3(d) {
    const x = d.stats.tasks;
    const counts = Object.entries(d.tasks.reduce((m, t) => ((m[t.state] = (m[t.state] || 0) + 1), m), {}))
      .map(([k, v]) => pill(k, `${TASK_NAME[k]} ${v}`)).join('');
    const tasks = d.tasks.length ? taskGraph(d) : empty('还没有任务路线图', 'smallcat-feat-3-dev');

    const devs = [...d.devs].reverse();
    const newest = d.devs.length ? d.devs[d.devs.length - 1].n : 0;
    const isOpen = (r) => (st.openTouched ? st.open.has(r.n) : r.n === newest);
    const recs = devs.length ? `<div class="fb-recs">${devs.map((r) => {
      const open = isOpen(r);
      const done = r.subs.filter((s) => s.state === 'done').length;
      const tags = r.items.flatMap((it) => [...String(it.value).matchAll(/(自测|流程图)[：:]\s*([^；;。]+)/g)].map((m) => `<span class="fb-tag" title="${esc(m[0])}"><i>${m[1]}</i>${esc(m[2].trim())}</span>`));
      return `<article class="fb-rec${open ? ' open' : ''}" data-line="${r.n}">
        <header><button class="fb-rec-toggle" aria-expanded="${open}" data-key="rec-${r.n}" ${act(() => { if (!st.openTouched) { st.openTouched = true; st.open = new Set([newest]); } st.open.has(r.n) ? st.open.delete(r.n) : st.open.add(r.n); render(); })}>
          <span class="fb-chev" aria-hidden="true">▸</span><time>${esc(r.date)}</time>${r.ts.map((t) => `<span class="fb-tid sm">${esc(t)}</span>`).join('')}<span class="fb-rec-title">${esc(r.title)}</span>
          ${r.subs.length ? `<span class="fb-badge">${done}/${r.subs.length} 子任务</span>` : ''}</button><span class="spacer"></span>${src(r.n)}</header>
        ${open ? `<div class="fb-rec-body">
          ${r.items.length ? `<dl>${r.items.map((it) => `<dt>${esc(it.key || '·')}</dt><dd>${cell(it.value)}</dd>`).join('')}</dl>` : ''}
          ${tags.length ? `<div class="fb-tags">${tags.join('')}</div>` : ''}
          ${r.subs.length ? `<ul class="fb-subs">${r.subs.map((s) => `<li data-line="${s.n}"><span class="fb-tid sm">${esc(s.id)}</span><span class="fb-sub-goal">${cell(s.goal)}</span><span class="fb-who">${esc(s.who)}</span>${pill(s.state, TASK_NAME[s.state], s.raw)}</li>`).join('')}</ul>` : ''}
        </div>` : ''}</article>`;
    }).join('')}</div>` : empty('还没有开发记录', 'smallcat-feat-3-dev');
    return `${card(d, '3.1', '任务路线图', tasks, x.total ? ring(x.done, x.total) + `<span class="fb-pills">${counts}</span>` : '')}
      ${d.tasks.length ? (st.selectedT ? taskDetail(d, st.selectedT) : taskOverview(d)) : ''}
      ${card(d, '3.2', '开发记录', recs, pill('muted', `全部 ${d.devs.length} 条`))}`;
  }

  /** §4.1 自测：只读列表，结果色块，备注像路径时带复制按钮。 */
  function autoList(d) {
    const t = d.auto;
    if (!t || !t.rows.length) return empty('还没有程序自测项', 'smallcat-feat-4-test');
    const ri = col(t.head, '结果'), ni = col(t.head, '备注'), wi = col(t.head, '方式'), ti = col(t.head, '自测项', 1);
    return `<ul class="fb-autos">${t.rows.map((r) => {
      const c = (i) => (i >= 0 && r.cells[i]?.text) || '';
      const v = verdict(c(ri)), note = c(ni);
      return `<li class="v-${v || 'none'}" data-line="${r.n}"><span class="fb-idx">${esc(c(0))}</span><span class="fb-auto-title">${cell(c(ti))}</span>
        ${c(wi) ? `<span class="fb-type">${esc(c(wi))}</span>` : ''}${pill('v-' + (v || 'none'), c(ri) || '未填', c(ri))}
        ${note ? `<span class="fb-auto-note">${cell(note)}${/[\\/]|\.\w{1,4}\b/.test(note) ? `<button class="fb-icon" data-copy="${esc(note)}" title="复制备注（测试文件路径）" aria-label="复制备注">${ICON_COPY}</button>` : ''}</span>` : ''}</li>`;
    }).join('')}</ul>`;
  }

  /**
   * §4.2 人工确认卡：OK / NG 写「结果」列（再点一次已选的清除判定词，保留其后的说明），备注框写「备注」列；
   * 点 NG 后聚焦备注框。缺「结果」列时整节只读显示原文并提示格式。
   */
  function manualList(d) {
    const t = d.manual;
    if (!t || !t.rows.length) return empty('还没有人工确认项', 'smallcat-feat-4-test');
    const ri = col(t.head, '结果'), ni = col(t.head, '备注'), ti = col(t.head, '测试项', 1);
    if (ri < 0) return `<div class="fb-warn">表头缺少「结果」列，无法识别，请在文档视图中修正。</div><div class="fb-prose">${md(body(d, '4.2').map((l) => l.t).join('\n'))}</div>`;
    const fields = t.head.map((h, i) => [h, i]).filter(([, i]) => i > 0 && ![ri, ni, ti].includes(i));
    const rows = t.rows.map((r, i) => ({ r, i, v: verdict(r.cells[ri]?.text || '') })).filter((x) => !st.onlyTodo || !x.v);
    if (!rows.length) return `<div class="fb-empty ok"><span>全部已填写结果</span></div>`;
    return `<div class="fb-accs">${rows.map(({ r, i, v }) => {
      const rc = r.cells[ri], nc = ni >= 0 ? r.cells[ni] : null;
      const broken = !rc || (ni >= 0 && !nc);
      const set = (word) => {
        const cur = rc.text, has = cur.match(VERDICT_WORD);
        const rest = has ? cur.slice(has[0].length) : (cur ? '；' + cur : '');
        const same = verdict(cur) === (word === '通过' ? 'pass' : 'fail');
        st.focusKey = word === '不通过' && !same ? `note-${i}` : `acc-${i}`;
        writeCell(rc, same ? rest.replace(/^[；;\s]+/, '') : word + rest);
      };
      return `<article class="fb-acc v-${v || 'none'}" tabindex="0" data-key="acc-${i}" data-acc="${i}" data-line="${r.n}">
        <div class="fb-acc-head"><span class="fb-idx">${esc(r.cells[0]?.text || i + 1)}</span><div class="fb-acc-title">${cell(r.cells[ti]?.text || '')}</div>
          <div class="fb-verdict" role="group" aria-label="确认结果">
            <button class="ok${v === 'pass' ? ' on' : ''}" aria-pressed="${v === 'pass'}" data-key="ok-${i}" data-verdict="ok" ${broken ? 'disabled' : act(() => set('通过'))} title="通过（快捷键 1）">✓ OK</button>
            <button class="ng${v === 'fail' ? ' on' : ''}" aria-pressed="${v === 'fail'}" data-key="ng-${i}" data-verdict="ng" ${broken ? 'disabled' : act(() => set('不通过'))} title="不通过（快捷键 2）">✗ NG</button>
          </div>${src(r.n)}</div>
        ${fields.length ? `<dl class="fb-acc-fields">${fields.map(([h, k]) => `<dt>${esc(h)}</dt><dd>${cell(r.cells[k]?.text || '')}</dd>`).join('')}</dl>` : ''}
        ${v === 'other' ? `<div class="fb-warn">结果「${esc(rc.text)}」不是判定词，点 OK / NG 后会写在判定词之后。</div>` : ''}
        ${broken ? '<div class="fb-warn">本行单元格数少于表头，请在文档视图补齐。</div>' : nc ? `<input class="fb-note${v === 'fail' && !nc.text ? ' need' : ''}" data-key="note-${i}" data-note="${acts.length}" value="${esc(nc.text)}" placeholder="${v === 'fail' ? '写明问题现象，便于记入 §4.3' : '备注（可选），回车保存'}" aria-label="第 ${esc(r.cells[0]?.text || i + 1)} 项备注">${(act((value) => writeCell(nc, value)), '')}` : ''}
      </article>`;
    }).join('')}</div>`;
  }

  /** §4.3 问题卡：问题 → 修复 → 复测三段；复测段可点「通过 / 未复测」，只改「复测：」之后的文字。 */
  function issueList(d) {
    if (!d.issues.length) return empty('没有问题记录', '');
    return `<div class="fb-issues">${d.issues.map((it, i) => `<article class="fb-issue ${it.closed ? 'closed' : 'open'}" data-line="${it.n}">
      ${it.date ? `<time>${esc(it.date)}</time>` : ''}
      <div class="fb-chain"><div class="fb-seg"><i>问题</i>${cell(it.problem)}</div><span class="fb-arrow" aria-hidden="true">→</span>
        <div class="fb-seg"><i>修复</i>${cell(it.fix)}</div><span class="fb-arrow" aria-hidden="true">→</span>
        <div class="fb-seg retest"><i>复测</i>${it.retest ? `<div class="fb-verdict sm" role="group" aria-label="复测结果">
          <button class="ok${it.closed ? ' on' : ''}" aria-pressed="${it.closed}" data-key="rt-ok-${i}" ${act(() => { st.focusKey = `rt-ok-${i}`; edit(it.retest.from, it.retest.to, it.retest.raw, it.closed ? '未复测' : '通过'); })}>通过</button>
          <button class="${!it.closed ? 'on' : ''}" aria-pressed="${!it.closed}" data-key="rt-no-${i}" ${act(() => { st.focusKey = `rt-no-${i}`; if (it.closed) edit(it.retest.from, it.retest.to, it.retest.raw, '未复测'); })}>${esc(!it.closed && it.value && it.value !== '未复测' ? it.value : '未复测')}</button>
        </div>` : '<span class="fb-none">没有「复测：」段</span>'}</div></div>${src(it.n)}</article>`).join('')}</div>`;
  }

  /** 测试页（§4）：三项汇总，自测、人工确认、问题与修复。 */
  function page4(d) {
    const { auto: a, manual: m, issues: q } = d.stats;
    const meter = (name, done, total, tone, text) => `<div class="fb-meter ${tone}">${ring(done, total, tone)}<div><b>${name}</b><span>${text}</span></div></div>`;
    const tools = `<label class="fb-switch"><input type="checkbox" ${st.onlyTodo ? 'checked' : ''} ${act(() => { st.onlyTodo = !st.onlyTodo; render(); })}>只看未填</label>
      <span class="fb-hint" title="焦点在卡片上时可用">J / K 切换 · 1 OK · 2 NG · N 备注</span>`;
    return `<div class="fb-meters">
        ${meter('程序自测', a.pass, a.total, a.fail ? 'err' : 'ok', a.total ? `通过 ${a.pass} · 不通过 ${a.fail}` : '未开始')}
        ${meter('人工确认', m.filled, m.total, m.fail ? 'err' : m.filled < m.total ? 'warn' : 'ok', m.total ? `通过 ${m.pass} · 不通过 ${m.fail} · 未填 ${m.total - m.filled}` : '未开始')}
        ${meter('问题闭环', q.total - q.open, q.total, q.open ? 'err' : 'ok', q.total ? `未闭环 ${q.open}` : '暂无问题')}
      </div>
      ${card(d, '4.1', '程序自测（Agent 执行）', autoList(d))}
      ${card(d, '4.2', '人工确认清单', manualList(d), d.manual?.rows.length ? tools : '')}
      ${card(d, '4.3', '问题与修复', issueList(d))}`;
  }

  /** 发布页（§5）：只读排版；未生成时给关闭命令。 */
  function page5(d) {
    const s = d.h2['5'];
    const lines = s ? s.body : [];
    return `<section class="fb-card" data-line="${s ? s.n : ''}"><header class="fb-card-head"><h3><span class="fb-no">§5</span>发布说明</h3><span class="spacer"></span>${s ? src(s.n) : ''}</header>
      ${meaningful(lines) ? `<div class="fb-prose release">${md(lines.map((l) => l.t).join('\n'))}</div>` : empty('关闭 Feat 时生成', 'smallcat-feat-5-close')}</section>`;
  }

  const PAGES = { 0: page0, 1: page1, 2: page2, 3: page3, 4: page4, 5: page5 };

  // ---------------- 主渲染 ----------------

  /** 合并同一轮事件里的多次变化后重绘（setTimeout，后台或最小化窗口也会执行）；控件页隐藏时只记脏，显示时再画。 */
  function schedule() {
    st.dirty = true;
    if (!st.raf) st.raf = setTimeout(render, 0);
  }

  /** 重绘整页：保留滚动位置与焦点控件（按 data-key）；备注输入未提交时推迟到失焦后。 */
  function render() {
    clearTimeout(st.raf);
    st.raf = 0;
    const box = $('feat-board');
    if (!api || box.hidden) return;
    const active = document.activeElement;
    if (active?.matches?.('.fb-note') && box.contains(active) && active.value !== active.defaultValue) { st.holdRender = true; return; }
    st.dirty = false;
    st.holdRender = false;
    const path = api.path();
    if (!path) { box.innerHTML = ''; $('feat-notices').innerHTML = ''; st.path = ''; return; }
    const d = model(api.text());
    const fresh = path !== st.path;
    if (fresh) Object.assign(st, { path, tab: d.stage, selectedT: '', onlyTodo: false, open: new Set(), openTouched: false });
    if (!STAGES.some((s) => s.k === st.tab) || (st.tab === '0' && !d.h2['0'])) st.tab = d.stage;
    const key = st.focusKey || (box.contains(active) ? active.dataset.key : '');
    st.focusKey = '';
    const scroll = fresh ? 0 : box.scrollTop;
    acts = [];
    mds = [];
    hovered = null;
    const next = nexts(d);
    $('feat-notices').innerHTML = next.notices;
    box.innerHTML = `<div class="fb-shell">${rail(d)}<div class="fb-main">${next.commands}<div class="fb-page tab-${st.tab}" role="tabpanel">${PAGES[st.tab](d)}</div></div></div>`;
    box.querySelectorAll('[data-md]').forEach((el) => {
      const { text, inline } = mds[el.dataset.md];
      const frag = LiveMarkdown.render(text);
      if (inline && frag.childElementCount === 1 && frag.firstElementChild.tagName === 'P') el.append(...frag.firstElementChild.childNodes);
      else el.append(frag);
    });
    // Agent 持锁：只禁用会写原文的控件（勾选、OK / NG、复测、备注），筛选与展开等视图操作照常可用。
    box.classList.toggle('readonly', api.readOnly());
    if (api.readOnly()) box.querySelectorAll('.fb-check, .fb-verdict button, .fb-note').forEach((el) => { el.disabled = true; });
    layoutGraph();
    // 刚打开/切换分栏时父容器尚未完成布局，下一轮再测量一次；后台窗口也不依赖动画帧。
    setTimeout(layoutGraph, 0);
    box.scrollTop = scroll;
    if (key) box.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }

  /** 复制命令或路径，按钮短暂显示已复制。 */
  function copy(btn) {
    navigator.clipboard.writeText(btn.dataset.copy).then(() => {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1200);
      api.notify('已复制：' + btn.dataset.copy);
    }, (e) => api.notify('复制失败：' + e, true));
  }

  /** §4.2 卡片之间移动焦点：step 为 ±1。 */
  function moveAcc(from, step) {
    const list = [...$('feat-board').querySelectorAll('.fb-acc')];
    const next = list[list.indexOf(from) + step];
    if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
  }

  /** 事件委托：页签、动作、复制、定位原文、节点引用、§4.2 快捷键与备注提交。 */
  function bind() {
    const box = $('feat-board');
    box.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { st.tab = tab.dataset.tab; st.selectedT = ''; render(); box.scrollTop = 0; return; }
      const jump = e.target.closest('[data-jump]');
      if (jump) { flashTo(box.querySelector(`.fb-page [data-line="${jump.dataset.jump}"]`), 'start'); return; }
      const tj = e.target.closest('[data-tjump]');
      if (tj) {
        st.tab = '3';
        st.selectedT = '';
        selectTask(tj.dataset.tjump);
        return;
      }
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) { e.stopPropagation(); copy(copyBtn); return; }
      const line = e.target.closest('.fb-src');
      if (line) { e.stopPropagation(); api.showDoc(Number(line.dataset.line)); return; }
      const ref = e.target.closest('.node-ref');
      if (ref) { e.preventDefault(); api.openFlow(ref.dataset.file, ref.dataset.id); return; }
      if (e.target.closest('a[href]')) return;
      const el = e.target.closest('[data-act]');
      if (!el || el.matches('input:not([type="checkbox"])') || el.disabled) return;
      acts[el.dataset.act]?.();
    });
    box.addEventListener('keydown', (e) => {
      const note = e.target.closest('.fb-note');
      if (note) {
        if (e.key === 'Enter') { e.preventDefault(); note.closest('.fb-acc').focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); note.value = note.defaultValue; note.closest('.fb-acc').focus(); }
        return;
      }
      const acc = e.target.matches('.fb-acc') && e.target;
      if (!acc || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j' || k === 'arrowdown') { e.preventDefault(); moveAcc(acc, 1); }
      else if (k === 'k' || k === 'arrowup') { e.preventDefault(); moveAcc(acc, -1); }
      else if (k === '1') { e.preventDefault(); acc.querySelector('[data-verdict="ok"]:not(:disabled)')?.click(); }
      else if (k === '2') { e.preventDefault(); acc.querySelector('[data-verdict="ng"]:not(:disabled)')?.click(); }
      else if (k === 'n' || k === 'enter') { e.preventDefault(); acc.querySelector('.fb-note:not(:disabled)')?.focus(); }
    });
    /** 备注在失焦或回车时提交（change 事件），内容未变不写；推迟的重绘在失焦后补上。 */
    box.addEventListener('change', (e) => {
      const note = e.target.closest('.fb-note');
      if (!note) return;
      const value = note.value.trim();
      if (value === note.defaultValue.trim()) return;
      note.defaultValue = note.value;
      acts[note.dataset.note]?.(value);
    });
    box.addEventListener('focusout', (e) => {
      if (e.target.matches('.fb-note') && st.holdRender) setTimeout(schedule, 0);
    });
    box.addEventListener('pointerover', (e) => focusNode(e.target.closest('.fb-node')));
    box.addEventListener('pointerleave', () => focusNode(null));
  }

  /** 滚动到元素并短暂高亮；el 为空时不动。 */
  function flashTo(el, block) {
    if (!el) return;
    el.scrollIntoView({ block, inline: 'nearest' });
    el.classList.remove('fb-flash');
    void el.offsetWidth;
    el.classList.add('fb-flash');
    setTimeout(() => el.classList.remove('fb-flash'), 1400);
  }

  /** 当前悬停的依赖图节点：指针在同一节点内移动时不重复计算。 */
  let hovered = null;

  /** 依赖图悬停：高亮该 T、它的前置（hi-dep）与后续（hi-of）及相连的线，其余变淡；node 为空时清除。 */
  function focusNode(node) {
    if (node === hovered) return;
    hovered = node;
    const graph = node?.closest('.fb-graph') || $('feat-board').querySelector('.fb-graph');
    if (!graph) return;
    graph.querySelectorAll('.hi-self, .hi-dep, .hi-of, .hi').forEach((el) => el.classList.remove('hi-self', 'hi-dep', 'hi-of', 'hi'));
    graph.classList.toggle('focus', !!node);
    if (!node) return;
    const id = node.dataset.node, deps = node.dataset.deps.split(' ').filter(Boolean);
    node.classList.add('hi-self');
    graph.querySelectorAll('.fb-node').forEach((n) => {
      if (deps.includes(n.dataset.node)) n.classList.add('hi-dep');
      if (n.dataset.deps.split(' ').includes(id)) n.classList.add('hi-of');
    });
    graph.querySelectorAll('.fb-edge').forEach((p) => { if (p.dataset.from === id || p.dataset.to === id) p.classList.add('hi'); });
  }

  /** 切到控件页后定位到源文件第 line 行所在章节与最近的卡片，并短暂高亮。 */
  function revealLine(line) {
    if (!api.path()) return;
    const d = parse(api.text());
    const sec = Object.values(d.h2).filter((s) => s.n <= line).sort((a, b) => b.n - a.n)[0];
    if (sec && PAGES[sec.k] && sec.k !== st.tab) { st.tab = sec.k; st.selectedT = ''; }
    render();
    const box = $('feat-board');
    const hit = [...box.querySelectorAll('.fb-page [data-line]')].filter((el) => Number(el.dataset.line) && Number(el.dataset.line) <= line)
      .sort((a, b) => Number(b.dataset.line) - Number(a.dataset.line))[0];
    if (!hit) { box.scrollTop = 0; return; }
    hit.scrollIntoView({ block: 'center' });
    hit.classList.add('fb-flash');
    setTimeout(() => hit.classList.remove('fb-flash'), 1400);
  }

  /**
   * 接入编辑器。a 由 feat.js 提供：text() 当前全文，edit(change) 提交一处 CodeMirror 修改（进撤销历史、触发保存），
   * readOnly() Agent 是否持锁，path() / id() 当前档案路径与编号，nodes() 挂本 Feat 标签的节点，
   * openFlow(name, id) 打开流程图（id 为空只开图），showDoc(line) 切到文档视图定位行，notify(text, isError) 顶栏提示。
   */
  function init(a) {
    api = a;
    bind();
    // 只重算图形几何，拖动分栏不会重建输入框、详情或开发记录的展开状态。
    new ResizeObserver(layoutGraph).observe($('feat-board'));
    window.addEventListener('resize', layoutGraph);
  }

  return {
    init,
    /** 文本、锁或节点变化：控件页可见时下一帧重绘。 */
    changed: schedule,
    /** 控件页刚显示：有积压变化时立即重绘。 */
    shown: () => { if (st.dirty || !$('feat-board').innerHTML) render(); layoutGraph(); },
    revealLine,
    /** 供浏览器自测：解析结果（不含 DOM）。 */
    model,
  };
})();
