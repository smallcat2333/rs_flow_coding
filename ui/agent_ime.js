// xterm 输入法适配：只约束预编辑浮层及候选窗锚点，不改输入内容或 PTY 数据。
'use strict';

window.AgentImeAddon = class AgentImeAddon {
  activate(term) {
    const screen = term.element.querySelector('.xterm-screen');
    const view = term.element.querySelector('.composition-view');
    const textarea = term.textarea;
    if (!screen || !view || !textarea) return;

    const viewProps = ['max-width', 'overflow', 'white-space', 'transform'];
    const textareaProps = ['max-width', 'transform'];
    const save = (element, props) => props.map(name => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
    const originalView = save(view, viewProps), originalTextarea = save(textarea, textareaProps);
    const set = (element, name, value) => {
      if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
    };
    const restore = (element, saved) => {
      for (const [name, value, priority] of saved) {
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      }
    };
    let adjusted = false;
    const reset = () => {
      if (!adjusted) return;
      restore(view, originalView);
      restore(textarea, originalTextarea);
      adjusted = false;
    };
    const observe = () => mutations.observe(view, {
      attributes: true, attributeFilter: ['class', 'style'], childList: true, characterData: true, subtree: true,
    });
    const sync = () => {
      // xterm 仍拥有 left/top/width；使用 transform 避让，后续重绘不会覆盖修正。
      // 暂停观察自身写入，避免 MutationObserver 引起重复布局。
      mutations.disconnect();
      try {
        if (!view.classList.contains('active')) { reset(); return; }
        const width = screen.getBoundingClientRect().width;
        if (width <= 0 || !view.style.left.endsWith('px')) return; // 隐藏页签不测量
        adjusted = true;
        set(view, 'max-width', `${width}px`);
        set(view, 'overflow', 'hidden');
        set(view, 'white-space', 'pre');
        const anchor = parseFloat(view.style.left);
        const visible = Math.min(width, Math.max(view.scrollWidth, view.getBoundingClientRect().width, 1));
        const left = Math.max(0, Math.min(anchor, width - visible));
        set(view, 'transform', `translateX(${left - anchor}px)`);
        // 超长组合串保留当前正在输入的末尾；不截断内容或改 textarea.value。
        view.scrollLeft = view.scrollWidth;
        if (textarea.style.left.endsWith('px')) {
          set(textarea, 'transform', `translateX(${left - parseFloat(textarea.style.left)}px)`);
          set(textarea, 'max-width', `${width - left}px`);
        }
      } finally { observe(); }
    };
    const mutations = new MutationObserver(sync);
    const resize = new ResizeObserver(sync);
    observe();
    resize.observe(screen);
    const events = ['compositionstart', 'compositionupdate', 'compositionend'];
    for (const event of events) textarea.addEventListener(event, sync);
    const subscriptions = [term.onRender(sync), term.onResize(sync)];
    this.cleanup = () => {
      mutations.disconnect();
      resize.disconnect();
      for (const event of events) textarea.removeEventListener(event, sync);
      for (const subscription of subscriptions) subscription.dispose();
      reset();
    };
  }

  dispose() { this.cleanup?.(); }
};
