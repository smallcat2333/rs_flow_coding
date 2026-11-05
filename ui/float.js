// 悬浮窗页面：只展示主窗口推送的 float-data，不自己汇总项目（汇总会触发扫描与入库）。
// 单击 / 回车回到 Flow Coding；按下后移动超过 4px 视为拖动，交给系统移动窗口。
'use strict';

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen, emit } = window.__TAURI__.event;
  const win = window.__TAURI__.window.getCurrentWindow();
  const $ = (id) => document.getElementById(id);

  /** 两侧的状态构成：谁该动手按协作规则划分；色块与主窗口状态色一致，dash 表示删除类虚线。 */
  const SIDES = {
    user: [
      { key: 'review', name: '待审', full: '起草待审', fill: '#fff2cc', stroke: '#d6b656' },
      { key: 'plan_delete', name: '删除', full: '计划删除', fill: '#f5f5f5', dash: true },
    ],
    agent: [
      { key: 'confirmed', name: '确认', full: '已确认待实现', fill: '#d5e8d4', stroke: '#82b366' },
      { key: 'issue', name: '问题', full: '有问题', fill: '#f8cecc', stroke: '#b85450' },
      { key: 'idea', name: '想法', full: '你的想法', fill: '#dae8fc', stroke: '#6c8ebf' },
      { key: 'confirm_delete', name: '删除', full: '确认删除', fill: '#d5e8d4', dash: true },
    ],
  };
  const SOURCE = { agent: 'Agent', external: '外部程序' };
  /** 最近一次推送；locks 会被本页轮询修正（Agent 解锁不改文件，不会触发主窗口刷新）。 */
  let data = null;

  /** 文本转义，名称来自文件名与别名。 */
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** 相对时间：一分钟内为“刚刚”，一小时内按分钟，当天按小时，更早给月/日。 */
  function ago(time) {
    const s = (Date.now() - time) / 1000;
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    const d = new Date(time);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  /** 一侧：合计大数字 + 非零状态色块；合计为零时整侧变淡，色块区留空。 */
  function side(name, counts) {
    const parts = SIDES[name].map((s) => ({ ...s, value: counts[s.key] || 0 }));
    const total = parts.reduce((sum, p) => sum + p.value, 0);
    $(`n-${name}`).textContent = total.toLocaleString();
    $(`side-${name}`).classList.toggle('zero', !total);
    $(`c-${name}`).innerHTML = parts.filter((p) => p.value).map((p) =>
      `<span class="chip" title="${p.full} ${p.value}"><i class="sw${p.dash ? ' dash' : ''}" style="background-color:${p.fill}${p.stroke ? `;border-color:${p.stroke}` : ''}"></i>${p.name} ${p.value}</span>`).join('');
    $(`side-${name}`).title = parts.map((p) => `${p.full}：${p.value}`).join('\n');
  }

  /** 底部动态：有 Agent 锁时显示“正在编辑”并呼吸点；否则显示最近一次 Agent / 外部改动。 */
  function renderLive() {
    const foot = $('live'), text = $('live-text');
    const lock = data?.locks[0];
    foot.classList.toggle('live', !!lock);
    if (lock) text.textContent = `Agent 正在编辑 ${lock.app} / ${lock.name}${data.locks.length > 1 ? `，另有 ${data.locks.length - 1} 个文件` : ''}`;
    else if (data?.activity) text.textContent = `${SOURCE[data.activity.source] || data.activity.source} ${ago(data.activity.at)}修改了 ${data.activity.app} / ${data.activity.name}`;
    else text.textContent = '暂无 Agent 动态';
    foot.title = text.textContent;
  }

  /** 整卡重绘；主题跟随主窗口推送。 */
  function render() {
    document.documentElement.dataset.theme = data.dark ? 'dark' : 'light';
    $('app').textContent = data.app;
    $('chart').textContent = data.chart;
    side('user', data.counts);
    side('agent', data.counts);
    renderLive();
  }

  /** 校验推送里的 Agent 锁是否仍在：已释放或超时的移除。只在悬浮窗可见时轮询。 */
  async function checkLocks() {
    if (!data?.locks.length || document.hidden) return;
    const alive = await Promise.all(data.locks.map((l) => invoke('lock_status', { path: l.path }).then((x) => x?.owner === 'agent', () => true)));
    const locks = data.locks.filter((_, i) => alive[i]);
    if (locks.length !== data.locks.length) { data.locks = locks; renderLive(); }
  }

  listen('float-data', (ev) => { data = ev.payload; render(); });
  setInterval(checkLocks, 4000);
  setInterval(() => { if (data && !document.hidden) renderLive(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data) { renderLive(); checkLocks(); } });

  // 单击回到程序；按住移动超过 4px 改为拖动窗口（系统接管后不会再收到 pointerup）。
  const card = $('card');
  let down = null;
  card.addEventListener('pointerdown', (e) => { if (e.button === 0) down = { x: e.screenX, y: e.screenY }; });
  card.addEventListener('pointermove', (e) => {
    if (!down || Math.hypot(e.screenX - down.x, e.screenY - down.y) < 4) return;
    down = null;
    win.startDragging();
  });
  card.addEventListener('pointerup', (e) => {
    if (!down || e.button !== 0) return;
    down = null;
    invoke('float_activate');
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); invoke('float_activate'); }
  });
  card.addEventListener('contextmenu', (e) => e.preventDefault());

  emit('float-ready');
})();
