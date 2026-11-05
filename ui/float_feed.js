// 悬浮窗数据源（仅主窗口）：从 app.js 已有的汇总 st.apps 提炼当前 APP 的待处理计数、Agent 锁和最近外部改动，
// 推给悬浮窗。依赖 app.js 的 st / curFeat / appOf / isDark 与 Sidebar.appName，在 app.js 之后载入。
'use strict';

window.FloatFeed = (() => {
  if (SOLO) return { push() {} };
  const { emitTo } = window.__TAURI__.event;
  /** 最近一次 Agent / 外部改动（App 内自己编辑不算），只保留最新一条。 */
  let activity = null;
  let timer = 0;

  /** 文件名去掉扩展名。 */
  const stem = (path) => path.split(/[\\/]/).pop().replace(/\.(drawio|md)$/i, '');

  /** 当前范围：打开的图或 Feat 所属 APP；都没打开时汇总全部 APP。 */
  function snapshot() {
    const path = st.cur || curFeat.path;
    const app = path ? appOf(path) : null;
    const counts = {};
    for (const a of app ? [app] : st.apps) for (const [k, v] of Object.entries(a.counts)) counts[k] = (counts[k] || 0) + v;
    const locks = [];
    for (const a of st.apps) for (const f of [...a.files, ...a.feats]) {
      if (f.lock?.owner === 'agent') locks.push({ path: f.path, name: stem(f.path), app: Sidebar.appName(a), mine: a === app });
    }
    locks.sort((x, y) => y.mine - x.mine);
    return {
      app: app ? Sidebar.appName(app) : '全部 APP',
      chart: st.cur ? stem(st.cur) : curFeat.path ? stem(curFeat.path) : `${st.apps.length} 个 APP`,
      counts, locks, activity, dark: isDark(),
    };
  }

  /** 合并 100ms 内的多次变化后推送；悬浮窗不存在时 emitTo 无接收者，不报错。 */
  function push() {
    clearTimeout(timer);
    timer = setTimeout(() => emitTo('float', 'float-data', snapshot()).catch(() => {}), 100);
  }

  /** 记录 Agent / 外部改动；App 自己保存（user）与回滚不记。 */
  function record(ev) {
    const { path, source } = ev.payload;
    if (source !== 'agent' && source !== 'external') return;
    const app = appOf(path);
    activity = { path, name: stem(path), app: app ? Sidebar.appName(app) : '', source, at: Date.now() };
    push();
  }

  listen('flow-changed', record);
  listen('md-changed', record);
  listen('float-ready', push);
  listen('ui-cur-feat', push);
  window.addEventListener('fc-theme', push);
  new MutationObserver(push).observe($('cur-name'), { childList: true, characterData: true, subtree: true });
  return { push };
})();
