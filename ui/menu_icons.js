// 右键菜单共用 SVG：使用 currentColor 随菜单主题变化，不请求外部图片。
'use strict';
window.MenuIcons = (() => {
  const paths = {
    pin: '<path d="m15 3 6 6-4 1-3 5-5-5 5-3zM9 15l-6 6M7 12l5 5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M14 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.92)"/>',
    file: '<path d="M14 3H5v18h14V8zM14 3v6h5M8 13h8M8 17h6"/>',
    folder: '<path d="M3 6h7l2 3h9v11H3z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>',
    cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 12 12M8 16 20 4"/>',
    paste: '<path d="M9 5H5v16h14V5h-4"/><rect x="9" y="3" width="6" height="4" rx="1"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    style: '<path d="m14 4 6 6-9 9-7 1 1-7zM12 6l6 6M4 23h16"/>',
    up: '<path d="m6 12 6-6 6 6M12 6v15"/>',
    down: '<path d="m6 12 6 6 6-6M12 18V3"/>',
    front: '<path d="M4 3h16m-14 10 6-6 6 6M12 7v14"/>',
    back: '<path d="M4 21h16M6 11l6 6 6-6M12 17V3"/>',
    data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    point: '<path d="M3 12h18M12 3v18"/><circle cx="12" cy="12" r="4"/>',
    note: '<path d="M3 3h18v12l-6 6H3zM15 21v-6h6M7 8h10M7 12h6"/>',
    archive: '<path d="M4 8v13h16V8M9 12h6"/><rect x="3" y="3" width="18" height="5" rx="1"/>',
    open: '<path d="M9 4H4v16h16v-5M13 3h8v8M21 3 10 14"/>',
    closeAll: '<rect x="7" y="3" width="14" height="14" rx="2"/><path d="M17 21H5a2 2 0 0 1-2-2V7M11 7l6 6M17 7l-6 6"/>',
    closeOthers: '<rect x="8" y="4" width="13" height="16" rx="2"/><path d="M4 7v10M2 10l4 4M6 10l-4 4"/>',
    fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    item: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 14h5"/>',
  };
  const rules = [
    [/置顶/, 'pin'],
    [/全部关闭/, 'closeAll'], [/关闭其他/, 'closeOthers'],
    [/全屏|fullscreen/i, 'fullscreen'],
    [/复制引用|copy.reference/i, 'link'], [/复制路径|copy.path/i, 'folder'],
    [/复制|copy|duplicate/i, 'copy'], [/剪切|cut/i, 'cut'], [/粘贴|paste/i, 'paste'],
    [/删除|废弃|delete|remove/i, 'trash'], [/锁定|解锁|lock/i, 'lock'],
    [/移至最前|bring.to.front|to.front/i, 'front'], [/移至最后|send.to.back|to.back/i, 'back'],
    [/上移|bring.forward/i, 'up'], [/下移|send.backward/i, 'down'],
    [/连接点|connection.point/i, 'point'], [/链接|link|挂载到节点/i, 'link'],
    [/样式|style/i, 'style'], [/数据|data/i, 'data'], [/便签|scratchpad/i, 'note'],
    [/停用|归档|收纳|disable|archive/i, 'archive'], [/启用|开启|enable|reopen/i, 'open'],
    [/关闭|close/i, 'check'], [/Feat|复制名称/i, 'file'],
  ];
  function svg(key) {
    return `<svg class="menu-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key] || paths.item}</svg>`;
  }
  function forLabel(label) {
    return svg(rules.find(([pattern]) => pattern.test(label))?.[1] || 'item');
  }
  return { forLabel };
})();
