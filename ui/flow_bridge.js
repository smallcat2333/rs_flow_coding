// Flow Coding 与 draw.io 的桥接：在 draw.io 页面内运行，由 fetch_drawio.py 注入 PreConfig.js 之后加载。
// 包装 App.main 拿到编辑器实例，通过 postMessage 与外层 App 交换「选中节点」「高亮/挂标签」消息。
//
// 发给外层：{event:'fc-select', cells:[{id, label, tags:[...]}], auto}（选中变化，仅更新选中状态）
//           {event:'fc-open-feat', cell:{id, label, tags:[...]}}（点击书签，打开关联 Feat）
//           {event:'fc-open-flow', source, link, cell}（点击图链接，打开目标图/节点）
//           {event:'fc-select-miss', id}（fc-select-cell 要定位的节点不在当前图）
//           {event:'fc-copied', count | error}（右键「复制引用」已写剪贴板或失败，外层提示）
//           {event:'fc-tagged'}（右键挂/摘 Feat 后，外层刷新统计）
// 接收外层：
//   {action:'fc-highlight', tag}           高亮带该标签的全部节点（tag 为空则清除）
//   {action:'fc-select-cell', id}          选中并滚动到节点
//   {action:'fc-tag', tag, add:true|false} 给当前选中节点加/去标签（经 draw.io 撤销栈，触发 autosave）
//   {action:'fc-theme', dark}              切换 draw.io 深色 / 浅色
//   {action:'fc-viewport-save'}            暂存当前缩放与位置（同图更新前）
//   {action:'fc-viewport-apply', keep}     更新完成后恢复暂存视图，或自动适应
//   {action:'fc-ids', show}                显示 / 隐藏节点左上角的 ID 小卡
//   {action:'fc-feats', feats:[{id,title}]} 当前图所属 APP 的未收纳 Feat，供右键「挂到 Feat」列出
// 右键节点时菜单顶部追加 Flow Coding 操作：复制引用、打开关联 Feat、挂到 Feat ▸。
// 另：挂了 Feat 标签的节点右上角显示书签角标（数字 = 挂了几个 Feat），仅点击角标打开关联档案。
// 角标是 mxCellOverlay，只存在于视图，不写入文件。
// 节点左上角的 ID 小卡同为 mxCellOverlay，显示在节点内部，不写入文件，可由外层开关。
// 新建节点/连线的 id 改为短号 n1、n2…（替换 draw.io 的随机 guid 前缀），便于口头或在会话中报给 Agent；已有 id 不改。
(function () {
  'use strict';
  var origMain = null;
  var ui = null;
  var highlighted = [];   // 当前高亮的 mxCellHighlight 实例
  var autoSelect = false; // 正在执行程序定位（fc-select-cell），选中通知带 auto 标记
  var marks = {};         // 节点 id -> {cell, overlay, key}：当前显示的书签角标
  var linkMarks = {};     // 图间链接角标，和 Feat 书签分别维护
  var idMarks = {};       // 节点 id -> {cell, overlay, key}：左上角 ID 小卡
  var showIds = true;     // 是否显示 ID 小卡，外层按本机偏好通过 fc-ids 下发
  var ID_SHOW_MAX = 12;   // 小卡最多显示的字符数，超出省略，完整 id 看悬停提示
  var FEAT_TAG = /^Feat_\d+_\d+$/;
  var fullPath = '';      // 当前图完整路径，由外层 fc-path 下发；用于路径提示和「复制引用」的图名
  var appFeats = [];      // 当前图所属 APP 的未收纳 Feat [{id, title}]，由外层 fc-feats 下发

  /** 书签角标图片：蓝色书签形状 + 白色数字（超过 9 显示 9+）。 */
  function markImage(n) {
    var t = n > 9 ? '9+' : String(n);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="20" viewBox="0 0 16 20">' +
      '<path d="M0 0h16v20l-8-5-8 5z" fill="#0969da" stroke="#fff" stroke-width="1"/>' +
      '<text x="8" y="11" font-size="' + (t.length > 1 ? 8 : 10) + '" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">' + t + '</text></svg>';
    return new mxImage('data:image/svg+xml;base64,' + btoa(svg), 16, 20);
  }

  /** 仅识别本地图文件链接；网页和 draw.io 内部链接继续由原编辑器处理。 */
  function isFlowLink(link) {
    if (!link || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) return false;
    try { return /\.drawio(?:#.*)?$/i.test(decodeURIComponent(link)); }
    catch (e) { return /\.drawio(?:#.*)?$/i.test(link); }
  }

  /** 图间链接角标：独立于 Feat 书签的箭头，不表达业务状态。 */
  function linkImage() {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">' +
      '<rect x=".5" y=".5" width="17" height="17" rx="4" fill="white" stroke="#57606a"/>' +
      '<path d="M5 12L12 5M6 5h6v6" fill="none" stroke="#24292f" stroke-width="1.6"/></svg>';
    return new mxImage('data:image/svg+xml;base64,' + btoa(svg), 18, 18);
  }

  /** 更新链接角标；删除或改链后移除旧角标，与书签并排显示且不写入 XML。 */
  function refreshLinkMarks(graph, cells) {
    var seen = {};
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (!graph.model.isVertex(cell)) continue;
      var link = graph.getLinkForCell(cell);
      if (!isFlowLink(link)) continue;
      var hasFeat = tagsOf(graph, cell).some(function (tag) { return FEAT_TAG.test(tag); });
      var key = link + '|' + hasFeat;
      seen[cell.id] = true;
      var old = linkMarks[cell.id];
      if (old && old.cell === cell && old.key === key) continue;
      if (old) graph.removeCellOverlay(old.cell, old.overlay);
      var ov = new mxCellOverlay(linkImage(), '打开流程图：' + link,
        mxConstants.ALIGN_RIGHT, mxConstants.ALIGN_TOP, new mxPoint(hasFeat ? -35 : -14, 10), 'pointer');
      ov.addListener(mxEvent.CLICK, (function (target, href) {
        return function () { graph.customLinkClicked(href, target); };
      })(cell, link));
      graph.addCellOverlay(cell, ov);
      linkMarks[cell.id] = { cell: cell, overlay: ov, key: key };
    }
    for (var id in linkMarks) {
      if (!seen[id]) {
        graph.removeCellOverlay(linkMarks[id].cell, linkMarks[id].overlay);
        delete linkMarks[id];
      }
    }
  }

  /**
   * ID 小卡图片：浅灰圆角底 + 等宽字体 id，宽度按字符估算（非 ASCII 按两倍宽）。
   * 浅色、深色画布上都可读；含中文时用 encodeURIComponent 生成 data URI（btoa 不支持非 Latin1）。
   */
  function idImage(text) {
    var units = 0;
    for (var i = 0; i < text.length; i++) units += text.charCodeAt(i) > 127 ? 2 : 1;
    var w = Math.ceil(units * 6.2 + 8);
    var esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="14" viewBox="0 0 ' + w + ' 14">' +
      '<rect x=".5" y=".5" width="' + (w - 1) + '" height="13" rx="3" fill="#f6f8fa" stroke="#8c959f"/>' +
      '<text x="' + (w / 2) + '" y="10.5" font-size="10" font-family="Consolas,Menlo,monospace" fill="#24292f" text-anchor="middle">' + esc + '</text></svg>';
    return new mxImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), w, 14);
  }

  /** 刷新左上角 ID 小卡：id 变化（如编辑数据改了 id）才重建；关闭显示时全部移除。 */
  function refreshIdMarks(graph, cells) {
    var seen = {};
    for (var i = 0; showIds && i < cells.length; i++) {
      var c = cells[i];
      if (!graph.model.isVertex(c) || c.id == null) continue;
      var id = String(c.id);
      seen[id] = true;
      var old = idMarks[id];
      if (old && old.cell === c) continue;
      if (old) graph.removeCellOverlay(old.cell, old.overlay);
      var shown = id.length > ID_SHOW_MAX ? id.slice(0, ID_SHOW_MAX - 1) + '…' : id;
      var img = idImage(shown);
      // 小卡中心从节点左上角向内偏移，左侧留 6px，上沿与右侧 Feat 书签一致。
      var ov = new mxCellOverlay(img, '节点 ID：' + id, mxConstants.ALIGN_LEFT, mxConstants.ALIGN_TOP,
        new mxPoint(img.width / 2 + 6, img.height / 2), 'default');
      ov.addListener(mxEvent.CLICK, (function (cell) {
        return function () { graph.setSelectionCell(cell); };
      })(c));
      graph.addCellOverlay(c, ov);
      idMarks[id] = { cell: c, overlay: ov };
    }
    for (var k in idMarks) {
      if (!seen[k]) {
        graph.removeCellOverlay(idMarks[k].cell, idMarks[k].overlay);
        delete idMarks[k];
      }
    }
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
        return function () {
          graph.setSelectionCell(cell);
          send({ event: 'fc-open-feat', cell: { id: cell.id, label: plain(graph, cell), tags: tagsOf(graph, cell) } });
        };
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
    refreshLinkMarks(graph, cells);
    refreshIdMarks(graph, cells);
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

  /** 用协作状态替换原生配色快捷按钮，颜色与虚线在同一次撤销事务中应用。 */
  function installStatusStyles() {
    var states = [
      { name: '已实现', fill: '#FFFFFF', dashed: false },
      { name: '起草待审', fill: '#FFF2CC', dashed: false },
      { name: '你的想法', fill: '#DAE8FC', dashed: false },
      { name: '已确认', fill: '#D5E8D4', dashed: false },
      { name: '有问题', fill: '#F8CECC', dashed: false },
      { name: '计划删除', fill: '#F5F5F5', dashed: true },
      { name: '确认删除', fill: '#D5E8D4', dashed: true },
    ];
    var css = document.createElement('style');
    css.textContent = '.fc-status-styles{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:12px 16px}' +
      '.fc-status-style{display:flex;align-items:center;gap:6px;min-width:0;padding:7px 6px;border:1px solid transparent;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;text-align:left}' +
      '.fc-status-style:hover{background:light-dark(#eef2f6,#333a44)}' +
      '.fc-status-style:focus-visible{outline:2px solid #0969da;outline-offset:1px}' +
      '.fc-status-style:disabled{opacity:.45;cursor:default}' +
      '.fc-status-swatch{box-sizing:border-box;width:16px;height:16px;flex:none;border:1px solid #808080;border-radius:3px}';
    document.head.appendChild(css);
    var originalAddStyles = StyleFormatPanel.prototype.addStyles;
    StyleFormatPanel.prototype.addStyles = function (container) {
      var graph = this.editorUi.editor.graph;
      if (!graph.getSelectionCells().some(function (cell) { return graph.model.isVertex(cell); })) {
        return originalAddStyles.apply(this, arguments);
      }
      var panel = document.createElement('div');
      panel.className = 'fc-status-styles';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', '节点状态');
      states.forEach(function (state) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'fc-status-style';
        button.title = '设为' + state.name;
        var cells = graph.getSelectionCells().filter(function (cell) {
          return graph.model.isVertex(cell) && graph.isCellEditable(cell);
        });
        button.disabled = !graph.isEnabled() || !cells.length;
        var swatch = document.createElement('span');
        swatch.className = 'fc-status-swatch';
        swatch.style.backgroundColor = state.fill;
        swatch.style.borderStyle = state.dashed ? 'dashed' : 'solid';
        swatch.setAttribute('aria-hidden', 'true');
        button.appendChild(swatch);
        button.appendChild(document.createTextNode(state.name));
        button.addEventListener('click', function () {
          if (!graph.isEnabled()) return;
          var selected = graph.getSelectionCells().filter(function (cell) {
            return graph.model.isVertex(cell) && graph.isCellEditable(cell);
          });
          if (!selected.length) return;
          graph.model.beginUpdate();
          try {
            graph.setCellStyles(mxConstants.STYLE_FILLCOLOR, state.fill, selected);
            graph.setCellStyles(mxConstants.STYLE_DASHED, state.dashed ? '1' : '0', selected);
            graph.setCellStyles(mxConstants.STYLE_DASH_PATTERN, null, selected);
            graph.setCellStyles(mxConstants.STYLE_GRADIENTCOLOR, null, selected);
          } finally { graph.model.endUpdate(); }
        });
        panel.appendChild(button);
      });
      container.appendChild(panel);
      return container;
    };
  }

  /**
   * 右键节点时在原生菜单顶部追加 Flow Coding 操作，右键空白或连线保持原菜单。
   * 作用对象为当前选中的节点（draw.io 右键未选中的节点会先选中它）；「打开关联 Feat」只看右键的那个节点。
   * 「挂到 Feat ▸」列出 appFeats，全部选中节点都已挂的打勾，点击时全部已挂则摘除、否则补挂。
   * 标签改动走 draw.io 撤销栈并触发 autosave，随后通知外层刷新统计。
   */
  function installNodeMenu() {
    var graph = ui.editor.graph;
    var origPopup = ui.menus.createPopupMenu;
    ui.menus.createPopupMenu = function (menu, cell, evt) {
      menu.smartSeparators = true;
      var sel = graph.getSelectionCells().filter(function (c) { return graph.model.isVertex(c); });
      if (cell && graph.model.isVertex(cell) && sel.length) {
        // 点菜单时焦点在本 iframe，外层文档写剪贴板会因未聚焦被拒，所以在这里写，结果交外层提示。
        menu.addItem('复制引用', null, function () {
          var name = fullPath.split(/[\\/]/).pop();
          var text = sel.map(function (c) { return name + '#' + c.id; }).join('\n');
          navigator.clipboard.writeText(text).then(function () {
            send({ event: 'fc-copied', count: sel.length });
          }, function (e) {
            send({ event: 'fc-copied', error: String(e) });
          });
        });
        var feats = tagsOf(graph, cell).filter(function (t) { return FEAT_TAG.test(t); });
        if (feats.length) {
          menu.addItem('打开关联 Feat' + (feats.length > 1 ? '（' + feats.length + '）' : ''), null, function () {
            send({ event: 'fc-open-feat', cell: { id: cell.id, label: plain(graph, cell), tags: tagsOf(graph, cell) } });
          });
        }
        var editable = graph.isEnabled() && sel.every(function (c) { return graph.isCellEditable(c); });
        if (!appFeats.length) {
          menu.addItem('挂到 Feat（本 APP 无进行中的 Feat）', null, null, null, null, false);
        } else {
          var sub = menu.addItem('挂到 Feat', null, null, null, null, editable);
          appFeats.forEach(function (f) {
            var all = sel.every(function (c) { return tagsOf(graph, c).indexOf(f.id) >= 0; });
            var item = menu.addItem(f.id + '  ' + f.title, null, function () {
              if (all) graph.removeTagsForCells(sel, [f.id]);
              else graph.addTagsForCells(sel, [f.id]);
              graph.getSelectionModel().fireEvent(new mxEventObject(mxEvent.CHANGE));
              send({ event: 'fc-tagged' });
            }, sub, null, editable);
            if (all) menu.addCheckmark(item, Editor.checkmarkImage);
          });
        }
        menu.addSeparator();
      }
      return origPopup.apply(this, arguments);
    };
  }

  /** 绑定选中事件与外层消息，ui 为 draw.io EditorUi 实例。 */
  function attach(app) {
    ui = app;
    installStatusStyles();
    installNodeMenu();
    var graph = ui.editor.graph;
    var savedViewport = null; // 同一张图外部同步前的缩放与滚动位置，仅用于本次更新。
    var presentation = null; // 演示前的编辑状态与视图，退出后恢复。
    var presentationCss = document.createElement('style');
    presentationCss.textContent = 'body.fc-presentation .geMenubarContainer,body.fc-presentation .geToolbarContainer,' +
      'body.fc-presentation .geSidebarContainer,body.fc-presentation .geFooterContainer,' +
      'body.fc-presentation .geTabContainer,body.fc-presentation .geHsplit,' +
      'body.fc-presentation .geHsplitter,body.fc-presentation .geVsplit,body.fc-presentation .geStatusContainer,' +
      'body.fc-presentation .geSidebarFooter,body.fc-presentation .geButtonContainer{display:none!important}' +
      'body.fc-presentation .geDiagramContainer{position:fixed!important;inset:0!important;margin:0!important;width:auto!important;height:auto!important;background-image:none!important}';
    document.head.appendChild(presentationCss);

    /** 演示只保留画布；临时禁用编辑与节点角标，适应全图，退出恢复选中、缩放和滚动。 */
    function setPresentation(show) {
      if (show === !!presentation) return;
      if (show) {
        presentation = { view: graph.getViewState(), enabled: graph.isEnabled(), selection: graph.getSelectionCells() };
        graph.stopEditing(false);
        graph.clearSelection();
        graph.setEnabled(false);
      }
      document.body.classList.toggle('fc-presentation', show);
      graph.view.getOverlayPane().style.visibility = show ? 'hidden' : '';
      ui.refresh(true);
      graph.sizeDidChange();
      if (show) {
        ui.actions.get('fitWindow').funct();
      } else {
        graph.setEnabled(presentation.enabled);
        graph.setSelectionCells(presentation.selection.filter(function (c) { return graph.model.contains(c); }));
        var v = presentation.view;
        graph.view.scaleAndTranslate(v.scale, v.translate.x, v.translate.y);
        graph.container.scrollLeft = v.translate.x * v.scale + v.scrollLeft;
        graph.container.scrollTop = v.translate.y * v.scale + v.scrollTop;
        presentation = null;
      }
    }
    var origCustom = graph.isCustomLink;
    var origClick = graph.customLinkClicked;
    graph.isCustomLink = function (href) { return isFlowLink(href) || origCustom.apply(this, arguments); };
    graph.customLinkClicked = function (href, cell) {
      if (!isFlowLink(href)) return origClick.apply(this, arguments);
      send({ event: 'fc-open-flow', source: fullPath, link: href, cell: cell ? cell.id : '' });
      return true;
    };
    /** 路径最多使用菜单右侧的剩余宽度；长文件名省略，完整路径保留在 title。 */
    function fitPath() {
      var status = document.querySelector('.geStatusDiv');
      if (!status) return;
      var right = 0;
      document.querySelectorAll('.geMenubar > .geItem').forEach(function (item) {
        right = Math.max(right, item.getBoundingClientRect().right);
      });
      status.style.maxWidth = Math.max(0, document.documentElement.clientWidth - right - 24) + 'px';
      status.style.overflow = 'hidden';
      status.style.textOverflow = 'ellipsis';
      status.style.whiteSpace = 'nowrap';
      if (fullPath) status.title = fullPath;
    }
    window.addEventListener('resize', fitPath);
    var menubar = document.querySelector('.geMenubarContainer');
    if (menubar) {
      new ResizeObserver(fitPath).observe(menubar);
      new MutationObserver(fitPath).observe(menubar, { childList: true, subtree: true });
    }
    // 调试入口：浏览器预览 / 开发者工具中可直接检查编辑器与角标
    window.fcBridge = { ui: ui, refreshMarks: function () { refreshMarks(graph); }, marks: marks, linkMarks: linkMarks, idMarks: idMarks };
    useShortIds(graph.model);
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
      if (m.action === 'fc-path') {
        fullPath = m.path;
        fitPath();
      } else if (m.action === 'fc-highlight') {
        lastTag = m.tag || '';
        highlight(graph, lastTag);
      } else if (m.action === 'fc-select-cell') {
        var cell = graph.model.getCell(m.id);
        if (cell) {
          autoSelect = true;
          try { graph.setSelectionCell(cell); } finally { autoSelect = false; }
          graph.scrollCellToVisible(cell, true);
        } else if (m.id) {
          send({ event: 'fc-select-miss', id: m.id });
        }
      } else if (m.action === 'fc-viewport-save') {
        savedViewport = graph.getViewState();
      } else if (m.action === 'fc-viewport-apply') {
        if (m.keep && savedViewport) {
          graph.view.scaleAndTranslate(savedViewport.scale, savedViewport.translate.x, savedViewport.translate.y);
          graph.container.scrollLeft = graph.view.translate.x * savedViewport.scale + savedViewport.scrollLeft;
          graph.container.scrollTop = graph.view.translate.y * savedViewport.scale + savedViewport.scrollTop;
        } else if (!m.keep) {
          ui.actions.get('fitWindow').funct();
        }
        savedViewport = null;
      } else if (m.action === 'fc-presentation') {
        setPresentation(!!m.show);
      } else if (m.action === 'fc-feats') {
        appFeats = m.feats || [];
      } else if (m.action === 'fc-ids') {
        showIds = !!m.show;
        refreshMarks(graph);
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
    // iframe 内的按键不会冒泡到外层；Esc 转发给窗口，draw.io 对话框打开时优先由其处理。
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !ev.isComposing && !(ui.dialogs && ui.dialogs.length)) {
        send({ event: 'fc-escape' });
      }
    }, true);
    send({ event: 'fc-ready' });
  }

  /**
   * 新 cell 的 id 取「n + 图内已用 n 号最大值 + 1」；同一张图内发过的号不回收，删掉最大号后也不重复使用。
   * 切换图文件时 draw.io 会换掉 model 根节点，此时计数清零，按新图重新取最大号。
   * mxGraphModel.cellAdded 在 id 冲突时会重新调用 createId，粘贴/复制同样得到短号；
   * 只覆盖当前编辑器的 model 实例，不影响 draw.io 内部的临时 model（剪贴板、页面克隆）。
   */
  function useShortIds(model) {
    var last = 0;
    var lastRoot = null;
    model.createId = function () {
      if (this.root !== lastRoot) { last = 0; lastRoot = this.root; }
      var max = last;
      for (var key in this.cells) {
        var m = /^n(\d+)$/.exec(key);
        if (m) max = Math.max(max, +m[1]);
      }
      last = max + 1;
      return 'n' + last;
    };
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
