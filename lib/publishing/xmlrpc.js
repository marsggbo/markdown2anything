'use strict';

const https = require('https');
const { LIMITS } = require('./constants');

function xmlError(code) { const error = new Error(code); error.code = code; return error; }
function escapeXml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function encodeValue(value) {
  if (Buffer.isBuffer(value)) return `<value><base64>${value.toString('base64')}</base64></value>`;
  if (typeof value === 'string') return `<value><string>${escapeXml(value)}</string></value>`;
  if (typeof value === 'boolean') return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  if (Number.isInteger(value)) return `<value><int>${value}</int></value>`;
  if (Array.isArray(value)) return `<value><array><data>${value.map(encodeValue).join('')}</data></array></value>`;
  if (value && typeof value === 'object') return `<value><struct>${Object.keys(value).sort().map(key => `<member><name>${escapeXml(key)}</name>${encodeValue(value[key])}</member>`).join('')}</struct></value>`;
  throw xmlError('INVALID_XMLRPC_VALUE');
}
function encodeMethodCall(method, args) { if (typeof method !== 'string' || !method || !Array.isArray(args)) throw xmlError('INVALID_XMLRPC_VALUE'); return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${args.map(value => `<param>${encodeValue(value)}</param>`).join('')}</params></methodCall>`; }
function text(value) { return value.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }
function parseValue(xml, depth) {
  if ((depth || 0) > 32) throw xmlError('INVALID_PROVIDER_RESPONSE'); const source = xml.trim();
  const wrapped = source.match(/^<value>([\s\S]*)<\/value>$/); const value = wrapped ? wrapped[1].trim() : source;
  if (!value || /^<string>/.test(value)) return text(value);
  if (/^<(?:int|i4)>/.test(value)) { const n = Number(text(value)); if (!Number.isSafeInteger(n)) throw xmlError('INVALID_PROVIDER_RESPONSE'); return n; }
  if (/^<boolean>/.test(value)) { const n = text(value); if (n !== '0' && n !== '1') throw xmlError('INVALID_PROVIDER_RESPONSE'); return n === '1'; }
  if (/^<base64>/.test(value)) return Buffer.from(text(value), 'base64');
  if (/^<array>/.test(value)) { const inner = (value.match(/^<array>\s*<data>([\s\S]*)<\/data>\s*<\/array>$/) || [])[1]; if (inner === undefined) throw xmlError('INVALID_PROVIDER_RESPONSE'); return valuesFromXml(inner, (depth || 0) + 1); }
  if (/^<struct>/.test(value)) { const out = {}; const members = [...value.matchAll(/<member>\s*<name>([\s\S]*?)<\/name>\s*(<value>[\s\S]*?<\/value>)\s*<\/member>/g)]; if (!members.length && !/^<struct>\s*<\/struct>$/.test(value)) throw xmlError('INVALID_PROVIDER_RESPONSE'); members.forEach(member => { out[text(member[1])] = parseValue(member[2], (depth || 0) + 1); }); return out; }
  throw xmlError('INVALID_PROVIDER_RESPONSE');
}
function valuesFromXml(xml, depth) { const values = []; const matcher = /<value>(?:[\s\S]*?)<\/value>/g; let match; while ((match = matcher.exec(xml))) values.push(parseValue(match[0], depth)); return values; }
function parseMethodResponse(xml, maxBytes) { if (Buffer.byteLength(xml, 'utf8') > (maxBytes || LIMITS.maxResponseBytes) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw xmlError('INVALID_PROVIDER_RESPONSE'); const fault = xml.match(/<fault>\s*(<value>[\s\S]*?<\/value>)\s*<\/fault>/); if (fault) { const error = xmlError('XMLRPC_FAULT'); error.fault = parseValue(fault[1], 0); throw error; } const param = xml.match(/<param>\s*(<value>[\s\S]*?<\/value>)\s*<\/param>/); if (!param) throw xmlError('INVALID_PROVIDER_RESPONSE'); return parseValue(param[1], 0); }
function defaultTransport({ url, body, timeoutMs, maxResponseBytes }) { return new Promise((resolve, reject) => { const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body), Accept: 'text/xml' }, timeout: timeoutMs, agent: false }, res => { let size = 0; const chunks = []; res.on('data', chunk => { size += chunk.length; if (size > maxResponseBytes) { res.destroy(); reject(xmlError('RESPONSE_TOO_LARGE')); } else chunks.push(chunk); }); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })); }); req.on('error', () => reject(xmlError('REMOTE_NETWORK_ERROR'))); req.on('timeout', () => { req.destroy(); reject(xmlError('REMOTE_TIMEOUT')); }); req.end(body); }); }
async function callXmlRpc({ url, method, args, timeoutMs, maxResponseBytes, transport }) { const body = encodeMethodCall(method, args); const response = await (transport || defaultTransport)({ url, body, timeoutMs: timeoutMs || LIMITS.remoteTimeoutMs, maxResponseBytes: maxResponseBytes || LIMITS.maxResponseBytes }); if (response.status < 200 || response.status >= 300) throw xmlError('REMOTE_HTTP_STATUS'); return parseMethodResponse(response.body, maxResponseBytes); }

module.exports = { encodeValue, encodeMethodCall, parseMethodResponse, callXmlRpc, xmlError };
