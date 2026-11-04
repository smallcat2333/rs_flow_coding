// 挂载注释协议：shape=note;fcNote=1，parent 为所属节点/连线，geometry.relative=1。
// 正文保留在原生 note 中；仅在本客户端隐藏正文，以目标角标打开。原生 draw.io 仍能读到便签。
(function () {
  'use strict';

  window.installFlowNotes = function (ui) {
    var graph = ui.editor.graph;
    var model = graph.model;
    var marks = {};
    var pending = null;
    var notice = null;
    var panelTarget = null;
    var panelRoot = null;
    var panelEnabled = null;

    /** 将悬浮卡限制在应用视口内；拖动和窗口缩小时保留可操作的标题栏。 */
    function placePanel(left, top) {
      var bounds = panelRoot.getBoundingClientRect();
      panelRoot.style.left = Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8)) + 'px';
      panelRoot.style.top = Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)) + 'px';
      panelRoot.style.right = 'auto';
    }
    window.addEventListener('resize', function () {
      if (!panelRoot) return;
      var bounds = panelRoot.getBoundingClientRect();
      placePanel(bounds.left, bounds.top);
    });

    function isNote(cell) {
      return !!cell && model.isVertex(cell) && /(?:^|;)(?:shape=note|note)(?:;|$)/.test(model.getStyle(cell) || '');
    }
    function isTarget(cell) {
      return !!cell && !isNote(cell) && (model.isVertex(cell) || model.isEdge(cell));
    }
    function attached(cell) {
      return isNote(cell) && /(?:^|;)fcNote=1(?:;|$)/.test(model.getStyle(cell) || '') && isTarget(model.getParent(cell));
    }
    function notesOf(target) {
      return (target.children || []).filter(attached);
    }
    function editable(cell) {
      return graph.isEnabled() && model.contains(cell) && graph.isCellEditable(cell) && !graph.isCellLocked(cell);
    }
    function text(cell) {
      var value = graph.convertValueToString(cell) || '';
      if (!graph.isHtmlLabel(cell)) return value.replace(/\s+/g, ' ').trim();
      var div = document.createElement('div');
      div.innerHTML = Graph.sanitizeHtml(value);
      return (div.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // 只覆盖可见性查询，不写 visible=0；布局算法同样会跳过这些附属便签及其说明连线。
    var originalVisible = model.isVisible;
    model.isVisible = function (cell) {
      if (attached(cell)) return false;
      if (model.isEdge(cell) && (attached(model.getTerminal(cell, true)) || attached(model.getTerminal(cell, false)))) return false;
      return originalVisible.apply(this, arguments);
    };
    var originalFoldable = graph.isCellFoldable;
    graph.isCellFoldable = function (cell) {
      if (notesOf(cell).length && (cell.children || []).every(attached)) return false;
      return originalFoldable.apply(this, arguments);
    };

    var css = document.createElement('style');
    css.textContent = '.fc-notes{position:fixed;top:64px;right:24px;z-index:1000;box-sizing:border-box;display:flex;flex-direction:column;width:380px;max-width:calc(100vw - 16px);max-height:calc(100vh - 80px);min-height:0;padding:14px;border:1px solid light-dark(#ffffffb3,#ffffff29);border-radius:8px;background:light-dark(#ffffff73,#29292973);-webkit-backdrop-filter:blur(16px) saturate(125%);backdrop-filter:blur(16px) saturate(125%);color:light-dark(#222,#ddd);box-shadow:0 8px 28px #0003,inset 0 1px 0 light-dark(#ffffffa6,#ffffff14);font:13px/1.6 Arial,"Microsoft YaHei",sans-serif}' +
      '.fc-notes-head{display:flex;align-items:center;gap:8px;cursor:move;touch-action:none;user-select:none;margin-bottom:4px}' +
      '.fc-notes h2{flex:1;min-width:0;font-size:15px;margin:0;overflow-wrap:anywhere}' +
      '.fc-notes-head .geBtn{margin:0;min-width:28px;padding:2px 7px;cursor:pointer}' +
      '.fc-notes-empty{padding:12px 0;opacity:.7}' +
      '.fc-notes-summary{opacity:.7;font-size:12px;margin-bottom:12px}' +
      '.fc-notes-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}' +
      '.fc-note-card{border-top:1px solid light-dark(#d0d7de,#505050);padding:12px 0}' +
      '.fc-note-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}' +
      '.fc-note-caption{font-size:11px;opacity:.65;min-width:0}' +
      '.fc-note-content{overflow-wrap:anywhere;max-height:300px;overflow:auto;white-space:normal}' +
      '.fc-note-content[contenteditable=true]{min-height:100px;outline:1px solid #b7791f;padding:8px;box-sizing:border-box}' +
      '.fc-note-content:focus-visible,.fc-notes button:focus-visible{outline:2px solid #b7791f;outline-offset:2px}' +
      '.fc-note-actions{display:flex;gap:4px;margin-left:auto;flex-shrink:0}' +
      '.fc-note-actions .geBtn{margin:0;padding:2px 4px;min-width:0;font-size:11px;line-height:16px;display:inline-flex;align-items:center;gap:3px}' +
      '.fc-note-action-icon{width:12px;height:12px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}' +
      '.fc-note-pick{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);z-index:10000;max-width:calc(100% - 32px);box-sizing:border-box;padding:10px 14px;border:1px solid #b7791f;border-radius:6px;background:light-dark(#fff8e8,#332b1c);color:light-dark(#55370a,#ffe0a0);font:13px/1.5 Arial,"Microsoft YaHei",sans-serif;pointer-events:none}';
    document.head.appendChild(css);

    var actionIcons = {
      '编辑': 'M12 3l3 3M3 12l9-9a2.1 2.1 0 0 1 3 3l-9 9-4 1z',
      '解绑': 'M7 11l4-4M6 9l-2 2a3 3 0 0 0 4 4l2-2M9 6l2-2a3 3 0 0 1 4 4l-2 2M2 2l14 14',
      '删除': 'M3 5h12M7 5V3h4v2M5 5l1 11h6l1-11M8 8v5M10 8v5'
    };
    function button(label, run, primary) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'geBtn' + (primary ? ' gePrimaryBtn' : '');
      if (actionIcons[label]) {
        var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('class', 'fc-note-action-icon');
        icon.setAttribute('viewBox', '0 0 18 18');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('focusable', 'false');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', actionIcons[label]);
        icon.appendChild(path);
        btn.appendChild(icon);
      }
      btn.appendChild(document.createTextNode(label));
      btn.onclick = run;
      return btn;
    }
    /** 切换或关闭卡片前保存正在编辑的正文；只读锁生效后不再写入图。 */
    function savePanelEdits() {
      if (!panelRoot) return;
      model.beginUpdate();
      try {
        panelRoot.querySelectorAll('[contenteditable="true"]').forEach(function (body) {
          var note = model.getCell(body.dataset.noteId);
          if (!editable(note)) return;
          graph.cellLabelChanged(note, graph.isHtmlLabel(note) ? Graph.sanitizeHtml(body.innerHTML) : body.innerText, false);
        });
      } finally { model.endUpdate(); }
    }
    /** 关闭应用内卡片并释放引用，不影响 draw.io 自己的对话框。 */
    function closePanel() {
      savePanelEdits();
      if (panelRoot) panelRoot.remove();
      panelRoot = null;
      panelTarget = null;
    }
    function validPair(note, target) {
      return editable(note) && editable(target) && isNote(note) && isTarget(target) &&
        !model.isAncestor(note, target) && !model.getChildCount(note);
    }
    function attach(note, target) {
      if (!validPair(note, target)) return false;
      model.beginUpdate();
      try {
        var geo = model.getGeometry(note);
        geo = geo ? geo.clone() : new mxGeometry(0, 0, 300, 120);
        geo.relative = true;
        geo.x = model.isEdge(target) ? 0 : 1;
        geo.y = model.isEdge(target) ? 24 : 0;
        geo.offset = new mxPoint(model.isEdge(target) ? 0 : 16, model.isEdge(target) ? 0 : 24);
        // model.add 避免原生容器自动扩展父节点；保留 note 的 id、正文、尺寸及其他属性。
        model.add(target, note);
        model.setGeometry(note, geo);
        model.setStyle(note, mxUtils.setStyle(model.getStyle(note), 'fcNote', '1'));
      } finally { model.endUpdate(); }
      graph.setSelectionCell(target);
      return true;
    }
    function detach(note) {
      var target = model.getParent(note);
      if (!attached(note) || !editable(note) || !editable(target)) return false;
      var state = graph.view.getState(target);
      var parent = graph.getDefaultParent();
      var parentState = graph.view.getState(parent);
      var origin = parentState ? parentState.origin : new mxPoint();
      var geo = model.getGeometry(note).clone();
      var point = state && model.isEdge(target) ? graph.view.getPoint(state, geo) : state;
      geo.relative = false;
      geo.offset = null;
      geo.x = point ? point.x / graph.view.scale - graph.view.translate.x - origin.x + 24 : 40;
      geo.y = point ? point.y / graph.view.scale - graph.view.translate.y - origin.y + 24 : 40;
      model.beginUpdate();
      try {
        model.add(parent, note);
        model.setGeometry(note, geo);
        model.setStyle(note, mxUtils.setStyle(model.getStyle(note), 'fcNote', null));
      } finally { model.endUpdate(); }
      graph.setSelectionCell(note);
      return true;
    }
    function addNote(target) {
      if (!isTarget(target) || !editable(target)) return;
      var note = new mxCell('', new mxGeometry(0, 0, 300, 120),
        'shape=note;whiteSpace=wrap;html=1;align=left;spacing=8;fillColor=#fff2cc;strokeColor=#b7791f;');
      note.vertex = true;
      model.beginUpdate();
      try {
        model.add(graph.getDefaultParent(), note);
        attach(note, target);
      } finally { model.endUpdate(); }
      open(target, note);
    }

    /** 在同一张悬浮卡中显示宿主注释；切换不抢画布焦点，添加时才聚焦编辑器。 */
    function open(target, editing, discardEdits) {
      if (!model.contains(target) || !isTarget(target)) return;
      if (!discardEdits) savePanelEdits();
      var root = panelRoot;
      panelEnabled = graph.isEnabled();
      if (!root) {
        root = document.createElement('div');
        root.className = 'fc-notes';
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', '挂载注释');
        // 卡片内的文字操作不触发画布删除、撤销等快捷键。
        root.addEventListener('keydown', function (ev) {
          ev.stopPropagation();
          if (ev.key === 'Escape') { ev.preventDefault(); closePanel(); }
        });
        document.body.appendChild(root);
        panelRoot = root;
      }
      root.replaceChildren();
      panelTarget = target;
      var header = document.createElement('div');
      header.className = 'fc-notes-head';
      var title = document.createElement('h2');
      title.textContent = (model.isEdge(target) ? '连线注释' : '节点注释') + ' · ' + target.id;
      header.appendChild(title);
      if (editable(target)) {
        var add = button('+', function () { addNote(target); });
        add.setAttribute('aria-label', '添加注释');
        add.title = '添加注释';
        header.appendChild(add);
      }
      var close = button('×', closePanel);
      close.setAttribute('aria-label', '关闭注释');
      close.title = '关闭注释（Esc）';
      header.appendChild(close);
      // 只拖标题空白/文字，按钮仍保持正常点击；捕获指针防止拖出卡片后中断。
      header.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0 || ev.target.closest('button')) return;
        var bounds = root.getBoundingClientRect();
        var dx = ev.clientX - bounds.left, dy = ev.clientY - bounds.top;
        header.setPointerCapture(ev.pointerId);
        function move(e) { placePanel(e.clientX - dx, e.clientY - dy); }
        function end() {
          header.removeEventListener('pointermove', move);
          header.removeEventListener('lostpointercapture', end);
        }
        header.addEventListener('pointermove', move);
        header.addEventListener('lostpointercapture', end);
        ev.preventDefault();
      });
      root.appendChild(header);
      var summary = document.createElement('div');
      summary.className = 'fc-notes-summary';
      summary.textContent = text(target).slice(0, 100) || '此连线的说明';
      root.appendChild(summary);
      var list = document.createElement('div');
      list.className = 'fc-notes-list';
      root.appendChild(list);
      var focusEditor = null;
      if (!notesOf(target).length) {
        var empty = document.createElement('div');
        empty.className = 'fc-notes-empty';
        empty.textContent = '此' + (model.isEdge(target) ? '连线' : '节点') + '暂无注释';
        list.appendChild(empty);
      }
      notesOf(target).forEach(function (note) {
        var card = document.createElement('section');
        card.className = 'fc-note-card';
        var noteHead = document.createElement('div');
        noteHead.className = 'fc-note-head';
        card.appendChild(noteHead);
        var caption = document.createElement('div');
        caption.className = 'fc-note-caption';
        caption.textContent = '注释 ' + note.id;
        noteHead.appendChild(caption);
        var body = document.createElement('div');
        body.className = 'fc-note-content';
        body.dataset.noteId = note.id;
        if (graph.isHtmlLabel(note)) body.innerHTML = Graph.sanitizeHtml(graph.convertValueToString(note) || '');
        else { body.textContent = graph.convertValueToString(note) || ''; body.style.whiteSpace = 'pre-wrap'; }
        card.appendChild(body);
        var actions = document.createElement('div');
        actions.className = 'fc-note-actions';
        noteHead.appendChild(actions);
        function edit() {
          if (!editable(note)) return;
          body.contentEditable = 'true';
          body.setAttribute('role', 'textbox');
          body.setAttribute('aria-label', '编辑注释 ' + note.id);
          body.setAttribute('aria-multiline', 'true');
          actions.replaceChildren();
          actions.appendChild(button('保存', function () {
            if (!editable(note)) return;
            graph.cellLabelChanged(note, graph.isHtmlLabel(note) ? Graph.sanitizeHtml(body.innerHTML) : body.innerText, false);
            open(target);
          }, true));
          actions.appendChild(button('取消', function () { open(target, null, true); }));
          body.focus();
        }
        // 富文本沿用 draw.io 清洗器；粘贴只接收文本，保留换行。
        body.addEventListener('paste', function (ev) {
          if (body.contentEditable !== 'true') return;
          ev.preventDefault();
          document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'));
        });
        body.addEventListener('keydown', function (ev) {
          if (body.contentEditable === 'true' && (ev.ctrlKey || ev.metaKey) && /^[zy]$/i.test(ev.key)) ev.stopPropagation();
        });
        if (editable(note) && editable(target)) {
          actions.appendChild(button('编辑', edit));
          actions.appendChild(button('解绑', function () { closePanel(); detach(note); }));
          actions.appendChild(button('删除', function () {
            if (!editable(note) || !editable(target)) return;
            graph.removeCells([note]);
            open(target);
          }));
        }
        list.appendChild(card);
        if (note === editing) focusEditor = edit;
      });
      var bounds = root.getBoundingClientRect();
      placePanel(bounds.left, bounds.top);
      if (focusEditor) focusEditor();
    }

    // 空白点击不关闭卡片；选中另一个节点/连线时直接复用卡片，并保存当前草稿。
    graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
      if (!panelRoot) return;
      var target = graph.getSelectionCell();
      if (attached(target)) target = model.getParent(target);
      if (!isTarget(target) || target === panelTarget) return;
      open(target);
    });

    function cancelPick() {
      pending = null;
      if (notice) notice.remove();
      notice = null;
      graph.container.style.cursor = '';
    }
    function pick(note) {
      if (!editable(note) || !isNote(note) || model.getChildCount(note)) return;
      cancelPick();
      pending = note;
      notice = document.createElement('div');
      notice.className = 'fc-note-pick';
      notice.setAttribute('role', 'status');
      notice.textContent = '点击要挂载的节点或连线，Esc 取消';
      document.body.appendChild(notice);
      graph.container.style.cursor = 'crosshair';
    }
    // 在原生拖动/选择处理前消费点击，目标选择不会移动图形。
    graph.addListener(mxEvent.FIRE_MOUSE_EVENT, function (sender, evt) {
      if (!pending) return;
      var me = evt.getProperty('event');
      if (evt.getProperty('eventName') === mxEvent.MOUSE_DOWN && !mxEvent.isPopupTrigger(me.getEvent())) {
        var target = me.getCell();
        if (validPair(pending, target)) {
          var note = pending;
          cancelPick();
          attach(note, target);
        }
      }
      me.consume();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && pending) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        cancelPick();
      }
    }, true);

    var originalPopup = ui.menus.createPopupMenu;
    ui.menus.createPopupMenu = function (menu, cell) {
      menu.smartSeparators = true;
      if (isNote(cell) && editable(cell)) {
        menu.addItem('挂载到节点或连线…', null, function () { pick(cell); }, null, null, !model.getChildCount(cell));
      } else if (isTarget(cell)) {
        var notes = notesOf(cell);
        if (notes.length) menu.addItem('查看注释（' + notes.length + '）', null, function () { open(cell); });
        menu.addItem('添加注释', null, function () { addNote(cell); }, null, null, editable(cell));
      }
      if (isNote(cell) || isTarget(cell)) menu.addSeparator();
      return originalPopup.apply(this, arguments);
    };

    function image(count) {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="18" viewBox="0 0 28 18">' +
        '<rect x=".5" y=".5" width="27" height="17" rx="4" fill="#fff8e8" stroke="#b7791f"/>' +
        '<path d="M5 4h8v7H9l-3 3v-3H5z" fill="none" stroke="#80520e" stroke-width="1.2"/>' +
        '<text x="20" y="12" font-size="10" font-family="Arial" fill="#55370a" text-anchor="middle">' +
        (count > 9 ? '9+' : count) + '</text></svg>';
      return new mxImage('data:image/svg+xml;base64,' + btoa(svg), 28, 18);
    }
    function refresh() {
      var seen = {};
      model.getDescendants(model.getRoot()).forEach(function (target) {
        var notes = notesOf(target);
        if (!notes.length || !model.isVisible(target)) return;
        seen[target.id] = true;
        var firstGeo = model.getGeometry(notes[0]);
        var key = notes.map(function (n) { return n.id; }).join('|') + '|' +
          (firstGeo ? firstGeo.x + ',' + firstGeo.y : '');
        var old = marks[target.id];
        if (old && old.cell === target && old.key === key) return;
        if (old) graph.removeCellOverlay(old.cell, old.overlay);
        var overlay = new mxCellOverlay(image(notes.length), '查看 ' + notes.length + ' 条注释',
          mxConstants.ALIGN_RIGHT, mxConstants.ALIGN_BOTTOM, new mxPoint(-18, -12), 'pointer');
        if (model.isEdge(target)) {
          overlay.getBounds = function (state) {
            var point = state.view.getPoint(state, { relative: true, x: firstGeo ? firstGeo.x : 0, y: firstGeo ? firstGeo.y : 24 });
            var scale = state.view.scale;
            return new mxRectangle(point.x - 14 * scale, point.y - 9 * scale, 28 * scale, 18 * scale);
          };
        }
        overlay.addListener(mxEvent.CLICK, function () { open(target); });
        graph.addCellOverlay(target, overlay);
        marks[target.id] = { cell: target, overlay: overlay, key: key };
      });
      Object.keys(marks).forEach(function (id) {
        if (!seen[id]) { graph.removeCellOverlay(marks[id].cell, marks[id].overlay); delete marks[id]; }
      });
      if (pending && (!model.contains(pending) || !editable(pending))) cancelPick();
      if (panelTarget && !model.contains(panelTarget)) closePanel();
      else if (panelRoot && panelEnabled !== graph.isEnabled()) open(panelTarget);
    }
    // setGraphXml/切页会更换根；可见性覆盖必须在首次读取 cell state 前安装。
    graph.refresh();
    refresh();
    return { refresh: refresh, attach: attach, detach: detach, open: open, add: addNote, pick: pick,
      close: closePanel, isOpen: function () { return !!panelRoot; },
      cancelPick: cancelPick, isPicking: function () { return !!pending; }, isAttached: attached, notesOf: notesOf, marks: marks };
  };
})();
