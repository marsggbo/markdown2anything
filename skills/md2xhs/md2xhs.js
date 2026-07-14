#!/usr/bin/env node
'use strict';
/**
 * md2xhs.js — Markdown → 小红书多张长图
 *
 * 用法:
 *   node md2xhs.js <file.md> [选项]
 *   node md2xhs.js install          # 下载 Chromium（首次使用）
 *
 * 选项:
 *   --theme <name>    主题（默认 zhihu）
 *   --width <n>       图片宽度 px（默认 1080）
 *   --height <n>      每张最大高度 px（默认 1440）
 *   --padding <n>     上下内边距 px（默认 40）
 *   --bg <color>      背景色（默认 #ffffff）
 *   --out <dir>       输出目录（默认 <md同目录>/<文章名>_xhs/）
 *   --json            输出 JSON 而非逐行路径
 *
 * 退出码:
 *   0  成功
 *   1  失败（stderr 有错误信息）
 *   2  未找到 Chromium（运行 node md2xhs.js install 安装）
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── 参数解析 ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

if (argv[0] === 'install') {
  installBrowser();
  process.exit(0);
}

const mdFile = argv.find(a => !a.startsWith('-'));
if (!mdFile) {
  process.stderr.write([
    'Usage: node md2xhs.js <file.md> [options]',
    '       node md2xhs.js install   # 首次使用，下载 Chromium',
    '',
    'Options:',
    '  --theme <name>    主题名（默认 zhihu）',
    '  --width <n>       图片宽度 px（默认 1080）',
    '  --height <n>      每张最大高度 px（默认 1440）',
    '  --padding <n>     上下内边距 px（默认 40）',
    '  --bg <color>      背景色（默认 #ffffff）',
    '  --out <dir>       输出目录（默认 <文章名>_xhs/）',
    '  --json            输出 JSON',
    '',
    '可用主题: wechat claude zhihu macos notion academic spring dark monochrome xhs',
  ].join('\n') + '\n');
  process.exit(1);
}

function flag(name, def) {
  const i = argv.indexOf(name);
  return (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-'))
    ? argv[i + 1] : def;
}

const theme   = flag('--theme',   'zhihu');
const imgW    = parseInt(flag('--width',   '1080'), 10);
const imgH    = parseInt(flag('--height',  '1440'), 10);
const padding = parseInt(flag('--padding', '40'),   10);
const bg      = flag('--bg', '#ffffff');
const outDir  = flag('--out', null);
const jsonOut = argv.includes('--json');

// ─── 定位 lib/ 和 scripts/（支持 skill 独立目录 和 仓库内运行两种布局）────────
const HERE = __dirname;  // skill 目录本身

// 优先找 skill 同目录的 vendor/（独立发布时预置的副本）
// 否则找仓库根的 lib/ 和 scripts/（仓库内开发）
function findRoot() {
  // 1. skill 目录下有 vendor/lib/converter.js → 独立发布布局
  if (fs.existsSync(path.join(HERE, 'vendor', 'lib', 'converter.js'))) {
    return path.join(HERE, 'vendor');
  }
  // 2. skill 是仓库里的 skills/md2xhs/，往上两级找 lib/
  const repoRoot = path.resolve(HERE, '..', '..');
  if (fs.existsSync(path.join(repoRoot, 'lib', 'converter.js'))) {
    return repoRoot;
  }
  // 3. skill 是仓库里的 skills/ 下一级，往上一级
  const parent = path.resolve(HERE, '..');
  if (fs.existsSync(path.join(parent, 'lib', 'converter.js'))) {
    return parent;
  }
  throw new Error('找不到 lib/converter.js，请确认 skill 目录结构正确');
}

const ROOT = findRoot();
const LIB  = path.join(ROOT, 'lib');

// ─── 查找 Chromium ────────────────────────────────────────────────────────────
function findChromium() {
  const home = os.homedir();

  // 1. Playwright 管理的 Chromium
  const cacheDir = path.join(home, '.cache', 'ms-playwright');
  if (fs.existsSync(cacheDir)) {
    for (const entry of fs.readdirSync(cacheDir).filter(e => e.startsWith('chromium'))) {
      const candidates = {
        darwin: path.join(cacheDir, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        linux:  path.join(cacheDir, entry, 'chrome-linux', 'chrome'),
        win32:  path.join(cacheDir, entry, 'chrome-win', 'chrome.exe'),
      };
      const p = candidates[process.platform];
      if (p && fs.existsSync(p)) return p;
    }
  }

  // 2. 系统已安装的浏览器
  const system = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ],
    linux: [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser', '/usr/bin/chromium',
      '/snap/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  };
  for (const p of (system[process.platform] || [])) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── 安装 Chromium ────────────────────────────────────────────────────────────
function installBrowser() {
  const { execFileSync } = require('child_process');
  process.stderr.write('正在下载 Chromium（约 150MB，只需一次）...\n');

  // 优先用 playwright-core 附带的 CLI
  const pwCliPath = path.join(HERE, 'node_modules', 'playwright-core', 'lib', 'cli', 'program.js');
  if (fs.existsSync(pwCliPath)) {
    try {
      execFileSync(process.execPath, [pwCliPath, 'install', 'chromium'], { stdio: 'inherit' });
      process.stderr.write('✅ Chromium 安装完成\n');
      return;
    } catch (_) {}
  }

  // fallback：npx playwright install
  try {
    execFileSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: true });
    process.stderr.write('✅ Chromium 安装完成\n');
  } catch (e) {
    process.stderr.write('❌ 安装失败：' + e.message + '\n');
    process.stderr.write('请手动运行：npx playwright install chromium\n');
    process.exit(1);
  }
}

// ─── 解析颜色 ─────────────────────────────────────────────────────────────────
function parseColor(hex) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

// ─── 主逻辑 ───────────────────────────────────────────────────────────────────
async function main() {
  const mdPath = path.resolve(mdFile);
  if (!fs.existsSync(mdPath)) {
    process.stderr.write(`文件不存在: ${mdPath}\n`);
    process.exit(1);
  }

  // 输出目录
  const base    = path.basename(mdPath, path.extname(mdPath));
  const imgDir  = outDir ? path.resolve(outDir) : path.join(path.dirname(mdPath), `${base}_xhs`);
  fs.mkdirSync(imgDir, { recursive: true });

  // Chromium 检测
  const executablePath = findChromium();
  if (!executablePath) {
    process.stderr.write('未找到 Chromium，请运行：node md2xhs.js install\n');
    process.exit(2);
  }
  process.stderr.write(`使用浏览器: ${path.basename(path.dirname(executablePath))}\n`);

  // 渲染 HTML
  process.stderr.write('正在渲染 Markdown...\n');
  const converter = require(path.join(LIB, 'converter'));
  const themes    = require(path.join(LIB, 'themes'));
  const { bodyHtml } = converter.renderMarkdown(mdPath);
  const themeObj     = themes.getTheme(theme);
  const html         = converter.buildXhsRenderHtml(bodyHtml, path.dirname(mdPath), themeObj);

  const tmpHtml = path.join(os.tmpdir(), `md2xhs_${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  // Playwright 截图 + 分片
  const { PNG } = require('pngjs');
  const { chromium } = require('playwright-core');

  const TILE_H = 4096;  // 每段视口高度（突破 canvas 高度上限）
  const SCALE  = 2;     // deviceScaleFactor，输出 2x 高清图
  const bgRgb  = parseColor(bg);

  const browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let savedPaths = [];
  try {
    const page = await browser.newPage({
      viewport: { width: imgW, height: TILE_H },
      deviceScaleFactor: SCALE,
    });

    const fileUrl = 'file://' + tmpHtml;
    await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);

    const totalPageH = await page.evaluate(() => document.documentElement.scrollHeight);
    process.stderr.write(`页面总高 ${totalPageH}px，开始分段截图...\n`);

    // 分段截图拼接
    const tiles = [];
    let targetY = 0;
    while (targetY < totalPageH) {
      await page.evaluate(y => window.scrollTo(0, y), targetY);
      await page.waitForTimeout(80);
      const actualY  = await page.evaluate(() => window.scrollY);
      const tileBuf  = await page.screenshot({ type: 'png' });
      const tile     = PNG.sync.read(tileBuf);
      const rowStart = targetY - actualY;
      const rowEnd   = Math.min(TILE_H, totalPageH - actualY);
      const validH   = rowEnd - rowStart;
      tiles.push({ png: tile, rowStart: rowStart * SCALE, validH: validH * SCALE });
      targetY += TILE_H;
    }

    // 拼接
    const W = tiles[0].png.width;
    const H = tiles.reduce((s, t) => s + t.validH, 0);
    const combined = new PNG({ width: W, height: H });
    let dstY = 0;
    for (const { png, rowStart, validH } of tiles) {
      for (let row = 0; row < validH; row++) {
        const srcOff = (rowStart + row) * W * 4;
        const dstOff = (dstY + row) * W * 4;
        png.data.copy(combined.data, dstOff, srcOff, srcOff + W * 4);
      }
      dstY += validH;
    }

    // 添加 padding
    const physPadding = padding * SCALE;
    const physImgH    = imgH    * SCALE;
    const padH        = H + 2 * physPadding;
    const padded      = new PNG({ width: W, height: padH });
    for (let y = 0; y < padH; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        padded.data[i] = bgRgb[0]; padded.data[i+1] = bgRgb[1];
        padded.data[i+2] = bgRgb[2]; padded.data[i+3] = 255;
      }
    }
    for (let y = 0; y < H; y++) {
      const srcOff = y * W * 4;
      const dstOff = (y + physPadding) * W * 4;
      combined.data.copy(padded.data, dstOff, srcOff, srcOff + W * 4);
    }

    const totalW = W, totalH = padH, pixels = padded.data;

    // 智能分片：优先在空白行处切割
    function isBlankRow(y, tol = 10) {
      for (let x = 0; x < totalW; x++) {
        const i = (y * totalW + x) * 4;
        if (Math.abs(pixels[i]   - bgRgb[0]) > tol ||
            Math.abs(pixels[i+1] - bgRgb[1]) > tol ||
            Math.abs(pixels[i+2] - bgRgb[2]) > tol) return false;
      }
      return true;
    }

    const slices = [];
    let startY = 0;
    while (startY < totalH) {
      let endY = Math.min(startY + physImgH, totalH);
      if (endY < totalH) {
        const minCut = startY + Math.floor(physImgH / 2);
        let cutY = endY;
        while (cutY > minCut) {
          if (isBlankRow(cutY - 1)) { endY = cutY; break; }
          cutY--;
        }
      }
      slices.push([startY, endY]);
      startY = endY;
    }

    process.stderr.write(`共 ${slices.length} 张，开始保存...\n`);

    // 保存分片
    for (let i = 0; i < slices.length; i++) {
      const [y0, y1] = slices[i];
      const sliceH = y1 - y0;
      const slice  = new PNG({ width: totalW, height: sliceH });
      for (let y = 0; y < sliceH; y++) {
        const srcOff = (y0 + y) * totalW * 4;
        const dstOff = y * totalW * 4;
        pixels.copy(slice.data, dstOff, srcOff, srcOff + totalW * 4);
      }
      const outPath = path.join(imgDir, `xhs_${String(i + 1).padStart(2, '0')}.png`);
      fs.writeFileSync(outPath, PNG.sync.write(slice));
      process.stderr.write(`已保存: ${path.basename(outPath)}\n`);
      savedPaths.push(outPath);
    }

  } finally {
    await browser.close();
    try { fs.unlinkSync(tmpHtml); } catch (_) {}
  }

  // 输出结果
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ count: savedPaths.length, dir: imgDir, images: savedPaths }, null, 2) + '\n');
  } else {
    process.stdout.write(savedPaths.join('\n') + '\n');
  }

  process.stderr.write(`✅ 完成，共 ${savedPaths.length} 张，保存到: ${imgDir}\n`);
}

main().catch(err => {
  process.stderr.write('❌ 错误: ' + err.message + '\n');
  process.exit(1);
});
