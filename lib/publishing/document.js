'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const cheerio = require('cheerio');
const { renderMarkdown, buildWechatCopyHtml } = require('../converter');
const { getTheme } = require('../themes');
const { failure } = require('./http');
const { findChromium, launchOptions, browserErrorMessage } = require('../browser');
const { missingLibraries, installUserLibraries } = require('../browser-setup');

const PLATFORMS = ['wechat', 'zhihu', 'cnblogs'];
const MAX_SVG_BYTES = 8 * 1024 * 1024;
const HTML_TAGS = new Set(('p div span section article header footer h1 h2 h3 h4 h5 h6 ' +
  'a img br hr strong b em i u s del strike sub sup blockquote pre code kbd samp var ' +
  'ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col figure figcaption ' +
  'details summary mark abbr time ruby rt rp wbr math semantics annotation mrow mi mn mo ms ' +
  'mtext mspace mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd ' +
  'menclose mpadded mphantom mstyle mmultiscripts mprescripts none').split(' '));
const SVG_TAGS = new Set(('svg g path defs use symbol rect circle ellipse line polyline polygon ' +
  'text tspan title desc clipPath mask linearGradient radialGradient stop pattern marker').toLowerCase().split(' '));
const ATTRS = /^(?:style|class|id|title|alt|src|href|width|height|display|align|valign|colspan|rowspan|scope|start|type|reversed|datetime|open|dir|lang|role|xmlns|encoding|mathvariant|stretchy|fence|separator|accent|accentunder|columnalign|rowspacing|columnspacing|aria-[\w-]+|data-[\w-]+)$/i;
const ACTIVE = new Set(('script iframe object embed form input button textarea select option ' +
  'base link meta frame frameset applet foreignobject animate animatemotion animatetransform set').split(' '));

function unsafe(what) { throw failure(`发布正文包含不安全内容：${what}`); }

// No stylesheet survives into the preview. Keep inline layout, but exclude resource
// functions and CSS escape tricks before either Juice or Chromium sees the content.
function cleanStyle(style, svg = false) {
  if (/\\|\/\*|\*\/|@|expression\s*\(|(?:-moz-binding|behavior)\s*:|image(?:-set)?\s*\(|var\s*\(/i.test(style)) {
    unsafe('style');
  }
  const withoutFragments = svg ? style.replace(/url\(\s*(['"]?)#[\w:.-]+\1\s*\)/gi, '') : style;
  if (/url\s*\(/i.test(withoutFragments)) unsafe('style url');
  const declarations = new Map();
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 1) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (/^--/.test(key) || !value) continue;
    declarations.set(key, value);
  }
  return [...declarations].map(([key, value]) => `${key}:${value}`).join(';');
}

function safeAddress(value, image = false) {
  const normalized = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  if (/^data:/i.test(normalized)) {
    if (!image || !/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(normalized)) unsafe('data URL');
  } else {
    const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/i);
    if (scheme && !/^(?:https?|file)$/i.test(scheme[1]) &&
        !(!image && /^(?:mailto|tel)$/i.test(scheme[1]))) unsafe('URL 协议');
  }
}

function svgDocument(markup) {
  if (Buffer.byteLength(markup) > MAX_SVG_BYTES) throw failure('SVG 超过大小上限');
  // Standalone SVG exports commonly have an inert XML declaration. Other
  // processing instructions (including xml-stylesheet) must remain forbidden.
  markup = markup.replace(/^\uFEFF?\s*<\?xml\s[^?]*\?>/i, '');
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(markup)) unsafe('SVG XML 声明');
  const $ = cheerio.load(markup, { xmlMode: true }, false);
  if ($.root().children().length !== 1 || $.root().children()[0].name.toLowerCase() !== 'svg') {
    throw failure('无效的 SVG 图片');
  }
  $('*').each((_, node) => {
    const tag = node.name.toLowerCase();
    if (!SVG_TAGS.has(tag)) unsafe(`SVG ${tag}`);
    for (const [name, value] of Object.entries(node.attribs || {})) {
      const key = name.toLowerCase();
      if (/^on/.test(key) || /^(?:src|srcset|xml:base)$/.test(key)) unsafe(`SVG ${key}`);
      if (/(?:^|:)href$/.test(key)) {
        if (!/^#[\w:.-]+$/.test(value)) unsafe('SVG 外部资源');
      }
      if (key === 'style') $(node).attr(name, cleanStyle(value, true));
      if (/url\s*\(/i.test(value) && !/^url\(\s*(['"]?)#[\w:.-]+\1\s*\)$/i.test(value) && key !== 'style') {
        unsafe('SVG 外部资源');
      }
      if (/\\|\/\*/.test(value) && key !== 'd') unsafe('SVG 属性');
    }
  });
  return $.root().html();
}

function decodeSvg(src) {
  if (src.length > MAX_SVG_BYTES * 4) throw failure('SVG 超过大小上限');
  const match = src.match(/^data:image\/svg\+xml((?:;[^,]*)?),(.*)$/is);
  if (!match) throw failure('无效的 SVG data URI');
  try {
    return /;base64(?:;|$)/i.test(match[1])
      ? Buffer.from(match[2], 'base64').toString('utf8') : decodeURIComponent(match[2]);
  } catch (_) { throw failure('无效的 SVG data URI'); }
}

function sanitize(html) {
  const $ = cheerio.load(html, null, false);
  // Validate entire SVG subtrees, including nodes that HTML's allowlist would unwrap.
  $('svg').each((_, node) => { svgDocument($.html(node)); });
  $('*').each((_, node) => {
    const tag = node.name.toLowerCase();
    if (ACTIVE.has(tag)) unsafe(tag);
    if (tag === 'style' || tag === 'noscript' || tag === 'template') { $(node).remove(); return; }
    const inSvg = tag === 'svg' || $(node).parents('svg').length > 0;
    for (const [name, value] of Object.entries(node.attribs || {})) {
      const key = name.toLowerCase();
      if (/^on/.test(key) || key === 'srcdoc') unsafe(key);
      if (key === 'style') $(node).attr(name, cleanStyle(value, inSvg));
      if (key === 'src' || key === 'href' || key === 'xlink:href') safeAddress(value, tag === 'img' && key === 'src');
      if (!inSvg && !ATTRS.test(key)) $(node).removeAttr(name);
    }
    if (tag === 'img' && /^data:image\/svg\+xml[;,]/i.test($(node).attr('src') || '')) {
      const clean = svgDocument(decodeSvg($(node).attr('src')));
      $(node).attr('src', `data:image/svg+xml;base64,${Buffer.from(clean).toString('base64')}`);
    }
    if (!inSvg && !HTML_TAGS.has(tag)) $(node).replaceWith($(node).contents());
  });
  return $.root().html();
}

function localPath(src, baseDir) {
  try { return /^file:/i.test(src) ? fileURLToPath(src) : path.resolve(baseDir, decodeURIComponent(src)); }
  catch (_) { throw failure('无效的本地图片路径'); }
}

// The renderer embeds local images, but intentionally ignores missing files.
// Fail closed here rather than silently publishing a preview with missing images.
async function checkLocalImages(bodyHtml, baseDir) {
  const $ = cheerio.load(bodyHtml, null, false);
  const hash = crypto.createHash('sha256');
  for (const node of $('img').toArray()) {
    const src = ($(node).attr('src') || '').trim();
    if (!src) throw failure('正文图片缺少 src');
    safeAddress(src, true);
    if (/^(?:data:|https?:|\/\/)/i.test(src)) continue;
    try {
      const bytes = await fs.promises.readFile(localPath(src, baseDir));
      hash.update(JSON.stringify([src, bytes.toString('base64')]));
    } catch (_) { throw failure('正文本地图片不存在或无法读取'); }
  }
  return hash.digest('hex');
}

async function coverBytes(src, baseDir) {
  safeAddress(src, true);
  if (/^data:/i.test(src)) {
    const match = src.match(/^data:image\/(?:png|jpe?g|gif|webp);base64,([a-z0-9+/=\s]+)$/i);
    if (!match) throw failure('封面必须是 PNG、JPEG、GIF 或 WebP 图片');
    const bytes = Buffer.from(match[1], 'base64');
    if (!bytes.length) throw failure('封面图片为空');
    return bytes;
  }
  if (/^(?:https?:)?\/\//i.test(src)) throw failure('请选择本地封面图片，以便检查预览是否过期');
  try {
    const bytes = await fs.promises.readFile(localPath(src, baseDir));
    if (!bytes.length) throw new Error('empty');
    return bytes;
  } catch (_) { throw failure('封面图片不存在或无法读取'); }
}

function stableJson(value) {
  return JSON.stringify(value, (_, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
}

function browserExecutable() {
  return findChromium() || undefined;
}

async function downloadSvg(src, redirects = 0) {
  const address = new URL(src.startsWith('//') ? `https:${src}` : src);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) unsafe('SVG URL');
  return new Promise((resolve, reject) => {
    const client = require(address.protocol === 'https:' ? 'https' : 'http');
    const req = client.get(address, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        resolve(downloadSvg(new URL(res.headers.location, address).href, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(failure('SVG 图片下载失败')); return; }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_SVG_BYTES) req.destroy(failure('SVG 超过大小上限'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => reject(failure('SVG 图片下载中断')));
      res.on('aborted', () => reject(failure('SVG 图片下载中断')));
    });
    const timer = setTimeout(() => req.destroy(failure('SVG 图片下载超时')), 20000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(failure('SVG 图片下载失败')));
  });
}

function isSvgImage(src) {
  return /^data:image\/svg\+xml[;,]/i.test(src) || /\.svg(?:[?#]|$)/i.test(src);
}

// One isolated browser per snapshot, created only on the first actual SVG.
function rasterizer(baseDir) {
  let browser;
  let page;
  const cache = new Map();
  return {
    async html(html, { preserveMath = false } = {}) {
      const $ = cheerio.load(html, null, false);
      for (const node of $('svg, img').toArray()) {
        if ($(node).parents('svg').length) continue;
        const element = $(node);
        if (preserveMath && element.closest('[data-math]').length) continue;
        const src = element.attr('src') || '';
        const inline = node.name === 'svg';
        if (!inline && !isSvgImage(src)) continue;
        let markup;
        if (inline) markup = $.html(node);
        else if (/^data:/i.test(src)) markup = decodeSvg(src);
        else if (/^(?:https?:)?\/\//i.test(src)) markup = await downloadSvg(src);
        else markup = await fs.promises.readFile(localPath(src, baseDir), 'utf8');
        markup = svgDocument(markup);
        let result = cache.get(markup);
        if (!result) {
          if (!page) {
            const { chromium } = require('playwright-core');
            try {
              const executablePath = browserExecutable();
              const missing = await missingLibraries(executablePath);
              if (missing.length) {
                const vscode = require('vscode');
                const choice = await vscode.window.showInformationMessage(
                  `公式或 SVG 转图需要浏览器依赖（${missing.slice(0, 3).join('、')}）。是否下载到你的用户目录？不需要 sudo。`,
                  { modal: true }, '自动安装'
                );
                if (choice !== '自动安装') throw failure('已取消安装浏览器依赖');
                await installUserLibraries();
                const stillMissing = await missingLibraries(executablePath);
                if (stillMissing.length) throw failure(`仍缺少系统库：${stillMissing.join('、')}`);
              }
              browser = await chromium.launch(launchOptions({ headless: true, executablePath }));
              const context = await browser.newContext({
                javaScriptEnabled: false, serviceWorkers: 'block', deviceScaleFactor: 2,
                viewport: { width: 1600, height: 1200 },
              });
              await context.route('**/*', route => route.abort());
              page = await context.newPage();
            } catch (error) { throw failure(browserErrorMessage(error)); }
          }
          await page.setContent('<!doctype html><html><head>' +
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">' +
            '</head><body style="margin:0;font-size:16px;color:#222">' + markup + '</body></html>');
          const svg = page.locator('body > svg');
          const box = await svg.boundingBox();
          if (!box || box.width < 0.1 || box.height < 0.1 || box.width > 8192 || box.height > 8192 ||
              box.width * box.height > 16000000) throw failure('SVG 尺寸无效或超过栅格化上限');
          const buffer = await svg.screenshot({ type: 'png', omitBackground: true, animations: 'disabled', timeout: 15000 });
          result = { src: `data:image/png;base64,${buffer.toString('base64')}`, width: box.width, height: box.height };
          cache.set(markup, result);
        }
        const image = $('<img>').attr('src', result.src);
        for (const key of ['width', 'height', 'style', 'display', 'alt', 'title', 'class']) {
          if (element.attr(key) !== undefined) image.attr(key, element.attr(key));
        }
        // Keep ex/em dimensions from MathJax and the original inline/block alignment.
        if (!image.attr('width')) image.attr('width', String(result.width));
        if (!image.attr('height')) image.attr('height', String(result.height));
        // SVG accepts ex/em lengths; HTML image attributes only accept pixels.
        // Preserve those lengths in CSS instead of displaying the PNG at 2x size.
        let style = image.attr('style') || '';
        for (const dimension of ['width', 'height']) {
          const value = image.attr(dimension);
          if (!/^\d+(?:\.\d+)?$/.test(value) && !new RegExp(`(?:^|;)\\s*${dimension}\\s*:`, 'i').test(style)) {
            style += `;${dimension}:${value}`;
          }
        }
        if (image.attr('display') && !/(?:^|;)\s*display\s*:/i.test(style)) style += `;display:${image.attr('display')}`;
        if (style) image.attr('style', cleanStyle(style));
        if (!image.attr('alt')) image.attr('alt', element.closest('[data-formula]').attr('data-formula') || '');
        element.replaceWith(image);
      }
      return $.root().html();
    },
    async close() { if (browser) await browser.close(); },
  };
}

function stripCodeDecorations(html) {
  const $ = cheerio.load(html, null, false);
  // These dots are preview chrome inserted by renderMarkdown, not article content.
  // Keep semantic code without requiring a browser just for decoration.
  $('pre.mac-code > span.mac-dots').remove();
  return $.root().html();
}

function semanticMath(html) {
  const $ = cheerio.load(stripCodeDecorations(html), null, false);
  $('[data-math]').each((_, node) => {
    if ($(node).parents('[data-math]').length) return;
    const converted = buildWechatCopyHtml($.html(node), null, null);
    if (!/<svg[\s>]/i.test(converted)) throw failure('公式无法转换为 SVG，已停止发布以免丢失公式');
    $(node).replaceWith(converted);
  });
  return $.root().html();
}

function compactWechat(html) {
  const $ = cheerio.load(html, null, false);
  $('head, style').remove();
  // Relative sizes/line heights/weights can change meaning when inherited.
  const typography = /^(?:font-family|color|text-align)$/;
  const declarations = style => new Map((style || '').split(';').filter(Boolean).map(part => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon), part.slice(colon + 1)];
  }));
  const common = new Map();
  $('p[style]').each((_, node) => {
    const value = [...declarations($(node).attr('style'))].filter(([key]) => typography.test(key))
      .map(([key, item]) => `${key}:${item}`).join(';');
    if (value) common.set(value, (common.get(value) || 0) + 1);
  });
  const baseline = [...common].sort((a, b) => b[1] - a[1])[0];
  if (baseline && baseline[1] > 1) {
    const section = $('<section>').attr('style', baseline[0]);
    section.append($.root().contents());
    $.root().append(section);
  }
  const effective = new Map();
  $('*').each((_, node) => {
    const element = $(node);
    element.removeAttr('data-source-line').removeAttr('data-tools').removeAttr('data-id');
    // Neutral tags inherit typography. Keep explicit styles on headings, links,
    // strong/code/table etc., whose browser defaults can override inheritance.
    const inherited = effective.get(element.parent()[0]) || new Map();
    const style = element.attr('style');
    const own = declarations(style);
    const neutral = /^(?:p|div|span|section|article|li|figcaption)$/.test(node.name);
    effective.set(node, new Map([...(neutral ? inherited : []), ...[...own].filter(([key]) => typography.test(key))]));
    if (!style) return;
    const kept = [...own].filter(([key, value]) => !neutral || !typography.test(key) || inherited.get(key) !== value)
      .map(([key, value]) => `${key}:${value}`).join(';');
    if (kept) element.attr('style', kept);
    else element.removeAttr('style');
  });
  return $.root().html();
}

/**
 * render=false still renders Markdown in Node to capture local image bytes, but
 * never builds platform HTML or starts a browser. Its fingerprint equals the
 * render=true snapshot, allowing the host to reject a stale preview on submit.
 */
async function snapshot(sourcePath, config = {}, { themeId = 'wechat', render = true } = {}) {
  sourcePath = path.resolve(sourcePath);
  const baseDir = path.dirname(sourcePath);
  // Detach configuration before any asynchronous reads.
  config = JSON.parse(stableJson(config));
  const options = config.options || {};
  if (options.zhihu && options.zhihu.coverPath) throw failure('知乎官方接口不支持独立封面');
  const targets = config.targets === undefined ? PLATFORMS : config.targets;
  if (!Array.isArray(targets) || targets.some(target => !PLATFORMS.includes(target))) throw failure('无效的发布平台');
  const rendered = renderMarkdown(sourcePath);
  const raw = rendered.rawMarkdown === undefined ? fs.readFileSync(sourcePath, 'utf8') : rendered.rawMarkdown;
  const bodyHtml = sanitize(rendered.bodyHtml);
  const localImages = await checkLocalImages(bodyHtml, baseDir);
  const title = config.title || rendered.title;
  const sourceUrl = config.sourceUrl || '';
  if (sourceUrl) safeAddress(sourceUrl);
  const hash = crypto.createHash('sha256');
  // Hash the original renderer output, before sanitization or lossy conversion.
  hash.update(stableJson({ sourcePath, raw, bodyHtml: rendered.bodyHtml, localImages, config, themeId }));
  const covers = {};
  for (const platform of PLATFORMS) {
    const src = platform === 'zhihu' ? '' : (options[platform] || {}).coverPath || config.coverPath || '';
    covers[platform] = src;
    if (src && targets.includes(platform)) {
      if (typeof src !== 'string') throw failure('封面路径必须是字符串');
      const bytes = await coverBytes(src, baseDir);
      hash.update(stableJson([platform, crypto.createHash('sha256').update(bytes).digest('hex')]));
    }
  }
  const result = { sourcePath, baseDir, title, sourceUrl, fingerprint: hash.digest('hex'), platforms: {} };
  for (const platform of PLATFORMS) {
    result.platforms[platform] = {
      title: (options[platform] || {}).title || config.title || rendered.title,
      html: '', baseDir, coverPath: covers[platform], sourceUrl: (options[platform] || {}).sourceUrl || sourceUrl,
    };
  }
  if (!render) return result;
  const raster = rasterizer(baseDir);
  try {
    if (targets.includes('zhihu')) {
      // Preserve the renderer's data-math tree for the official adapter, while
      // ordinary SVG images need PNG bytes for the shared image uploader.
      result.platforms.zhihu.html = sanitize(await raster.html(stripCodeDecorations(bodyHtml), { preserveMath: true }));
    }
    if (targets.includes('wechat')) {
      let wechat = buildWechatCopyHtml(bodyHtml, null, getTheme(themeId));
      // The legacy builder falls back to Zhihu equation URLs on MathJax errors.
      // Publishing must fail explicitly rather than send that fallback to WeChat.
      const $wechat = cheerio.load(wechat, null, false);
      if ($wechat('img').toArray().some(node => /^https:\/\/www\.zhihu\.com\/equation\?tex=/i.test($wechat(node).attr('src') || ''))) {
        throw failure('微信公式转换失败');
      }
      wechat = sanitize(wechat);
      result.platforms.wechat.html = sanitize(compactWechat(await raster.html(wechat)));
    }
    if (targets.includes('cnblogs')) {
      result.platforms.cnblogs.html = sanitize(await raster.html(sanitize(semanticMath(bodyHtml))));
    }
  } finally { await raster.close(); }
  return result;
}

module.exports = { snapshot };
