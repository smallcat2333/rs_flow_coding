// 仅由开发服务器注入主窗口和 Agent 页面；会话、归档与终端均为浏览器模拟，不启动真实 CLI。
(() => {
  const original = window.__TAURI__.core.invoke;
  const { emit, listen } = window.__TAURI__.event;
  const sessions = new Map();
  const calls = [];
  // 仅预览入口使用：延迟就绪与启动超时复用真实页面逻辑，不启动 CLI。
  const startup = new URLSearchParams(location.search).get('agentStartup');
  const startupReady = startup === 'slow' ? new Promise(resolve => { window.__mock.agentReady = resolve; }) : Promise.resolve();
  window.__mock.agentSessions = sessions;
  window.__mock.agentCalls = calls;
  const key = p => String(p || '').replace(/\\/g, '/').toLowerCase();
  const stem = p => String(p).split(/[\\/]/).pop().replace(/\.drawio$/i, '');
  function sync(s) {
    s.source_kind = s.feat ? 'feat' : s.links.length ? 'flow' : '';
    s.source_path = s.feat || s.links[0]?.flow || '';
    s.title_locked = !!s.source_kind;
    if (s.feat) {
      const text = window.__mock.mds[s.feat] || '';
      s.title = (text.match(/^#\s+(?:Feat_\d+_\d+\s+)?(.+)$/m) || [])[1] || s.title;
    } else if (s.source_kind === 'flow') s.title = stem(s.source_path);
    return s;
  }
  function make(p) {
    return sync({ id: crypto.randomUUID(), title: p.title || '新会话', cwd: p.cwd || '/mock', app: p.app || 'rs_bot_sever', feat: p.feat || '', feat_code: p.featCode || '', links: p.links || [], pinned: !!p.pinned, pin_at: Date.now(), created: Date.now(), started: true,
      running: false, archived_at: 0, status: 'off', since: Date.now(), beat: Date.now(), turn: 0, tool: '', tool_since: 0, wait_text: '', focus: null, task: null, workers: [], exit_code: null, done: 0, seen: 0, queued: 0, acts: [] });
  }
  const feat = Object.keys(window.__mock.mds)[0], flows = Object.keys(window.__mock.files);
  const add = p => { const s = make(p); sessions.set(s.id, s); return s; };
  if (feat) add({ feat, featCode: feat.split('/').pop().match(/^(Feat_\d+_\d+)/)[1] });
  if (flows[0]) add({ links: [{ flow: flows[0], node: '' }] });
  add({ title: '排查日志（浏览器模拟）' });
  async function update(s) { sync(s); await emit('agent-update', s); return structuredClone(s); }
  listen('md-changed', () => { for (const s of sessions.values()) update(s); });
  window.__TAURI__.core.invoke = async (cmd, args = {}) => {
    calls.push({ cmd, args });
    const s = sessions.get(args.id);
    if (cmd === 'open_agent_window') return;
    if (cmd === 'summary') return (await original(cmd, args)).map(a => ({ ...a, root: a.root || (a.app === 'rs_bot_sever' ? '/mock' : '/mock/' + a.app) }));
    if (cmd === 'agent_list') {
      if (startup === 'error') throw 'Agent 服务启动超时（30 秒），请稍后重试';
      await startupReady;
      return [...sessions.values()].map(s => structuredClone(sync(s)));
    }
    if (cmd === 'agent_create') {
      const wanted = make(args);
      const duplicate = [...sessions.values()].find(x => !x.archived_at && wanted.source_kind && sync(x).source_kind === wanted.source_kind && key(x.source_path) === key(wanted.source_path));
      if (duplicate) throw `DUP:${duplicate.id}:来源已有主会话`;
      wanted.running = true; wanted.status = 'idle';
      sessions.set(wanted.id, wanted);
      return update(wanted);
    }
    if (cmd === 'agent_update') {
      if (s.title_locked && args.patch.title != null && args.patch.title !== s.title) throw '主 Agent 名称跟随来源，不能单独修改';
      Object.assign(s, args.patch);
      return update(s);
    }
    if (cmd === 'agent_buffer') return { data: '\x1b[36m浏览器模拟终端\x1b[0m\r\n这里用于验证侧栏与会话交互，不会调用 Claude Code。\r\n', seq: 0 };
    if (cmd === 'agent_archive') {
      if (!args.archived && [...sessions.values()].some(x => x.id !== s.id && !x.archived_at && s.source_kind && x.source_kind === s.source_kind && key(x.source_path) === key(s.source_path))) throw '该来源已有主会话';
      s.archived_at = args.archived ? s.archived_at || Date.now() : 0;
      if (args.archived) { s.running = false; s.status = 'off'; }
      return update(s);
    }
    if (cmd === 'agent_start' && s.archived_at) throw '会话已归档，请先取消归档';
    if (cmd === 'agent_start' || cmd === 'agent_stop') { s.running = cmd === 'agent_start'; s.status = s.running ? 'idle' : 'off'; await update(s); return; }
    if (cmd === 'agent_seen' || cmd === 'agent_resize' || cmd === 'agent_write') return;
    if (cmd === 'agent_remove') { sessions.delete(args.id); await emit('agent-removed', { id: args.id }); return; }
    if (cmd === 'rename_entry') {
      const result = await original(cmd, args);
      for (const x of sessions.values()) {
        if (key(x.feat) === key(args.path)) x.feat = result.path;
        for (const l of x.links) if (key(l.flow) === key(args.path)) l.flow = result.path;
        await update(x);
      }
      return result;
    }
    return original(cmd, args);
  };
})();
