'use strict';

const https = require('https');
const { requireAvailable } = require('./profiles');
const { redact } = require('./secrets');

function httpError(code, statusClass) { const error = new Error(code); error.code = code; error.statusClass = statusClass; return error; }
function boundedBody(body, maxBytes) { const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || ''); if (buffer.length > maxBytes) throw httpError('RESPONSE_TOO_LARGE'); return buffer; }
function defaultTransport(request) { return new Promise((resolve, reject) => { const url = new URL(request.url); const req = https.request(url, { method: request.method, headers: request.headers, timeout: request.timeoutMs, agent: false }, response => { const chunks = []; let size = 0; response.on('data', chunk => { size += chunk.length; if (size > request.maxResponseBytes) { response.destroy(); reject(httpError('RESPONSE_TOO_LARGE')); } else chunks.push(chunk); }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })); }); req.on('error', () => reject(httpError('REMOTE_NETWORK_ERROR'))); req.on('timeout', () => { req.destroy(); reject(httpError('REMOTE_TIMEOUT')); }); if (request.signal) request.signal.addEventListener('abort', () => { req.destroy(); reject(httpError('CANCELLED')); }, { once: true }); if (request.body) req.write(request.body); req.end(); }); }
function readPath(value, expression) { if (typeof expression !== 'string' || !expression.startsWith('$.')) return undefined; return expression.slice(2).split('.').reduce((current, key) => current && current[key], value); }
function responseSatisfies(data, route) { const success = route.success || {}; const code = route.response && route.response.errorCode && readPath(data, route.response.errorCode); if (success.errorCode === 'absent-or-zero' && code !== undefined && code !== 0 && code !== '0') return false; return (success.required || []).every(requirement => { const [field, predicate] = requirement.split(':'); const value = readPath(data, route.response && route.response[field]); if (predicate === 'nonEmptyString') return typeof value === 'string' && !!value; if (predicate === 'absoluteHttps') { try { return new URL(value).protocol === 'https:'; } catch (_) { return false; } } return value !== undefined && value !== null; }); }
function buildRouteUrl(route, query) { const url = new URL(route.path, route.origin); Object.entries(query || {}).forEach(([key, value]) => { if (value !== undefined && value !== null) url.searchParams.set(key, String(value)); }); return url; }
async function requestRoute(profile, routeName, request, dependencies) {
  requireAvailable(profile); const route = profile.routes && profile.routes[routeName]; if (!route) throw httpError('PROFILE_UNAVAILABLE');
  if (route.acceptedMimes && request.asset && (!route.acceptedMimes.includes(request.asset.mime) || request.asset.byteLength > route.maxAssetBytes)) throw httpError('IMAGE_MIME_MISMATCH');
  const url = buildRouteUrl(route, request.query); const transport = dependencies && dependencies.transport || defaultTransport;
  let response; try { response = await transport({ url: url.toString(), method: route.method, headers: request.headers || {}, body: request.body, timeoutMs: route.timeoutMs, maxResponseBytes: route.maxResponseBytes, signal: request.signal }); } catch (error) { throw error.code ? error : httpError('REMOTE_NETWORK_ERROR'); }
  const body = boundedBody(response.body, route.maxResponseBytes); if (response.status < 200 || response.status >= 300) throw httpError('REMOTE_HTTP_STATUS', `${String(response.status)[0]}xx`);
  let json; try { json = JSON.parse(body.toString('utf8')); } catch (_) { throw httpError('INVALID_PROVIDER_RESPONSE'); }
  if (!responseSatisfies(json, route)) throw httpError('INVALID_PROVIDER_RESPONSE'); return json;
}
function sanitizedRequestLog(request, secrets) { return redact({ method: request.method, url: String(request.url).replace(/\?.*$/, ''), headers: request.headers }, secrets); }

module.exports = { requestRoute, buildRouteUrl, responseSatisfies, sanitizedRequestLog, defaultTransport, httpError };
