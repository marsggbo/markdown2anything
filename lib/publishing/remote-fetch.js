'use strict';

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { CREDENTIAL_QUERY_NAME, LIMITS } = require('./constants');
const { sha256 } = require('./model');

class RemoteFetchError extends Error { constructor(code, statusClass) { super(code); this.code = code; this.statusClass = statusClass; } }
function sanitizedRemoteDescriptor(value) {
  const url = new URL(value);
  return { origin: url.origin, pathname: url.pathname, urlSha256: sha256(url.toString()) };
}
function validateRemoteUrl(value) {
  let url; try { url = new URL(value); } catch (_) { throw new RemoteFetchError('INVALID_IMAGE_SOURCE'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RemoteFetchError('INVALID_IMAGE_SOURCE');
  for (const [name] of url.searchParams) if (CREDENTIAL_QUERY_NAME.test(name)) throw new RemoteFetchError('REMOTE_CREDENTIAL_QUERY');
  return url;
}
function ipv4Private(address) {
  const values = address.split('.').map(Number); if (values.length !== 4 || values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = values;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0);
}
function ipv6Private(address) {
  const value = address.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1' || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('2001:db8')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); return !!(mapped && ipv4Private(mapped[1]));
}
function isPublicAddress(address) {
  const family = net.isIP(address); return family === 4 ? !ipv4Private(address) : family === 6 ? !ipv6Private(address) : false;
}
async function resolvePublic(hostname, lookup) {
  let entries;
  try { entries = await lookup(hostname, { all: true, verbatim: true }); } catch (_) { throw new RemoteFetchError('REMOTE_DNS_FAILED'); }
  if (!Array.isArray(entries) || !entries.length || entries.some(entry => !entry || !isPublicAddress(entry.address))) throw new RemoteFetchError('REMOTE_PRIVATE_ADDRESS');
  return entries;
}
function responseBody(response, maxBytes) {
  if (Buffer.isBuffer(response.body)) { if (response.body.length > maxBytes) throw new RemoteFetchError('IMAGE_TOO_LARGE'); return Promise.resolve(response.body); }
  if (typeof response.body === 'string') { const body = Buffer.from(response.body); if (body.length > maxBytes) throw new RemoteFetchError('IMAGE_TOO_LARGE'); return Promise.resolve(body); }
  if (!response.body || typeof response.body.on !== 'function') return Promise.reject(new RemoteFetchError('REMOTE_NETWORK_ERROR'));
  return new Promise((resolve, reject) => { const chunks = []; let length = 0; response.body.on('data', chunk => { length += chunk.length; if (length > maxBytes) { if (typeof response.body.destroy === 'function') response.body.destroy(); reject(new RemoteFetchError('IMAGE_TOO_LARGE')); return; } chunks.push(chunk); }); response.body.on('end', () => resolve(Buffer.concat(chunks))); response.body.on('error', () => reject(new RemoteFetchError('REMOTE_NETWORK_ERROR'))); });
}
function defaultTransport({ url, addresses, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const pinned = addresses && addresses[0];
    const request = client.request(url, { method: 'GET', headers: { Accept: 'image/*', 'User-Agent': 'markdown2anything-publisher' }, agent: false, lookup: (hostname, options, callback) => pinned ? callback(null, pinned.address, net.isIP(pinned.address)) : callback(new RemoteFetchError('REMOTE_DNS_FAILED')) }, response => resolve({ statusCode: response.statusCode, headers: response.headers || {}, body: response }));
    request.once('error', () => reject(new RemoteFetchError('REMOTE_NETWORK_ERROR')));
    request.setTimeout(timeoutMs, () => { request.destroy(); reject(new RemoteFetchError('REMOTE_TIMEOUT')); });
    if (signal) signal.addEventListener('abort', () => { request.destroy(); reject(new RemoteFetchError('CANCELLED')); }, { once: true });
    request.end();
  });
}
async function withTimeout(promise, timeoutMs) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new RemoteFetchError('REMOTE_TIMEOUT')), timeoutMs); })]); } finally { clearTimeout(timer); }
}
async function fetchRemoteImage(input, options) {
  options = options || {};
  const lookup = options.lookup || dns.promises.lookup;
  const transport = options.transport || defaultTransport;
  const timeoutMs = options.timeoutMs || LIMITS.remoteTimeoutMs;
  const maxBytes = options.maxBytes || LIMITS.maxImageBytes;
  const maxRedirects = options.maxRedirects === undefined ? LIMITS.maxRedirects : options.maxRedirects;
  let url = validateRemoteUrl(input); let redirectCount = 0;
  while (true) {
    const addresses = await resolvePublic(url.hostname, lookup);
    let response;
    try { response = await withTimeout(Promise.resolve(transport({ url, addresses, lookup, timeoutMs, maxBytes, signal: options.signal })), timeoutMs); } catch (error) { throw error instanceof RemoteFetchError ? error : new RemoteFetchError('REMOTE_NETWORK_ERROR'); }
    const status = response.statusCode || response.status;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers && response.headers.location) {
      if (response.body && typeof response.body.resume === 'function') response.body.resume();
      if (redirectCount >= maxRedirects) throw new RemoteFetchError('REMOTE_REDIRECT_LIMIT');
      url = validateRemoteUrl(new URL(response.headers.location, url).toString()); redirectCount++; continue;
    }
    if (status !== 200) { if (response.body && typeof response.body.resume === 'function') response.body.resume(); throw new RemoteFetchError('REMOTE_HTTP_STATUS', String(status).slice(0, 1) + 'xx'); }
    const declared = Number(response.headers && response.headers['content-length']); if (Number.isFinite(declared) && declared > maxBytes) { if (response.body && typeof response.body.destroy === 'function') response.body.destroy(); throw new RemoteFetchError('IMAGE_TOO_LARGE'); }
    const body = await responseBody(response, maxBytes);
    return { buffer: body, descriptor: sanitizedRemoteDescriptor(url.toString()), contentType: response.headers && response.headers['content-type'] || null, redirects: redirectCount };
  }
}

module.exports = { RemoteFetchError, validateRemoteUrl, sanitizedRemoteDescriptor, isPublicAddress, resolvePublic, fetchRemoteImage };
