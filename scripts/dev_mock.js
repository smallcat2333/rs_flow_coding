// 浏览器预览用的 Tauri 模拟层：仅由 scripts/dev_server.py 注入，不随 App 打包。
// 内存保存图、Feat 档案与快照，用于在浏览器中验证 draw.io 嵌入、实时保存、只读锁、历史面板与节点↔Feat 联动。
// 控制台可用：__mock.agentLock(true/false) 模拟 Agent 加锁；__mock.agentEdit() 模拟 Agent 改图。
(function () {
  if (window.__TAURI__) return;
  const listeners = {};
  const files = {};       // 流程图 path -> xml
  const mds = {};         // Feat 档案 path -> text
  const snaps = [];       // {id, path, ts, source, xml}
  let agentLock = false;
  const userLocks = new Set();

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
    snaps.push({ id: snaps.length + 1, path, ts: new Date().toLocaleString(), source, xml });
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
      path: p, id, title, status, counts: c, node_total: mine.length, lock: lockOf(p),
      tasks_total: rows.length, tasks_done: rows.filter((r) => /完成|取消/.test(r.split('|').slice(-2)[0])).length,
      closable: mine.length > 0 && c.none === mine.length,
    };
  }

  const api = {
    async get_config() { return { roots: ['(mock)'], flow_dirs: [] }; },
    async set_roots() { return { roots: [], flow_dirs: [] }; },
    async summary() {
      const list = Object.keys(files).map((p) => ({ path: p, name: p.split('/').pop(), counts: counts(files[p]), lock: lockOf(p), error: null }));
      const total = {};
      list.forEach((f) => Object.entries(f.counts).forEach(([k, v]) => total[k] = (total[k] || 0) + v));
      const feats = Object.keys(mds).sort().reverse().map(featEntry);
      return [{ group: 'group_sever', app: 'rs_bot_sever', root: '', flow_dir: '/mock/flow', feat_dir: '/mock/feat', files: list, feats, counts: total }];
    },
    async read_diagram({ path }) { return { path, xml: files[path], hash: hash(files[path]) }; },
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
      const a = counts(snaps[old - 1].xml), b = counts(snaps[nw - 1].xml);
      return Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => ({ kind: 'changed', page_name: '', node_id: `(${k} 计数)`, old_label: String(a[k]), new_label: String(b[k]), old_status: k, new_status: k }));
    },
    async snapshot_xml({ id }) { return snaps[id - 1].xml; },
    async restore({ path, id }) { files[path] = snaps[id - 1].xml; snap(path, 'restore'); return hash(files[path]); },
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
      return hash(text);
    },
    async tagged_nodes({ tag }) { return allNodes().filter((n) => n.tags.includes(tag)); },
    async create_feat({ title }) {
      const p = `/mock/feat/Feat_261101_${Object.keys(mds).length + 1}_${title}.md`;
      mds[p] = `# ${p.split('/').pop().match(/^(Feat_\d+_\d+)/)[1]} ${title}\n\n> 状态：需求整理中\n`;
      return p;
    },
    /** 弹出窗口：用 window.open 模拟（各窗口的模拟数据互相独立，只验证界面与窗口间路由）。 */
    async open_popout({ kind, path, node }) {
      const name = 'pop-' + kind;
      if (popWins[name] && !popWins[name].closed) {
        popWins[name].focus();
        bc.postMessage({ name: 'popout-open', payload: { kind, path, node } });
        return;
      }
      popWins[name] = window.open(`/index.html?solo=${kind}&path=${encodeURIComponent(path)}&node=${encodeURIComponent(node || '')}`, name, 'width=1100,height=820');
    },
  };

  // 窗口间事件：同一页面内直接派发，跨窗口经 BroadcastChannel（模拟 Tauri 的全局 emit）
  const popWins = {};
  const bc = new BroadcastChannel('fc-mock');
  bc.onmessage = (e) => emit(e.data.name, e.data.payload);
  const solo = new URLSearchParams(location.search).get('solo');
  if (solo) window.addEventListener('pagehide', () => bc.postMessage({ name: 'popout-closed', payload: { kind: solo } }));

  window.__TAURI__ = {
    core: { invoke: (cmd, args) => (api[cmd] ? api[cmd](args || {}) : Promise.reject('mock 未实现 ' + cmd)) },
    event: {
      listen: async (name, f) => { (listeners[name] = listeners[name] || []).push(f); return () => {}; },
      emit: async (name, payload) => { emit(name, payload); bc.postMessage({ name, payload }); },
    },
    window: { getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }) },
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
    if (name.endsWith('.md')) mds[`/mock/feat/${name}`] = text;
    else { files[`/mock/flow/${name}`] = text; snap(`/mock/flow/${name}`, 'scan'); }
  }
})();
