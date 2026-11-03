// 使用说明：书本按钮打开弹层，「图文说明」与「视频介绍」两个页签；关闭或切走时暂停视频。
'use strict';

window.Guide = (() => {
  const $ = (id) => document.getElementById(id);
  /** 视频章节起点（秒），与 scripts/guide_video/timeline.mjs 的 SCENES 一致（每小节 2.4 秒）；最后一项为片尾。 */
  const CHAPTERS = [
    ['开场', 0], ['为什么', 12], ['开始使用', 24], ['流程图', 38.4], ['节点颜色', 52.8], ['协作循环', 67.2],
    ['状态统计', 105.6], ['Feat 档案', 122.4], ['图间链接', 141.6], ['Agent 加锁', 153.6], ['历史对比', 170.4], ['结尾', 182.4],
  ];
  const END = 194.4;
  const RATES = [0.75, 1, 1.25, 1.5, 2];
  const RATE_KEY = 'fc-guide-rate';
  let loading = null;

  /** 首次进入视频页时整段读成 Blob 再播放：App 内嵌资源协议不支持 Range 请求，直接引用文件无法拖动或跳转。
   *  读取失败时退回直接引用（可播放，但不能跳转）。 */
  function loadVideo(video) {
    loading ||= fetch(video.dataset.src)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then((blob) => { video.src = URL.createObjectURL(blob); })
      .catch(() => { video.src = video.dataset.src; });
    return loading;
  }

  /** 章节条按时长分段，点击跳到该章起点；播放时当前章高亮并显示章内进度。 */
  function initChapters(video) {
    const bar = $('guide-chapters');
    bar.innerHTML = CHAPTERS.map(([name, start], i) => {
      const end = CHAPTERS[i + 1]?.[1] ?? END;
      const m = Math.floor(start / 60), s = String(Math.floor(start % 60)).padStart(2, '0');
      return `<button data-start="${start}" data-end="${end}" style="flex-grow:${end - start}" title="${name}（${m}:${s}）"><span>${name}</span></button>`;
    }).join('');
    const buttons = [...bar.children];
    bar.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      loadVideo(video).then(() => {
        video.currentTime = +b.dataset.start;
        video.play().catch(() => {});
      });
    };
    const sync = () => {
      const t = video.currentTime;
      for (const b of buttons) {
        const start = +b.dataset.start, end = +b.dataset.end;
        const p = Math.max(0, Math.min(1, (t - start) / (end - start)));
        b.style.setProperty('--p', p);
        const on = t >= start && t < end;
        b.classList.toggle('current', on);
        if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      }
    };
    video.addEventListener('timeupdate', sync);
    video.addEventListener('seeked', sync);
    sync();
  }

  /** 倍速按钮单选；选择记在本机，下次打开沿用。 */
  function initSpeed(video) {
    const box = $('guide-speed');
    box.innerHTML = RATES.map((r) => `<button data-rate="${r}" aria-pressed="false">${r}×</button>`).join('');
    const apply = (rate) => {
      video.defaultPlaybackRate = video.playbackRate = rate;
      box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.rate === rate)));
    };
    box.onclick = (e) => {
      const b = e.target.closest('[data-rate]');
      if (!b) return;
      apply(+b.dataset.rate);
      localStorage.setItem(RATE_KEY, b.dataset.rate);
    };
    // 原生控件菜单里改倍速时同步按钮状态
    video.addEventListener('ratechange', () => {
      box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.rate === video.playbackRate)));
    });
    const saved = +localStorage.getItem(RATE_KEY);
    apply(RATES.includes(saved) ? saved : 1);
  }

  /** 切换页签：进入视频页时播放（由点击触发，满足自动播放限制），离开时暂停。 */
  function tab(name) {
    document.querySelectorAll('[data-guide-tab]').forEach((b) => {
      const on = b.dataset.guideTab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('[data-guide-panel]').forEach((p) => { p.hidden = p.dataset.guidePanel !== name; });
    const video = $('guide-player');
    if (name === 'video') loadVideo(video).then(() => { if (!$('guide-video').hidden) video.play().catch(() => {}); });
    else video.pause();
  }

  function init() {
    $('btn-guide').onclick = () => { $('guide-dialog').showModal(); tab('doc'); $('guide-doc').scrollTop = 0; };
    $('guide-close').onclick = () => $('guide-dialog').close();
    $('guide-dialog').addEventListener('close', () => $('guide-player').pause());
    initChapters($('guide-player'));
    initSpeed($('guide-player'));
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
