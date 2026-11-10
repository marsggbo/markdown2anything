'use strict';

// 上传文件与正文引用分离：同一内容只上传一次，每个 img 始终保留自己的位置和属性。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { fileURLToPath } = require('url');
const cheerio = require('cheerio');

const REF_ATTR = 'data-m2a-image-ref';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

function isZhihuImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'zhimg.com' || url.hostname.endsWith('.zhimg.com'));
  } catch (_) { return false; }
}

function isEquation(img) {
  if (!img.attr('eeimg')) return false;
  try {
    const url = new URL(img.attr('src'), 'https://www.zhihu.com');
    return url.protocol === 'https:' && url.hostname === 'www.zhihu.com' &&
      url.pathname === '/equation';
  } catch (_) { return false; }
}

function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'];
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return ['image/jpeg', 'jpg'];
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString())) return ['image/gif', 'gif'];
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') {
    return ['image/webp', 'webp'];
  }
  throw new Error('不支持或无效的图片格式，请使用 PNG、JPEG、GIF 或 WebP');
}

function download(url, { timeoutMs = 20000, maxBytes = MAX_BYTES } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let address;
    try {
      address = new URL(url);
      if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
        throw new Error('图片地址必须使用 HTTP(S)，且不能包含登录凭证');
      }
    } catch (err) { reject(err); return; }
    const client = address.protocol === 'https:' ? https : http;
    const req = client.get(address, { headers: { 'User-Agent': 'Markdown2Anything' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) { reject(new Error('图片重定向次数过多')); return; }
        let next;
        try { next = new URL(res.headers.location, address).href; }
        catch (err) { reject(err); return; }
        resolve(download(next, { timeoutMs, maxBytes }, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`图片下载失败（HTTP ${res.statusCode}）`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error('图片超过大小上限')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('图片下载中断')));
    });
    // 总时限也覆盖持续发送少量数据的响应。
    const timer = setTimeout(() => req.destroy(new Error('图片下载超时')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

async function readImage(src, baseDir, options) {
  if (/^data:/i.test(src)) {
    const match = src.match(/^data:image\/[^;,]+;base64,([a-z0-9+/=\s]+)$/i);
    if (!match) throw new Error('图片 data URI 必须是有效的 base64 图片');
    if (match[1].length > Math.ceil(options.maxBytes / 3) * 4 + 1024) throw new Error('图片超过大小上限');
    return Buffer.from(match[1], 'base64');
  }
  if (/^(https?:)?\/\//i.test(src)) return download(src.startsWith('//') ? `https:${src}` : src, options);
  const file = src.startsWith('file:') ? fileURLToPath(src) : path.resolve(baseDir, decodeURIComponent(src));
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error('图片路径不是文件');
  if (stat.size > options.maxBytes) throw new Error('图片超过大小上限');
  return fs.promises.readFile(file);
}

async function prepareImages(html, {
  baseDir = process.cwd(), maxBytes = MAX_BYTES, timeoutMs = 20000,
  maxTotalBytes = MAX_TOTAL_BYTES, maxReferences = 500,
  reuseUrl = isZhihuImageUrl,
} = {}) {
  const $ = cheerio.load(html, null, false);
  const references = [];
  const assets = new Map();
  const sources = new Map();
  let totalBytes = 0;
  // 不接受上游传入的内部编号。
  $(`[${REF_ATTR}]`).removeAttr(REF_ATTR);
  for (const element of $('img').toArray()) {
    const img = $(element);
    if (isEquation(img)) continue;
    const index = references.length;
    if (index >= maxReferences) throw new Error(`正文图片引用超过上限（${maxReferences} 处）`);
    const id = `image-${index}`;
    const src = (img.attr('src') || '').trim();
    const ref = { id, index };
    try {
      if (!src) throw new Error('图片缺少 src');
      if (reuseUrl(src)) {
        ref.url = src;
      } else {
        let assetId = sources.get(src);
        if (!assetId) {
          const buffer = await readImage(src, baseDir, { maxBytes, timeoutMs });
          if (!buffer.length || buffer.length > maxBytes) throw new Error('图片为空或超过大小上限');
          const [mimeType, ext] = imageType(buffer);
          assetId = crypto.createHash('sha256').update(buffer).digest('hex');
          if (!assets.has(assetId)) {
            totalBytes += buffer.length;
            if (totalBytes > maxTotalBytes) throw new Error('正文图片总大小超过上限');
            assets.set(assetId, { id: assetId, buffer, mimeType, name: `${assetId}.${ext}`, indexes: [] });
          }
          sources.set(src, assetId);
        }
        ref.assetId = assetId;
        assets.get(assetId).indexes.push(index);
      }
    } catch (err) {
      // 不把 data URI、签名 URL 或正文内容写进错误日志。
      throw new Error(`第 ${index + 1} 处图片准备失败：${err.code || err.message}`);
    }
    references.push(ref);
    img.attr(REF_ATTR, id);
  }
  return { html: $.html(), references, assets: [...assets.values()] };
}

function completeImages(plan, uploaded) {
  const $ = cheerio.load(plan.html, null, false);
  for (const ref of plan.references) {
    const url = ref.url || uploaded.get(ref.assetId);
    if (!isZhihuImageUrl(url)) throw new Error(`第 ${ref.index + 1} 处图片尚未确认上传成功`);
    const img = $(`img[${REF_ATTR}="${ref.id}"]`);
    if (img.length !== 1) throw new Error(`第 ${ref.index + 1} 处图片引用不完整`);
    img.attr('src', url).removeAttr('srcset').removeAttr('sizes').removeAttr(REF_ATTR);
  }
  return $.html();
}

async function uploadImages(plan, upload, { cache = {}, onProgress } = {}) {
  const uploaded = new Map();
  let reused = 0;
  let done = plan.references.filter(ref => ref.url).length;
  for (const asset of plan.assets) {
    // v2 key 与旧版“猜测 URL”缓存隔离；调用方还必须按账号隔离 cache。
    const key = `verified-v2:${asset.id}`;
    let url = cache[key];
    if (isZhihuImageUrl(url)) {
      reused += asset.indexes.length;
    } else {
      try {
        url = await upload(asset);
        if (!isZhihuImageUrl(url)) throw new Error('上传未返回有效的知乎图片地址');
      } catch (err) {
        const indexes = asset.indexes.map(i => i + 1).join('、');
        const error = new Error(`第 ${indexes} 处图片上传失败：${err.message}`);
        error.code = 'IMAGE_UPLOAD_FAILED';
        throw error;
      }
      cache[key] = url;
    }
    uploaded.set(asset.id, url);
    done += asset.indexes.length;
    if (onProgress) onProgress(done, plan.references.length, 0);
  }
  return { html: completeImages(plan, uploaded), total: plan.references.length, failed: 0, errors: [], reused };
}

function imageSources(html) {
  const $ = cheerio.load(html, null, false);
  return $('img').toArray().filter(el => !isEquation($(el))).map(el => $(el).attr('src') || '');
}

function contentSignature(html) {
  const $ = cheerio.load(html, null, false);
  function visit(node) {
    if (node.type === 'text') return node.data;
    if (node.name === 'img') return isEquation($(node)) ? '' : `\ufffc${$(node).attr('src')}\ufffc`;
    return (node.children || []).map(visit).join('');
  }
  return visit($.root()[0]).replace(/[\s\u200b\ufeff]/g, '');
}

module.exports = { prepareImages, completeImages, uploadImages, imageSources, contentSignature, isZhihuImageUrl };
