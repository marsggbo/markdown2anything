'use strict';

const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');
const cheerio = require('cheerio');
const hljs = require('highlight.js');
const juice = require('juice');
const matter = require('gray-matter');
const katex = require('katex');

// ─────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
//  marked 扩展：Block 公式 $$...$$
// ─────────────────────────────────────────────

const blockMathExt = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    const idx = src.indexOf('$$');
    return idx >= 0 ? idx : undefined;
  },
  tokenizer(src) {
    // 匹配 $$...$$ (greedy 最短)
    const match = src.match(/^\$\$([\s\S]+?)\$\$/);
    if (match) {
      return {
        type: 'blockMath',
        raw: match[0],
        math: match[1].trim(),
      };
    }
  },
  renderer(token) {
    try {
      const html = katex.renderToString(token.math, {
        displayMode: true,
        throwOnError: false,
        output: 'html',
        strict: false,
      });
      return (
        `<div class="math-block" data-math="${escapeHtml(token.math)}" data-display="true" style="text-align:center;overflow-x:auto;` +
        `margin:1.2em 0;padding:0.5em 0;">${html}</div>\n`
      );
    } catch (e) {
      return `<pre><code class="math">${escapeHtml(token.math)}</code></pre>\n`;
    }
  },
};

// ─────────────────────────────────────────────
//  marked 扩展：Inline 公式 $...$
// ─────────────────────────────────────────────

const inlineMathExt = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    // 找到下一个单 $ 的位置（跳过 $$）
    let i = src.indexOf('$');
    while (i !== -1 && src[i + 1] === '$') {
      i = src.indexOf('$', i + 2);
    }
    return i >= 0 ? i : undefined;
  },
  tokenizer(src) {
    // 必须以单 $ 开头（不是 $$）
    if (src.startsWith('$$')) return undefined;
    const match = src.match(/^\$([^\$\n]+?)\$/);
    if (match) {
      return {
        type: 'inlineMath',
        raw: match[0],
        math: match[1],
      };
    }
  },
  renderer(token) {
    try {
      const html = katex.renderToString(token.math, {
        displayMode: false,
        throwOnError: false,
        output: 'html',
        strict: false,
      });
      return `<span class="math-inline" data-math="${escapeHtml(token.math)}">${html}</span>`;
    } catch (e) {
      return `<code class="math">${escapeHtml(token.math)}</code>`;
    }
  },
};

// ─────────────────────────────────────────────
//  创建 marked 实例（不污染全局）
// ─────────────────────────────────────────────

const markedInstance = new Marked();

markedInstance.use({
  gfm: true,
  breaks: false,
  extensions: [blockMathExt, inlineMathExt],
  renderer: {
    // 任务列表（GFM task list）：移除 disabled，使复选框可交互
    listitem(text, task, checked) {
      if (task) {
        // marked 会在 text 里自动插入 <input disabled ...>，先剥离它
        const cleanText = text.replace(/<input\b[^>]*>/i, '').trim();
        return `<li class="task-list-item"><input type="checkbox" class="task-checkbox"${checked ? ' checked' : ''}> ${cleanText}</li>\n`;
      }
      return `<li>${text}</li>\n`;
    },
    // 图片渲染：支持 caption（alt 文本作为说明文字）
    image(href, title, text) {
      const alt = text || '';
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const imgStyle =
        'max-width:100%;display:block;margin:0 auto;';
      const img = `<img src="${href}" alt="${escapeHtml(alt)}"${titleAttr} style="${imgStyle}">`;

      const captionStyle =
        'display:block;text-align:center;color:#999;font-size:14px;' +
        'margin-top:8px;line-height:1.5;font-style:normal;';
      const figStyle = 'margin:1.5em auto;text-align:center;';

      if (alt) {
        return (
          `<figure style="${figStyle}">` +
          img +
          `<figcaption style="${captionStyle}">${alt}</figcaption>` +
          `</figure>\n`
        );
      }
      return `<figure style="${figStyle}">${img}</figure>\n`;
    },
  },
});

// ─────────────────────────────────────────────
//  图片转 Base64
// ─────────────────────────────────────────────

function convertImagesToBase64($, baseDir) {
  $('img').each((_, elem) => {
    const img = $(elem);
    const src = img.attr('src');
    if (!src || src.startsWith('data:') || /^https?:\/\//.test(src) || src.startsWith('//')) {
      return;
    }
    const imagePath = path.isAbsolute(src)
      ? path.join(baseDir, src)
      : path.resolve(baseDir, src);
    try {
      if (!fs.existsSync(imagePath)) return;
      const buf = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
      };
      const mime = mimeMap[ext] || 'image/jpeg';
      img.attr('src', `data:${mime};base64,${buf.toString('base64')}`);
    } catch (_) {
      // 忽略，继续处理
    }
  });
}

// ─────────────────────────────────────────────
//  代码块高亮（macOS 风格）
// ─────────────────────────────────────────────

function enhanceCodeBlocks($) {
  const hlCssPath = require.resolve('highlight.js/styles/github.css');
  const hlCss = fs.readFileSync(hlCssPath, 'utf8');

  if ($('head').length === 0) $('html').prepend('<head></head>');
  $('head').append(`<style>${hlCss}</style>`);

  const macStyle = `
    pre.mac-code {
      font-size: 90%; overflow-x: auto; border-radius: 8px;
      padding: 0 !important; line-height: 1.5; margin: 10px 8px;
      background-color: #f6f8fa; border: 1px solid #eaedf0;
    }
    .mac-dots { display: block; margin: 12px 16px 0; }
    pre.mac-code code.hljs {
      display: -webkit-box; padding: 0.5em 1em 1em;
      overflow-x: auto; text-indent: 0; color: inherit;
      background: none; white-space: nowrap; margin: 0;
    }
  `;
  $('head').append(`<style>${macStyle}</style>`);

  const svgDots =
    `<svg width="52" height="12" viewBox="0 0 52 12" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="6" cy="6" r="6" fill="#FF5F56"/>` +
    `<circle cx="26" cy="6" r="6" fill="#FFBD2E"/>` +
    `<circle cx="46" cy="6" r="6" fill="#27C93F"/></svg>`;

  $('pre').each((_, elem) => {
    const pre = $(elem);
    const code = pre.find('code');
    if (code.length === 0 || pre.hasClass('mac-code')) return;

    const rawCode = code.text();
    let language = 'plaintext';
    const classes = (pre.attr('class') || '') + ' ' + (code.attr('class') || '');
    const langMatch = classes.match(/language-([\w-]+)/);
    if (langMatch && hljs.getLanguage(langMatch[1])) {
      language = langMatch[1];
    }

    let highlighted;
    try {
      highlighted = hljs.highlight(rawCode, { language }).value;
    } catch (_) {
      highlighted = hljs.highlightAuto(rawCode).value;
    }

    // 换行和空格兼容微信
    highlighted = highlighted.replace(/(<[^>]+>)|([^<]+)/g, (m, tag, txt) => {
      if (tag) return tag;
      return txt.replace(/\r\n|\r|\n/g, '<br>').replace(/ /g, '&nbsp;');
    });

    pre.replaceWith(
      `<pre class="mac-code"><span class="mac-dots">${svgDots}</span>` +
      `<code class="hljs ${language}">${highlighted}</code></pre>`
    );
  });
}

// ─────────────────────────────────────────────
//  核心渲染函数：Markdown → 文章 body HTML
// ─────────────────────────────────────────────

/**
 * 解析 Markdown 文件，返回文章 body HTML + 元数据。
 * @param {string} mdFilePath 绝对路径
 * @returns {{ bodyHtml: string, title: string, rawMarkdown: string }}
 */
function renderMarkdown(mdFilePath) {
  const fullPath = path.isAbsolute(mdFilePath)
    ? mdFilePath
    : path.join(process.cwd(), mdFilePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Markdown 文件不存在: ${fullPath}`);
  }

  const raw = fs.readFileSync(fullPath, 'utf8');
  const { content: mdContent, data: frontmatter } = matter(raw);

  // Markdown → HTML
  const parsedHtml = markedInstance.parse(mdContent);

  // cheerio 处理
  const $ = cheerio.load(parsedHtml, { decodeEntities: false });
  const baseDir = path.dirname(fullPath);

  convertImagesToBase64($, baseDir);
  enhanceCodeBlocks($);

  // 提取 body HTML（去掉 cheerio 自动包裹的 <html><body> 等标签）
  const bodyHtml = $('body').html() || $.html();

  // 从 frontmatter 或第一个 h1 提取标题
  let title = frontmatter.title || '';
  if (!title) {
    const firstH1 = $('h1').first().text();
    title = firstH1 || path.basename(fullPath, '.md');
  }

  return { bodyHtml, title, rawMarkdown: raw };
}

// ─────────────────────────────────────────────
//  构建完整 HTML（供导出/保存用）
// ─────────────────────────────────────────────

/**
 * 将 body HTML 包裹进模板并内联 CSS（for WeChat 粘贴）。
 * @param {string} bodyHtml
 * @param {string} templatePath
 * @returns {string} 完整 HTML
 */
function buildFullHtml(bodyHtml, templatePath) {
  let template = fs.readFileSync(templatePath, 'utf8');
  template = template.replace('{{body}}', bodyHtml);

  const $ = cheerio.load(template, { decodeEntities: false });

  // 加入 KaTeX CSS（去掉 @font-face，避免字体路径问题）
  const katexCssPath = require.resolve('katex/dist/katex.min.css');
  const katexCss = fs.readFileSync(katexCssPath, 'utf8')
    .replace(/@font-face\s*\{[\s\S]*?\}/g, '');
  $('head').append(`<style>${katexCss}</style>`);

  let processedHtml = $.html();

  // juice 内联 CSS（保留 &nbsp; 和 <br>）
  const NBSP = '\u200B__NBSP__\u200B';
  const BR = '\u200B__BR__\u200B';
  processedHtml = processedHtml
    .replace(/&nbsp;/g, NBSP)
    .replace(/<br\s*\/?>/gi, BR);

  let finalHtml = juice(processedHtml, {
    removeStyleTags: false,
    applyStyleTags: true,
    preserveImportant: true,
  });

  finalHtml = finalHtml
    .replace(new RegExp(NBSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '&nbsp;')
    .replace(new RegExp(BR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<br>');

  return finalHtml;
}

// ─────────────────────────────────────────────
//  高级入口：一步完成转换并写文件
// ─────────────────────────────────────────────

/**
 * @param {string} mdFilePath
 * @param {string} templatePath
 * @param {string} outputPath
 * @returns {string} 输出文件路径
 */
function convertMarkdownToWeChat(mdFilePath, templatePath, outputPath) {
  const { bodyHtml } = renderMarkdown(mdFilePath);
  const finalHtml = buildFullHtml(bodyHtml, templatePath);

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, finalHtml, 'utf8');
  return outputPath;
}

// ─────────────────────────────────────────────
//  构建小红书截图用 HTML（供 Playwright 渲染）
// ─────────────────────────────────────────────

/**
 * 生成一个完全独立的 HTML 文件，供 Playwright 截图。
 * - 内嵌 KaTeX CSS（带 base64 字体）
 * - 内嵌 highlight.js CSS
 * - 本地图片转 base64；远程图片保持原 URL（Playwright 可直接加载）
 * - 应用主题 CSS
 * @param {string} bodyHtml - renderMarkdown 返回的 bodyHtml
 * @param {string} baseDir  - MD 文件所在目录（用于解析本地图片路径）
 * @param {object} theme    - THEMES 中的主题对象
 * @returns {string} 完整 HTML 字符串
 */
function buildXhsRenderHtml(bodyHtml, baseDir, theme) {
  // 1. KaTeX CSS（带 base64 字体）
  const katexCssPath = require.resolve('katex/dist/katex.min.css');
  const katexDir     = path.dirname(katexCssPath);
  let katexCss = fs.readFileSync(katexCssPath, 'utf8');
  // 将字体 url(...) 替换为 base64 data URI
  katexCss = katexCss.replace(/url\(([^)]+)\)/g, (match, fontRef) => {
    const fontFile = fontRef.replace(/['"]/g, '');
    if (fontFile.startsWith('data:')) return match; // 已经是 data URI
    const fontPath = path.join(katexDir, fontFile);
    if (!fs.existsSync(fontPath)) return match;
    const ext = path.extname(fontFile).slice(1).toLowerCase();
    const mimeMap = { woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject' };
    const mime = mimeMap[ext] || 'font/woff2';
    const b64 = fs.readFileSync(fontPath).toString('base64');
    return `url(data:${mime};base64,${b64})`;
  });

  // 2. highlight.js CSS
  const hlCssPath = require.resolve('highlight.js/styles/github.min.css');
  const hlCss = fs.readFileSync(hlCssPath, 'utf8');

  // 3. 本地图片转 base64
  const $ = cheerio.load(bodyHtml, { decodeEntities: false });
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src || src.startsWith('data:') || /^https?:\/\//.test(src)) return;
    const imgPath = path.isAbsolute(src) ? src : path.join(baseDir, src);
    if (!fs.existsSync(imgPath)) return;
    const ext = path.extname(imgPath).slice(1).toLowerCase();
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
    const mime = mimeMap[ext] || 'image/png';
    const b64 = fs.readFileSync(imgPath).toString('base64');
    $(el).attr('src', `data:${mime};base64,${b64}`);
  });
  const processedBody = $.html();

  // 4. 主题 CSS（wrapperBg 作为背景色）
  const themeCss = theme ? theme.css || '' : '';
  const bgColor  = theme ? (theme.wrapperBg || '#ffffff') : '#ffffff';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: ${bgColor};
      margin: 0;
      padding: 0;
    }
    .article-wrapper {
      width: 100%;
      padding: 32px 28px;
      background: ${bgColor};
      font-family: system-ui, -apple-system, BlinkMacSystemFont,
        'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB',
        'Microsoft YaHei UI', 'Microsoft YaHei', Arial, sans-serif;
      font-size: 16px;
      line-height: 1.75;
      color: #3f3f3f;
    }
    /* ── 文章基础样式 ── */
    .article-wrapper p { margin: 1.3em 0; }
    .article-wrapper img { max-width: 100%; display: block; margin: 0 auto; }
    .article-wrapper strong { font-weight: 600; color: rgb(0, 122, 170); }
    .article-wrapper a { color: orange; }
    .article-wrapper h1 { font-size: 140%; color: #de7456; text-align: center; font-weight: normal; margin: 0.8em 0; }
    .article-wrapper h2 { font-size: 120%; font-weight: bold; color: #de7456; text-align: center; line-height: 2; border-bottom: 1px solid #de7456; margin: 1em 0; padding-bottom: 4px; }
    .article-wrapper h3 { font-size: 110%; color: rgb(0, 122, 170); border-left: 3px solid rgb(0, 122, 170); padding-left: 10px; margin: 1em 0; }
    .article-wrapper h4, .article-wrapper h5, .article-wrapper h6 { font-size: 100%; color: #555; margin: 0.8em 0; }
    .article-wrapper blockquote { border-left: 4px solid #ddd; margin: 1em 0; padding: 0.5em 1em; color: #666; background: #fafafa; }
    .article-wrapper table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    .article-wrapper table td, .article-wrapper table th { border: 1px solid #999; padding: 8px; }
    .article-wrapper table th { background: #f2f2f2; font-weight: bold; text-align: center; }
    .article-wrapper ul, .article-wrapper ol { padding-left: 1.5em; }
    .article-wrapper li { margin: 0.3em 0; }
    .article-wrapper figure { margin: 1.5em auto; text-align: center; }
    .article-wrapper figcaption { text-align: center; color: #999; font-size: 14px; margin-top: 8px; }
    .article-wrapper code:not([class]) { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 14px; }
    .article-wrapper pre.mac-code { border-radius: 8px; background: #f6f8fa; border: 1px solid #eaedf0; overflow-x: auto; margin: 10px 0; }
    .article-wrapper pre.mac-code code.hljs { padding: 10px 16px; display: block; }
    .article-wrapper .math-block { text-align: center; overflow-x: auto; margin: 1.2em 0; }
    .article-wrapper .math-inline { display: inline; }
    ${themeCss}
  </style>
  <style>${katexCss}</style>
  <style>${hlCss}</style>
</head>
<body>
  <div class="article-wrapper">${processedBody}</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────
//  MathJax SVG 渲染（微信复制专用，纯路径无字体依赖）
// ─────────────────────────────────────────────

let _mjxState = null;

function getMjxState() {
  if (_mjxState) return _mjxState;
  const { mathjax }         = require('mathjax-full/js/mathjax.js');
  const { TeX }             = require('mathjax-full/js/input/tex.js');
  const { SVG }             = require('mathjax-full/js/output/svg.js');
  const { liteAdaptor }     = require('mathjax-full/js/adaptors/liteAdaptor.js');
  const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
  const { AllPackages }     = require('mathjax-full/js/input/tex/AllPackages.js');

  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);

  _mjxState = {
    adaptor,
    doc: mathjax.document('', {
      InputJax: new TeX({ packages: AllPackages }),
      OutputJax: new SVG({ fontCache: 'none' }),
    }),
  };
  return _mjxState;
}

function mathToSvg(latex, displayMode) {
  const { doc, adaptor } = getMjxState();
  const node = doc.convert(latex, { display: displayMode, em: 16, ex: 8, containerWidth: 600 });
  const outerHtml = adaptor.outerHTML(node);
  // 提取 <svg>...</svg>（去掉 mjx-container 包装），保证 data URI 是合法 SVG 文档
  const svgMatch = outerHtml.match(/<svg[\s\S]*<\/svg>/);
  if (!svgMatch) throw new Error('MathJax 未能生成 SVG');
  return svgMatch[0];
}

// ─────────────────────────────────────────────
//  微信复制专用 HTML（公式转 SVG，其余内联 CSS）
// ─────────────────────────────────────────────

/**
 * 将 bodyHtml 处理成微信编辑器可直接粘贴的 HTML 片段。
 * 关键：把 KaTeX CSS 通过 juice 内联到每个元素的 style 属性，
 * 这样复制到微信时公式布局不依赖外部样式表。
 * 字体文件转为 base64 data URL，避免路径失效。
 * @param {string} bodyHtml
 * @param {string|null} templatePath
 * @param {{ css?: string, wrapperBg?: string }|null} theme
 * @returns {string} 适合粘贴的 HTML 片段
 */
function buildWechatCopyHtml(bodyHtml, templatePath, theme) {
  // 用一个带 id 的容器包裹，方便最后只取 body 内容
  const $ = cheerio.load(
    `<html><head></head><body><div id="wechat-body">${bodyHtml}</div></body></html>`,
    { decodeEntities: false },
  );

  // 0. 将 KaTeX HTML 替换为 MathJax SVG img（WeChat 会剥离 position/top CSS，KaTeX 依赖这些）
  $('[data-math]').each((_, elem) => {
    const $el = $(elem);
    const latex = $el.attr('data-math');
    const isDisplay = $el.attr('data-display') === 'true';
    try {
      const svgStr = mathToSvg(latex, isDisplay);
      const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svgStr, 'utf8').toString('base64');
      if (isDisplay) {
        $el.replaceWith(
          `<div style="text-align:center;overflow-x:auto;margin:1.2em 0;">` +
          `<img src="${dataUri}" style="max-width:100%;display:block;margin:0 auto;" alt="${escapeHtml(latex)}"></div>`
        );
      } else {
        const vaMatch = svgStr.match(/style="[^"]*vertical-align:\s*(-?[\d.]+\w*)/);
        const va = vaMatch ? vaMatch[1] : '-0.1em';
        $el.replaceWith(
          `<img src="${dataUri}" style="display:inline-block;vertical-align:${va};" alt="${escapeHtml(latex)}">`
        );
      }
    } catch (_) { /* 降级：保留 KaTeX HTML，juice 会尝试内联 CSS */ }
  });

  // 1. 注入模板里的 <style>
  if (templatePath && fs.existsSync(templatePath)) {
    const $tmpl = cheerio.load(fs.readFileSync(templatePath, 'utf8'), { decodeEntities: false });
    $tmpl('style').each((_, el) => {
      $('head').append($tmpl.html(el));
    });
  }

  // 1b. 注入主题 CSS（覆盖模板默认样式）
  if (theme && theme.css) {
    $('head').append(`<style>${theme.css}</style>`);
  }

  // 2. 注入 KaTeX CSS，字体转 base64（避免路径问题）
  const katexCssPath = require.resolve('katex/dist/katex.min.css');
  const katexCssDir = path.dirname(katexCssPath);
  let katexCss = fs.readFileSync(katexCssPath, 'utf8');

  katexCss = katexCss.replace(/url\(["']?([^)"'\s]+)["']?\)/g, (match, url) => {
    if (url.startsWith('data:')) return match;
    const fontPath = path.resolve(katexCssDir, url);
    try {
      if (fs.existsSync(fontPath)) {
        const ext = path.extname(fontPath).toLowerCase();
        const mimeMap = {
          '.woff2': 'font/woff2',
          '.woff': 'font/woff',
          '.ttf': 'font/ttf',
        };
        const mime = mimeMap[ext] || 'application/octet-stream';
        const base64 = fs.readFileSync(fontPath).toString('base64');
        return `url(data:${mime};base64,${base64})`;
      }
    } catch (_) {}
    return match;
  });

  $('head').append(`<style>${katexCss}</style>`);

  // 3. juice 内联 CSS
  let processedHtml = $.html();
  const NBSP = '\u200B__NBSP__\u200B';
  const BR   = '\u200B__BR__\u200B';
  processedHtml = processedHtml
    .replace(/&nbsp;/g, NBSP)
    .replace(/<br\s*\/?>/gi, BR);

  let finalHtml = juice(processedHtml, {
    removeStyleTags: false,
    applyStyleTags: true,
    preserveImportant: true,
  });

  finalHtml = finalHtml
    .replace(new RegExp(NBSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '&nbsp;')
    .replace(new RegExp(BR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<br>');

  // 4. 只返回文章内容片段（去掉 <html><body> 包裹）
  const $final = cheerio.load(finalHtml, { decodeEntities: false });
  return $final('#wechat-body').html() || $final('body').html() || finalHtml;
}

// ─────────────────────────────────────────────
//  知乎复制专用 HTML（保留 KaTeX HTML，内联 CSS）
// ─────────────────────────────────────────────

/**
 * 将 bodyHtml 处理成知乎编辑器可直接粘贴的 HTML 片段。
 * 公式用知乎自带的公式图片服务渲染（https://www.zhihu.com/equation?tex=...），
 * 图片由知乎 CDN 托管，粘贴时不会被拒绝。
 * @param {string} bodyHtml
 * @param {string|null} templatePath
 * @param {{ css?: string }|null} theme
 * @returns {string}
 */
function buildZhihuCopyHtml(bodyHtml, templatePath, theme) {
  const $ = cheerio.load(
    `<html><head></head><body><div id="zhihu-body">${bodyHtml}</div></body></html>`,
    { decodeEntities: false },
  );

  // 0. 将公式替换为知乎公式图片（使用知乎自家的 eeimg="1" 标记，不依赖 CSS）
  //    inline:  <img eeimg="1" alt="..." src="...">
  //    block :  <img eeimg="1" alt="\\..." src="..."> (alt 以 \\ 开头表示 block)
  $('[data-math]').each((_, elem) => {
    const $el = $(elem);
    const latex = $el.attr('data-math');
    const isDisplay = $el.attr('data-display') === 'true';
    if (isDisplay) {
      const encodedTex = encodeURIComponent(latex);
      const imgUrl = `https://www.zhihu.com/equation?tex=${encodedTex}`;
      // alt 以 \\ 开头是知乎块公式约定
      $el.replaceWith(
        `<p><img eeimg="1" src="${imgUrl}" alt="\\\\${escapeHtml(latex)}"></p>`
      );
    } else {
      const encodedTex = encodeURIComponent(latex);
      const imgUrl = `https://www.zhihu.com/equation?tex=${encodedTex}`;
      // 行内：包在 <span> 中（不是 <p>），不加任何样式，只靠 eeimg 标记
      $el.replaceWith(
        `<img eeimg="1" src="${imgUrl}" alt="${escapeHtml(latex)}">`
      );
    }
  });

  // 1. 注入模板样式
  if (templatePath && fs.existsSync(templatePath)) {
    const $tmpl = cheerio.load(fs.readFileSync(templatePath, 'utf8'), { decodeEntities: false });
    $tmpl('style').each((_, el) => $('head').append($tmpl.html(el)));
  }

  // 2. 注入主题 CSS
  if (theme && theme.css) {
    $('head').append(`<style>${theme.css}</style>`);
  }

  // 3. juice 内联 CSS（SVG 内部不需要 KaTeX CSS，路径已内联到路径数据）
  let html = $.html();
  const NBSP = '\u200B__NBSP__\u200B';
  const BR   = '\u200B__BR__\u200B';
  html = html.replace(/&nbsp;/g, NBSP).replace(/<br\s*\/?>/gi, BR);

  let final = juice(html, {
    removeStyleTags: false,
    applyStyleTags: true,
    preserveImportant: true,
  });

  final = final
    .replace(new RegExp(NBSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '&nbsp;')
    .replace(new RegExp(BR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<br>');

  const $f = cheerio.load(final, { decodeEntities: false });
  return $f('#zhihu-body').html() || $f('body').html() || final;
}

module.exports = {
  renderMarkdown,
  buildFullHtml,
  buildWechatCopyHtml,
  buildZhihuCopyHtml,
  convertMarkdownToWeChat,
  buildXhsRenderHtml,
};
