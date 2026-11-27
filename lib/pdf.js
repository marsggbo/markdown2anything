'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cheerio = require('cheerio');
const { launchOptions } = require('./browser');

/**
 * 将主题 CSS 中的每个选择器加上作用域前缀（默认 .article-wrapper），
 * 正确处理逗号分隔的多选择器（如 `p, li, td, th { ... }`）、注释及 @ 规则。
 *
 * @param {string} css
 * @param {string} [scope='.article-wrapper']
 * @returns {string}
 */
function scopeThemeCss(css, scope = '.article-wrapper') {
  if (!css || !css.trim()) return '';
  // 先剥离块注释，避免注释中的花括号干扰规则切分
  const stripped = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped.replace(/([^{}@]+)\{/g, (match, selectorGroup) => {
    const trimmed = selectorGroup.trim();
    if (!trimmed) return match;
    // keyframes 百分比帧（如 0%, 100%, from, to）不加前缀
    if (/^(from|to|\d+%(\s*,\s*\d+%)*)$/i.test(trimmed)) return match;
    const scoped = trimmed
      .split(',')
      .map((sel) => {
        const s = sel.trim();
        if (!s) return '';
        if (s.startsWith(scope)) return s;
        if (s === ':root' || s === 'html' || s === 'body') return scope;
        return `${scope} ${s}`;
      })
      .filter(Boolean)
      .join(', ');
    return `${scoped} {`;
  });
}

/**
 * 页边距预设（单位 mm）
 */
const MARGIN_PRESETS = {
  compact: { top: 10, bottom: 10, left: 10, right: 10 },
  normal:  { top: 16, bottom: 16, left: 15, right: 15 },
  wide:    { top: 24, bottom: 24, left: 22, right: 22 },
};

/**
 * 判断颜色是否为深色背景（用于自动匹配页码文字颜色）
 * @param {string} hexOrRgb
 * @returns {boolean}
 */
function isDarkColor(hexOrRgb) {
  const s = String(hexOrRgb || '#ffffff').trim();
  let r = 255, g = 255, b = 255;
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length >= 6) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
  } else {
    const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
  }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.45;
}

/**
 * 构建与当前预览主题完全一致的独立 PDF 渲染 HTML。
 *
 * - 内嵌 KaTeX CSS（含 base64 字体）与 highlight.js 样式
 * - 复刻 webview 预览区基础样式（含 Mermaid / Callout / 脚注 / 代码块增强）+ 当前主题样式（含 wrapperBg 背景色）+ 用户自定义 CSS
 * - 分页模式下通过 `@page { margin: 0 }` + 固定背景层 + 表格页眉/页脚留白，
 *   确保暗色主题（如深夜极客 #1e1e2e）与暖色主题整页铺满无白边，且每页上下边距均匀
 * - 针对打印引擎处理渐变文字回退、横向滚动容器展开、标题/公式/图片防跨页截断
 *
 * @param {string} bodyHtml - renderMarkdown 产出的文章 HTML
 * @param {string} baseDir  - Markdown 所在目录（用于兜底解析相对路径图片）
 * @param {{ id?: string, name?: string, css?: string, wrapperBg?: string }} theme - 当前选中的主题
 * @param {{
 *   katexCss?: string,
 *   hlCss?: string,
 *   customCss?: string,
 *   title?: string,
 *   format?: 'A4'|'Letter'|'continuous',
 *   marginPreset?: 'compact'|'normal'|'wide',
 *   pageNumbers?: boolean,
 * }} [options]
 * @returns {string}
 */
function buildPdfRenderHtml(bodyHtml, baseDir, theme, options = {}) {
  const {
    katexCss = '',
    hlCss = '',
    customCss = '',
    title = 'Markdown2Anything',
    format = 'A4',
    marginPreset = 'normal',
    pageNumbers = false,
  } = options;

  // 兜底把未转 data URI 的本地相对图片转为 base64
  const $ = cheerio.load(bodyHtml || '', { decodeEntities: false });
  if (baseDir) {
    $('img').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (!src || src.startsWith('data:') || /^https?:\/\//i.test(src) || src.startsWith('//')) return;
      const imgPath = path.isAbsolute(src) ? src : path.resolve(baseDir, src);
      try {
        if (!fs.existsSync(imgPath)) return;
        const ext = path.extname(imgPath).slice(1).toLowerCase();
        const mimeMap = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        };
        const mime = mimeMap[ext] || 'image/png';
        const b64 = fs.readFileSync(imgPath).toString('base64');
        $(el).attr('src', `data:${mime};base64,${b64}`);
      } catch (_) {}
    });
  }
  const processedBody = $('body').html() || $.html();

  const bgColor = (theme && theme.wrapperBg) ? theme.wrapperBg : '#ffffff';
  const scopedThemeCss = scopeThemeCss(theme ? theme.css : '', '.article-wrapper');
  const margins = MARGIN_PRESETS[marginPreset] || MARGIN_PRESETS.normal;
  const isContinuous = format === 'continuous';
  const pageSizeCss = format === 'Letter' ? 'Letter' : 'A4';

  // Claude Pro 等使用 background-clip:text + transparent 填充色的标题在 Chromium PDF 导出中
  // 可能在部分阅读器（如 macOS 预览）里变成纯色色块或不可见，打印态回退为清晰的实色矢量字
  const gradientTextPrintFix = (theme && theme.id === 'claude-pro')
    ? `.article-wrapper h1 { background: none !important; -webkit-text-fill-color: #92400e !important; color: #92400e !important; }`
    : '';

  const useFooterTemplate = !isContinuous && !!pageNumbers;
  const pageRule = isContinuous
    ? `@page { margin: 0; }`
    : `@page { size: ${pageSizeCss}; margin: 0; }`;

  const topSpacerMm = margins.top;
  const bottomSpacerMm = useFooterTemplate ? Math.max(margins.bottom, 14) : margins.bottom;
  const sidePaddingMm = margins.left;

  const safeTitle = String(title || 'Markdown2Anything')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const bodyMarkup = isContinuous
    ? `<div class="pdf-continuous-wrap"><div class="article-wrapper" id="preview-content">${processedBody}</div></div>`
    : `<table class="pdf-layout-table" role="presentation">
        <thead><tr><td class="pdf-layout-spacer-cell"><div class="pdf-spacer-top"></div></td></tr></thead>
        <tbody><tr><td class="pdf-layout-body-cell"><div class="article-wrapper" id="preview-content">${processedBody}</div></td></tr></tbody>
        <tfoot><tr><td class="pdf-layout-spacer-cell"><div class="pdf-spacer-bottom"></div></td></tr></tfoot>
      </table>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <style>${katexCss}</style>
  <style>${hlCss}</style>
  <style>
    ${pageRule}
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: ${bgColor};
      -webkit-font-smoothing: antialiased;
    }
    /* 固定全页背景层：保证每一页（含暗色/暖色主题）边缘不留白框 */
    .pdf-page-bg {
      position: fixed;
      inset: 0;
      background: ${bgColor};
      z-index: -1;
      pointer-events: none;
    }
    /* 分页布局外层骨架（利用 thead/tfoot 在每页自动重复上下边距） */
    table.pdf-layout-table {
      width: 100%;
      border-collapse: collapse;
      border: none;
      margin: 0;
      padding: 0;
      table-layout: fixed;
      background: transparent;
    }
    table.pdf-layout-table > thead { display: table-header-group; }
    table.pdf-layout-table > tfoot { display: table-footer-group; }
    table.pdf-layout-table > thead > tr > td.pdf-layout-spacer-cell,
    table.pdf-layout-table > tfoot > tr > td.pdf-layout-spacer-cell,
    table.pdf-layout-table > tbody > tr > td.pdf-layout-body-cell {
      border: none !important;
      padding: 0 !important;
      background: transparent !important;
    }
    .pdf-spacer-top { height: ${topSpacerMm}mm; }
    .pdf-spacer-bottom { height: ${bottomSpacerMm}mm; }
    .pdf-layout-body-cell {
      padding-left: ${sidePaddingMm}mm !important;
      padding-right: ${margins.right}mm !important;
    }
    .pdf-continuous-wrap {
      padding: ${topSpacerMm}mm ${margins.right}mm ${bottomSpacerMm}mm ${sidePaddingMm}mm;
      background: ${bgColor};
    }

    /* ── 与预览面板一致的 .article-wrapper 基础样式 ── */
    .article-wrapper {
      width: 100%;
      background: ${bgColor};
      padding: 4px 2px;
    }
    .article-wrapper p,
    .article-wrapper li,
    .article-wrapper td,
    .article-wrapper th {
      text-align: left;
      color: #3f3f3f;
      line-height: 1.75em;
      font-family: system-ui, -apple-system, BlinkMacSystemFont,
        'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB',
        'Microsoft YaHei UI', 'Microsoft YaHei', Arial, sans-serif;
      font-size: 16px;
    }
    .article-wrapper strong { font-weight: 600; color: rgb(0, 122, 170); }
    .article-wrapper img {
      outline: none;
      text-decoration: none;
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
    .article-wrapper p { margin: 1.15em 0; }
    .article-wrapper h1 { font-size: 140%; color: #de7456; text-align: center; }
    .article-wrapper h2 {
      font-size: 120%;
      font-weight: bold;
      color: #de7456;
      text-align: center;
      line-height: 2;
      border-bottom: 1px solid #de7456;
      margin: 1em auto;
      padding-bottom: 4px;
    }
    .article-wrapper h3 {
      font-size: 110%;
      color: rgb(0, 122, 170);
      border-left: 3px solid rgb(0, 122, 170);
      padding-left: 10px;
      margin: 20px 0 12px;
    }
    .article-wrapper h4,
    .article-wrapper h5,
    .article-wrapper h6 {
      font-size: 100%;
      color: rgb(0, 122, 170);
      margin: 16px 0 8px;
    }
    .article-wrapper a { color: orange; word-break: break-word; }
    .article-wrapper blockquote {
      border-left: 4px solid #ddd;
      margin: 1em 0;
      padding: 0.5em 1em;
      color: #666;
      background: #fafafa;
    }
    .article-wrapper table {
      border-collapse: collapse;
      width: max-content;
      max-width: 100%;
      margin: 1em auto;
      table-layout: auto;
      font-size: 0.95em;
      line-height: 1.6;
    }
    .article-wrapper table td,
    .article-wrapper table th {
      border: 1px solid #999;
      padding: 8px 12px;
      vertical-align: middle;
      word-break: break-word;
      overflow-wrap: break-word;
      text-align: left;
    }
    .article-wrapper table th {
      background: #f2f2f2;
      font-weight: 600;
      text-align: center;
    }
    .article-wrapper table tbody tr:nth-child(even) { background: rgba(128,128,128,0.06); }
    .article-wrapper .table-wrapper {
      overflow: visible !important;
      max-width: 100%;
    }
    .article-wrapper ul, .article-wrapper ol { padding-left: 1.5em; }
    .article-wrapper figure { margin: 1.5em auto; text-align: center; }
    .article-wrapper figcaption {
      display: block;
      text-align: center;
      color: #999;
      font-size: 14px;
      margin-top: 8px;
      line-height: 1.5;
    }
    /* Mermaid / Callout / 脚注 / 代码块增强（同步 5.0.2+） */
    .article-wrapper .mermaid-diagram {
      max-width: 100%;
      overflow: visible !important;
      margin: 1.2em 0;
      text-align: center;
    }
    .article-wrapper .mermaid-diagram svg {
      max-width: 100% !important;
      min-width: 0 !important;
      height: auto;
      display: inline-block;
    }
    .article-wrapper .mermaid-source {
      text-align: left;
      white-space: pre-wrap;
    }
    .article-wrapper .callout {
      margin: 1em 0;
      padding: 12px 16px;
      border-left: 4px solid #6b7280;
      border-radius: 4px;
      background: rgba(107,114,128,.1);
    }
    .article-wrapper .callout > strong {
      display: block;
      margin-bottom: 6px;
      color: inherit;
    }
    .article-wrapper .callout > div > :first-child { margin-top: 0; }
    .article-wrapper .callout > div > :last-child { margin-bottom: 0; }
    .article-wrapper .callout-warning { border-color: #d97706; background: rgba(217,119,6,.1); }
    .article-wrapper .callout-danger  { border-color: #dc2626; background: rgba(220,38,38,.1); }
    .article-wrapper .callout-success { border-color: #16a34a; background: rgba(22,163,74,.1); }
    .article-wrapper .callout-tip     { border-color: #2563eb; background: rgba(37,99,235,.1); }
    .article-wrapper .footnotes {
      margin-top: 2.5em;
      font-size: .9em;
      color: #666;
    }
    .article-wrapper .footnotes hr { border: 0; border-top: 1px solid #ddd; }
    .article-wrapper .footnote-ref { font-size: .75em; vertical-align: super; }
    .article-wrapper .footnote-backref { margin-left: 4px; text-decoration: none; }
    .article-wrapper .math-block {
      text-align: center;
      overflow: visible !important;
      margin: 1.2em 0;
      max-width: 100%;
    }
    .article-wrapper .math-inline { display: inline; }
    .article-wrapper pre.mac-code {
      border-radius: 8px;
      background: #f6f8fa;
      border: 1px solid #eaedf0;
      overflow: visible !important;
      margin: 10px 0;
    }
    .article-wrapper pre.mac-code code.hljs {
      padding: 10px 16px !important;
      border: none !important;
      background: none !important;
      white-space: pre-wrap !important;
      word-break: break-word !important;
      overflow-wrap: anywhere !important;
      overflow: visible !important;
    }
    .article-wrapper pre.mac-code .code-line { display: block; }
    .article-wrapper pre.mac-code .code-line-number {
      display: inline-block;
      width: 2.5em;
      margin-right: 1em;
      color: #999;
      text-align: right;
      user-select: none;
    }
    .article-wrapper code:not([class]) {
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
      font-size: 14px;
    }
    .article-wrapper .task-list-item {
      list-style: none;
      margin-left: -1.2em;
      padding-left: 0.2em;
      display: flex;
      align-items: flex-start;
      gap: 6px;
    }
    .article-wrapper .task-checkbox {
      margin-top: 0.35em;
      flex-shrink: 0;
      width: 15px;
      height: 15px;
      accent-color: #07c160;
    }
  </style>
  <style id="theme-style">
    .article-wrapper { background: ${bgColor}; }
    ${scopedThemeCss}
    /* 确保代码块内层 code 不被主题行内 code 边框污染 */
    .article-wrapper pre.mac-code code.hljs {
      border: none !important;
      background: none !important;
    }
    ${gradientTextPrintFix}
  </style>
  <style id="pdf-print-fixes">
    /* 分页防截断保护 */
    .article-wrapper h1,
    .article-wrapper h2,
    .article-wrapper h3,
    .article-wrapper h4,
    .article-wrapper h5,
    .article-wrapper h6 {
      break-after: avoid;
      page-break-after: avoid;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .article-wrapper figure,
    .article-wrapper img,
    .article-wrapper .math-block,
    .article-wrapper .mermaid-diagram,
    .article-wrapper .callout,
    .article-wrapper tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .article-wrapper blockquote {
      break-inside: avoid;
      page-break-inside: avoid;
    }
  </style>
  ${customCss ? `<style id="custom-style">${customCss}</style>` : ''}
</head>
<body>
  <div class="pdf-page-bg"></div>
  ${bodyMarkup}
</body>
</html>`;
}

/**
 * 使用 Playwright Chromium 将渲染好的 HTML 导出为 PDF 文件。
 *
 * @param {{
 *   htmlContent: string,
 *   outFile: string,
 *   executablePath: string,
 *   format?: 'A4'|'Letter'|'continuous',
 *   pageNumbers?: boolean,
 *   bgColor?: string,
 *   timeoutMs?: number,
 *   onProgress?: (msg: string) => void,
 * }} params
 * @returns {Promise<string>} 输出的 PDF 文件路径
 */
async function exportHtmlToPdf(params) {
  const {
    htmlContent,
    outFile,
    executablePath,
    format = 'A4',
    pageNumbers = false,
    bgColor = '#ffffff',
    timeoutMs = 90000,
    onProgress = () => {},
  } = params;

  if (!executablePath) {
    const err = new Error('未找到可用的 Chromium / Chrome 浏览器');
    err.code = 'NO_CHROMIUM';
    throw err;
  }

  const tmpHtml = path.join(os.tmpdir(), `m2a_pdf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.html`);
  fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

  const { chromium } = require('playwright-core');
  let browser = null;
  let timer = null;

  try {
    onProgress('⏳ 正在启动渲染引擎...');
    browser = await Promise.race([
      chromium.launch(launchOptions({
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('启动浏览器超时')), timeoutMs);
      }),
    ]);

    // A4 宽度在 96dpi 下约 794px，Letter 约 816px
    const viewportWidth = format === 'Letter' ? 816 : 794;
    const page = await browser.newPage({
      viewport: { width: viewportWidth, height: 1123 },
      deviceScaleFactor: 2,
    });

    onProgress('⏳ 正在排版与加载字体/图片...');
    await page.goto('file://' + path.resolve(tmpHtml), {
      waitUntil: 'networkidle',
      timeout: Math.min(timeoutMs, 45000),
    });

    // 确保所有 WebFont（特别是 KaTeX 数学字体）与图片解码完毕
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch (_) {}
      }
      const imgs = Array.from(document.querySelectorAll('img'));
      await Promise.all(imgs.map((img) => {
        if (img.complete) return img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
          setTimeout(resolve, 5000);
        });
      }));
    });
    await page.waitForTimeout(200);

    onProgress('⏳ 正在生成 PDF 文件...');
    const outDir = path.dirname(outFile);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    if (format === 'continuous') {
      const contentHeight = await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        return Math.max(
          body ? body.scrollHeight : 0,
          body ? body.offsetHeight : 0,
          html ? html.scrollHeight : 0,
          html ? html.offsetHeight : 0,
          400
        );
      });
      await page.pdf({
        path: outFile,
        width: `${viewportWidth}px`,
        height: `${Math.ceil(contentHeight) + 2}px`,
        printBackground: true,
        margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
      });
    } else {
      const dark = isDarkColor(bgColor);
      const numColor = dark ? '#a6adc8' : '#888888';
      const pdfOpts = {
        path: outFile,
        format: format === 'Letter' ? 'Letter' : 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      };

      if (pageNumbers) {
        pdfOpts.preferCSSPageSize = false;
        pdfOpts.displayHeaderFooter = true;
        pdfOpts.margin = { top: '0mm', right: '0mm', bottom: '12mm', left: '0mm' };
        pdfOpts.headerTemplate = '<span></span>';
        pdfOpts.footerTemplate =
          `<div style="width:100%;height:100%;margin:0;padding:2mm 0 0;background:${bgColor};` +
          `-webkit-print-color-adjust:exact;print-color-adjust:exact;` +
          `font-size:9px;color:${numColor};text-align:center;font-family:system-ui,-apple-system,sans-serif;">` +
          `<span class="pageNumber"></span> / <span class="totalPages"></span></div>`;
      }

      await page.pdf(pdfOpts);
    }

    return outFile;
  } finally {
    if (timer) clearTimeout(timer);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    try { if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml); } catch (_) {}
  }
}

module.exports = {
  scopeThemeCss,
  buildPdfRenderHtml,
  exportHtmlToPdf,
  MARGIN_PRESETS,
  isDarkColor,
};
