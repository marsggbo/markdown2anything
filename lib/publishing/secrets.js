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
function storedRecord(value) {
  if (!value || typeof value !== 'object') return { value: null, revision: null };
  return {
    value: typeof value.value === 'string' ? value.value : null,
    revision: typeof value.revision === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value.revision) ? value.revision : null,
  };
}
function decodeRecord(value) {
  if (typeof value !== 'string') return { value: null, revision: null };
  try {
    const parsed = JSON.parse(value);
    if (parsed && parsed.version === 1 && Object.prototype.hasOwnProperty.call(parsed, 'value')) return storedRecord(parsed);
  } catch (_) {}
  return { value, revision: null };
}
function encodeRecord(record) { return JSON.stringify({ version: 1, value: record.value, revision: record.revision }); }

class SecretStore {
  constructor(port) { this.port = port || {}; }
  async availability() { return this.port.availability ? this.port.availability() : { available: false, reason: 'SECURE_STORAGE_UNAVAILABLE' }; }
  async readRecord(slot) {
    const state = await this.availability();
    if (!state.available) return { value: null, revision: null };
    if (typeof this.port.getRecord === 'function') {
      const record = await this.port.getRecord(slot);
      return typeof record === 'string' ? decodeRecord(record) : storedRecord(record);
    }
    return decodeRecord(await this.port.get(slot));
  }
  async writeRecord(slot, record) {
    if (typeof this.port.setRecord === 'function') return this.port.setRecord(slot, record);
    return this.port.set(slot, encodeRecord(record));
  }
  async get(slot) {
    assertSlot(slot);
    return (await this.readRecord(slot)).value;
  }
  async set(slot, value) {
    assertSlot(slot);
    if (typeof value !== 'string') throw cookieError('INVALID_CREDENTIAL');
    const state = await this.availability();
    if (!state.available) throw cookieError('SECURE_STORAGE_UNAVAILABLE');
    if (slot.endsWith('browserCookies')) value = validateZhihuCookies(value);
    const record = { value, revision: revision() };
    await this.writeRecord(slot, record);
    const roundTrip = await this.readRecord(slot);
    if (roundTrip.value !== value || roundTrip.revision !== record.revision) throw cookieError('SECURE_STORAGE_UNAVAILABLE');
    return { revision: record.revision };
  }
  async delete(slot) {
    assertSlot(slot);
    const state = await this.availability();
    if (!state.available) throw cookieError('SECURE_STORAGE_UNAVAILABLE');
    const record = { value: null, revision: revision() };
    await this.writeRecord(slot, record);
    const roundTrip = await this.readRecord(slot);
    if (roundTrip.value !== null || roundTrip.revision !== record.revision) throw cookieError('SECURE_STORAGE_UNAVAILABLE');
    return { revision: record.revision };
  }
  async getRevision(slot) {
    assertSlot(slot);
    const record = await this.readRecord(slot);
    if (record.revision) return record.revision;
    if (record.value === null) return 'uninitialized';
    const migrated = { value: record.value, revision: revision() };
    await this.writeRecord(slot, migrated);
    const roundTrip = await this.readRecord(slot);
    if (roundTrip.value !== migrated.value || roundTrip.revision !== migrated.revision) throw cookieError('SECURE_STORAGE_UNAVAILABLE');
    return migrated.revision;
  }
}
function assertSecretFreePersistence(value, secrets) { return assertPersistable(value, secrets); }

module.exports = { SecretStore, SECRET_SLOT_NAMES, assertSlot, validateZhihuCookies, redact, sanitizeReason, assertSecretFreePersistence };
