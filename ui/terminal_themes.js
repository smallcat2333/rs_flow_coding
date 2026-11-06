// 内嵌 CLI 的终端主题：设置预览与 Agent 窗口共用，偏好跨窗口持久化。
'use strict';
window.TerminalThemes = (() => {
  const KEY = 'fc-agent-terminal-theme';
  const FONT = '"Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace';
  const ansiKeys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  function palette(background, foreground, selectionBackground, colors) {
    return { background, foreground, cursor: foreground, cursorAccent: background, selectionBackground,
      ...Object.fromEntries(ansiKeys.map((key, i) => [key, '#' + colors.split(' ')[i]])) };
  }
  // 原生 ANSI 色取自随应用分发的 xterm.js；浅色时沿用原有黑白文字适配。
  const nativeDark = palette('#0d1117', '#e6edf3', '#264f78',
    '2e3436 cc0000 4e9a06 c4a000 3465a4 75507b 06989a d3d7cf 555753 ef2929 8ae234 fce94f 729fcf ad7fa8 34e2e2 eeeeec');
  const nativeLight = { ...nativeDark, background: '#ffffff', foreground: '#24292f', cursor: '#24292f',
    cursorAccent: '#ffffff', selectionBackground: '#add6ff', black: '#24292f', brightBlack: '#57606a', white: '#6e7781', brightWhite: '#8c959f' };
  const themes = [
    { id: 'native', name: '原生（默认）', description: '跟随界面深浅色，保留原生终端配色。', dark: nativeDark, light: nativeLight },
    { id: 'graphite', name: '石墨 · 深色', description: '中性石墨底色，柔和的蓝青强调，适合长时间阅读。',
      colors: palette('#181a1f', '#e6e6e6', '#3d4655',
        '5c6370 ef8b86 a6cc8a e4c584 8eb8e5 c8a3cf 81c5c7 d3d6dc 9299a6 f4aaa5 b9dda2 eed69e a5cbf0 d9bbdf 9bd8d9 f4f4f4') },
    { id: 'forest', name: '松林 · 深色', description: '低亮度松绿底色，清晰区分提示、成功与错误。',
      colors: palette('#111b17', '#e0e9e2', '#304c3d',
        '53665b e99b91 9fcb9d d5c58a 9abbd1 c3a5c8 8bc9bc d2e0d7 8ca397 f0b1a8 b5deb1 e7d8a5 b2cee0 d8bfdb a6e0d2 f1f6f2') },
    { id: 'paper', name: '纸白 · 浅色', description: '干净纸白底色，深色文字与高对比强调，适合白天使用。',
      colors: palette('#ffffff', '#24292f', '#cddff2',
        '24292f a63135 1f713e 856000 235f9f 854c91 086b73 57606a 57606a b4232a 196a34 7b5900 1855a0 80418b 08646c 24292f') },
    { id: 'mist', name: '海雾 · 浅色', description: '淡灰蓝底色，克制的蓝绿配色，减少纯白画面的眩光。',
      colors: palette('#eef3f6', '#263742', '#c6dbe6',
        '263742 a1323d 27663e 7c5c19 265e91 7e4c86 1c6670 536570 536570 a52a37 215e37 76520c 1c568d 783f80 105e68 263742') },
  ];
  const choices = themes.map(({ id, name, description }) => Object.freeze({ id, name, description }));
  function valid(id) { return themes.some(theme => theme.id === id) ? id : 'native'; }
  function current() { return valid(localStorage.getItem(KEY)); }
  function resolve(id = current(), dark = document.documentElement.dataset.theme === 'dark') {
    const theme = themes.find(theme => theme.id === valid(id));
    // 返回完整的新调色板，切回原生时也重置上一套主题的 ANSI 色。
    return { ...(theme.colors || (dark ? theme.dark : theme.light)) };
  }
  function save(id) {
    const value = valid(id);
    localStorage.setItem(KEY, value);
    return value;
  }
  // 固定样例通过真实 ANSI 解析器显示，不启动 CLI，也不消耗模型额度。
  const SAMPLE = '\x1b[1mClaude Code\x1b[0m · Flow Coding\r\n' +
    '\x1b[36m>\x1b[0m 检查流程图与关联的 Feat\r\n' +
    '\x1b[32m✓\x1b[0m 已读取业务流程图\r\n' +
    '\x1b[33m!\x1b[0m 等待确认  \x1b[31m- 删除\x1b[0m  \x1b[32m+ 新增\x1b[0m\r\n' +
    '\x1b[35mconst\x1b[0m status = \x1b[36m"ready"\x1b[0m;\r\n' +
    '\x1b[2m预览样例 · 不会发送请求\x1b[0m';
  return { KEY, FONT, SAMPLE, choices: Object.freeze(choices), current, resolve, save };
})();
