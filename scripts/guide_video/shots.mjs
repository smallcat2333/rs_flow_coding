// 图文说明页配图：在浏览器预览（dev_server.py + Tauri 模拟层）中操作真实界面并截图到 ui/guide/。
// 先运行 python scripts/dev_server.py --samples tests/samples；依赖同 render.mjs。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'noop.js'));
const puppeteer = require('puppeteer-core');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../../ui/guide');
const url = process.argv[2] || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 1440, height: 860 } });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => localStorage.setItem('fc-theme', 'dark'));
await page.goto(url, { waitUntil: 'networkidle0' });
await sleep(800);

/** 点侧栏里名称匹配的条目。 */
async function openEntry(name) {
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('#tree .file, #tree .feat')].find((e) => e.textContent.trim().startsWith(n));
    el.click();
  }, name);
}

// 侧栏状态统计
await (await page.$('#totals')).screenshot({ path: path.join(out, 'shot_status.png') });

// 打开图，等 draw.io 就绪后选中挂了 Feat 的节点
await openEntry('颜色协作样例');
const frame = await (await page.waitForSelector('#editor')).contentFrame();
await frame.waitForFunction(() => window.fcBridge && window.fcBridge.ui, { timeout: 30000 });
await sleep(1500);
const picked = await frame.evaluate(() => {
  const graph = window.fcBridge.ui.editor.graph;
  const cells = graph.model.getDescendants(graph.model.getRoot()).filter((c) => graph.model.isVertex(c));
  const target = cells.find((c) => (graph.getTagsForCell(c) || '').includes('Feat_')) || cells[0];
  graph.setSelectionCell(target);
  return target.id;
});
await sleep(1200);
await page.screenshot({ path: path.join(out, 'shot_flow.png') });

// draw.io 右侧格式面板：节点状态按钮
await frame.evaluate(() => {
  const ui = window.fcBridge.ui;
  if (ui.formatWidth === 0 || (ui.isFormatPanelVisible && !ui.isFormatPanelVisible())) ui.actions.get('format').funct();
});
await sleep(800);
const panel = await frame.evaluate(() => {
  const box = document.querySelector('.fc-status-styles');
  if (!box) return null;
  box.scrollIntoView({ block: 'center' });
  const r = box.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
if (panel) {
  const ifr = await (await page.$('#editor')).boundingBox();
  await sleep(300);
  await page.screenshot({ path: path.join(out, 'shot_format.png'), clip: { x: ifr.x + panel.x - 8, y: ifr.y + panel.y - 8, width: panel.width + 16, height: panel.height + 16 } });
}

// 点书签打开 Feat，与图分栏显示
await openEntry('查询缓存');
await sleep(1800);
await page.screenshot({ path: path.join(out, 'shot_feat.png') });

console.log('selected', picked, 'format panel', !!panel);
await browser.close();
