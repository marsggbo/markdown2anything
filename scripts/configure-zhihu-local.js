#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  parseZhihuCredentialText, readZhihuCredentialFile, ZhihuCredentialsError,
} = require('../lib/publishing/credentials');

const KEY = 'ZHIHU_OPENAPI_APP_KEY';
const SECRET = 'ZHIHU_OPENAPI_APP_SECRET';
const fail = code => { throw new ZhihuCredentialsError(code); };
const complete = value => !!value.appKey && !!value.appSecret;
const same = (a, b) => a.appKey === b.appKey && a.appSecret === b.appSecret;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!['--app-key', '--secret-file', '--check', '--write'].includes(name) || Object.hasOwn(options, name)) fail('arguments');
    if (name === '--check' || name === '--write') options[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail('arguments');
      options[name] = value;
    }
  }
  if (!!options['--check'] === !!options['--write'] ||
      (options['--secret-file'] && !path.isAbsolute(options['--secret-file']))) fail('arguments');
  return { appKey: options['--app-key'], secretFile: options['--secret-file'], write: !!options['--write'] };
}

function status(credentials, source, consistent, permissions) {
  const isComplete = !!credentials && complete(credentials);
  return {
    configured: isComplete && consistent && !['insecure', 'absent'].includes(permissions),
    source,
    ...(credentials && credentials.appKey ? { appKey: credentials.appKey } : {}),
    complete: isComplete,
    consistent,
    permissions,
  };
}

async function secureParent(directory) {
  try { await fs.promises.mkdir(directory, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) fail('file');
  if (process.platform !== 'win32') await fs.promises.chmod(directory, 0o700);
}

async function secureExisting(target, expected) {
  // Re-read the open descriptor before changing permissions. Never overwrite.
  const handle = await fs.promises.open(target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 || (process.getuid && stat.uid !== process.getuid())) fail('file');
    const current = await readZhihuCredentialFile(target, { allowInsecure: true });
    const now = await fs.promises.lstat(target);
    if (!current || !same(current.credentials, expected) || stat.ino !== now.ino || stat.dev !== now.dev) fail('conflict');
    if (process.platform !== 'win32') await handle.chmod(0o600);
  } finally { await handle.close().catch(() => {}); }
}

async function writeShared(target, credentials) {
  const directory = path.dirname(target);
  let temporary;
  let handle;
  try {
    await secureParent(directory);
    const existing = await readZhihuCredentialFile(target, { allowInsecure: true });
    if (existing) {
      if (!same(existing.credentials, credentials)) fail('conflict');
      await secureExisting(target, credentials);
      return;
    }
    temporary = path.join(directory, `.openapi-${crypto.randomBytes(16).toString('hex')}.tmp`);
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ [KEY]: credentials.appKey, [SECRET]: credentials.appSecret }, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      // A hard link publishes the complete file atomically and cannot clobber a
      // target created concurrently. rename() would overwrite that target.
      await fs.promises.link(temporary, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = await readZhihuCredentialFile(target, { allowInsecure: true });
      if (!winner || !same(winner.credentials, credentials)) fail('conflict');
      await secureExisting(target, credentials);
    }
  } catch (error) {
    if (error instanceof ZhihuCredentialsError) throw error;
    fail('write');
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await fs.promises.unlink(temporary).catch(() => {});
  }
}

/**
 * Only --write persists, only in homeDir/.zhihu. Returned status contains no
 * secret, mask, fingerprint, file contents, or arbitrary filesystem messages.
 * homeDir/env are injectable so tests never access the real user's credentials.
 */
async function configureZhihuLocal({
  env = process.env, homeDir = os.homedir(), appKey, secretFile, write = false,
} = {}) {
  if (secretFile && !path.isAbsolute(secretFile)) fail('arguments');
  // Use the same field validation as the canonical parser.
  const environment = parseZhihuCredentialText(JSON.stringify({ [KEY]: env[KEY], [SECRET]: env[SECRET] }));
  const explicit = parseZhihuCredentialText(JSON.stringify({ [KEY]: appKey })).appKey;
  const target = path.join(homeDir, '.zhihu', 'openapi-credentials.json');
  const shared = await readZhihuCredentialFile(target, { allowInsecure: true });
  let credentials;
  let source;
  let permissions;
  if (complete(environment)) {
    credentials = environment; source = 'environment'; permissions = 'not-applicable';
  } else if (shared && complete(shared.credentials)) {
    credentials = shared.credentials; source = 'shared-file'; permissions = shared.permissions;
  }
  let consistent = !(complete(environment) && shared && complete(shared.credentials) && !same(environment, shared.credentials));
  if (credentials && explicit && explicit !== credentials.appKey) consistent = false;
  // An explicitly named file is always inspected, even with an existing shared
  // pair, so --write cannot silently ignore a different supplied secret.
  if (secretFile || !credentials) {
    const publicKeys = [explicit, environment.appKey, shared && shared.credentials.appKey].filter(Boolean);
    if (new Set(publicKeys).size > 1) consistent = false;
    const legacy = await readZhihuCredentialFile(secretFile || path.join(homeDir, '.zhihu', '.sync_key'),
      { kind: 'sync-key', allowInsecure: true });
    if (legacy) {
      const identity = publicKeys[0] || '';
      if (legacy.credentials.appKey && legacy.credentials.appKey !== identity) consistent = false;
      const candidate = { appKey: identity, appSecret: legacy.credentials.appSecret };
      if (credentials && !same(credentials, candidate)) consistent = false;
      if (!credentials || secretFile) {
        credentials = candidate; source = 'sync-key'; permissions = legacy.permissions;
      }
      // A permissive input secret is never imported. Shared-file mode can be
      // repaired only after a complete matching pair has been established.
      if (legacy.permissions === 'insecure') permissions = 'insecure';
    }
  }
  if (shared && complete(shared.credentials) && credentials && !same(shared.credentials, credentials)) consistent = false;
  if (!write) {
    if (shared && shared.permissions === 'insecure') permissions = 'insecure';
    return status(credentials, source || null, consistent, permissions || 'absent');
  }
  if (!consistent) fail('conflict');
  if (!credentials || !complete(credentials)) return status(credentials, source || null, true, permissions || 'absent');
  if (permissions === 'insecure' && source !== 'shared-file') fail('permissions');
  await writeShared(target, credentials);
  return status(credentials, 'shared-file', true, process.platform === 'win32' ? 'not-applicable' : 'secure');
}

async function runCli(argv, { env = process.env, homeDir = os.homedir(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const result = await configureZhihuLocal({ ...parseArgs(argv), env, homeDir });
    stdout.write(JSON.stringify(result) + '\n');
    return result.configured ? 0 : 1;
  } catch (error) {
    const safe = error instanceof ZhihuCredentialsError ? error : new ZhihuCredentialsError('read');
    stdout.write(JSON.stringify(status(null, null, safe.code !== 'conflict',
      safe.code === 'permissions' ? 'insecure' : 'absent')) + '\n');
    stderr.write(safe.message + '\n');
    return 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

module.exports = { configureZhihuLocal, parseArgs, runCli };
