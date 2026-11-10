'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TextDecoder } = require('util');

const MAX_BYTES = 16 * 1024;
const APP_KEY = 'ZHIHU_OPENAPI_APP_KEY';
const APP_SECRET = 'ZHIHU_OPENAPI_APP_SECRET';
const MESSAGES = {
  conflict: 'Zhihu credential sources conflict.',
  malformed: 'Invalid Zhihu credential data.',
  oversized: 'Zhihu credential file is too large.',
  permissions: 'Zhihu credential file permissions are unsafe.',
  file: 'Zhihu credentials require an owned regular file.',
  read: 'Unable to read Zhihu credential file.',
  write: 'Unable to safely write Zhihu shared credentials.',
  arguments: 'Use --app-key KEY --secret-file /absolute/path with exactly one of --check or --write.',
};

class ZhihuCredentialsError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.read);
    this.name = 'ZhihuCredentialsError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'read';
  }
}

function fail(code) { throw new ZhihuCredentialsError(code); }

function field(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail('malformed');
  return value.trim();
}

const KEY_ALIASES = [APP_KEY, 'app_key', 'appKey', 'APP_KEY'];
const SECRET_ALIASES = [
  APP_SECRET, 'app_secret', 'appSecret', 'APP_SECRET', 'secret', 'SECRET',
  'sync_key', 'SYNC_KEY', 'ZHIHU_SYNC_KEY', 'key', 'KEY',
];

function alias(record, names) {
  const values = names.filter(name => Object.hasOwn(record, name)).map(name => field(record[name])).filter(Boolean);
  if (new Set(values).size > 1) fail('malformed');
  return values[0] || '';
}

/**
 * Pure parser. Shared files accept only the official JSON field names.
 * Legacy files accept a raw token, JSON, or literal NAME=value lines. No shell
 * expansion, escapes, interpolation, execution, or evaluation is performed.
 * Returned values are private application data; never log this result.
 */
function parseZhihuCredentialText(text, { kind = 'shared-file' } = {}) {
  if (typeof text !== 'string' || !['shared-file', 'sync-key'].includes(kind)) fail('malformed');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('oversized');
  const input = text.trim();
  if (!input || input.includes('\ufffd')) fail('malformed');
  let record;
  if (kind === 'shared-file' || /^[{["]/.test(input)) {
    try { record = JSON.parse(input); } catch (_) { fail('malformed'); }
    if (kind === 'sync-key' && typeof record === 'string') return { appKey: '', appSecret: field(record) };
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail('malformed');
    const keys = kind === 'shared-file' ? [APP_KEY] : KEY_ALIASES;
    const secrets = kind === 'shared-file' ? [APP_SECRET] : SECRET_ALIASES;
    if (Object.keys(record).some(name => ![...keys, ...secrets].includes(name))) fail('malformed');
    return { appKey: alias(record, keys), appSecret: alias(record, secrets) };
  }
  const names = [...KEY_ALIASES, ...SECRET_ALIASES];
  // Padded base64 is a common raw secret, not a NAME=value assignment.
  const assignment = input.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (/^[A-Za-z0-9_+/-]+={0,2}$/.test(input) && !(assignment && names.includes(assignment[1]))) {
    return { appKey: '', appSecret: field(input) };
  }
  if (input.includes('\n') || /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(input)) {
    record = Object.create(null);
    for (const line of input.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || !names.includes(match[1]) || Object.hasOwn(record, match[1])) fail('malformed');
      let value = match[2];
      if (/^['"]/.test(value)) {
        if (value.length < 2 || value.at(-1) !== value[0]) fail('malformed');
        value = value.slice(1, -1);
      }
      // Restrict token syntax so a copied shell expression cannot become a secret.
      if (!/^[A-Za-z0-9_+/.=:@~-]+$/.test(value)) fail('malformed');
      record[match[1]] = value;
    }
    if (!Object.keys(record).length) fail('malformed');
    return { appKey: alias(record, KEY_ALIASES), appSecret: alias(record, SECRET_ALIASES) };
  }
  if (!/^[A-Za-z0-9_+/.=:@~-]+$/.test(input)) fail('malformed');
  return { appKey: '', appSecret: field(input) };
}

/**
 * Bounded, symlink-resistant read. allowInsecure is for the configuration
 * helper's status/permission repair only; the resolver always fails closed.
 */
async function readZhihuCredentialFile(filePath, { kind = 'shared-file', allowInsecure = false } = {}) {
  let handle;
  try {
    let before;
    try { before = await fs.promises.lstat(filePath); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!before.isFile() || (process.getuid && before.uid !== process.getuid())) fail('file');
    handle = await fs.promises.open(filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || before.ino !== stat.ino || before.dev !== stat.dev ||
        (process.getuid && stat.uid !== process.getuid())) fail('file');
    const mode = stat.mode & 0o7777;
    const secure = process.platform === 'win32' ||
      (kind === 'shared-file' ? mode === 0o600 : (mode & 0o7177) === 0 && (mode & 0o400) !== 0);
    const permissions = process.platform === 'win32' ? 'not-applicable' : secure ? 'secure' : 'insecure';
    if (!secure && !allowInsecure) fail('permissions');
    if (stat.size > MAX_BYTES) fail('oversized');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) fail('oversized');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
    catch (_) { fail('malformed'); }
    return { credentials: parseZhihuCredentialText(text, { kind }), permissions };
  } catch (error) {
    if (error instanceof ZhihuCredentialsError) throw error;
    // Never attach native errors, paths, parser messages, or raw contents.
    fail('read');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

const complete = value => !!value.appKey && !!value.appSecret;
const same = (a, b) => a.appKey === b.appKey && a.appSecret === b.appSecret;

/**
 * Read-only fallback for hosts AFTER SecretStorage. The returned credentials
 * belong only in memory or secure storage, never tasks, previews, or logs.
 */
async function resolveZhihuCredentials({ env = process.env, homeDir = os.homedir(), appKey } = {}) {
  const environment = { appKey: field(env[APP_KEY]), appSecret: field(env[APP_SECRET]) };
  const explicitKey = field(appKey);
  const shared = await readZhihuCredentialFile(path.join(homeDir, '.zhihu', 'openapi-credentials.json'));
  if (complete(environment) && shared && complete(shared.credentials) && !same(environment, shared.credentials)) fail('conflict');
  let credentials;
  let source;
  if (complete(environment)) { credentials = environment; source = 'environment'; }
  else if (shared && complete(shared.credentials)) { credentials = shared.credentials; source = 'shared-file'; }
  if (credentials) {
    if (explicitKey && explicitKey !== credentials.appKey) fail('conflict');
  } else {
    const publicKeys = [explicitKey, environment.appKey, shared && shared.credentials.appKey].filter(Boolean);
    if (new Set(publicKeys).size > 1) fail('conflict');
    // Do not touch legacy data if no public identity is available.
    if (!publicKeys.length) return null;
    const legacy = await readZhihuCredentialFile(path.join(homeDir, '.zhihu', '.sync_key'), { kind: 'sync-key' });
    if (!legacy || !legacy.credentials.appSecret) return null;
    if (legacy.credentials.appKey && legacy.credentials.appKey !== publicKeys[0]) fail('conflict');
    credentials = { appKey: publicKeys[0], appSecret: legacy.credentials.appSecret };
    source = 'sync-key';
  }
  const sourceLabel = {
    environment: 'Zhihu OpenAPI environment variables',
    'shared-file': '~/.zhihu/openapi-credentials.json',
    'sync-key': '~/.zhihu/.sync_key',
  }[source];
  return { credentials, source, sourceLabel };
}

module.exports = {
  resolveZhihuCredentials,
  parseZhihuCredentialText,
  readZhihuCredentialFile,
  ZhihuCredentialsError,
};
