'use strict';

const crypto = require('crypto');
const cheerio = require('cheerio');
const { request, multipart, safeUrl, failure } = require('./http');
const { mapImages, coverAsset } = require('./media');

const API = 'https://api.weixin.qq.com';
const DRAFTS = 'https://mp.weixin.qq.com/';
const MB = 1024 * 1024;
// Transport 隔离便于宿主/测试注入；凭据和 token 均不进入 prepared 或媒体缓存。
const tokens = new WeakMap();

function credentials(ctx) {
  const data = ctx.credentials || {};
  if (typeof data.appId !== 'string' || !data.appId.trim() ||
      typeof data.appSecret !== 'string' || !data.appSecret.trim()) {
    throw failure('请配置公众号 AppID 和 AppSecret');
  }
  return data;
}

function stringField(value, label, limit, required = false) {
  if (typeof value !== 'string' || (required && !value.trim())) throw failure(`${label}不能为空或类型无效`);
  if ([...value].length > limit) throw failure(`${label}不能超过 ${limit} 字`);
}

function content(html, final = true) {
  if (typeof html !== 'string' || !html.trim()) throw failure('公众号正文不能为空');
  const $ = cheerio.load(html, null, false);
  if ($('svg').length || $('img').toArray().some(el => /(?:^data:image\/svg\+xml|\.svg(?:[?#]|$))/i.test($(el).attr('src') || ''))) {
    throw failure('公众号官方草稿接口不支持 SVG，请由宿主先转为 PNG/JPEG');
  }
  if ($('img[eeimg]').length) throw failure('请由宿主将公式图片转换为 PNG/JPEG 后提交公众号');
  // 本地路径/data URI 会被映射为上传 URL；输入阶段仅检查去掉待替换地址后的下限。
  // 最终 payload 必须再按实际 HTML 严格检查字符数和 UTF-8 字节数。
  if (!final) $('img').removeAttr('src').removeAttr('srcset').removeAttr('sizes');
  const measured = final ? html : $.html();
  if ([...measured].length >= 20000 || Buffer.byteLength(measured, 'utf8') >= MB) {
    throw failure('公众号正文必须少于 20000 字符且小于 1MB（UTF-8）');
  }
}

function sourceUrl(article, options) {
  return options.sourceUrl === undefined ? (article.sourceUrl || '') : options.sourceUrl;
}

function validate(ctx) {
  credentials(ctx);
  const article = ctx.article || {};
  const options = ctx.options || {};
  stringField(article.title, '公众号标题', 32, true);
  stringField(options.author === undefined ? '' : options.author, '公众号作者', 16);
  stringField(options.digest === undefined ? '' : options.digest, '公众号摘要', 120);
  content(article.html, false);
  if (typeof article.coverPath !== 'string' || !article.coverPath.trim()) throw failure('请选择公众号封面图片');
  for (const key of ['comments', 'fansOnly']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw failure('公众号评论选项必须是布尔值');
  }
  if (options.fansOnly && !options.comments) throw failure('仅粉丝评论需要先开启评论');
  const url = sourceUrl(article, options);
  if (typeof url !== 'string' || Buffer.byteLength(url, 'utf8') > 1024) throw failure('原文地址不能超过 1KB（UTF-8）');
  if (url) {
    let address;
    try { address = new URL(url); } catch (_) { throw failure('原文地址必须是有效的 HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw failure('原文地址必须是无凭证的 HTTP(S) URL');
  }
  return { valid: true };
}

async function fetchJson(ctx, url, options = {}) {
  let response;
  try { response = await (ctx.request || request)(url, { ...options, maxBytes: 8 * MB }); }
  catch (_) { throw failure('微信接口连接失败，提交结果可能未知', false); }
  if (response.status < 200 || response.status >= 300) {
    const error = failure(`微信接口失败（HTTP ${response.status}）`, response.status >= 400 && response.status < 500);
    error.status = response.status;
    throw error;
  }
  let data;
  try { data = JSON.parse(response.body.toString('utf8')); }
  catch (_) { throw failure('微信接口响应无效，提交结果可能未知', false); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('微信接口响应无效，提交结果可能未知', false);
  if (data.errcode !== undefined && Number(data.errcode) !== 0) {
    const code = Number(data.errcode);
    if (!Number.isSafeInteger(code)) throw failure('微信接口响应无效，提交结果可能未知', false);
    // 不携带 errmsg：其中可能含 secret、access_token、请求 URL。
    const error = failure(`微信接口业务失败（errcode ${code}）`);
    error.errcode = code;
    throw error;
  }
  return data;
}

function tokenSlot(ctx) {
  const data = credentials(ctx);
  const transport = ctx.request || request;
  if (!tokens.has(transport)) tokens.set(transport, new Map());
  const cache = tokens.get(transport);
  const key = crypto.createHash('sha256').update(JSON.stringify([data.appId, data.appSecret])).digest('hex');
  return { cache, key, data };
}

async function accessToken(ctx, refresh = false) {
  const { cache, key, data } = tokenSlot(ctx);
  if (refresh) cache.delete(key);
  const previous = cache.get(key);
  if (previous && previous.expiresAt > Date.now()) return previous.token;
  if (previous && previous.pending) return previous.pending;
  const slot = {};
  slot.pending = (async () => {
    const params = new URLSearchParams({ grant_type: 'client_credential', appid: data.appId, secret: data.appSecret });
    const result = await fetchJson(ctx, `${API}/cgi-bin/token?${params}`);
    if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
      throw failure('微信未返回有效的接口凭据');
    }
    const ttl = result.expires_in * 1000;
    slot.token = result.access_token;
    slot.expiresAt = Date.now() + ttl - Math.min(60000, ttl / 10);
    delete slot.pending;
    return slot.token;
  })();
  cache.set(key, slot);
  try { return await slot.pending; }
  catch (error) { if (cache.get(key) === slot) cache.delete(key); throw error; }
}

async function api(ctx, path, options = {}, query = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(ctx, attempt === 1);
    const params = new URLSearchParams({ ...query, access_token: token });
    try { return await fetchJson(ctx, `${API}${path}?${params}`, options); }
    catch (error) {
      // 仅在微信明确拒绝过期/无效 token 时重试；网络错误绝不重放写请求。
      if (attempt === 0 && [40001, 40014, 42001].includes(error.errcode)) continue;
      throw error;
    }
  }
}

async function check(ctx) {
  const result = await api(ctx, '/cgi-bin/draft/count', { method: 'GET' });
  if (!Number.isSafeInteger(result.total_count) || result.total_count < 0) {
    throw failure('微信草稿数量接口未返回有效结果');
  }
  return { appId: credentials(ctx).appId, draftAccess: true, draftCount: result.total_count };
}

function image(asset, cover = false) {
  const allowed = cover ? ['image/jpeg', 'image/png', 'image/gif', 'image/bmp'] : ['image/jpeg', 'image/png'];
  if (!allowed.includes(asset.mimeType)) throw failure(cover ?
    '公众号封面须为 JPG/PNG/GIF/BMP 图片' : '公众号正文图片仅支持 JPG/PNG，请由宿主转换');
  if (!asset.buffer.length || (cover ? asset.buffer.length > 10 * MB : asset.buffer.length >= MB)) {
    throw failure(cover ? '公众号永久封面图片不能超过 10MB' : '公众号正文图片必须小于 1MB');
  }
}

// 微信可能返回 http://mmbiz.qpic.cn/...；只对官方 CDN 做 HTTPS 规范化。
function imageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && (url.hostname === 'mmbiz.qpic.cn' || url.hostname.endsWith('.qpic.cn'))) url.protocol = 'https:';
    if (safeUrl(url.href)) return url.href;
  } catch (_) { /* 使用固定错误，避免泄露带签名的 URL。 */ }
  throw failure('微信上传未返回有效的图片地址');
}

async function prepare(ctx) {
  validate(ctx);
  const article = ctx.article;
  const options = ctx.options || {};
  const cover = await coverAsset(article.coverPath, article.baseDir);
  image(cover, true);
  const rootCache = ctx.mediaCache || (ctx.mediaCache = {});
  const key = `wechat:${credentials(ctx).appId}`;
  const cache = rootCache[key] || (rootCache[key] = {});
  const mapped = await mapImages(article.html, {
    baseDir: article.baseDir, cache, onProgress: ctx.onProgress, saveCache: ctx.saveCache,
    upload: async asset => {
      image(asset);
      const result = await api(ctx, '/cgi-bin/media/uploadimg', { method: 'POST', ...multipart(asset) });
      return { url: imageUrl(result.url) };
    },
  });
  content(mapped.html);
  const coverKey = `cover:${cover.id}`;
  let mediaId = cache[coverKey] && cache[coverKey].mediaId;
  if (typeof mediaId !== 'string' || !mediaId) {
    const result = await api(ctx, '/cgi-bin/material/add_material',
      { method: 'POST', ...multipart(cover) }, { type: 'image' });
    mediaId = result.media_id;
    if (typeof mediaId !== 'string' || !mediaId) throw failure('微信未返回永久封面素材 ID');
    cache[coverKey] = { mediaId };
    if (ctx.saveCache) await ctx.saveCache();
  }
  const payload = { articles: [{
    title: article.title, content: mapped.html, thumb_media_id: mediaId,
    author: options.author || '', digest: options.digest || '',
    content_source_url: sourceUrl(article, options),
    need_open_comment: options.comments ? 1 : 0, only_fans_can_comment: options.fansOnly ? 1 : 0,
  }] };
  return {
    html: mapped.html, payload,
    summary: { title: article.title, images: mapped.count, state: 'draft' }, warnings: [],
  };
}

async function execute(ctx) {
  credentials(ctx);
  const payload = ctx.prepared && ctx.prepared.payload;
  const expected = payload && payload.articles && payload.articles[0];
  if (!expected || payload.articles.length !== 1 || !expected.thumb_media_id) throw failure('请先准备公众号草稿');
  stringField(expected.title, '公众号标题', 32, true);
  content(expected.content);
  const created = await api(ctx, '/cgi-bin/draft/add', { method: 'POST', json: payload });
  if (typeof created.media_id !== 'string' || !created.media_id) throw failure('微信创建响应缺少草稿 ID，请先在后台核对', false);
  const result = { state: 'draft', id: created.media_id, url: DRAFTS };
  try {
    const readback = await api(ctx, '/cgi-bin/draft/get', { method: 'POST', json: { media_id: result.id } });
    const actual = readback.news_item && readback.news_item[0];
    const sources = html => {
      const $ = cheerio.load(html || '', null, false);
      return $('img').toArray().map(el => imageUrl($(el).attr('src')));
    };
    if (!actual || typeof actual.content !== 'string' || actual.title !== expected.title || actual.thumb_media_id !== expected.thumb_media_id ||
        JSON.stringify(sources(actual.content)) !== JSON.stringify(sources(expected.content))) {
      result.warnings = ['草稿已创建，但回读标题、封面或正文图片不一致，请在公众号后台核对；勿重复创建。'];
    }
  } catch (_) {
    result.warnings = ['草稿已创建，但回读确认失败，请凭草稿 ID 在公众号后台核对；勿重复创建。'];
  }
  return result;
}

module.exports = { id: 'wechat', validate, check, prepare, execute };
