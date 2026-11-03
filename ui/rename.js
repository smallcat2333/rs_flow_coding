// 文件树双击重命名：跨窗口先保存并释放锁，后端更名成功后由原窗口恢复打开新路径。
'use strict';

window.Rename = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen, emit } = window.__TAURI__.event;
  const prepared = new Map();
  let busy = false;

  /** 每个窗口只关闭正被更名的文件；流程图引用可能涉及当前 Feat，先确保它已落盘。 */
  listen('rename-prepare', async ({ payload: p }) => {
    const state = { flow: st.cur === p.path, feat: FeatPane.curPath() === p.path };
    prepared.set(p.request, state);
    try {
      if (p.kind === 'flow' || state.feat) await FeatPane.settle();
      if (state.feat) await FeatPane.close();
      if (state.flow) {
        while (st.saving || st.pendingXml != null) await new Promise((resolve) => setTimeout(resolve, 20));
        await closeFlow();
      }
      await emit('rename-ready', { request: p.request, role: SOLO, error: '' });
    } catch (error) {
      await emit('rename-ready', { request: p.request, role: SOLO, error: String(error) });
    }
  });

  /** 成功打开新路径，失败恢复原路径；其他正在查看的档案通过 md-changed 同步引用。 */
  listen('rename-finished', async ({ payload: p }) => {
    const state = prepared.get(p.request);
    if (!state) return;
    prepared.delete(p.request);
    if (lastSel.file === p.oldPath) lastSel = { file: p.path, cells: [] };
    try {
      await refresh(false);
      if (state.flow) await routeDiagram(p.path);
      if (state.feat) await routeFeat(p.path);
      if (p.error && !SOLO) sideMsg('重命名失败：' + p.error);
    } catch (error) { sideMsg(String(error)); }
  });

  /** 等主窗口及已弹出的窗口完成准备；关窗竞态或无响应不允许无限挂起。 */
  async function prepare(path, kind, request) {
    const waiting = new Set(['', ...Object.keys(popped).filter((key) => popped[key])]);
    let resolve, reject;
    const done = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const off = await listen('rename-ready', ({ payload: p }) => {
      if (p.request !== request || !waiting.has(p.role)) return;
      if (p.error) reject(new Error(p.error));
      waiting.delete(p.role);
      if (!waiting.size) resolve();
    });
    const offClose = await listen('popout-closed', ({ payload: p }) => {
      waiting.delete(p.kind);
      if (!waiting.size) resolve();
    });
    const timer = setTimeout(() => reject(new Error('窗口未完成保存，请停止编辑后重试重命名')), 10000);
    try { await emit('rename-prepare', { path, kind, request }); await done; }
    finally { clearTimeout(timer); off(); offClose(); }
  }

  /** 仅改同目录文件名；后端负责编号、引用、元数据、历史及冲突校验。 */
  async function run(path, kind, name) {
    if (busy) return;
    busy = true;
    const request = crypto.randomUUID();
    try {
      await prepare(path, kind, request);
      const result = await invoke('rename_entry', { path, name });
      await emit('rename-finished', { request, oldPath: path, path: result.path });
      return result;
    } catch (error) {
      await emit('rename-finished', { request, oldPath: path, path, error: String(error) });
      throw error;
    } finally { busy = false; }
  }

  /** 双击流程图/Feat 行时编辑标题；状态菜单按钮与 APP 分组不触发文件更名。 */
  document.getElementById('tree').addEventListener('dblclick', async (event) => {
    if (event.target.closest('button')) return;
    const row = event.target.closest('.file, .feat');
    if (!row || busy) return;
    event.preventDefault();
    const kind = row.classList.contains('file') ? 'flow' : 'feat';
    const path = kind === 'flow' ? row.dataset.path : row.dataset.feat;
    const app = appOf(path);
    const file = (kind === 'flow' ? app.files : app.feats).find((f) => f.path === path);
    const current = kind === 'flow' ? file.name.replace(/\.drawio$/i, '') : file.title;
    const name = await ask(kind === 'flow' ? '重命名流程图（不含 .drawio）' : `重命名 ${file.id}（编号保持不变）`, current);
    if (!name || name === current) return;
    try { await run(path, kind, name); }
    catch (error) { sideMsg('重命名失败：' + error); }
  });

  return { run };
})();
