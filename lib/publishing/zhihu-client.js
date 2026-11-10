'use strict';

const crypto = require('crypto');
const { request, safeUrl, failure } = require('./http');

const ORIGIN = 'https://openapi.zhihu.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 8192;
const MAX_MESSAGE_LENGTH = 300;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function credentials(ctx) {
  const creds = ctx.credentials || {};
  if (typeof creds.appKey !== 'string' || !creds.appKey.trim() ||
      /[\x00-\x1f\x7f]/.test(creds.appKey) ||
      typeof creds.appSecret !== 'string' || !creds.appSecret.trim()) {
    throw failure('请配置知乎官方 appKey 和 appSecret');
  }
  return creds;
}

function authHeaders(ctx) {
  const { appKey, appSecret } = credentials(ctx);
  const ts = String(Math.floor(Date.now() / 1000));
  const logId = `req_${crypto.randomBytes(16).toString('hex')}`;
  const extra = '';
  const sign = crypto.createHmac('sha256', appSecret)
    .update(`app_key:${appKey}|ts:${ts}|logid:${logId}|extra_info:${extra}`).digest('base64');
  return { 'Content-Type': 'application/json', 'X-App-Key': appKey, 'X-Timestamp': ts,
    'X-Log-Id': logId, 'X-Extra-Info': extra, 'X-Sign': sign };
}

function officialUrl(value) {
  if (!safeUrl(value)) return false;
  const url = new URL(value);
  return url.hostname === 'openapi.zhihu.com' && !url.port && !url.hash;
}

// Decode common diagnostic encodings before redaction, never after it. Work is
// bounded, and oversized messages are omitted rather than cutting a secret.
function diagnosticText(value) {
  for (let i = 0; i < 3; i++) {
    const decoded = value.replace(/(?:%[a-f0-9]{2})+/gi, part => {
      try { return decodeURIComponent(part); } catch (_) { return part; }
    }).replace(/\\(?:u([a-f0-9]{4})|(["\\/bfnrt]))/gi, (_, hex, char) =>
      hex ? String.fromCharCode(parseInt(hex, 16)) :
        ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[char] || char));
    if (decoded === value) break;
    value = decoded;
  }
  return value;
}

function safeMessage(value, sensitiveValues) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_MESSAGE_BYTES) return '';
  let message = diagnosticText(value);
  const secrets = new Set();
  for (const secret of sensitiveValues) {
    if (typeof secret !== 'string' || !secret) continue;
    const base64 = Buffer.from(secret).toString('base64');
    for (const form of [secret, JSON.stringify(secret).slice(1, -1),
      new URLSearchParams({ v: secret }).toString().slice(2), base64,
      base64.replace(/=+$/, ''), base64.replace(/\+/g, '-').replace(/\//g, '_'),
      base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')]) {
      secrets.add(form);
      secrets.add(diagnosticText(form));
    }
  }
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join('[REDACTED]');
  }
  // Unknown assignments may contain spaces, escaped quotes or nested objects.
  // Omit their entire remainder rather than trying to preserve a credential dump.
  message = message.replace(/\b(?:Bearer|Basic)\s+[\s\S]*/gi, '[REDACTED]')
    .replace(/(\b(?:x-[\w-]+|[\w-]*(?:token|secret|password|authorization|cookie|signature|credential)[\w-]*|access[_-]?key(?:[_-]?id)?|app[_-]?key|sign|sts)\s*["']?\s*[:=])[\s\S]*/gi, '$1[REDACTED]')
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f<>]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return Array.from(message).slice(0, MAX_MESSAGE_LENGTH).join('');
}

// ctx.request is the transport seam. An optional ctx.sensitiveValues Set can be
// shared across requests to redact earlier headers/STS values in later errors.
// The set is private caller state, never attached to an error or return value.
async function api(ctx, url, method, json, extraHeaders = {}, timeoutMs = 30000, sensitiveValues = []) {
  // Check BEFORE signing or sending STS/app credentials. Transport never follows redirects.
  if (!officialUrl(url)) throw failure('知乎接口地址必须为 openapi.zhihu.com 的 HTTPS 地址');
  const headers = { ...authHeaders(ctx), ...extraHeaders };
  const privateValues = [...Object.values(credentials(ctx)), ...Object.values(headers), ...sensitiveValues];
  if (ctx.sensitiveValues instanceof Set) {
    privateValues.forEach(value => {
      if (typeof value === 'string' && value) ctx.sensitiveValues.add(value);
    });
    privateValues.push(...ctx.sensitiveValues);
  }
  let response;
  try {
    response = await (ctx.request || request)(url, {
      method, headers, json, timeoutMs, maxBytes: MAX_RESPONSE_BYTES,
    });
  } catch (_) {
    // Never forward SDK/transport messages: they can contain signatures or credentials.
    throw failure('知乎连接失败，提交结果可能未知，请先核对平台内容', false);
  }
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw failure('知乎 HTTP 响应无效，提交结果可能未知', false);
  }
  let data;
  try {
    const body = response.body;
    if ((!Buffer.isBuffer(body) && typeof body !== 'string') || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      throw new Error('Invalid response body');
    }
    data = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body);
  } catch (_) { /* Non-2xx still has useful HTTP status, never expose raw body. */ }
  const validStatus = object(data) && Number.isSafeInteger(data.status);
  const rejected = (message, definitive, includeMessage = false) => {
    const detail = includeMessage && object(data) ? safeMessage(data.msg, privateValues) : '';
    const error = failure(`${message}（HTTP ${response.status}${validStatus ? `，status ${data.status}` : ''}）${detail ? `：${detail}` : ''}`, definitive);
    error.status = response.status;
    if (validStatus) error.apiStatus = data.status;
    return error;
  };
  if (response.status < 200 || response.status >= 300) {
    throw rejected('知乎请求失败', response.status >= 400 && response.status < 500, true);
  }
  if (data === undefined) throw rejected('知乎返回非法 JSON，提交结果可能未知', false);
  if (!object(data)) throw rejected('知乎响应结构无效，提交结果可能未知', false);
  if (own(data, 'status')) {
    if (!validStatus) {
      throw rejected('知乎响应状态无效，提交结果可能未知', false);
    }
    if (data.status !== 0) throw rejected('知乎业务拒绝', true, true);
  }
  return data;
}

module.exports = { ORIGIN, credentials, officialUrl, api };
