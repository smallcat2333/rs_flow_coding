// 浏览器预览用的 Tauri 模拟层：仅由 scripts/dev_server.py 注入，不随 App 打包。
// 内存保存图、Feat 档案与快照，用于在浏览器中验证 draw.io 嵌入、实时保存、只读锁、历史面板与节点↔Feat 联动。
// 控制台可用：__mock.agentLock(true/false) 模拟 Agent 加锁；__mock.agentEdit() 模拟 Agent 改图。
(function () {
  if (window.__TAURI__) return;
  const listeners = {};
  const files = {};       // 流程图 path -> xml
  const mds = {};         // Feat 档案 path -> text
  const snaps = [];       // {id, path, ts, source, xml}
  let nextSnapshotId = 1; // 清理旧历史后不复用 id，保持历史面板引用稳定。
  let agentLock = false;
  const userLocks = new Set();
  const chartStates = JSON.parse(localStorage.getItem('fc-mock-charts') || '{}');
  const mdOverrides = JSON.parse(localStorage.getItem('fc-mock-mds') || '{}');
  const config = { roots: ['(mock)'], flow_dirs: [], excluded_dirs: JSON.parse(localStorage.getItem('fc-mock-excluded') || '[]'), sidebar: { app_aliases: {}, group_aliases: {}, group_order: [], app_order: [], auto_top: true, bumped: {}, unseen: [], layout: 'tree', ...JSON.parse(localStorage.getItem('fc-mock-sidebar') || '{"collapsed":[],"expanded_archives":[],"include_archived":false}') } };

  /** 解析节点：与 Rust flow::parse 同口径（仅用于预览），返回 [{id,label,status,tags}]。 */
  function nodes(xml) {
    const out = [];
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    for (const el of doc.querySelectorAll('mxCell[vertex="1"]')) {
      const style = el.getAttribute('style') || '';
      if (/^(text|swimlane|group|edgeLabel|note)(;|$)|shape=(note|swimlane)/.test(style)) continue;
      const fill = ((style.match(/fillColor=([^;]+)/) || [])[1] || '').toLowerCase();
      const dashed = /dashed=1/.test(style);
      const status = { '': 'none', none: 'none', '#ffffff': 'none', '#fff2cc': 'review', '#f8cecc': 'issue', '#dae8fc': 'idea' }[fill]
        || (fill === '#d5e8d4' ? (dashed ? 'confirm_delete' : 'confirmed') : fill === '#f5f5f5' && dashed ? 'plan_delete' : 'unknown');
      const w = el.parentElement && /^(object|UserObject)$/.test(el.parentElement.tagName) ? el.parentElement : null;
      const label = ((w ? w.getAttribute('label') : el.getAttribute('value')) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      out.push({ id: (w || el).getAttribute('id'), label, status, tags: ((w && w.getAttribute('tags')) || '').split(' ').filter(Boolean) });
    }
    return out;
  }
  function counts(xml) {
    const c = { none: 0, review: 0, plan_delete: 0, issue: 0, idea: 0, confirmed: 0, confirm_delete: 0, unknown: 0 };
    nodes(xml).forEach((n) => c[n.status]++);
    return c;
  }
  const hash = (s) => String(s.length) + ':' + [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0);
  const snap = (path, source) => {
    const xml = files[path];
    const last = snaps.filter((s) => s.path === path).pop();
    if (last && last.xml === xml) return;
    snaps.push({ id: nextSnapshotId++, path, ts: new Date().toLocaleString(), source, xml });
  };
  const emit = (name, payload) => (listeners[name] || []).forEach((f) => f({ payload }));
  const lockOf = (p) => agentLock ? { owner: 'agent', pid: 1, since: Date.now() / 1000 } : userLocks.has(p) ? { owner: 'user', pid: 2, since: 0 } : null;
  const allNodes = () => Object.keys(files).flatMap((f) => nodes(files[f]).map((n) => ({ file: f, ...n })));

  /** Feat 摘要：与 Rust feat::summarize 同口径。 */
  function featEntry(p) {
    const text = mds[p];
    const id = p.split('/').pop().match(/^(Feat_\d+_\d+)/)[1];
    const title = ((text.match(/^# (.*)$/m) || [])[1] || '').replace(id, '').trim();
    const status = ((text.match(/状态[：:](.*)$/m) || [])[1] || '').trim();
    const sec = (text.split(/^### 3\.1.*$/m)[1] || '').split(/^##/m)[0];
    const rows = sec.split('\n').filter((l) => l.trim().startsWith('|')).slice(2);
    const mine = allNodes().filter((n) => n.tags.includes(id));
    const c = { none: 0, review: 0, plan_delete: 0, issue: 0, idea: 0, confirmed: 0, confirm_delete: 0, unknown: 0 };
    mine.forEach((n) => c[n.status]++);
    return {
      path: p, id, title, status, archived: /^(已关闭|已废弃)/.test(status), closed_at: ((text.match(/关闭[：:]\s*(\S+)/) || [])[1] || ''), counts: c, node_total: mine.length, lock: lockOf(p),
      tasks_total: rows.filter((r) => !/^\s*(暂缓|取消)/.test(r.split('|').slice(-2)[0])).length,
      tasks_done: rows.filter((r) => /^\s*完成/.test(r.split('|').slice(-2)[0])).length,
      closable: mine.length > 0 && c.none === mine.length,
    };
  }

  /** 推进进度：Rust progress::parse 的预览用移植（口径以 Rust 单测为准）。 */
  function progress(p) {
    const text = mds[p];
    const e = featEntry(p);
    const lines = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');
    const region = (head, stopH3) => {
      const s = lines.findIndex((l) => l.trimStart().startsWith(head));
      if (s < 0) return [0, []];
      const body = [];
      for (let i = s + 1; i < lines.length; i++) {
        const t = lines[i].trimStart();
        if (t.startsWith('## ') || (stopH3 && t.startsWith('### '))) break;
        body.push([i + 1, lines[i]]);
      }
      return [s + 1, body];
    };
    const rows = (body) => {
      const out = []; let inT = false;
      for (const [n, l] of body) {
        const t = l.trim();
        if (!t.startsWith('|')) { inT = false; continue; }
        if (!inT) { inT = true; continue; }
        if (!t.replace(/[|\-\s:]/g, '')) continue;
        out.push([n, t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())]);
      }
      return out;
    };
    const state = (s) => (s = s.trim().replace(/^\*+/, ''), [['待用户确认', 'waiting'], ['待开发', 'todo'], ['进行中', 'doing'], ['完成', 'done'], ['暂缓', 'paused'], ['取消', 'cancelled']].find(([w]) => s.startsWith(w))?.[1] || 'unknown');
    const mean = (body) => body.filter(([, l]) => l.trim() && !l.trim().startsWith('<')).length;
    const req = { done: 0, total: 0, line: region('## 1.')[0] };
    for (const [, l] of region('### 1.3', true)[1]) {
      const m = l.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/);
      if (m && m[2] && !m[2].startsWith('<')) { req.total++; if (m[1] !== ' ') req.done++; }
    }
    const ui = { has: mean(region('### 2.1', true)[1]) > 0, controls: rows(region('### 2.2', true)[1]).length, logs: region('### 2.4', true)[1].filter(([, l]) => l.trimStart().startsWith('- ')).length, line: region('## 2.')[0] };
    const tasks = rows(region('### 3.1', true)[1]).filter(([, c]) => /^T\d+$/.test(c[0])).map(([n, c]) => ({
      id: c[0], title: c[1] || '', deps: c.length >= 5 ? c[2] : '', status: c[c.length - 1], state: state(c[c.length - 1]), line: n,
      record_line: 0, first_date: '', last_date: '', records: 0, dup: false, subs: [] }));
    tasks.forEach((t) => { t.dup = tasks.filter((x) => x.id === t.id).length > 1; });
    const rec = region('### 3.2', false)[1];
    for (const [n, l] of rec) {
      const m = l.match(/^\s*### (\d{4}-\d{2}-\d{2})(.*)$/);
      if (!m) continue;
      const ids = [...m[2].matchAll(/\[([^\]]*)\]/g)].flatMap((x) => x[1].split(/[,，/ ]/).map((s) => s.trim()));
      for (const t of tasks.filter((t) => ids.includes(t.id))) {
        if (!t.record_line) t.record_line = n;
        if (!t.first_date || m[1] < t.first_date) t.first_date = m[1];
        if (m[1] > t.last_date) t.last_date = m[1];
        t.records++;
      }
    }
    for (const [n, c] of rows(rec)) {
      if (!/^T\d+\.\d+$/.test(c[0])) continue;
      const t = tasks.find((x) => x.id === c[0].split('.')[0]);
      if (!t) continue;
      const sub = { id: c[0], title: c[2] || '', status: c[c.length - 1], state: state(c[c.length - 1]), line: n };
      const i = t.subs.findIndex((s) => s.id === sub.id);
      if (i >= 0) t.subs[i] = sub; else t.subs.push(sub);
    }
    const dev = { todo: 0, doing: 0, waiting: 0, done: 0, paused: 0, cancelled: 0, unknown: 0, total: 0, line: region('## 3.')[0] };
    tasks.forEach((t) => dev[t.state]++);
    dev.total = tasks.length - dev.paused - dev.cancelled;
    const tally = (head) => {
      const body = region(head, true)[1];
      const hdr = body.find(([, l]) => l.trim().startsWith('|'));
      const col = hdr ? hdr[1].trim().replace(/^\||\|$/g, '').split('|').findIndex((c) => c.includes('结果')) : -1;
      const rs = rows(body);
      let pass = 0, fail = 0;
      for (const [, c] of rs) { const v = (c[col] || '').trim(); if (/^(不通过|失败|FAIL)/i.test(v)) fail++; else if (/^(通过|PASS)/i.test(v)) pass++; }
      return [pass, fail, rs.length];
    };
    const [ap, af, at] = tally('### 4.1'), [mp, mf, mt] = tally('### 4.2');
    const issues = region('### 4.3', true)[1].filter(([, l]) => l.trimStart().startsWith('- '));
    const test = { auto_pass: ap, auto_fail: af, auto_total: at, manual_pass: mp, manual_fail: mf, manual_total: mt,
      issues_open: issues.filter(([, l]) => !/复测[：:]通过/.test(l)).length, issues_total: issues.length, line: region('## 4.')[0] };
    const [cl, cb] = region('## 5.');
    const close = { release: mean(cb) > 0, line: cl };
    const s = e.status;
    const inferred = at + mt ? 'test' : tasks.length ? 'dev' : ui.has ? 'ui' : 'req';
    const stage = /^(探讨中|需求整理中)/.test(s) ? (ui.has ? 'ui' : 'req') : /^开发中/.test(s) ? 'dev' : /^测试中/.test(s) ? 'test' : /^已关闭/.test(s) ? 'close' : inferred;
    const flag = /^已暂停/.test(s) ? 'paused' : /^已废弃/.test(s) ? 'dropped' : '';
    return { path: p, id: e.id, title: e.title, status: s, archived: e.archived, closed_at: e.closed_at, stage, flag, req, ui, dev, test, close, tasks };
  }

  const api = {
    async get_config() { return config; },
    async feat_progress() { return Object.keys(mds).sort().reverse().map(progress); },
    async set_roots({ roots, excludedDirs }) {
      const excluded = excludedDirs ?? config.excluded_dirs;
      for (const dir of excluded) {
        if (!roots.some((r) => dir === r || dir.startsWith(r.replace(/\/$/, '') + '/'))) throw '排除路径必须位于增加路径内：' + dir;
      }
      config.roots = roots;
      config.excluded_dirs = excluded;
      localStorage.setItem('fc-mock-excluded', JSON.stringify(config.excluded_dirs));
      return config;
    },
    async remove_directory({ path }) {
      if (!config.excluded_dirs.includes(path)) config.excluded_dirs.push(path);
      localStorage.setItem('fc-mock-excluded', JSON.stringify(config.excluded_dirs));
      return config;
    },
    async save_sidebar({ sidebar }) { config.sidebar = sidebar; localStorage.setItem('fc-mock-sidebar', JSON.stringify(sidebar)); },
    async set_chart_enabled({ path, enabled }) {
      if (agentLock) throw 'LOCKED:agent 正在编辑';
      if (enabled) delete chartStates[path]; else chartStates[path] = { status: 'disabled', disabled_at: new Date().toISOString() };
      localStorage.setItem('fc-mock-charts', JSON.stringify(chartStates));
      emit('catalog-changed', {});
    },
    async set_feat_status({ path, status, expectedHash }) {
      if (agentLock || userLocks.has(path)) throw 'LOCKED:文件正在编辑，请停止编辑后重试';
      if (hash(mds[path]) !== expectedHash) throw '档案已变化，请刷新后重试';
      const closed = /^(已关闭|已废弃)/.test(status);
      let text = mds[path].replace(/^([> -]*状态)[：:].*$/m, '$1：' + status);
      const date = closed ? new Date().toISOString().slice(0, 10) : '-';
      if (/关闭[：:]/.test(text)) text = text.replace(/关闭[：:][^\S\n]*\S+/, '关闭：' + date);
      else text = text.replace(/^(#[^\n]*\n)/, '$1\n> 关闭：' + date + '\n');
      mds[path] = text; mdOverrides[path] = text;
      localStorage.setItem('fc-mock-mds', JSON.stringify(mdOverrides));
      emit('md-changed', { path, hash: hash(text), source: 'user' });
    },
    /** 设置页模拟本机用量；测试只改变内存快照和目录缓存。 */
    async get_storage_stats() {
      const paths = new Set(snaps.map((s) => s.path));
      return { database_path: '(浏览器模拟) /mock/flow.db', database_bytes: snaps.reduce((n, s) => n + new TextEncoder().encode(s.xml).length, 0), diagrams: paths.size,
        snapshots: snaps.length, old_snapshots: snaps.length - paths.size, node_states: snaps.reduce((n, s) => n + nodes(s.xml).length, 0),
        cached_dirs: config.flow_dirs.length, cache_bytes: config.flow_dirs.length ? new TextEncoder().encode(JSON.stringify(config.flow_dirs)).length : 0 };
    },
    async clean_database() {
      const latest = new Map();
      for (const s of snaps) latest.set(s.path, s.id);
      const removed = snaps.length - latest.size;
      for (let i = snaps.length - 1; i >= 0; i--) if (latest.get(snaps[i].path) !== snaps[i].id) snaps.splice(i, 1);
      emit('history-pruned', {});
      return removed;
    },
    async clear_scan_cache() { config.flow_dirs = []; },
    async summary() {
      config.flow_dirs = ['/mock/flow'];
      const list = Object.keys(files).map((p) => ({ path: p, name: p.split('/').pop(), enabled: !chartStates[p], disabled_at: chartStates[p]?.disabled_at || '', counts: counts(files[p]), lock: lockOf(p), error: null }));
      const total = {};
      list.filter((f) => f.enabled).forEach((f) => Object.entries(f.counts).forEach(([k, v]) => total[k] = (total[k] || 0) + v));
      const feats = Object.keys(mds).sort().reverse().map(featEntry);
      // 另附两个空 APP（同一分组），用于预览分组/APP 拖动排序与分组别名。
      const empty = (app) => ({ group: 'group_tools', app, root: '', flow_dir: `/mock/group_tools/${app}/docs/flow`, feat_dir: `/mock/group_tools/${app}/docs/feat`, files: [], feats: [], counts: counts('') });
      return [{ group: 'group_sever', app: 'rs_bot_sever', root: '', flow_dir: '/mock/flow', feat_dir: '/mock/feat', files: list, feats, counts: total }, empty('app_demo_a'), empty('app_demo_b')].filter((a) => !config.excluded_dirs.some((d) => a.flow_dir === d || a.flow_dir.startsWith(d + '/')));
    },
    /** 浏览器预览中模拟同目录重命名；真实锁、引用和历史一致性由 Rust 测试覆盖。 */
    async rename_entry({ path, name }) {
      if (agentLock || userLocks.has(path)) throw 'LOCKED:文件正在编辑';
      const flow = path.endsWith('.drawio');
      const base = flow ? name + '.drawio' : path.split('/').pop().match(/^(Feat_\d+_\d+)/)[1] + '_' + name + '.md';
      const target = path.slice(0, path.lastIndexOf('/') + 1) + base;
      if (files[target] || mds[target]) throw '目标文件已存在';
      const changed = [];
      if (flow) {
        files[target] = files[path]; delete files[path];
        snaps.filter((s) => s.path === path).forEach((s) => s.path = target);
        if (chartStates[path]) { chartStates[target] = chartStates[path]; delete chartStates[path]; }
        for (const md of Object.keys(mds)) {
          const text = mds[md].split(path.split('/').pop() + '#').join(base + '#');
          if (text !== mds[md]) { mds[md] = text; changed.push(md); emit('md-changed', { path: md, hash: hash(text), source: 'user' }); }
        }
      } else {
        const id = base.match(/^(Feat_\d+_\d+)/)[1];
        mds[target] = mds[path].replace(/^# .*$/m, '# ' + id + ' ' + name); delete mds[path];
      }
      emit('catalog-changed', {});
      return { path: target, changed_feats: changed };
    },
    /** 模拟 Rust 的本地图链接解析；真实路径与 XML 校验由 Rust 单测覆盖。 */
    async resolve_flow_link({ source, link }) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) throw '不是本地图链接';
      const url = new URL(link.replace(/\\/g, '/'), 'http://mock.local' + source);
      const path = decodeURIComponent(url.pathname);
      const node = decodeURIComponent(url.hash.slice(1));
      if (!/\.drawio$/i.test(path)) throw '目标不是 .drawio';
      if (!Object.hasOwn(files, path)) throw '目标不存在：' + path;
      const doc = new DOMParser().parseFromString(files[path], 'text/xml');
      if (doc.querySelector('parsererror')) throw '目标 XML 损坏';
      if (node && ![...doc.querySelectorAll('mxCell[vertex="1"]')].some((cell) =>
        (cell.parentElement.matches('object, UserObject') ? cell.parentElement : cell).getAttribute('id') === node)) throw '目标节点不存在：' + node;
      return { path, node };
    },
    async read_diagram({ path }) {
      if (!Object.hasOwn(files, path)) throw '文件不存在：' + path;
      return { path, xml: files[path], hash: hash(files[path]) };
    },
    async save_diagram({ path, xml }) {
      if (agentLock) throw 'LOCKED:agent 正在编辑（pid 1）';
      userLocks.add(path);
      files[path] = xml;
      snap(path, 'user');
      return hash(xml);
    },
    async release_lock({ path }) { return userLocks.delete(path); },
    async lock_status({ path }) { return lockOf(path); },
    async history({ path }) {
      return snaps.filter((s) => s.path === path).reverse().map((s) => ({ id: s.id, ts: s.ts, source: s.source, hash: '', counts: counts(s.xml) }));
    },
    async diff({ old, new: nw }) {
      const a = counts(snaps.find((s) => s.id === old).xml), b = counts(snaps.find((s) => s.id === nw).xml);
      return Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => ({ kind: 'changed', page_name: '', node_id: `(${k} 计数)`, old_label: String(a[k]), new_label: String(b[k]), old_status: k, new_status: k }));
    },
    async snapshot_xml({ id }) { return snaps.find((s) => s.id === id).xml; },
    async restore({ path, id }) { files[path] = snaps.find((s) => s.id === id).xml; snap(path, 'restore'); return hash(files[path]); },
    async create_diagram({ name }) {
      const p = `/mock/flow/${name}.drawio`;
      files[p] = '<mxfile><diagram id="p" name="' + name + '"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
      snap(p, 'user');
      return p;
    },
    async read_md({ path }) { return { path, text: mds[path], hash: hash(mds[path]) }; },
    async save_md({ path, text }) {
      if (agentLock) throw 'LOCKED:agent 正在编辑（pid 1）';
      userLocks.add(path);
      mds[path] = text;
      emit('md-changed', { path, hash: hash(text), source: 'user' });
      return hash(text);
    },
    async tagged_nodes({ tag }) { return allNodes().filter((n) => n.tags.includes(tag)); },
    async create_feat({ title }) {
      const p = `/mock/feat/Feat_261101_${Object.keys(mds).length + 1}_${title}.md`;
      mds[p] = `# ${p.split('/').pop().match(/^(Feat_\d+_\d+)/)[1]} ${title}\n\n> 状态：需求整理中\n`;
      return p;
    },
    /** 弹出窗口：用 window.open 模拟（各窗口的模拟数据互相独立，只验证界面与窗口间路由）。 */
    async open_popout({ kind, path, node, line = 0 }) {
      const name = 'pop-' + kind;
      if (popWins[name] && !popWins[name].closed) {
        popWins[name].focus();
        bc.postMessage({ name: 'popout-open', payload: { kind, path, node, line } });
        return;
      }
      popWins[name] = window.open(`/index.html?solo=${kind}&path=${encodeURIComponent(path)}&node=${encodeURIComponent(node || '')}&line=${line}`, name, 'width=1100,height=820');
    },
  };

  // 窗口间事件：同一页面内直接派发，跨窗口经 BroadcastChannel（模拟 Tauri 的全局 emit）
  const popWins = {};
  const bc = new BroadcastChannel('fc-mock');
  bc.onmessage = (e) => emit(e.data.name, e.data.payload);
  const solo = new URLSearchParams(location.search).get('solo');
  let mockFullscreen = false;
  if (solo) window.addEventListener('pagehide', () => bc.postMessage({ name: 'popout-closed', payload: { kind: solo } }));

  window.__TAURI__ = {
    core: { invoke: (cmd, args) => (api[cmd] ? api[cmd](args || {}) : Promise.reject('mock 未实现 ' + cmd)) },
    event: {
      listen: async (name, f) => { (listeners[name] = listeners[name] || []).push(f); return () => {}; },
      emit: async (name, payload) => { emit(name, payload); bc.postMessage({ name, payload }); },
    },
    window: {
      getCurrentWindow: () => ({
        onCloseRequested: async () => () => {},
        setFullscreen: async (on) => { mockFullscreen = !!on; },
        isFullscreen: async () => mockFullscreen,
        destroy: async () => {},
        close: async () => {},
      }),
    },
  };

  window.__mock = {
    files, mds, snaps,
    agentLock(on) { agentLock = !!on; },
    /** 模拟 Agent：把第一个无填充色的圆角节点改成黄（起草待审），并发出文件变化通知。 */
    agentEdit(path) {
      path = path || Object.keys(files)[0];
      files[path] = files[path].replace(/style="(rounded=1;whiteSpace=wrap;html=1;)"/, 'style="$1fillColor=#fff2cc;strokeColor=#d6b656;"');
      snap(path, 'agent');
      emit('flow-changed', { path, hash: hash(files[path]), source: 'agent' });
    },
  };

  // 预置样例：dev_server 以 /__samples 提供样例文件（.drawio 与 Feat_*.md）
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/__samples', false);
  xhr.send();
  for (const [name, text] of Object.entries(JSON.parse(xhr.responseText))) {
    if (name.endsWith('.md')) mds[`/mock/feat/${name}`] = mdOverrides[`/mock/feat/${name}`] || text;
    else { files[`/mock/flow/${name}`] = text; snap(`/mock/flow/${name}`, 'scan'); }
  }
})();
