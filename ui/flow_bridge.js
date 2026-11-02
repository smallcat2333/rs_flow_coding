// Flow Coding 与 draw.io 的桥接：在 draw.io 页面内运行，由 fetch_drawio.py 注入 PreConfig.js 之后加载。
// 包装 App.main 拿到编辑器实例，通过 postMessage 与外层 App 交换「选中节点」「高亮/挂标签」消息。
//
// 发给外层：{event:'fc-select', cells:[{id, label, tags:[...]}], auto}（选中变化，仅顶点；auto=true 表示由 fc-select-cell 程序定位）
// 接收外层：
//   {action:'fc-highlight', tag}           高亮带该标签的全部节点（tag 为空则清除）
//   {action:'fc-select-cell', id}          选中并滚动到节点
//   {action:'fc-tag', tag, add:true|false} 给当前选中节点加/去标签（经 draw.io 撤销栈，触发 autosave）
//   {action:'fc-theme', dark}              切换 draw.io 深色 / 浅色
// 另：挂了 Feat 标签的节点右上角显示书签角标（数字 = 挂了几个 Feat），点击角标等同点选该节点。
// 角标是 mxCellOverlay，只存在于视图，不写入文件。
(function () {
  'use strict';
  var origMain = null;
  var ui = null;
  var highlighted = [];   // 当前高亮的 mxCellHighlight 实例
  var autoSelect = false; // 正在执行程序定位（fc-select-cell），选中通知带 auto 标记
  var marks = {};         // 节点 id -> {cell, overlay, key}：当前显示的书签角标
  var FEAT_TAG = /^Feat_\d+_\d+$/;

  /** 书签角标图片：蓝色书签形状 + 白色数字（超过 9 显示 9+）。 */
  function markImage(n) {
    var t = n > 9 ? '9+' : String(n);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="20" viewBox="0 0 16 20">' +
      '<path d="M0 0h16v20l-8-5-8 5z" fill="#0969da" stroke="#fff" stroke-width="1"/>' +
      '<text x="8" y="11" font-size="' + (t.length > 1 ? 8 : 10) + '" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">' + t + '</text></svg>';
    return new mxImage('data:image/svg+xml;base64,' + btoa(svg), 16, 20);
  }

  /** 按节点上的 Feat 标签刷新书签角标：数量或标签变化才重建，标签清空则移除。 */
  function refreshMarks(graph) {
    var seen = {};
    var cells = graph.model.getDescendants(graph.model.getRoot());
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!graph.model.isVertex(c)) continue;
      var feats = tagsOf(graph, c).filter(function (t) { return FEAT_TAG.test(t); });
      if (!feats.length) continue;
      var key = feats.join(' ');
      seen[c.id] = true;
      var old = marks[c.id];
      if (old && old.cell === c && old.key === key) continue;
      if (old) graph.removeCellOverlay(old.cell, old.overlay);
      var ov = new mxCellOverlay(markImage(feats.length), '挂了 ' + feats.length + ' 个 Feat：\n' + feats.join('\n'),
        mxConstants.ALIGN_RIGHT, mxConstants.ALIGN_TOP, new mxPoint(-14, 10), 'pointer');
      ov.addListener(mxEvent.CLICK, (function (cell) {
        return function () { graph.setSelectionCell(cell); };
      })(c));
      graph.addCellOverlay(c, ov);
      marks[c.id] = { cell: c, overlay: ov, key: key };
    }
    for (var id in marks) {
      if (!seen[id]) {
        graph.removeCellOverlay(marks[id].cell, marks[id].overlay);
        delete marks[id];
      }
    }
  }

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
    // 调试入口：浏览器预览 / 开发者工具中可直接检查编辑器与角标
    window.fcBridge = { ui: ui, refreshMarks: function () { refreshMarks(graph); }, marks: marks };
    graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
      var cells = graph.getSelectionCells().filter(function (c) { return graph.model.isVertex(c); });
      send({
        event: 'fc-select',
        cells: cells.map(function (c) { return { id: c.id, label: plain(graph, c), tags: tagsOf(graph, c) }; }),
        auto: autoSelect,
      });
    });
    // 视图重绘（缩放/平移/内容变化）后高亮框需要跟随，简单做法：重画当前标签；内容变化同时刷新书签角标
    var lastTag = '';
    var markTimer = 0;
    graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, function () { if (lastTag) highlight(graph, lastTag); });
    graph.model.addListener(mxEvent.CHANGE, function () {
      if (lastTag) setTimeout(function () { highlight(graph, lastTag); }, 0);
      clearTimeout(markTimer);
      markTimer = setTimeout(function () { refreshMarks(graph); }, 50);
    });

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
          autoSelect = true;
          try { graph.setSelectionCell(cell); } finally { autoSelect = false; }
          graph.scrollCellToVisible(cell, true);
        }
      } else if (m.action === 'fc-theme') {
        if (typeof ui.setDarkMode === 'function' && Editor.isDarkMode() !== !!m.dark) ui.setDarkMode(!!m.dark);
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
