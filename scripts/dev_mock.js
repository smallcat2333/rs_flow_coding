// 浏览器预览用的 Tauri 模拟层：仅由 scripts/dev_server.py 注入，不随 App 打包。
// 内存保存图内容与快照，用于在浏览器中验证 draw.io 嵌入、实时保存、只读锁与历史面板。
// 控制台可用：__mock.agentLock(true/false) 模拟 Agent 加锁；__mock.agentEdit() 模拟 Agent 改图。
(function () {
  if (window.__TAURI__) return;
  const listeners = {};
  const files = {};       // path -> xml
  const snaps = [];       // {id, path, ts, source, xml}
  let agentLock = false;
  let userLock = false;

  /** 简易状态统计：与 Rust flow::classify_style 同口径（仅用于预览）。 */
  function counts(xml) {
    const c = { none: 0, review: 0, plan_delete: 0, issue: 0, idea: 0, confirmed: 0, confirm_delete: 0, unknown: 0 };
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    for (const el of doc.querySelectorAll('mxCell[vertex="1"]')) {
      const style = el.getAttribute('style') || '';
      if (/^(text|swimlane|group|edgeLabel|note)(;|$)|shape=(note|swimlane)/.test(style)) continue;
      const fill = ((style.match(/fillColor=([^;]+)/) || [])[1] || '').toLowerCase();
      const dashed = /dashed=1/.test(style);
      const s = { '': 'none', none: 'none', '#ffffff': 'none', '#fff2cc': 'review', '#f8cecc': 'issue', '#dae8fc': 'idea' }[fill]
        || (fill === '#d5e8d4' ? (dashed ? 'confirm_delete' : 'confirmed') : fill === '#f5f5f5' && dashed ? 'plan_delete' : 'unknown');
      c[s]++;
    }
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

  const api = {
    async get_config() { return { roots: ['(mock)'], flow_dirs: [] }; },
    async set_roots() { return { roots: [], flow_dirs: [] }; },
    async summary() {
      const list = Object.keys(files).map((p) => ({
        path: p, name: p.split('/').pop(), counts: counts(files[p]),
        lock: agentLock ? { owner: 'agent', pid: 1, since: Date.now() / 1000 } : null, error: null,
      }));
      const total = {};
      list.forEach((f) => Object.entries(f.counts).forEach(([k, v]) => total[k] = (total[k] || 0) + v));
      return [{ group: 'group_sever', app: 'rs_bot_sever', root: '', flow_dir: '/mock/flow', files: list, counts: total }];
    },
    async read_diagram({ path }) { return { path, xml: files[path], hash: hash(files[path]) }; },
    async save_diagram({ path, xml }) {
      if (agentLock) throw 'LOCKED:agent 正在编辑（pid 1）';
      userLock = true;
      files[path] = xml;
      snap(path, 'user');
      return hash(xml);
    },
    async release_lock() { const r = userLock; userLock = false; return r; },
    async lock_status() { return agentLock ? { owner: 'agent', pid: 1, since: Date.now() / 1000 } : userLock ? { owner: 'user', pid: 2, since: 0 } : null; },
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
  };

  window.__TAURI__ = {
    core: { invoke: (cmd, args) => (api[cmd] ? api[cmd](args || {}) : Promise.reject('mock 未实现 ' + cmd)) },
    event: { listen: async (name, f) => { (listeners[name] = listeners[name] || []).push(f); return () => {}; } },
  };

  window.__mock = {
    files, snaps,
    agentLock(on) { agentLock = !!on; },
    /** 模拟 Agent：把第一个无填充色的圆角节点改成黄（起草待审），并发出文件变化通知。 */
    agentEdit(path) {
      path = path || Object.keys(files)[0];
      files[path] = files[path].replace(/style="(rounded=1;whiteSpace=wrap;html=1;)"/, 'style="$1fillColor=#fff2cc;strokeColor=#d6b656;"');
      snap(path, 'agent');
      emit('flow-changed', { path, hash: hash(files[path]), source: 'agent' });
    },
  };

  // 预置样例：dev_server 以 /__samples 提供样例文件列表
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/__samples', false);
  xhr.send();
  for (const [name, xml] of Object.entries(JSON.parse(xhr.responseText))) {
    files[`/mock/flow/${name}`] = xml;
    snap(`/mock/flow/${name}`, 'scan');
  }
})();
