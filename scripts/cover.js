#!/usr/bin/env node
'use strict';
/**
 * scripts/cover.js — 封面截图（HTML -> 1080x1440 PNG）
 * 复用 xhs_screenshot.js 的 Chromium 查找逻辑
 *
 * 用法:
 *   node scripts/cover.js --title "标题" --out ./cover.png [--bg ./bg.png] [--subtitle marsggbo] [--width 1080] [--height 1440]
 *   node scripts/cover.js --html ./cover.html --out ./cover.png   # 直接给 HTML
 *
 * 协议 stdout:
 *   INFO:<msg>
 *   SAVED:<path>
 *   ERROR:<msg>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  return (i >= 0 && argv[i+1] && !argv[i+1].startsWith('--')) ? argv[i+1] : def;
}
function hasFlag(name) { return argv.includes(name); }

const title = flag('--title', '');
const subtitle = flag('--subtitle', 'marsggbo');
const bg = flag('--bg', '');
const htmlIn = flag('--html', '');
const out = flag('--out', '');
const tagline = flag('--tagline', '');
const width = parseInt(flag('--width','1080'),10);
const height = parseInt(flag('--height','1440'),10);
const titleStateRaw = flag('--titleState', '');
let titleState = null;
try { if (titleStateRaw) titleState = JSON.parse(titleStateRaw); } catch(_){}

if (!out) {
  console.log('ERROR:请指定 --out 输出路径');
  process.exit(1);
}

function findChromium() {
  const home = os.homedir();
  const cacheDir = path.join(home, '.cache', 'ms-playwright');
  if (fs.existsSync(cacheDir)) {
    const entries = fs.readdirSync(cacheDir).filter(e => e.startsWith('chromium'));
    for (const e of entries) {
      const candidates = {
        darwin: path.join(cacheDir, e, 'chrome-mac', 'Chromium.app','Contents','MacOS','Chromium'),
        linux: path.join(cacheDir, e, 'chrome-linux','chrome'),
        win32: path.join(cacheDir, e, 'chrome-win','chrome.exe'),
      };
      const p = candidates[process.platform];
      if (p && fs.existsSync(p)) return p;
    }
  }
  const system = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium-browser','/usr/bin/chromium'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  };
  for (const p of (system[process.platform]||[])) if (fs.existsSync(p)) return p;
  return null;
}

async function main() {
  let htmlContent = '';
  let tmpHtml = null;
  if (htmlIn) {
    if (!fs.existsSync(htmlIn)) { console.log(`ERROR:HTML 不存在: ${htmlIn}`); process.exit(1); }
    htmlContent = fs.readFileSync(htmlIn,'utf8');
    tmpHtml = path.resolve(htmlIn);
  } else {
    const { buildCoverHtml } = require('../lib/cover');
    htmlContent = buildCoverHtml({ title: title || '未命名封面', subtitle, bgImage: bg, tagline, width, height, titleState });
    tmpHtml = path.join(os.tmpdir(), `m2a_cover_${Date.now()}.html`);
    fs.writeFileSync(tmpHtml, htmlContent, 'utf8');
  }

  const executablePath = findChromium();
  if (!executablePath) { console.log('NEED_INSTALL'); process.exit(2); }
  console.log(`INFO:使用浏览器: ${path.basename(path.dirname(executablePath))}`);

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath, args:['--no-sandbox','--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport:{ width, height }, deviceScaleFactor: 2 });
    await page.goto('file://' + path.resolve(tmpHtml), { waitUntil:'networkidle', timeout:30000 });
    await page.waitForTimeout(600);
    // 截图的物理像素是 viewport*scale，需用 clip 限制
    const buf = await page.screenshot({ type:'png', clip:{ x:0, y:0, width, height } });
    const outPath = path.resolve(out);
    fs.mkdirSync(path.dirname(outPath), { recursive:true });
    fs.writeFileSync(outPath, buf);
    console.log(`SAVED:${outPath}`);
    console.log(`DONE:1`);
  } finally {
    await browser.close();
    // 清理临时 html（仅当是我们生成的）
    if (!htmlIn && tmpHtml && fs.existsSync(tmpHtml)) try{fs.unlinkSync(tmpHtml);}catch(_){}
  }
}
main().catch(e=>{ console.log(`ERROR:${e.message}`); process.exit(1); });
