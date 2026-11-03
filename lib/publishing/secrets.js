'use strict';

const crypto = require('crypto');
const { SECRET_SLOT_NAMES, LIMITS } = require('./constants');
const { assertPersistable, isPlainObject } = require('./model');

function revision() { return crypto.randomBytes(24).toString('base64url'); }
function assertSlot(slot) { if (!SECRET_SLOT_NAMES.includes(slot)) { const error = new Error('INVALID_SECRET_SLOT'); error.code = 'INVALID_SECRET_SLOT'; throw error; } }
function sanitizeReason(value) { return typeof value === 'string' ? value.replace(/(?:bearer\s+)?[A-Za-z0-9._~+\/-]{16,}/gi, '[redacted]').slice(0, 256) : undefined; }
function redact(value, knownSecrets) {
  const secrets = (knownSecrets || []).filter(Boolean).sort((a, b) => b.length - a.length);
  const visit = (input, key) => {
    if (/(?:authorization|cookie|appsecret|token|password|credential|private.?key)/i.test(key || '')) return '[redacted]';
    if (typeof input === 'string') return secrets.reduce((output, secret) => output.split(secret).join('[redacted]'), input).replace(/([?&](?:token|api_?key|secret|sig(?:nature)?|cookie)=)[^&\s]+/ig, '$1[redacted]');
    if (Array.isArray(input)) return input.map(item => visit(item, ''));
    if (isPlainObject(input)) return Object.fromEntries(Object.keys(input).map(child => [child, visit(input[child], child)]));
    return input;
  };
  return visit(value, '');
}
function validateZhihuCookies(input) {
  let cookies; try { cookies = typeof input === 'string' ? JSON.parse(input) : input; } catch (_) { throw cookieError('INVALID_COOKIE'); }
  if (!Array.isArray(cookies) || cookies.length === 0 || cookies.length > LIMITS.maxCookies || Buffer.byteLength(JSON.stringify(cookies), 'utf8') > LIMITS.maxCookieBytes) throw cookieError('INVALID_COOKIE');
  let zc0 = false;
  cookies.forEach(cookie => {
    if (!isPlainObject(cookie) || typeof cookie.name !== 'string' || !/^[\x21-\x7e]+$/.test(cookie.name) || typeof cookie.value !== 'string' || /[\r\n]/.test(cookie.value) || Buffer.byteLength(cookie.value, 'utf8') > LIMITS.maxCookieValueBytes || !['.zhihu.com', 'www.zhihu.com'].includes(cookie.domain) || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || !(cookie.expires === -1 || typeof cookie.expires === 'number' && Number.isFinite(cookie.expires))) throw cookieError('INVALID_COOKIE');
    if (cookie.name === 'z_c0' && cookie.value) zc0 = true;
  });
  if (!zc0) throw cookieError('MISSING_Z_C0_COOKIE');
  return JSON.stringify(cookies);
}
function cookieError(code) { const error = new Error(code); error.code = code; return error; }

class SecretStore {
  constructor(port) { this.port = port || {}; this.revisions = new Map(); }
  async availability() { return this.port.availability ? this.port.availability() : { available: false, reason: 'SECURE_STORAGE_UNAVAILABLE' }; }
  async get(slot) { assertSlot(slot); const state = await this.availability(); if (!state.available) return null; const value = await this.port.get(slot); return value === undefined ? null : value; }
  async set(slot, value) { assertSlot(slot); if (typeof value !== 'string') throw cookieError('INVALID_CREDENTIAL'); const state = await this.availability(); if (!state.available) throw cookieError('SECURE_STORAGE_UNAVAILABLE'); if (slot.endsWith('browserCookies')) value = validateZhihuCookies(value); await this.port.set(slot, value); const roundTrip = await this.port.get(slot); if (roundTrip !== value) throw cookieError('SECURE_STORAGE_UNAVAILABLE'); const next = revision(); this.revisions.set(slot, next); return { revision: next }; }
  async delete(slot) { assertSlot(slot); const state = await this.availability(); if (!state.available) throw cookieError('SECURE_STORAGE_UNAVAILABLE'); await this.port.delete(slot); const value = await this.port.get(slot); if (value !== null && value !== undefined) throw cookieError('SECURE_STORAGE_UNAVAILABLE'); const next = revision(); this.revisions.set(slot, next); return { revision: next }; }
  async getRevision(slot) { assertSlot(slot); return this.revisions.get(slot) || 'uninitialized'; }
}
function assertSecretFreePersistence(value, secrets) { return assertPersistable(value, secrets); }

module.exports = { SecretStore, SECRET_SLOT_NAMES, assertSlot, validateZhihuCookies, redact, sanitizeReason, assertSecretFreePersistence };
