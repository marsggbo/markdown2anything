'use strict';

const https = require('https');
const crypto = require('crypto');

function failure(message, definitive = true) {
  const error = new Error(message);
  error.definitive = definitive;
  return error;
}

// Never forward native messages: a custom transport may include request credentials.
const NETWORK_REASONS = Object.freeze({
  ETIMEDOUT: '请求超时，请检查网络或稍后重试',
  ENOTFOUND: 'DNS 无法解析服务器，请检查网络和 DNS 设置',
  EAI_AGAIN: 'DNS 查询暂时失败，请稍后重试',
  ECONNRESET: '连接被服务器或代理中断，请检查网络与代理设置',
  ECONNREFUSED: '服务器拒绝连接，请检查网络与代理设置',
  EPIPE: '上传连接中断，请检查网络与代理设置',
  ENETUNREACH: '网络不可达，请检查网络与代理设置',
  EHOSTUNREACH: '服务器不可达，请检查网络与代理设置',
  CERT_HAS_EXPIRED: 'TLS 证书已过期，请检查系统时间与代理证书',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书不受信任，请检查代理证书配置',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书链不受信任，请检查代理证书配置',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书验证失败，请检查代理证书配置',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS 证书签发者不受信任，请检查代理证书配置',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书与服务器不匹配，请检查代理设置',
  ERR_SSL_WRONG_VERSION_NUMBER: 'TLS 握手失败，请检查代理设置',
  M2A_RESPONSE_LIMIT: '平台响应超过大小上限',
  M2A_RESPONSE_ABORTED: '平台响应中断，请检查网络与代理设置',
});

function networkFailure(error, prefix = '平台连接失败') {
  const code = error && Object.hasOwn(NETWORK_REASONS, error.code) ? error.code : undefined;
  const result = failure(`${prefix}${code ? `：${NETWORK_REASONS[code]}（${code}）` : '，请检查网络与代理设置'}，提交结果可能未知`, false);
  if (code) result.code = code;
  return result;
}

function request(url, {
  method = 'GET', headers = {}, body, json, timeoutMs = 30000, maxBytes = 8 * 1024 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.username || address.password) {
      reject(failure('发布接口必须使用 HTTPS，且不能在地址中包含凭证'));
      return;
    }
    const bytes = json === undefined ? body : Buffer.from(JSON.stringify(json));
    const finalHeaders = { ...headers };
    if (json !== undefined) finalHeaders['Content-Type'] = 'application/json';
    if (bytes) finalHeaders['Content-Length'] = Buffer.byteLength(bytes);
    const req = https.request(address, { method, headers: finalHeaders }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(networkFailure({ code: 'M2A_RESPONSE_LIMIT' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', error => reject(networkFailure(error, '平台响应中断')));
      res.on('aborted', () => reject(networkFailure({ code: 'M2A_RESPONSE_ABORTED' })));
    });
    const timer = setTimeout(() => {
      reject(networkFailure({ code: 'ETIMEDOUT' }));
      req.destroy();
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', error => reject(networkFailure(error)));
    if (bytes) req.write(bytes);
    req.end();
  });
}

async function jsonRequest(url, options = {}, transport = request) {
  const response = await transport(url, options);
  let data;
  try { data = JSON.parse(response.body.toString('utf8')); }
  catch (_) { throw failure('平台返回了无法识别的响应，提交结果可能未知', false); }
  if (response.status < 200 || response.status >= 300) {
    const error = failure(`平台请求失败（HTTP ${response.status}）`, response.status < 500);
    error.status = response.status;
    throw error;
  }
  return data;
}

function multipart(asset, fields = {}, field = 'media') {
  const boundary = `m2a-${crypto.randomBytes(16).toString('hex')}`;
  const chunks = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; ` +
    `filename="${asset.name}"\r\nContent-Type: ${asset.mimeType}\r\n\r\n`));
  chunks.push(asset.buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch (_) { return false; }
}

module.exports = { request, jsonRequest, multipart, safeUrl, failure, networkFailure };
