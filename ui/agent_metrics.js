// 会话遥测条：上下文、模型与档位、本轮状态、子 Agent、实际目录与 Git 分支。
'use strict';
window.AgentMetrics = (() => {
  let root, currentId = '', contextSignature = '';
  const number = (value) => new Intl.NumberFormat('zh-CN').format(value);
  const compactNumber = (value) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase();

  /** 将会话快照转为展示数据；本轮完成后停止计时，上下文未知时不显示虚假的零占用。 */
  function describe(s, at = now()) {
    const m = s.metrics;
    const contextKnown = m?.used_tokens != null && m.capacity > 0 && Number.isFinite(m.used_percentage)
      && [m.input_tokens, m.cache_creation_input_tokens, m.cache_read_input_tokens].every((v) => v != null);
    const contextParts = contextKnown ? [
      { key: 'input', label: '普通输入', count: m.input_tokens },
      { key: 'creation', label: '缓存写入', count: m.cache_creation_input_tokens },
      { key: 'read', label: '缓存读取', count: m.cache_read_input_tokens },
      { key: 'free', label: '剩余容量', count: Math.max(0, m.capacity - m.used_tokens) },
    ].map((p) => ({ ...p, pct: Math.round(p.count / m.capacity * 1000) / 10 })) : [];
    let phase = !s.running ? (s.status === 'err' ? '异常退出' : '已停止')
      : s.compacting ? '压缩上下文' : s.status === 'wait' ? '等待确认'
      : s.tool ? `执行 ${s.tool}` : s.status === 'boot' ? '启动中'
      : s.status === 'run' ? '运行中' : '等待输入';
    const finished = s.turn > 0 && s.done >= s.turn;
    if (finished && s.running && s.status === 'idle') phase = '已完成';
    const end = finished ? s.done : s.running ? at : s.since;
    const duration = s.turn > 0 ? clock(end - s.turn) : '—';
    const workers = (s.workers || []).map((w) => {
      const running = !!(s.running && w.running);
      return { id: w.id, desc: w.desc, running, duration: clock((running ? at : w.t1 || s.since) - w.t0) };
    });
    return {
      currentDir: m?.current_dir || '待获取', gitBranch: m?.git_branch || '未获取',
      model: m?.model_name || m?.model_id || '模型待获取', modelId: m?.model_id || '待获取', effort: m?.effort || '未上报',
      contextKnown, percentage: contextKnown ? Math.round(m.used_percentage * 10) / 10 : null,
      used: contextKnown ? number(m.used_tokens) : '待获取', capacity: m?.capacity > 0 ? number(m.capacity) : '待获取',
      usedCompact: contextKnown ? compactNumber(m.used_tokens) : '待获取',
      capacityCompact: m?.capacity > 0 ? compactNumber(m.capacity) : '待获取',
      contextParts,
      updated: m?.updated_at ? ago(at - m.updated_at) : '尚未上报',
      phase, duration, tool: s.tool || '无', activity: s.beat ? ago(at - s.beat) : '尚无活动',
      workers, runningWorkers: workers.filter((w) => w.running).length,
    };
  }

  /** 按原始 token 数画同一组分段；零值不占宽，展开条支持鼠标与键盘查看精确值。 */
  function renderStackedBar(parts, mini = false) {
    return `<span class="am-bar${mini ? ' am-bar-mini' : ''}" role="group" aria-label="上下文用量分布">${parts.filter((p) => p.count > 0).map((p) => {
      const tip = `${p.label}：${number(p.count)} token（${p.pct}%）`;
      return `<span class="am-bar-seg seg-${p.key}" style="flex-grow:${p.count}" data-tip="${esc(tip)}" aria-label="${esc(tip)}"${mini ? '' : ' tabindex="0"'}></span>`;
    }).join('')}</span>`;
  }

  /** 展开面板复用短条的分项，数值以总容量为分母；缺失数据只显示等待状态。 */
  function renderContextDetail(d, compacting) {
    const content = d.contextKnown ? renderStackedBar(d.contextParts)
      + `<table class="am-context-table" aria-label="上下文用量明细"><tbody>${d.contextParts.map((p) => `<tr><th scope="row"><i class="am-swatch seg-${p.key}" aria-hidden="true"></i>${esc(p.label)}</th><td title="${number(p.count)} token">${compactNumber(p.count)}</td><td>${p.pct}%</td></tr>`).join('')}</tbody></table>` : '';
    const hint = compacting ? '正在压缩，完成后等待新数据。' : d.contextKnown ? '当前输入含缓存读写，不含输出。' : '等待 CLI 上报完整分项数据。';
    return `<b>上下文</b><div class="am-context-total"><strong>${d.contextKnown ? d.percentage + '% 已用' : '待获取'}</strong><span title="${esc(d.used)} / ${esc(d.capacity)} token">${d.usedCompact} / ${d.capacityCompact}</span></div>${content}<p class="am-context-foot">${hint} <span data-am="contextUpdated"></span></p>`;
  }

  /** 安装一次固定结构；后续只更新值和展开内容，保留用户正在查看的详情与键盘焦点。 */
  function init(onResize) {
    root = document.getElementById('agentMetrics');
    new ResizeObserver(onResize).observe(root);
    root.innerHTML = `<details class="am-item am-model"><summary><span data-am="model"></span><span class="am-effort" data-am="effort"></span></summary><div class="am-panel" data-am="modelDetail"></div></details>
      <details class="am-item am-context"><summary><span>上下文</span><span data-am="bar"></span><b data-am="percentage"></b></summary><div class="am-panel" data-am="contextDetail"></div></details>
      <details class="am-item am-round"><summary><span>本轮</span><span data-am="duration"></span><span class="am-phase" data-am="phase"></span></summary><div class="am-panel" data-am="roundDetail"></div></details>
      <details class="am-item am-workers"><summary><span>子 Agent</span><b data-am="workerCount"></b></summary><div class="am-panel" data-am="workerDetail"></div></details>
      <details class="am-item am-directory"><summary><span>目录</span><span data-am="currentDir"></span></summary><div class="am-panel" data-am="directoryDetail"></div></details>
      <details class="am-item am-git"><summary><span>Git</span><span data-am="gitBranch"></span></summary><div class="am-panel" data-am="gitDetail"></div></details>`;
    root.addEventListener('toggle', (e) => {
      if (!e.target.matches('details') || !e.target.open) return;
      root.querySelectorAll('details').forEach((item) => { if (item !== e.target) item.open = false; });
    }, true);
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      root.querySelectorAll('details').forEach((item) => { item.open = false; });
    });
    document.addEventListener('pointerdown', (e) => {
      if (!root.contains(e.target)) root.querySelectorAll('details').forEach((item) => { item.open = false; });
    });
  }

  /** 更新当前会话指标；切换会话时关闭旧详情，总览隐藏，不产生额外轮询或 API 请求。 */
  function render(s) {
    root.hidden = !s;
    if (!s) { currentId = ''; return; }
    if (currentId !== s.id) {
      root.querySelectorAll('details').forEach((item) => { item.open = false; });
      currentId = s.id;
    }
    const d = describe(s), el = (name) => root.querySelector(`[data-am="${name}"]`);
    el('currentDir').textContent = d.currentDir;
    el('currentDir').title = d.currentDir;
    el('directoryDetail').innerHTML = `<b>实际工作目录</b><dl><dt>目录</dt><dd>${esc(d.currentDir)}</dd></dl><p>${esc(d.updated)}</p>`;
    el('gitBranch').textContent = d.gitBranch;
    el('gitBranch').title = d.gitBranch;
    el('gitDetail').innerHTML = `<b>Git 分支</b><dl><dt>分支</dt><dd>${esc(d.gitBranch)}</dd><dt>目录</dt><dd>${esc(d.currentDir)}</dd></dl><p>${esc(d.updated)}</p>`;
    el('model').textContent = d.model;
    el('effort').textContent = s.metrics?.effort ? '/ ' + d.effort : '';
    el('modelDetail').innerHTML = `<b>模型与推理档位</b><dl><dt>模型</dt><dd>${esc(d.model)}</dd><dt>模型 ID</dt><dd>${esc(d.modelId)}</dd><dt>推理档位</dt><dd>${esc(d.effort)}</dd></dl><p>以 CLI 上报为准 · ${esc(d.updated)}</p>`;
    el('bar').hidden = !d.contextKnown;
    el('percentage').textContent = d.contextKnown ? d.percentage + '%' : '待获取';
    const signature = JSON.stringify([d.contextParts, d.percentage, d.used, d.capacity, !!s.compacting]);
    if (signature !== contextSignature) {
      el('bar').innerHTML = d.contextKnown ? renderStackedBar(d.contextParts, true) : '';
      el('contextDetail').innerHTML = renderContextDetail(d, !!s.compacting);
      contextSignature = signature;
    }
    el('contextUpdated').textContent = d.updated;
    el('phase').textContent = d.phase;
    el('duration').textContent = d.duration;
    el('roundDetail').innerHTML = `<b>本轮运行情况</b><dl><dt>状态</dt><dd>${esc(d.phase)}</dd><dt>本轮耗时</dt><dd>${esc(d.duration)}</dd><dt>当前工具</dt><dd>${esc(d.tool)}</dd><dt>最近活动</dt><dd>${esc(d.activity)}</dd></dl>${s.wait_text ? `<p>${esc(s.wait_text)}</p>` : ''}<p>耗时包含等待确认；完成后停止计时。</p>`;
    el('workerCount').textContent = String(d.runningWorkers);
    el('workerDetail').innerHTML = `<b>子 Agent · ${d.runningWorkers} 个运行中</b>${d.workers.length ? `<ul>${d.workers.map((w) => `<li><span class="am-worker-state ${w.running ? 'running' : ''}">${w.running ? '运行中' : '已结束'}</span><span class="am-worker-name" title="${esc(w.id)}">${esc(w.desc)}</span><time>${esc(w.duration)}</time></li>`).join('')}</ul>` : '<p>暂无子 Agent 记录。</p>'}`;
  }
  return { init, render, describe };
})();
