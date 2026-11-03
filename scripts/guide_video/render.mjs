// 导出使用说明视频：起本地静态服务打开 guide_video.html，逐帧调用 render(t) 截图，与 music.mjs 合成的配乐一起经 ffmpeg 编码为 MP4。
// 依赖（不入库）：npm i puppeteer-core ffmpeg-static three@0.170.0，本机 Chrome；在装有这些依赖的目录下运行。
// 用法：
//   node render.mjs [输出.mp4] [--fps 30]        导出完整视频（默认 ui/guide/guide.mp4）
//   node render.mjs --stills 5,30,90             只导出指定秒数的截图到 ./stills/，并拼一张 sheet.png
//   node render.mjs --serve                      只启动静态服务，浏览器打开 http://127.0.0.1:8790/guide_video.html 实时预览
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildMusic } from './music.mjs';

const require = createRequire(path.join(process.cwd(), 'noop.js'));
const here = path.dirname(fileURLToPath(import.meta.url));
const threeDir = path.resolve(path.dirname(require.resolve('three')), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const flag = (name) => { const i = args.indexOf(name); return i >= 0 && args.splice(i, 1).length > 0; };
const fps = Number(opt('--fps', 30));
const stills = opt('--stills', '');
const serveOnly = flag('--serve');
const out = path.resolve(args[0] || path.join(here, '../../ui/guide/guide.mp4'));
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/* ---------- 静态服务：/three/ 指向 three 包，其余指向本目录 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [root, rel] = url.startsWith('/three/') ? [threeDir, url.slice(7)] : [here, url.slice(1)];
  const file = path.resolve(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(serveOnly ? 8790 : 0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/guide_video.html`;
if (serveOnly) {
  console.log(`预览：${base}（?t=秒 定格，?from=秒 从某处播放）`);
} else {
  await run();
  server.close();
}

function ffmpegRun(argv, stdin = 'ignore') {
  const p = spawn(require('ffmpeg-static'), ['-y', '-loglevel', 'error', ...argv], { stdio: [stdin, 'inherit', 'inherit'] });
  p.done = new Promise((r, j) => p.on('close', (code) => (code ? j(new Error('ffmpeg 退出码 ' + code)) : r())));
  return p;
}

async function run() {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chrome, headless: 'new', defaultViewport: { width: 1920, height: 1080 },
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('页面错误：', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error(`[${m.type()}]`, m.text()); });
  await page.goto(base + '?capture');
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  const stage = await page.$('#stage');
  const shot = async (t, o) => { await page.evaluate((x) => window.render(x), t); return stage.screenshot(o); };

  if (stills) {
    const dir = path.resolve('stills');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const ts = stills.split(',').map(Number);
    const t0 = Date.now();
    for (const [i, t] of ts.entries()) await shot(t, { path: path.join(dir, `s_${String(i).padStart(2, '0')}_${t}s.png`) });
    console.log(`截图 ${ts.length} 张，平均 ${((Date.now() - t0) / ts.length).toFixed(0)} ms/帧`);
    // 拼成缩略图总览，便于一次检查（至少两张才拼）
    if (ts.length < 2) { await browser.close(); return; }
    const cols = Math.min(3, ts.length), rows = Math.ceil(ts.length / cols);
    const inputs = ts.flatMap((t, i) => ['-i', path.join(dir, `s_${String(i).padStart(2, '0')}_${t}s.png`)]);
    const pad = Array.from({ length: cols * rows - ts.length }, () => ['-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:d=1']).flat();
    const n = cols * rows;
    const graph = Array.from({ length: n }, (_, i) => `[${i}:v]scale=640:360,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${i < ts.length ? ts[i] + 's' : ''}':x=12:y=10:fontsize=26:fontcolor=yellow:box=1:boxcolor=black@0.6[v${i}]`).join(';')
      + ';' + Array.from({ length: n }, (_, i) => `[v${i}]`).join('') + `xstack=inputs=${n}:layout=` + Array.from({ length: n }, (_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 360}`).join('|') + '[out]';
    await ffmpegRun([...inputs, ...pad, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', path.join(dir, 'sheet.png')]).done;
    await browser.close();
    return;
  }

  const duration = await page.evaluate(() => window.DURATION);
  const wav = path.join(path.dirname(out), '.guide_music.wav');
  console.log('合成配乐…', buildMusic(wav));
  const frames = Math.round(duration * fps);
  const enc = ffmpegRun(['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-i', wav,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', out], 'pipe');
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    const jpg = await shot(f / fps, { type: 'jpeg', quality: 95 });
    if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once('drain', r));
    if (f % fps === 0) {
      const el = (Date.now() - t0) / 1000, eta = f ? el / f * (frames - f) : 0;
      process.stdout.write(`\r${(f / fps).toFixed(0)}s / ${duration}s  已用 ${el.toFixed(0)}s  预计剩余 ${eta.toFixed(0)}s   `);
    }
  }
  enc.stdin.end();
  await enc.done;
  await browser.close();
  await rm(wav, { force: true });
  console.log(`\n已导出 ${out}`);
}
