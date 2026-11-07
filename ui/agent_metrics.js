// 会话信息侧栏：模型、上下文、真实 CLI 计划、本轮状态、子 Agent 与工作位置。
'use strict';
window.AgentMetrics = (() => {
  let root, body, toggleButton, onResize, layout;
  let currentId = '', contextSignature = '', planSignature = '', usageSignature = '';
  let hasSession = false, preferredOpen = true, narrow = false, narrowOpen = false, visible = false;
  const number = value => new Intl.NumberFormat('zh-CN').format(value);
  const compactNumber = value => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).replace('K', 'k');
  const money = value => '$' + (value >= 100 ? Math.round(value) : value >= 10 ? value.toFixed(1) : value.toFixed(2));

  /** 累计用量：token、请求数与耗时来自对话记录（主对话），费用来自 CLI 估算；未知值显示「—」，不补零。 */
  function usageStats(m) {
    const u = m?.usage, cost = Number.isFinite(m?.cost_usd) ? m.cost_usd : null;
    const input = u ? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens : 0;
    const tokens = u ? input + u.output_tokens : 0;
    const stat = (key, label, value, tip) => ({ key, label, value: value ?? '—', tip, known: value != null });
    return {
      known: !!u || cost != null,
      items: [
        stat('tokens', 'Token', u ? compactNumber(tokens) : null, u ? `累计 ${number(tokens)} token（主对话）\n输入 ${number(u.input_tokens)} · 缓存写入 ${number(u.cache_creation_input_tokens)}\n缓存读取 ${number(u.cache_read_input_tokens)} · 输出 ${number(u.output_tokens)}` : '等待对话记录'),
        stat('tps', 'TPS', u && u.request_ms > 0 && u.output_tokens > 0 ? (u.output_tokens / u.request_ms * 1000).toFixed(1) : null, u ? `每秒输出 token：输出 ${number(u.output_tokens)} ÷ 请求耗时 ${Math.round(u.request_ms / 1000)} 秒（含首字延迟）` : '等待对话记录'),
        stat('cost', '费用估值', cost != null ? money(cost) : null, 'CLI 按标价估算的本会话费用，含子代理，不等于实际账单'),
        stat('hit', '缓存命中', u && input > 0 ? (Math.round(u.cache_read_input_tokens / input * 1000) / 10) + '%' : null, '缓存读取 ÷ 全部输入（含缓存写入与普通输入）'),
        stat('calls', '调用次数', u ? number(u.requests) : null, '主对话 API 请求数，不含子代理'),
        stat('avg', '均次费用', cost != null && u?.requests ? money(cost / u.requests) : null, '费用估值 ÷ 调用次数；费用含子代理请求，结果可能略高'),
      ],
    };
  }

  /** 将当前会话转为侧栏数据；保留未知值，已结束任务冻结计时，计划只使用后端原生快照。 */
  function describe(s, at = now()) {
    const m = s.metrics;
    const contextKnown = m?.used_tokens != null && m.capacity > 0 && Number.isFinite(m.used_percentage)
      && [m.input_tokens, m.cache_creation_input_tokens, m.cache_read_input_tokens].every(v => v != null);
    const contextParts = contextKnown ? [
      { key: 'input', label: '普通输入', count: m.input_tokens },
      { key: 'creation', label: '缓存写入', count: m.cache_creation_input_tokens },
      { key: 'read', label: '缓存读取', count: m.cache_read_input_tokens },
      { key: 'free', label: '剩余容量', count: Math.max(0, m.capacity - m.used_tokens) },
    ].map(p => ({ ...p, pct: Math.round(p.count / m.capacity * 1000) / 10 })) : [];
    let phase = !s.running ? (s.status === 'err' ? '异常退出' : '已停止')
      : s.status === 'interrupted' ? '已中断' : s.status === 'apierr' ? 'API 错误' : s.compacting ? '压缩上下文' : s.status === 'wait' ? '等待确认'
      : s.tool ? `执行 ${s.tool}` : s.status === 'boot' ? '启动中'
      : s.status === 'run' ? '运行中' : '等待输入';
    const finished = s.turn > 0 && s.done >= s.turn;
    if (finished && s.running && s.status === 'idle') phase = '已完成';
    const end = s.status === 'interrupted' ? s.since : finished ? s.done : s.running ? at : s.since;
    const duration = s.turn > 0 ? clock(end - s.turn) : '—';
    const workers = (s.workers || []).map(w => {
      const running = !!(s.running && w.running);
      return { id: w.id, desc: w.desc, running, duration: clock((running ? at : w.t1 || s.since) - w.t0) };
    });
    const tasks = s.plan?.tasks || [];
    return {
      currentDir: m?.current_dir || '待获取', gitBranch: m?.git_branch || '未获取',
      model: m?.model_name || m?.model_id || '模型待获取', modelId: m?.model_id || '待获取', effort: m?.effort || '未上报',
      contextKnown, percentage: contextKnown ? Math.round(m.used_percentage * 10) / 10 : null,
      used: contextKnown ? number(m.used_tokens) : '待获取', capacity: m?.capacity > 0 ? number(m.capacity) : '待获取',
      usedCompact: contextKnown ? compactNumber(m.used_tokens) : '—',
      capacityCompact: m?.capacity > 0 ? compactNumber(m.capacity) : '—',
      contextParts, updated: m?.updated_at ? ago(at - m.updated_at) : '尚未上报',
      phase, duration, tool: s.tool || '无', activity: s.beat ? ago(at - s.beat) : '尚无活动',
      workers, runningWorkers: workers.filter(w => w.running).length,
      usage: usageStats(m),
      tasks, completedTasks: tasks.filter(t => t.status === 'completed').length,
      planWaiting: !s.plan, planError: s.plan?.error || '',
      previousPlan: tasks.length > 0 && s.turn > 0 && s.plan.updated_at < s.turn,
    };
  }

  /** 按原始 token 数绘制分段；零值不占宽，分段支持悬停和键盘聚焦查看精确值。 */
  function renderStackedBar(parts) {
    return `<span class="am-bar" role="group" aria-label="上下文用量分布">${parts.filter(p => p.count > 0).map(p => {
      const tip = `${p.label}：${number(p.count)} token（${p.pct}%）`;
      return `<span class="am-bar-seg seg-${p.key}" style="flex-grow:${p.count}" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0"></span>`;
    }).join('')}</span>`;
  }

  /** 常驻上下文卡使用同一快照，数值以总容量为分母；缺失数据只显示等待状态。 */
  function renderContextTotal(d) {
    const tone = !d.contextKnown ? ' none' : d.percentage >= 90 ? ' danger' : d.percentage >= 75 ? ' warn' : '';
    return `<span class="am-context-total" title="${esc(d.used)} / ${esc(d.capacity)} token"><span>${d.usedCompact} / ${d.capacityCompact}</span><strong class="am-pct${tone}">${d.contextKnown ? d.percentage + '%' : '待获取'}</strong></span>`;
  }

  function renderContextDetail(d, compacting) {
    const content = d.contextKnown ? renderStackedBar(d.contextParts)
      + `<table class="am-context-table" aria-label="上下文用量明细"><tbody>${d.contextParts.map(p => `<tr class="row-${p.key}"><th scope="row"><i class="am-swatch seg-${p.key}" aria-hidden="true"></i>${esc(p.label)}</th><td title="${number(p.count)} token">${compactNumber(p.count)}</td><td>${p.pct}%</td></tr>`).join('')}</tbody></table>` : '';
    const hint = compacting ? '正在压缩，完成后等待新数据' : d.contextKnown ? '含缓存读写，不含输出' : '等待 CLI 上报完整分项数据';
    return `${content}<p class="am-context-foot"><span>${hint}</span><span data-am="contextUpdated"></span></p>`;
  }

  /** 只读显示 CLI 任务状态；不将普通回复推断为计划，未生成及读取失败分别展示。 */
  function renderPlan(d) {
    if (d.planError) return `<li class="am-empty am-error">无法读取计划：${esc(d.planError)}</li>`;
    if (!d.tasks.length) return `<li class="am-empty">${d.planWaiting ? '等待 CLI 同步任务计划' : '暂无任务计划'}</li>`;
    const labels = { pending: '待执行', in_progress: '进行中', completed: '已完成' };
    return d.tasks.map(task => {
      const label = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject;
      const mark = task.status === 'completed' ? '<path d="m3 7 2.5 2.5L11 4"/>'
        : task.status === 'in_progress' ? '<circle cx="7" cy="7" r="5" stroke-dasharray="20 12"/><circle cx="7" cy="7" r="1" fill="currentColor" stroke="none"/>' : '<circle cx="7" cy="7" r="4.5"/>';
      return `<li class="am-plan-task task-${task.status}"><span class="am-task-mark" role="img" aria-label="${labels[task.status]}"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">${mark}</svg></span><span class="am-task-subject" title="${esc(task.subject)}">${esc(label)}</span></li>`;
    }).join('');
  }

  /** 宽屏占固定侧栏，窄屏默认关闭并以覆盖栏打开，始终保留终端宽度。 */
  function syncVisibility() {
    const nextNarrow = body.clientWidth < 840;
    if (nextNarrow !== narrow) { narrow = nextNarrow; narrowOpen = false; }
    body.classList.toggle('info-narrow', narrow);
    const open = hasSession && (narrow ? narrowOpen : preferredOpen);
    root.hidden = !open;
    if (!open) layout?.hideTip();
    toggleButton.hidden = !hasSession;
    toggleButton.setAttribute('aria-expanded', String(open));
    toggleButton.title = open ? '收起会话信息' : '展开会话信息';
    if (visible !== open) { visible = open; onResize(); }
  }

  /** 用户开关只作用于信息栏；不会重建终端、重启会话或改变其他侧栏。 */
  function toggle() {
    if (narrow) narrowOpen = !visible; else preferredOpen = !visible;
    syncVisibility();
  }

  /** 关闭侧栏后将焦点交还开关，避免键盘焦点留在隐藏内容中。 */
  function close() {
    if (narrow) narrowOpen = false; else preferredOpen = false;
    syncVisibility();
    toggleButton.focus();
  }

  /** 安装稳定结构与开关；随后仅更新数据，保留展开状态、焦点及终端实例。 */
  function init(resize) {
    root = document.getElementById('agentMetrics');
    body = document.getElementById('sessionBody');
    toggleButton = document.getElementById('agentInfoToggle');
    onResize = resize;
    const group = (id, title, content, trailing = '') => `<details class="am-section am-group am-${id}" data-am-group="${id}" open><summary draggable="true" title="拖拽排序，松手保存（所有会话共用）；Alt+↑/↓ 移动分组"><b class="am-title">${title}</b>${trailing}<span class="am-grip" aria-hidden="true">⠿</span></summary><div class="am-group-content">${content}</div></details>`;
    // 分组容器只建一次；更新数值不会重建 details、重置折叠状态或拖拽顺序。
    root.innerHTML = `<header class="am-head"><div class="am-session" id="head"></div><button class="am-close" data-am="close" aria-label="收起会话信息" title="收起会话信息"><svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8"/></svg></button>
        <div class="am-status"><span class="am-phase" data-am="phase"></span><span class="am-duration" data-am="durationWrap">本轮 <time data-am="duration"></time></span></div>
        <p class="am-wait" data-am="waitText" hidden></p></header>
      <div class="am-scroll">
        ${group('run', '模型与活动', '<dl class="am-props"><dt>模型</dt><dd class="am-model-value"><span data-am="model"></span><span class="am-effort" data-am="effort"></span></dd><dt>活动</dt><dd class="am-meta" data-am="activity"></dd></dl>')}
        ${group('usage', '用量', '<div class="am-stats" data-am="stats"></div>', '<span class="am-count">本会话累计</span>')}
        ${group('context', '上下文', '<div data-am="contextDetail"></div>', '<span data-am="contextTotal"></span>')}
        ${group('plan', '任务计划', '<p class="am-meta" data-am="planHint" hidden>上轮计划</p><ol class="am-plan-list" data-am="planList"></ol>', '<span class="am-count" data-am="planCount"></span>')}
        ${group('links', '关联', '<div id="headLinks"></div>', '<button class="am-link-add" data-addlink="1" title="搜索流程图或 Feat 并关联"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M6 1v10M1 6h10"/></svg><span>添加</span></button>')}
        ${group('workers', '子 Agent', '<div data-am="workerDetail"></div>', '<span class="am-count" data-am="workerCount"></span>')}
        ${group('location', '工作位置', '<dl class="am-props"><dt>目录</dt><dd class="am-mono" data-am="currentDir"></dd><dt>分支</dt><dd class="am-mono" data-am="gitBranch"></dd></dl>')}
      </div><div class="am-tooltip" id="agentMetricTip" data-am="tooltip" role="tooltip" hidden></div>`;
    layout = window.AgentInfoLayout.init(root);
    toggleButton.addEventListener('click', toggle);
    root.querySelector('[data-am="close"]').addEventListener('click', close);
    root.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    new ResizeObserver(() => { syncVisibility(); onResize(); }).observe(body);
    syncVisibility();
  }

  /** 更新选中会话；总览隐藏侧栏，同快照不重画上下文和计划，续接前的计划保留来源提示。 */
  function render(s) {
    hasSession = !!s;
    if (!s) { currentId = ''; syncVisibility(); return; }
    if (currentId !== s.id) { layout.hideTip(); currentId = s.id; contextSignature = ''; planSignature = ''; usageSignature = ''; }
    const d = describe(s), el = name => root.querySelector(`[data-am="${name}"]`);
    el('model').textContent = d.model;
    el('model').title = d.modelId;
    el('effort').textContent = d.effort;
    const effortLevel = String(d.effort).trim().toLowerCase();
    el('effort').setAttribute('data-level', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effortLevel) ? effortLevel : '');
    el('effort').title = `推理强度：${d.effort}`;
    el('phase').textContent = d.phase;
    el('phase').title = s.api_error || '';
    el('phase').className = 'am-phase' + (typeof vs === 'function' ? ' v-' + vs(s) : '');
    el('duration').textContent = d.duration;
    el('durationWrap').hidden = d.duration === '—';
    el('activity').textContent = d.activity;
    el('waitText').hidden = !s.wait_text;
    el('waitText').textContent = s.wait_text || '';
    const signature = JSON.stringify([d.contextParts, d.percentage, d.used, d.capacity, !!s.compacting]);
    if (signature !== contextSignature) {
      el('contextTotal').innerHTML = renderContextTotal(d);
      el('contextDetail').innerHTML = renderContextDetail(d, !!s.compacting);
      contextSignature = signature;
    }
    el('contextUpdated').textContent = d.updated;
    // 每秒刷新只在数值变化时重写，悬停提示不闪烁。
    const nextUsage = JSON.stringify(d.usage);
    if (nextUsage !== usageSignature) {
      layout.hideTip();
      el('stats').innerHTML = d.usage.known
        ? d.usage.items.map(x => `<div class="am-stat st-${x.key}${x.known ? '' : ' unknown'}" tabindex="0" role="group" aria-label="${esc(x.label)}：${esc(x.value)}" data-am-tip="${esc(x.label)}：${esc(x.value)}&#10;${esc(x.tip)}"><b>${esc(x.value)}</b></div>`).join('')
        : '<p class="am-empty">等待 CLI 上报用量</p>';
      usageSignature = nextUsage;
    }
    const nextPlan = JSON.stringify([d.tasks, d.planError, d.planWaiting, d.previousPlan]);
    if (nextPlan !== planSignature) {
      el('planCount').textContent = d.tasks.length ? `${d.completedTasks}/${d.tasks.length}` : '';
      el('planHint').hidden = !d.previousPlan;
      el('planList').innerHTML = renderPlan(d);
      planSignature = nextPlan;
    }
    el('workerCount').textContent = d.workers.length ? `${d.runningWorkers} 运行中` : '';
    el('workerDetail').innerHTML = d.workers.length ? `<ul class="am-worker-list">${d.workers.map(w => `<li class="${w.running ? 'running' : ''}"><i class="am-worker-dot" role="img" aria-label="${w.running ? '运行中' : '已结束'}"></i><span class="am-worker-name" title="${esc(w.desc)}（${w.running ? '运行中' : '已结束'}）">${esc(w.desc)}</span><time>${esc(w.duration)}</time></li>`).join('')}</ul>` : '<p class="am-empty">暂无子 Agent</p>';
    el('currentDir').textContent = d.currentDir;
    el('currentDir').title = d.currentDir;
    el('gitBranch').textContent = d.gitBranch;
    syncVisibility();
  }
  return { init, render, describe };
})();
