'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const {
  resolveZhihuCredentials, parseZhihuCredentialText, readZhihuCredentialFile, ZhihuCredentialsError,
} = require('../lib/publishing/credentials');
const { configureZhihuLocal, parseArgs, runCli } = require('../scripts/configure-zhihu-local');

const KEY = 'ZHIHU_OPENAPI_APP_KEY';
const SECRET = 'ZHIHU_OPENAPI_APP_SECRET';
const PUBLIC_KEY = 'dummy-public-app';
const DUMMY_SECRET = 'TEST_ONLY_DUMMY_SECRET_39ad';
const pair = { appKey: PUBLIC_KEY, appSecret: DUMMY_SECRET };
const canonical = (credentials = pair) => JSON.stringify({
  [KEY]: credentials.appKey, [SECRET]: credentials.appSecret,
}, null, 2) + '\n';
const environment = (credentials = pair) => ({ [KEY]: credentials.appKey, [SECRET]: credentials.appSecret });
const unix = process.platform !== 'win32';

async function fixture(t) {
  const homeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm2a-dummy-credentials-'));
  t.after(() => fs.promises.rm(homeDir, { recursive: true, force: true }));
  const directory = path.join(homeDir, '.zhihu');
  await fs.promises.mkdir(directory, { mode: 0o700 });
  const shared = path.join(directory, 'openapi-credentials.json');
  const legacy = path.join(directory, '.sync_key');
  const write = async (file, data, mode = 0o600) => {
    await fs.promises.writeFile(file, data, { mode });
    if (unix) await fs.promises.chmod(file, mode);
  };
  const resolve = options => resolveZhihuCredentials({ env: {}, homeDir, ...options });
  const configure = options => configureZhihuLocal({ env: {}, homeDir, ...options });
  return { homeDir, directory, shared, legacy, write, resolve, configure };
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ZhihuCredentialsError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(DUMMY_SECRET));
    assert.equal(error.cause, undefined);
    return true;
  });
}

function assertPublicOutput(output, secrets = [DUMMY_SECRET]) {
  for (const secret of secrets) {
    for (const variant of [
      secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'),
      crypto.createHash('sha256').update(secret).digest('hex'),
    ]) assert.ok(!output.includes(variant), 'private data escaped into CLI output');
  }
  assert.doesNotMatch(output, /appSecret|APP_SECRET|redacted|\*{3}|fingerprint|hash|mask/i);
}

test('absent and incomplete sources resolve to null without persistence', async t => {
  const f = await fixture(t);
  assert.equal(await f.resolve(), null);
  assert.equal(await f.resolve({ env: { [KEY]: PUBLIC_KEY } }), null);
  assert.equal(await f.resolve({ env: { [SECRET]: DUMMY_SECRET } }), null);
  await f.write(f.shared, canonical({ appKey: PUBLIC_KEY, appSecret: '' }));
  assert.equal(await f.resolve(), null);
  assert.deepEqual(await fs.promises.readdir(f.directory), ['openapi-credentials.json']);
});

test('environment and canonical shared JSON resolve with stable public source labels', async t => {
  const f = await fixture(t);
  const result = await f.resolve({ env: environment() });
  assert.deepEqual(result, {
    credentials: pair, source: 'environment', sourceLabel: 'Zhihu OpenAPI environment variables',
  });
  await f.write(f.shared, canonical());
  assert.deepEqual(await f.resolve(), {
    credentials: pair, source: 'shared-file', sourceLabel: '~/.zhihu/openapi-credentials.json',
  });
  assert.equal((await f.resolve({ env: environment() })).source, 'environment');
  assert.equal(await fs.promises.readFile(f.shared, 'utf8'), canonical());
});

test('complete environment/shared disagreements fail with one fixed error', async t => {
  const f = await fixture(t);
  await f.write(f.shared, canonical());
  for (const conflicting of [
    { appKey: 'other-public-app', appSecret: DUMMY_SECRET },
    { appKey: PUBLIC_KEY, appSecret: 'OTHER_DUMMY_SECRET' },
  ]) {
    await assert.rejects(f.resolve({ env: environment(conflicting) }), {
      name: 'ZhihuCredentialsError', code: 'conflict', message: 'Zhihu credential sources conflict.',
    });
  }
  await rejectsCode(f.resolve({ appKey: 'different-explicit-key' }), 'conflict');
});

test('partial environment data never supplies a secret to a different shared identity', async t => {
  const f = await fixture(t);
  await f.write(f.shared, canonical({ appKey: PUBLIC_KEY, appSecret: '' }));
  assert.equal(await f.resolve({ env: { [SECRET]: DUMMY_SECRET } }), null);
  await f.write(f.shared, canonical());
  assert.deepEqual((await f.resolve({ env: { [SECRET]: 'unused-dummy-secret' } })).credentials, pair);
});

for (const [name, text] of [
  ['raw', DUMMY_SECRET + '\n'],
  ['JSON string', JSON.stringify(DUMMY_SECRET)],
  ['official JSON', canonical()],
  ['camelCase JSON', JSON.stringify(pair)],
  ['snake_case JSON', JSON.stringify({ app_key: PUBLIC_KEY, app_secret: DUMMY_SECRET })],
  ['literal KEY assignment', `KEY=${DUMMY_SECRET}\n`],
  ['official assignments', `${KEY}=${PUBLIC_KEY}\n${SECRET}="${DUMMY_SECRET}"\n`],
  ['export assignments', `# dummy only\nexport APP_KEY='${PUBLIC_KEY}'\nexport APP_SECRET='${DUMMY_SECRET}'\n`],
]) {
  test(`legacy ${name} resolves only with an independently supplied public key`, async t => {
    const f = await fixture(t);
    await f.write(f.legacy, text);
    assert.equal(await f.resolve(), null);
    assert.deepEqual(await f.resolve({ appKey: PUBLIC_KEY }), {
      credentials: pair, source: 'sync-key', sourceLabel: '~/.zhihu/.sync_key',
    });
    assert.deepEqual((await f.resolve({ env: { [KEY]: PUBLIC_KEY } })).credentials, pair);
    await f.write(f.shared, canonical({ appKey: PUBLIC_KEY, appSecret: '' }));
    assert.deepEqual((await f.resolve()).credentials, pair);
  });
}

test('raw padded base64 remains a token; contradictory legacy public keys fail', async t => {
  const f = await fixture(t);
  await f.write(f.legacy, 'dGVzdC1vbmx5LXNlY3JldA==');
  assert.equal((await f.resolve({ appKey: PUBLIC_KEY })).credentials.appSecret, 'dGVzdC1vbmx5LXNlY3JldA==');
  await f.write(f.legacy, JSON.stringify({ ...pair, appKey: 'other-public-app' }));
  await rejectsCode(f.resolve({ appKey: PUBLIC_KEY }), 'conflict');
  await rejectsCode(f.resolve({ appKey: PUBLIC_KEY, env: { [KEY]: 'other-public-app' } }), 'conflict');
});

test('complete official credentials do not inspect obsolete legacy contents', async t => {
  const f = await fixture(t);
  await f.write(f.legacy, '{invalid legacy');
  assert.equal((await f.resolve({ env: environment() })).source, 'environment');
  await f.write(f.shared, canonical());
  assert.equal((await f.resolve()).source, 'shared-file');
});

test('malformed/oversized/shared aliases and invalid UTF-8 produce fixed errors', async t => {
  const f = await fixture(t);
  for (const text of [
    '', '{bad ' + DUMMY_SECRET, 'null', '[]', JSON.stringify(pair),
    canonical({ appKey: PUBLIC_KEY, appSecret: 3 }),
    canonical({ appKey: PUBLIC_KEY, appSecret: DUMMY_SECRET + '\n' }),
    Buffer.from([0xff, 0xfe]),
  ]) {
    await f.write(f.shared, text);
    await rejectsCode(f.resolve({ env: environment() }), 'malformed');
  }
  await f.write(f.shared, 'x'.repeat(16 * 1024 + 1));
  await rejectsCode(f.resolve(), 'oversized');
  await fs.promises.unlink(f.shared);
  for (const text of [
    '{"secret":', 'APP_SECRET=$(touch dummy)', 'KEY=`touch dummy`',
    'KEY=dummy;touch dummy', 'KEY="unclosed', 'KEY=', "KEY=''", 'UNKNOWN=value\nKEY=dummy',
    'KEY=one\nKEY=two', '{"appSecret":"one","secret":"two"}',
  ]) {
    await f.write(f.legacy, text);
    await rejectsCode(f.resolve({ appKey: PUBLIC_KEY }), 'malformed');
  }
  assert.deepEqual((await fs.promises.readdir(f.directory)).sort(), ['.sync_key']);
});

test('nonregular files and symlinks are rejected without following them', async t => {
  const f = await fixture(t);
  await fs.promises.mkdir(f.shared);
  await rejectsCode(f.resolve(), 'file');
  await fs.promises.rmdir(f.shared);
  await f.write(f.legacy, DUMMY_SECRET);
  await fs.promises.symlink(f.legacy, f.shared);
  await rejectsCode(f.resolve(), 'file');
  await rejectsCode(f.configure({ appKey: PUBLIC_KEY, write: true }), 'file');
  assert.equal(await fs.promises.readFile(f.legacy, 'utf8'), DUMMY_SECRET);
});

test('Unix shared requires 0600; legacy permits 0400/0600 only', { skip: !unix }, async t => {
  const f = await fixture(t);
  await f.write(f.shared, canonical());
  for (const mode of [0o644, 0o640, 0o660, 0o700, 0o400, 0o1600]) {
    await fs.promises.chmod(f.shared, mode);
    await rejectsCode(f.resolve(), 'permissions');
    const inspected = await readZhihuCredentialFile(f.shared, { allowInsecure: true });
    assert.equal(inspected.permissions, 'insecure');
  }
  await fs.promises.unlink(f.shared);
  for (const mode of [0o644, 0o640, 0o700, 0o1600]) {
    await f.write(f.legacy, DUMMY_SECRET, mode);
    await rejectsCode(f.resolve({ appKey: PUBLIC_KEY }), 'permissions');
  }
  for (const mode of [0o400, 0o600]) {
    await fs.promises.chmod(f.legacy, 0o600);
    await f.write(f.legacy, DUMMY_SECRET, mode);
    assert.deepEqual((await f.resolve({ appKey: PUBLIC_KEY })).credentials, pair);
  }
});

test('pure parser helpers use no ambient credentials and reject invalid types', () => {
  assert.deepEqual(parseZhihuCredentialText(canonical()), pair);
  assert.deepEqual(parseZhihuCredentialText(DUMMY_SECRET, { kind: 'sync-key' }), { appKey: '', appSecret: DUMMY_SECRET });
  for (const input of [null, 4, {}, canonical({ appKey: [], appSecret: DUMMY_SECRET })]) {
    assert.throws(() => parseZhihuCredentialText(input), { code: 'malformed' });
  }
  assert.throws(() => parseZhihuCredentialText('x'.repeat(16385)), { code: 'oversized' });
});

test('CLI check reports status only and never writes; write creates canonical credentials', async t => {
  const f = await fixture(t);
  await f.write(f.legacy, DUMMY_SECRET);
  const options = { appKey: PUBLIC_KEY, secretFile: f.legacy };
  assert.deepEqual(await f.configure(options), {
    configured: true, source: 'sync-key', appKey: PUBLIC_KEY, complete: true,
    consistent: true, permissions: unix ? 'secure' : 'not-applicable',
  });
  await assert.rejects(fs.promises.stat(f.shared), { code: 'ENOENT' });
  const result = await f.configure({ ...options, write: true });
  assert.equal(result.source, 'shared-file');
  assert.equal(result.configured, true);
  assert.equal(await fs.promises.readFile(f.shared, 'utf8'), canonical());
  if (unix) {
    assert.equal((await fs.promises.stat(f.shared)).mode & 0o777, 0o600);
    assert.equal((await fs.promises.stat(f.directory)).mode & 0o777, 0o700);
  }
  assert.deepEqual((await fs.promises.readdir(f.directory)).sort(), ['.sync_key', 'openapi-credentials.json']);
  assertPublicOutput(JSON.stringify(result));
});

test('CLI write creates a missing private parent from dummy environment credentials', async t => {
  const f = await fixture(t);
  await fs.promises.rmdir(f.directory);
  assert.equal((await f.configure({ env: environment(), write: true })).configured, true);
  assert.equal(await fs.promises.readFile(f.shared, 'utf8'), canonical());
  if (unix) assert.equal((await fs.promises.stat(f.directory)).mode & 0o777, 0o700);
});

test('CLI retains matching shared bytes/inode and repairs file/parent modes', async t => {
  const f = await fixture(t);
  const retained = JSON.stringify(environment()) + '\n\n';
  await f.write(f.shared, retained, 0o644);
  if (unix) await fs.promises.chmod(f.directory, 0o755);
  const before = await fs.promises.stat(f.shared);
  const checked = await f.configure();
  assert.equal(checked.permissions, unix ? 'insecure' : 'not-applicable');
  assert.equal(checked.configured, !unix);
  const written = await f.configure({ write: true });
  assert.equal(written.configured, true);
  assert.equal(await fs.promises.readFile(f.shared, 'utf8'), retained);
  const after = await fs.promises.stat(f.shared);
  assert.equal(after.ino, before.ino);
  if (unix) {
    assert.equal(after.mode & 0o777, 0o600);
    assert.equal((await fs.promises.stat(f.directory)).mode & 0o777, 0o700);
  }
});

test('CLI refuses conflicting input, environment, shared data, or public identity without overwriting', async t => {
  const f = await fixture(t);
  await f.write(f.shared, canonical());
  await f.write(f.legacy, 'OTHER_DUMMY_SECRET');
  for (const options of [
    { appKey: PUBLIC_KEY, secretFile: f.legacy },
    { env: environment({ ...pair, appSecret: 'OTHER_DUMMY_SECRET' }) },
    { appKey: 'other-public-app' },
  ]) {
    const checked = await f.configure(options);
    assert.equal(checked.consistent, false);
    assert.equal(checked.configured, false);
    await rejectsCode(f.configure({ ...options, write: true }), 'conflict');
    assert.equal(await fs.promises.readFile(f.shared, 'utf8'), canonical());
    assertPublicOutput(JSON.stringify(checked), [DUMMY_SECRET, 'OTHER_DUMMY_SECRET']);
  }
});

test('CLI reports missing identities/incomplete credentials and refuses permissive input', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.configure(), {
    configured: false, source: null, complete: false, consistent: true, permissions: 'absent',
  });
  await f.write(f.legacy, DUMMY_SECRET);
  assert.equal((await f.configure({ write: true })).complete, false);
  await assert.rejects(fs.promises.stat(f.shared), { code: 'ENOENT' });
  if (unix) {
    await fs.promises.chmod(f.legacy, 0o644);
    assert.equal((await f.configure({ appKey: PUBLIC_KEY })).permissions, 'insecure');
    await rejectsCode(f.configure({ appKey: PUBLIC_KEY, write: true }), 'permissions');
    await assert.rejects(fs.promises.stat(f.shared), { code: 'ENOENT' });
  }
});

test('concurrent dummy writes publish one complete canonical file and leave no temporary files', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.configure({ env: environment(), write: true })));
  assert.ok(results.every(result => result.configured));
  assert.equal(await fs.promises.readFile(f.shared, 'utf8'), canonical());
  assert.deepEqual(await fs.promises.readdir(f.directory), ['openapi-credentials.json']);
});

test('CLI rejects symlink parent directories before persisting', async t => {
  const f = await fixture(t);
  const elsewhere = path.join(f.homeDir, 'dummy-elsewhere');
  await fs.promises.mkdir(elsewhere);
  await fs.promises.rmdir(f.directory);
  await fs.promises.symlink(elsewhere, f.directory);
  await rejectsCode(f.configure({ env: environment(), write: true }), 'file');
  assert.deepEqual(await fs.promises.readdir(elsewhere), []);
});

test('argument parsing accepts only public key/path/mode, never a secret argument', () => {
  assert.deepEqual(parseArgs(['--app-key', PUBLIC_KEY, '--secret-file', '/dummy/path', '--write']),
    { appKey: PUBLIC_KEY, secretFile: '/dummy/path', write: true });
  for (const args of [
    [], ['--check', '--write'], ['--check', '--check'], ['--write', '--secret-file', 'relative'],
    ['--check', '--app-key'], ['--check', '--secret', 'dummy'], ['--check', '--app-secret', 'dummy'],
    ['--check', '--unknown'], ['--write', '--app-key', 'one', '--app-key', 'two'],
  ]) assert.throws(() => parseArgs(args), { code: 'arguments' });
});

test('testable CLI entry emits one public JSON object and fixed diagnostics only', async t => {
  const f = await fixture(t);
  await f.write(f.legacy, `KEY=${DUMMY_SECRET}`);
  for (const args of [
    ['--check', '--app-key', PUBLIC_KEY, '--secret-file', f.legacy],
    ['--write', '--app-key', PUBLIC_KEY, '--secret-file', f.legacy],
    ['--check'],
  ]) {
    let output = '';
    let diagnostic = '';
    assert.equal(await runCli(args, {
      env: {}, homeDir: f.homeDir, stdout: { write: value => { output += value; } },
      stderr: { write: value => { diagnostic += value; } },
    }), 0);
    assert.equal(output.trim().split('\n').length, 1);
    assert.equal(JSON.parse(output).configured, true);
    assert.equal(diagnostic, '');
    assertPublicOutput(output);
  }
  await f.write(f.shared, '{"' + DUMMY_SECRET);
  let output = '';
  let diagnostic = '';
  assert.equal(await runCli(['--check'], {
    env: {}, homeDir: f.homeDir, stdout: { write: value => { output += value; } },
    stderr: { write: value => { diagnostic += value; } },
  }), 1);
  assert.equal(JSON.parse(output).configured, false);
  assert.equal(diagnostic, 'Invalid Zhihu credential data.\n');
  assertPublicOutput(output + diagnostic);
});

test('real CLI process uses only a disposable HOME and never exposes dummy secrets on success/failure', async t => {
  const f = await fixture(t);
  await f.write(f.legacy, DUMMY_SECRET);
  // Do not inherit any actual credential variables. Secrets are never argv.
  const env = { HOME: f.homeDir, USERPROFILE: f.homeDir, PATH: process.env.PATH || '' };
  const script = path.resolve(__dirname, '../scripts/configure-zhihu-local.js');
  const invoke = args => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 10000 });
  for (const mode of ['--check', '--write']) {
    const child = invoke([mode, '--app-key', PUBLIC_KEY, '--secret-file', f.legacy]);
    assert.equal(child.status, 0, 'CLI should configure dummy credentials successfully');
    assert.equal(JSON.parse(child.stdout).configured, true);
    assert.equal(child.stderr, '');
    assertPublicOutput(child.stdout + child.stderr);
  }
  await f.write(f.shared, '{' + DUMMY_SECRET);
  for (const args of [['--check'], ['--write', '--secret-file', 'relative'], ['--secret', '--check']]) {
    const child = invoke(args);
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout).configured, false);
    assertPublicOutput(child.stdout + child.stderr);
  }
});
