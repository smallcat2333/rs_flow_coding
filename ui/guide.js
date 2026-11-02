// 使用说明：书本按钮打开弹层，「图文说明」与「视频介绍」两个页签；关闭或切走时暂停视频。
'use strict';

window.Guide = (() => {
  const $ = (id) => document.getElementById(id);

  /** 切换页签：进入视频页时播放（由点击触发，满足自动播放限制），离开时暂停。 */
  function tab(name) {
    document.querySelectorAll('[data-guide-tab]').forEach((b) => {
      const on = b.dataset.guideTab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('[data-guide-panel]').forEach((p) => { p.hidden = p.dataset.guidePanel !== name; });
    const video = $('guide-player');
    if (name === 'video') video.play().catch(() => {});
    else video.pause();
  }

  function init() {
    $('btn-guide').onclick = () => { $('guide-dialog').showModal(); tab('doc'); $('guide-doc').scrollTop = 0; };
    $('guide-close').onclick = () => $('guide-dialog').close();
    $('guide-dialog').addEventListener('close', () => $('guide-player').pause());
    const tabs = [...document.querySelectorAll('[data-guide-tab]')];
    tabs.forEach((b) => { b.onclick = () => tab(b.dataset.guideTab); });
    // 页签左右方向键切换（WAI-ARIA tabs）
    $('guide-tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = tabs.indexOf(document.activeElement);
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      tab(next.dataset.guideTab);
    });
    // 目录跳转只滚动正文容器，不改地址
    $('guide-doc').querySelector('nav').addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      $('guide-doc').querySelector(a.getAttribute('href')).scrollIntoView({ block: 'start' });
    });
  }

  return { init };
})();
Guide.init();
