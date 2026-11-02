// Flow Coding 与 draw.io 的桥接：在 draw.io 页面内运行，由 fetch_drawio.py 注入 PreConfig.js 之后加载。
// 包装 App.main 拿到编辑器实例，通过 postMessage 与外层 App 交换「选中节点」「高亮/挂标签」消息。
//
// 发给外层：{event:'fc-select', cells:[{id, label, tags:[...]}]}（选中变化，仅顶点）
// 接收外层：
//   {action:'fc-highlight', tag}           高亮带该标签的全部节点（tag 为空则清除）
//   {action:'fc-select-cell', id}          选中并滚动到节点
//   {action:'fc-tag', tag, add:true|false} 给当前选中节点加/去标签（经 draw.io 撤销栈，触发 autosave）
(function () {
  'use strict';
  var origMain = null;
  var ui = null;
  var highlighted = [];   // 当前高亮的 mxCellHighlight 实例

  /** 发消息给外层 App。 */
  function send(msg) {
    window.parent.postMessage(JSON.stringify(msg), '*');
  }

  /** 节点 → 纯文本标签（去 HTML）。 */
  function plain(graph, cell) {
    var v = graph.convertValueToString(cell) || '';
    var d = document.createElement('div');
    d.innerHTML = v;
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** 节点的标签数组。 */
  function tagsOf(graph, cell) {
    return (graph.getTagsForCell(cell) || '').split(' ').filter(Boolean);
  }

  /** 清除高亮。 */
  function clearHighlight() {
    for (var i = 0; i < highlighted.length; i++) highlighted[i].destroy();
    highlighted = [];
  }

  /** 高亮带 tag 的全部节点（常驻，直到下一次高亮或清除）。 */
  function highlight(graph, tag) {
    clearHighlight();
    if (!tag) return;
    var cells = graph.getCellsForTags([tag], graph.model.getDescendants(graph.model.getRoot()));
    for (var i = 0; i < cells.length; i++) {
      var state = graph.view.getState(cells[i]);
      if (!state) continue;
      var h = new mxCellHighlight(graph, '#0969da', 4);
      h.highlight(state);
      highlighted.push(h);
    }
  }

  /** 绑定选中事件与外层消息，ui 为 draw.io EditorUi 实例。 */
  function attach(app) {
    ui = app;
    var graph = ui.editor.graph;
    graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
      var cells = graph.getSelectionCells().filter(function (c) { return graph.model.isVertex(c); });
      send({
        event: 'fc-select',
        cells: cells.map(function (c) { return { id: c.id, label: plain(graph, c), tags: tagsOf(graph, c) }; }),
      });
    });
    // 视图重绘（缩放/平移/内容变化）后高亮框需要跟随，简单做法：重画当前标签
    var lastTag = '';
    graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, function () { if (lastTag) highlight(graph, lastTag); });
    graph.model.addListener(mxEvent.CHANGE, function () { if (lastTag) setTimeout(function () { highlight(graph, lastTag); }, 0); });

    window.addEventListener('message', function (ev) {
      if (ev.source !== window.parent || typeof ev.data !== 'string') return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.action === 'fc-highlight') {
        lastTag = m.tag || '';
        highlight(graph, lastTag);
      } else if (m.action === 'fc-select-cell') {
        var cell = graph.model.getCell(m.id);
        if (cell) {
          graph.setSelectionCell(cell);
          graph.scrollCellToVisible(cell, true);
        }
      } else if (m.action === 'fc-tag') {
        var sel = graph.getSelectionCells().filter(function (c) { return graph.model.isVertex(c); });
        if (sel.length && m.tag) {
          if (m.add) graph.addTagsForCells(sel, [m.tag]);
          else graph.removeTagsForCells(sel, [m.tag]);
          // 触发一次选中通知，让外层刷新标签显示
          graph.getSelectionModel().fireEvent(new mxEventObject(mxEvent.CHANGE));
        }
      }
    });
    send({ event: 'fc-ready' });
  }

  /** 等 App.main 定义后包装它：在原回调之后附加桥接。 */
  function hook() {
    if (typeof App === 'undefined' || typeof App.main !== 'function') return setTimeout(hook, 20);
    if (origMain) return;
    origMain = App.main;
    App.main = function (callback, createUi) {
      return origMain.call(this, function (app) {
        try { attach(app); } catch (e) { console.error('flow bridge', e); }
        if (callback) callback(app);
      }, createUi);
    };
  }
  hook();
})();
