'use strict';
const fs = require('fs');
const path = require('path');

/**
 * lib/cover.js — 封面 HTML 生成（脚本固化风格）
 *
 * 视觉：麦当劳式大 M + marsggbo + 蜡笔小新/猪猪侠背景 + 中央毛玻璃标题卡
 * 输出：1080x1440 的独立 HTML，供 scripts/cover.js 用 Playwright 截图
 */

// ── 默认背景 prompt（供 LLM 生图或用户手动画图参考） ──────────
const DEFAULT_COVER_PROMPT = `Crayon Shin-chan and GG Bond (Zhu Zhu Xia) chibi style, playful pastel color palette, soft cloud and star doodles on the border, characters positioned ONLY on the four corners and edges, CENTER 45% area MUST be clean light beige / off-white empty space for title text, no text, no character in the center, kawaii sticker aesthetic, 3:4 vertical poster, 8k, flat illustration`;

const DEFAULT_COVER_NEGATIVE = `no text in center, no crowding, no dark background, no realistic photo, no horror`;

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// 将标题按长度自动处理：过长时插入 <br>，最多 2 行
function formatTitle(title) {
  const t = String(title || '').trim();
  if (!t) return '未命名封面';
  // 如果已有换行则保留
  if (t.includes('\n')) return t.split('\n').map(escapeHtml).join('<br>');
  // 中文按字符，英文按单词，超过 18 字自动折行（取中间空格/标点）
  if (t.length <= 18) return escapeHtml(t);
  // 找中间附近的空格或标点断行
  const mid = Math.floor(t.length / 2);
  let cut = -1;
  for (let d = 0; d < 8; d++) {
    for (const off of [d, -d]) {
      const i = mid + off;
      if (i > 4 && i < t.length - 4 && /[\s，,。！!？?、|｜—\-—:：]/.test(t[i])) { cut = i; break; }
    }
    if (cut !== -1) break;
  }
  if (cut === -1) cut = mid;
  return escapeHtml(t.slice(0, cut + 1)) + '<br>' + escapeHtml(t.slice(cut + 1));
}

/**
 * 构建封面 HTML
 * @param {object} opts
 * @param {string} opts.title - 标题（必填）
 * @param {string} [opts.subtitle] - 副标题/作者，默认 marsggbo
 * @param {string} [opts.bgImage] - 背景图 data URL 或 http(s) URL 或本地路径（absolute）。为空则用纯色+装饰
 * @param {string} [opts.bgColor] - 无图时的背景色
 * @param {number} [opts.width=1080]
 * @param {number} [opts.height=1440]
 * @param {string} [opts.accent='#FFC72C'] - M 的颜色
 * @returns {string} 完整 HTML
 */
function buildCoverHtml(opts = {}) {
  const title = opts.title || '未命名封面';
  const W = opts.width || 1080;
  const H = opts.height || 1440;
  const bgColor = opts.bgColor || '#FFF8E7';

  // 背景图处理：本地路径转 data URL
  let bgCss = `background: ${bgColor};`;
  let bgImage = opts.bgImage || '';
  if (bgImage) {
    if (!bgImage.startsWith('data:') && !/^https?:\/\//.test(bgImage) && fs.existsSync(bgImage)) {
      const ext = path.extname(bgImage).slice(1).toLowerCase();
      const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp' };
      const mime = mimeMap[ext] || 'image/png';
      const b64 = fs.readFileSync(bgImage).toString('base64');
      bgImage = `data:${mime};base64,${b64}`;
    }
    if (bgImage.startsWith('data:') || /^https?:\/\//.test(bgImage)) {
      bgCss = `background: ${bgColor} url('${bgImage}') center/cover no-repeat;`;
    }
  }

  const titleHtml = formatTitle(title);
  // 标题状态：支持拖拽/缩放后的自定义位置与大小，未传则居中自适应
  const ts = opts.titleState || {};
  const hasCustomPos = typeof ts.x === 'number' && typeof ts.y === 'number';
  const hasCustomSize = typeof ts.fontSize === 'number';
  const hasCustomWidth = typeof ts.width === 'number';
  const rawLen = String(title).trim().length;
  const autoSize = rawLen <= 14 ? Math.round(W*0.074) : rawLen <= 22 ? Math.round(W*0.068) : Math.round(W*0.060);
  const titleSize = hasCustomSize ? Math.max(28, Math.min(140, Math.round(ts.fontSize))) : autoSize;
  const titleWidth = hasCustomWidth ? Math.max(50, Math.min(92, ts.width)) : 70; // 百分比

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${W}, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; margin: 0; }
  .cover {
    width: ${W}px; height: ${H}px;
    ${bgCss}
    position: relative;
    display: ${hasCustomPos ? 'block' : 'flex'}; flex-direction: column;
    align-items: center; justify-content: center;
    font-family: 'PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,-apple-system,sans-serif;
  }
  /* ── 纯文字标题区（无卡片，不挡背景） ── */
  .title-wrap {
    position: ${hasCustomPos ? 'absolute' : 'relative'}; z-index: 2;
    ${hasCustomPos ? `left: ${ts.x}%; top: ${ts.y}%; transform: translate(-50%, -50%);` : 'margin: auto;'}
    width: ${titleWidth}%;
    max-width: 760px;
    text-align: center;
    padding: 12px 8px;
  }
  .title-wrap h1 {
    font-family: 'PingFang SC','Hiragino Sans GB','Alibaba PuHuiTi Heavy','ZCOOL KuaiLe',system-ui,sans-serif;
    font-size: ${titleSize}px;
    font-weight: 900;
    line-height: 1.28;
    color: #1A1A1A;
    letter-spacing: 0.02em;
    word-break: break-word;
    /* 白色描边 + 柔和阴影：在浅米黄留白上清晰，背景花也不糊 */
    -webkit-text-stroke: 7px #fff;
    paint-order: stroke fill;
    text-shadow: 0 2px 0 rgba(255,255,255,0.95), 0 10px 28px rgba(0,0,0,0.12);
    filter: drop-shadow(0 1px 0 rgba(255,255,255,1));
  }
  .title-wrap .tagline {
    margin-top: 16px;
    font-size: ${Math.round(W*0.028)}px;
    font-weight: 600;
    color: #3a3a3a;
    letter-spacing: 0.12em;
    -webkit-text-stroke: 4px #fff;
    paint-order: stroke fill;
    text-shadow: 0 1px 0 rgba(255,255,255,0.9);
  }
  /* 无背景图时的极简占位 */
  .corner-deco { position: absolute; z-index: 1; font-size: ${Math.round(W*0.10)}px; opacity: 0.14; line-height: 1; }
  .corner-deco.tl { left: 22px; top: 18px; transform: rotate(-10deg); }
  .corner-deco.tr { right: 22px; top: 18px; transform: rotate(10deg); }
  .corner-deco.bl { left: 22px; bottom: 22px; transform: rotate(8deg); }
  .corner-deco.br { right: 22px; bottom: 22px; transform: rotate(-8deg); }
</style>
</head>
<body>
<div class="cover">
  ${!opts.bgImage ? '<span class="corner-deco tl">✦</span><span class="corner-deco tr">✦</span><span class="corner-deco bl">✦</span><span class="corner-deco br">✦</span>' : ''}
  <div class="title-wrap">
    <h1>${titleHtml}</h1>
    ${opts.tagline ? `<div class="tagline">${escapeHtml(opts.tagline)}</div>` : ''}
  </div>
</div>
</body>
</html>`;
}

module.exports = { buildCoverHtml, DEFAULT_COVER_PROMPT, DEFAULT_COVER_NEGATIVE };
