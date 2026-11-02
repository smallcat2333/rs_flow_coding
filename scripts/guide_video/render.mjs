// 导出使用说明视频：逐帧调用 guide_video.html 的 render(t) 截图，经 ffmpeg 编码为 H.264 MP4。
// 依赖（不入库）：npm i puppeteer-core ffmpeg-static，本机 Chrome。
// 用法：node render.mjs [输出.mp4] [--fps 30] [--stills 1,6,20]（--stills 只导出指定秒数的 PNG 供检查）
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'noop.js'));
const puppeteer = require('puppeteer-core');
const ffmpeg = require('ffmpeg-static');
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const fps = Number(opt('--fps', 30));
const stills = opt('--stills', '');
const out = path.resolve(args[0] || path.join(here, '../../ui/guide/guide.mp4'));
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', defaultViewport: { width: 1920, height: 1080 } });
const page = await browser.newPage();
await page.goto(pathToFileURL(path.join(here, 'guide_video.html')).href + '?capture');
await page.evaluate(() => document.fonts.ready);
const stage = await page.$('#stage');

if (stills) {
  for (const t of stills.split(',').map(Number)) {
    await page.evaluate((x) => window.render(x), t);
    await stage.screenshot({ path: path.join(path.dirname(out), `still_${t}.png`) });
  }
  await browser.close();
  process.exit(0);
}

const duration = await page.evaluate(() => window.DURATION);
const frames = Math.round(duration * fps);
const enc = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
for (let f = 0; f < frames; f++) {
  await page.evaluate((x) => window.render(x), f / fps);
  const png = await stage.screenshot({ type: 'png' });
  if (!enc.stdin.write(png)) await new Promise((r) => enc.stdin.once('drain', r));
  if (f % fps === 0) process.stdout.write(`\r${(f / fps).toFixed(0)}s / ${duration}s`);
}
enc.stdin.end();
await new Promise((r, j) => enc.on('close', (code) => (code ? j(new Error('ffmpeg ' + code)) : r())));
await browser.close();
console.log(`\n已导出 ${out}`);
