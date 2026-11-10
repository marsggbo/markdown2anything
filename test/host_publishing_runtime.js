'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const { Publisher, submissionFingerprint, PLATFORMS } = require('../lib/publishing/runtime');
const { failure } = require('../lib/publishing/http');

const copy = value => JSON.parse(JSON.stringify(value));
const states = job => Object.fromEntries(Object.entries(job.targets).map(([p, target]) => [p, target.state]));
const config = (targets = PLATFORMS) => ({
  targets,
  title: 'Runtime test article',
  options: { cnblogs: { mode: 'publish', tags: ['runtime'] } },
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Exercise real persistence and locks, while replacing every external dependency.
async function fixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm2a-runtime-'));
  t.after(async () => {
    try {
      const files = await fs.promises.readdir(directory);
      assert.deepEqual(files.filter(file => /\.(?:lock|tmp)$/.test(file)), [], 'operations must release locks and temporary files');
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });
  const h = {
    directory,
    source: path.join(directory, 'mock-article.md'),
    fingerprint: 'original-document-fingerprint',
    calls: [],
    snapshots: [],
    credentialReads: [],
    requests: [],
    events: [],
    hooks: Object.fromEntries(PLATFORMS.map(platform => [platform, {}])),
    credentials: Object.fromEntries(PLATFORMS.map(platform => [platform, {
      account: `mock-${platform}`, secret: `MOCK_SECRET_${platform}`,
    }])),
  };
  h.notify = event => h.events.push(copy(event));
  h.count = (method, platform) => h.calls.filter(call =>
    call.method === method && (!platform || call.platform === platform)).length;
  const snapshot = async (sourcePath, input, options) => {
    h.snapshots.push(copy({ sourcePath, config: input, options }));
    return {
      title: 'Snapshot fallback title',
      fingerprint: h.fingerprint,
      platforms: Object.fromEntries(PLATFORMS.map(platform => [platform, {
        title: `${platform} title`, html: `<p>${platform} source</p>`, baseDir: directory,
      }])),
    };
  };
  const getCredentials = async platform => {
    h.credentialReads.push(platform);
    return copy(h.credentials[platform]);
  };
  const transport = async (url, options) => {
    const address = new URL(url);
    assert.equal(address.hostname, 'publishing.invalid', 'only the in-memory transport is allowed');
    h.requests.push({ url, options: copy(options) });
    const result = h.onRequest && await h.onRequest(address, options);
    if (result !== undefined) return result;
    const [, platform, operation] = address.pathname.split('/');
    if (operation === 'media') return { url: `https://media.invalid/${platform}.png` };
    assert.equal(operation, 'write', 'unexpected mock request');
    return {
      state: platform === 'wechat' ? 'draft' : 'published',
      id: `${platform}-article-id`, url: `https://publishing.invalid/${platform}/article`,
    };
  };
  const adapters = Object.fromEntries(PLATFORMS.map(platform => [platform, {
    validate(ctx) {
      h.calls.push({ method: 'validate', platform, ctx });
      assert.equal(ctx.request, transport);
      assert.deepEqual(ctx.credentials, h.credentials[platform]);
      assert.equal(ctx.article.title, `${platform} title`);
      if (h.hooks[platform].validate) h.hooks[platform].validate(ctx);
    },
    async prepare(ctx) {
      h.calls.push({ method: 'prepare', platform, ctx });
      if (h.hooks[platform].prepare) await h.hooks[platform].prepare(ctx);
      if (!ctx.mediaCache.image) {
        ctx.mediaCache.image = await ctx.request(`https://publishing.invalid/${platform}/media`, { method: 'POST' });
        await ctx.saveCache();
      }
      ctx.onProgress(`${platform} media ready`);
      return {
        html: `<p>${platform} preview</p>`,
        summary: { title: ctx.article.title, images: 1 },
        warnings: [`${platform} preview warning`],
        payload: { title: ctx.article.title, image: ctx.mediaCache.image.url },
      };
    },
    async execute(ctx) {
      h.calls.push({ method: 'execute', platform, ctx });
      assert.equal(ctx.request, transport);
      if (h.hooks[platform].execute) {
        const result = await h.hooks[platform].execute(ctx);
        if (result !== undefined) return result;
      }
      return ctx.request(`https://publishing.invalid/${platform}/write`, { method: 'POST', json: ctx.prepared.payload });
    },
  }]));
  h.publisher = () => new Publisher({ directory, getCredentials, snapshot, adapters, transport });
  h.p = h.publisher();
  h.read = async id => JSON.parse(await fs.promises.readFile(h.p.file(id), 'utf8'));
  h.prepare = (targets = PLATFORMS) => h.p.prepare(h.source, config(targets), { themeId: 'test-theme', notify: h.notify });
  return h;
}

test('prepare persists previews and media cache, emits progress, and never executes an article write', async t => {
  const h = await fixture(t);
  const job = await h.prepare();
  assert.deepEqual(states(job), { wechat: 'ready', zhihu: 'ready', cnblogs: 'ready' });
  assert.equal(h.count('validate'), 3);
  assert.equal(h.count('prepare'), 3);
  assert.equal(h.count('execute'), 0);
  assert.deepEqual(h.requests.map(call => new URL(call.url).pathname), ['/wechat/media', '/zhihu/media', '/cnblogs/media']);
  assert.deepEqual(h.credentialReads, PLATFORMS);
  assert.deepEqual(h.snapshots, [{
    sourcePath: h.source, config: job.config, options: { themeId: 'test-theme' },
  }]);
  const disk = await h.read(job.id);
  assert.equal(disk.fingerprint, h.fingerprint);
  assert.equal(disk.themeId, 'test-theme');
  for (const platform of PLATFORMS) {
    const target = disk.targets[platform];
    assert.deepEqual(target.mediaCache, { image: { url: `https://media.invalid/${platform}.png` } });
    assert.match(target.binding, /^[a-f0-9]{64}$/);
    assert.deepEqual(job.targets[platform].prepared, {
      html: target.prepared.html, summary: target.prepared.summary, warnings: target.prepared.warnings,
    });
    assert.ok(!Object.hasOwn(job.targets[platform].prepared, 'payload'));
    assert.ok(!Object.hasOwn(job.targets[platform], 'binding'));
    assert.ok(!Object.hasOwn(job.targets[platform], 'mediaCache'));
    assert.ok(h.events.some(event => event.type === 'progress' && event.platform === platform));
    assert.deepEqual(h.events.filter(event => event.type === 'job').map(event => event.job.targets[platform].state)
      .filter((state, i, all) => i === 0 || state !== all[i - 1]), ['pending', 'preparing', 'ready']);
  }
  assert.deepEqual(h.events.filter(event => event.type === 'busy').map(event => event.busy), [true, false]);
  for (const value of [disk, job, h.events]) {
    for (const credentials of Object.values(h.credentials)) assert.ok(!JSON.stringify(value).includes(credentials.secret));
  }
  // Public configuration is detached from the persisted job.
  job.config.options.cnblogs.tags.push('caller mutation');
  assert.deepEqual((await h.read(job.id)).config.options.cnblogs.tags, ['runtime']);
});

test('a validation failure is isolated; retry prepares only the failed platform before explicit execution', async t => {
  const h = await fixture(t);
  h.hooks.zhihu.validate = () => { throw failure('mock validation rejection'); };
  const job = await h.prepare();
  assert.deepEqual(states(job), { wechat: 'ready', zhihu: 'failed', cnblogs: 'ready' });
  assert.equal(job.targets.zhihu.message, 'mock validation rejection');
  assert.equal(h.count('prepare', 'zhihu'), 0);
  const partial = await h.p.execute(job.id, { confirmed: true });
  assert.deepEqual(states(partial), { wechat: 'draft', zhihu: 'failed', cnblogs: 'published' });
  delete h.hooks.zhihu.validate;
  const retried = await h.p.retry(job.id);
  assert.deepEqual(states(retried), { wechat: 'draft', zhihu: 'ready', cnblogs: 'published' });
  assert.deepEqual(PLATFORMS.map(p => h.count('prepare', p)), [1, 1, 1]);
  assert.equal(h.count('execute'), 2, 'retry must not execute');
  assert.deepEqual(h.snapshots.at(-1).options, { themeId: 'test-theme', render: true });
  const complete = await h.p.execute(job.id, { confirmed: true });
  assert.deepEqual(states(complete), { wechat: 'draft', zhihu: 'published', cnblogs: 'published' });
  assert.deepEqual(PLATFORMS.map(p => h.count('execute', p)), [1, 1, 1]);
});

test('execute requires literal confirmed=true before reading state, credentials, or taking a snapshot', async t => {
  const h = await fixture(t);
  const job = await h.prepare(['wechat']);
  const before = await fs.promises.readFile(h.p.file(job.id), 'utf8');
  for (const options of [undefined, {}, { confirmed: false }, { confirmed: 'true' }, { confirmed: 1 }, { confirmed: {} }]) {
    await assert.rejects(() => h.p.execute(job.id, options), /明确确认/);
  }
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.credentialReads.length, 1);
  assert.equal(h.count('execute'), 0);
  assert.equal(await fs.promises.readFile(h.p.file(job.id), 'utf8'), before);
  assert.deepEqual(await fs.promises.readdir(h.directory), [`${job.id}.json`]);
});

test('confirmed execute persists submitting before the write and consumes the persisted preview exactly once', async t => {
  const h = await fixture(t);
  const job = await h.prepare();
  const prepared = await h.read(job.id);
  for (const platform of PLATFORMS) {
    h.hooks[platform].execute = async ctx => {
      const disk = await h.read(job.id);
      assert.equal(disk.targets[platform].state, 'submitting', 'the durable boundary must precede external writes');
      assert.deepEqual(ctx.prepared, prepared.targets[platform].prepared);
      assert.deepEqual(ctx.mediaCache, prepared.targets[platform].mediaCache);
      assert.deepEqual(ctx.options, prepared.config.options[platform]);
      assert.equal(ctx.article, undefined, 'execution must not rebuild preview content');
    };
  }
  const complete = await h.p.execute(job.id, {
    confirmed: true, notify: h.notify, expectedSubmissionFingerprint: submissionFingerprint(prepared),
  });
  assert.deepEqual(states(complete), { wechat: 'draft', zhihu: 'published', cnblogs: 'published' });
  for (const platform of PLATFORMS) {
    assert.equal(complete.targets[platform].id, `${platform}-article-id`);
    assert.equal(complete.targets[platform].url, `https://publishing.invalid/${platform}/article`);
    assert.deepEqual(h.requests.find(call => call.url.endsWith(`/${platform}/write`)).options.json,
      prepared.targets[platform].prepared.payload);
  }
  assert.deepEqual(h.snapshots.at(-1).options, { themeId: 'test-theme', render: false });
  await h.publisher().execute(job.id, { confirmed: true });
  await assert.rejects(() => h.publisher().retry(job.id), /没有可重试/);
  assert.equal(h.count('execute'), 3, 'successful platforms must not be submitted again after restart');
  assert.equal(h.count('prepare'), 3);
});

const submissionMutations = {
  source: job => { job.sourcePath += '.replacement.md'; },
  title: job => { job.title = 'Replacement title'; },
  theme: job => { job.themeId = 'replacement-theme'; },
  'document fingerprint': job => { job.fingerprint = 'replacement-document'; },
  'platform options': job => { job.config.options.cnblogs.mode = 'draft'; },
  'ready set': job => { job.targets.wechat.state = 'unknown'; },
  'account binding': job => { job.targets.wechat.binding = 'replacement-binding'; },
  'prepared HTML': job => { job.targets.wechat.prepared.html += '<p>Replacement body</p>'; },
  'prepared payload': job => { job.targets.wechat.prepared.payload.title = 'Replacement payload only'; },
  'media attributes': job => { job.targets.wechat.prepared.payload.media.width = 640; },
  'media URL': job => { job.targets.wechat.prepared.payload.image = 'https://media.invalid/replacement.png'; },
  'prepared summary': job => { job.targets.wechat.prepared.summary.images = 99; },
  'prepared warnings': job => { job.targets.wechat.prepared.warnings.push('Changed prepared content'); },
};

for (const [name, mutate] of Object.entries(submissionMutations)) {
  test(`expected submission fingerprint rejects changed ${name} before any persisted transition or adapter call`, async t => {
    const h = await fixture(t);
    const job = await h.prepare();
    const prepared = await h.read(job.id);
    prepared.targets.wechat.prepared.payload.media = { width: 320, height: 180 };
    await h.p.save(prepared);
    const expectedSubmissionFingerprint = submissionFingerprint(prepared);
    mutate(prepared);
    await h.p.save(prepared);
    const before = await fs.promises.readFile(h.p.file(job.id), 'utf8');
    h.events.length = 0;
    await assert.rejects(() => h.p.execute(job.id, {
      confirmed: true, notify: h.notify, expectedSubmissionFingerprint,
    }), /待提交内容已变化.*重新同步/);
    assert.equal(h.count('execute'), 0);
    assert.equal(h.requests.length, 3, 'mismatch must not make any request after the initial mock uploads');
    assert.equal(h.snapshots.length, 1, 'reject before taking another snapshot');
    assert.deepEqual(h.credentialReads, PLATFORMS, 'reject before reading credentials again');
    assert.equal(await fs.promises.readFile(h.p.file(job.id), 'utf8'), before);
    assert.deepEqual(h.events.filter(event => event.type === 'job'), [], 'never persist submitting on mismatch');
    assert.equal(h.p.running, false);
    assert.deepEqual(h.events.filter(event => event.type === 'busy').map(event => event.busy), [true, false]);
  });
}

test('submission mismatch is checked inside the real lock after the final persisted payload reread', async t => {
  const h = await fixture(t);
  const job = await h.prepare(['wechat']);
  // The caller has already rechecked exactly what the user confirmed.
  const expectedSubmissionFingerprint = submissionFingerprint(await h.p.read(job.id));
  const originalLock = h.p.lock.bind(h.p);
  let swappedBytes;
  h.p.lock = (id, action) => originalLock(id, async () => {
    assert.ok((await fs.promises.stat(`${h.p.file(id)}.lock`)).isFile());
    const swapped = await h.read(id);
    swapped.targets.wechat.prepared.payload.image = 'https://media.invalid/swapped-after-host-check.png';
    swappedBytes = JSON.stringify(swapped);
    await fs.promises.writeFile(h.p.file(id), swappedBytes);
    return action();
  });
  h.events.length = 0;
  await assert.rejects(() => h.p.execute(job.id, {
    confirmed: true, expectedSubmissionFingerprint, notify: h.notify,
  }), /待提交内容已变化/);
  assert.equal(h.count('execute'), 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.snapshots.length, 1);
  assert.deepEqual(h.credentialReads, ['wechat']);
  assert.equal(await fs.promises.readFile(h.p.file(job.id), 'utf8'), swappedBytes);
  assert.equal((await h.read(job.id)).targets.wechat.state, 'ready');
  assert.deepEqual(h.events.filter(event => event.type === 'job'), []);
});

test('a submission mismatch also blocks saving crash recovery before any submission', async t => {
  const h = await fixture(t);
  const job = await h.prepare();
  const interrupted = await h.read(job.id);
  interrupted.targets.zhihu.state = 'submitting';
  await h.p.save(interrupted);
  const expectedSubmissionFingerprint = submissionFingerprint(interrupted);
  interrupted.targets.wechat.prepared.payload.title = 'Unconfirmed replacement';
  await h.p.save(interrupted);
  const before = await fs.promises.readFile(h.p.file(job.id), 'utf8');
  let saves = 0;
  const save = h.p.save.bind(h.p);
  h.p.save = async (...args) => { saves++; return save(...args); };
  await assert.rejects(() => h.p.execute(job.id, { confirmed: true, expectedSubmissionFingerprint }), /待提交内容已变化/);
  assert.equal(saves, 0, 'even recovered states must not be saved until the submitted content matches');
  assert.equal(h.count('execute'), 0);
  assert.equal(await fs.promises.readFile(h.p.file(job.id), 'utf8'), before);
  assert.equal((await h.read(job.id)).targets.zhihu.state, 'submitting');
});

test('matching submission fingerprint tolerates progress updates and submits the original prepared payload', async t => {
  const h = await fixture(t);
  const job = await h.prepare(['wechat']);
  const prepared = await h.read(job.id);
  const expectedSubmissionFingerprint = submissionFingerprint(prepared);
  prepared.targets.wechat.message = 'Updated progress message';
  prepared.targets.wechat.mediaCache.unused = { progress: 'complete' };
  await h.p.save(prepared);
  const result = await h.p.execute(job.id, { confirmed: true, expectedSubmissionFingerprint });
  assert.equal(result.targets.wechat.state, 'draft');
  assert.equal(h.count('execute'), 1);
  assert.deepEqual(h.requests.find(call => call.url.endsWith('/write')).options.json, prepared.targets.wechat.prepared.payload);
});

test('a timed-out write stays unknown across execute, retry, list, and a new Publisher', async t => {
  const h = await fixture(t);
  h.onRequest = address => {
    if (address.pathname === '/zhihu/write') throw failure('mock write timeout', false);
  };
  const job = await h.prepare(['zhihu']);
  const result = await h.p.execute(job.id, { confirmed: true });
  assert.equal(result.targets.zhihu.state, 'unknown');
  assert.equal(result.targets.zhihu.message, 'mock write timeout');
  const restarted = h.publisher();
  assert.equal((await restarted.list(h.source))[0].targets.zhihu.state, 'unknown');
  assert.equal((await restarted.execute(job.id, { confirmed: true })).targets.zhihu.state, 'unknown');
  await assert.rejects(() => restarted.retry(job.id), /没有可重试/);
  assert.equal((await h.read(job.id)).targets.zhihu.state, 'unknown');
  assert.equal(h.count('execute'), 1);
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.requests.filter(call => call.url.endsWith('/write')).length, 1);
});

test('partial execution continues after unknown and definitive failures; retry skips successful and unknown targets', async t => {
  const h = await fixture(t);
  h.onRequest = address => {
    if (address.pathname === '/zhihu/write') throw failure('mock disconnected response', false);
    if (address.pathname === '/cnblogs/write') throw failure('mock platform rejection');
  };
  const job = await h.prepare();
  const partial = await h.p.execute(job.id, { confirmed: true });
  assert.deepEqual(states(partial), { wechat: 'draft', zhihu: 'unknown', cnblogs: 'failed' });
  h.onRequest = undefined;
  const retried = await h.publisher().retry(job.id);
  assert.deepEqual(states(retried), { wechat: 'draft', zhihu: 'unknown', cnblogs: 'ready' });
  assert.deepEqual(PLATFORMS.map(p => h.count('prepare', p)), [1, 1, 2]);
  assert.equal(h.count('execute'), 3, 'repreparing must not perform a write');
  assert.equal(h.requests.filter(call => call.url.endsWith('/media')).length, 3, 'retry must reuse persisted media cache');
  const complete = await h.publisher().execute(job.id, { confirmed: true });
  assert.deepEqual(states(complete), { wechat: 'draft', zhihu: 'unknown', cnblogs: 'published' });
  assert.deepEqual(PLATFORMS.map(p => h.count('execute', p)), [1, 1, 2]);
});

test('malformed success responses and unclassified errors are unknown and cannot be retried', async t => {
  const h = await fixture(t);
  for (const outcome of [null, {}, { state: 'published' }, { state: 'ready', id: 'invalid' }, new Error('unclassified timeout')]) {
    h.hooks.zhihu.execute = () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    const job = await h.prepare(['zhihu']);
    const result = await h.p.execute(job.id, { confirmed: true });
    assert.equal(result.targets.zhihu.state, 'unknown');
    await assert.rejects(() => h.publisher().retry(job.id), /没有可重试/);
    await h.publisher().execute(job.id, { confirmed: true });
  }
  assert.equal(h.count('execute'), 5);
  assert.equal(h.requests.filter(call => call.url.endsWith('/write')).length, 0);
});

test('changed credentials block writes and media reuse; a new job can bind the new credentials', async t => {
  const h = await fixture(t);
  const job = await h.prepare(['wechat']);
  const original = (await h.read(job.id)).targets.wechat;
  h.credentials.wechat = { account: 'different-account', secret: 'DIFFERENT_MOCK_SECRET' };
  const blocked = await h.p.execute(job.id, { confirmed: true });
  assert.equal(blocked.targets.wechat.state, 'failed');
  assert.match(blocked.targets.wechat.message, /账号凭证已变化/);
  const retry = await h.p.retry(job.id);
  assert.equal(retry.targets.wechat.state, 'failed');
  assert.match(retry.targets.wechat.message, /账号凭证已变化/);
  assert.equal(h.count('execute'), 0);
  assert.equal(h.count('prepare'), 1, 'old cache must never be supplied to the replacement account');
  assert.equal(h.requests.length, 1);
  assert.equal((await h.read(job.id)).targets.wechat.binding, original.binding);
  const replacement = await h.prepare(['wechat']);
  assert.equal(replacement.targets.wechat.state, 'ready');
  assert.notEqual((await h.read(replacement.id)).targets.wechat.binding, original.binding);
  assert.equal((await h.p.execute(replacement.id, { confirmed: true })).targets.wechat.state, 'draft');
});

test('missing credentials fail that target before adapter validation, preparation, or execution', async t => {
  const h = await fixture(t);
  h.credentials.zhihu = null;
  const job = await h.prepare(['zhihu', 'cnblogs']);
  assert.deepEqual(states(job), { zhihu: 'failed', cnblogs: 'ready' });
  assert.match(job.targets.zhihu.message, /账号凭证/);
  assert.equal(h.count('validate', 'zhihu'), 0);
  assert.equal(h.count('prepare', 'zhihu'), 0);
  h.credentials.cnblogs = null;
  const result = await h.p.execute(job.id, { confirmed: true });
  assert.equal(result.targets.cnblogs.state, 'failed');
  assert.equal(h.count('execute'), 0);
});

test('stale fingerprint rejects execute without altering the ready preview or contacting adapters', async t => {
  const h = await fixture(t);
  const job = await h.prepare(['wechat']);
  const before = await h.read(job.id);
  h.fingerprint = 'changed-source-image-cover-or-theme';
  await assert.rejects(() => h.p.execute(job.id, { confirmed: true, notify: h.notify }), /已变化/);
  assert.deepEqual(await h.read(job.id), before);
  assert.equal(h.count('execute'), 0);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.snapshots.at(-1).options, { themeId: 'test-theme', render: false });
  assert.equal(h.p.running, false);
  assert.deepEqual(h.events.filter(event => event.type === 'busy').slice(-2).map(event => event.busy), [true, false]);
});

test('stale fingerprint rejects retry without preparing a failed target or reuploading cached media', async t => {
  const h = await fixture(t);
  h.hooks.cnblogs.prepare = ctx => {
    ctx.mediaCache.previousUpload = { url: 'https://media.invalid/already-uploaded.png' };
    throw failure('mock preparation failure');
  };
  const job = await h.prepare(['cnblogs']);
  assert.equal(job.targets.cnblogs.state, 'failed');
  const before = await h.read(job.id);
  h.fingerprint = 'changed-document';
  delete h.hooks.cnblogs.prepare;
  await assert.rejects(() => h.p.retry(job.id), /已变化/);
  assert.deepEqual(await h.read(job.id), before);
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.snapshots.at(-1).options, { themeId: 'test-theme', render: true });
});

test('crash recovery persists submitting as unknown, preparing/pending as failed, and safely resumes only preparation', async t => {
  const h = await fixture(t);
  const job = await h.prepare();
  const interrupted = await h.read(job.id);
  interrupted.targets.wechat.state = 'submitting';
  interrupted.targets.zhihu.state = 'preparing';
  interrupted.targets.cnblogs.state = 'pending';
  // Simulate an interrupted process by leaving its durable states on disk.
  await h.p.save(interrupted);
  const restarted = h.publisher();
  const recovered = await restarted.list(h.source);
  assert.equal(recovered.length, 1);
  assert.deepEqual(states(recovered[0]), { wechat: 'unknown', zhihu: 'failed', cnblogs: 'failed' });
  assert.match(recovered[0].targets.wechat.message, /不会自动重发/);
  assert.match(recovered[0].targets.zhihu.message, /可重试/);
  assert.deepEqual(states(await h.read(job.id)), states(recovered[0]));
  assert.equal(h.count('execute'), 0);
  const retried = await restarted.retry(job.id);
  assert.deepEqual(states(retried), { wechat: 'unknown', zhihu: 'ready', cnblogs: 'ready' });
  assert.deepEqual(PLATFORMS.map(p => h.count('prepare', p)), [1, 2, 2]);
  assert.equal(h.count('execute'), 0);
  await restarted.execute(job.id, { confirmed: true });
  assert.deepEqual(PLATFORMS.map(p => h.count('execute', p)), [0, 1, 1]);
  assert.equal(h.requests.filter(call => call.url.endsWith('/media')).length, 3);
});

test('execute itself recovers an interrupted submission without resending it', async t => {
  const h = await fixture(t);
  const job = await h.prepare(['zhihu']);
  const interrupted = await h.read(job.id);
  interrupted.targets.zhihu.state = 'submitting';
  await h.p.save(interrupted);
  const result = await h.publisher().execute(job.id, { confirmed: true });
  assert.equal(result.targets.zhihu.state, 'unknown');
  assert.equal((await h.read(job.id)).targets.zhihu.state, 'unknown');
  assert.equal(h.count('execute'), 0);
  await assert.rejects(() => h.publisher().retry(job.id), /没有可重试/);
});

test('a live job lock prevents another Publisher from executing, retrying, or falsely recovering an in-flight write', { timeout: 10000 }, async t => {
  const h = await fixture(t);
  const job = await h.prepare(['wechat']);
  const entered = deferred();
  const release = deferred();
  h.hooks.wechat.execute = async () => {
    entered.resolve();
    await release.promise;
  };
  const active = h.p.execute(job.id, { confirmed: true });
  // Always release the held operation, including when an assertion fails.
  try {
    await Promise.race([entered.promise, active.then(() => assert.fail('write did not reach the gate'))]);
    const other = h.publisher();
    assert.equal((await h.read(job.id)).targets.wechat.state, 'submitting');
    await assert.rejects(() => other.execute(job.id, { confirmed: true }), /另一个窗口|锁尚未就绪/);
    await assert.rejects(() => other.retry(job.id), /另一个窗口|锁尚未就绪/);
    const listed = await other.list(h.source);
    assert.equal(listed[0].targets.wechat.state, 'submitting', 'a live write is not an interrupted write');
    assert.equal((await h.read(job.id)).targets.wechat.state, 'submitting');
    assert.equal(h.count('execute'), 1);
    assert.equal(other.running, false, 'lock rejection must release the instance busy flag');
  } finally {
    release.resolve();
    await active;
  }
  assert.equal((await h.read(job.id)).targets.wechat.state, 'draft');
  await h.publisher().execute(job.id, { confirmed: true });
  assert.equal(h.count('execute'), 1);
});

test('one Publisher rejects concurrent operations even for a different job', { timeout: 10000 }, async t => {
  const h = await fixture(t);
  const first = await h.prepare(['wechat']);
  const second = await h.prepare(['cnblogs']);
  const entered = deferred();
  const release = deferred();
  h.hooks.wechat.execute = async () => {
    entered.resolve();
    await release.promise;
  };
  const active = h.p.execute(first.id, { confirmed: true, notify: h.notify });
  try {
    await Promise.race([entered.promise, active.then(() => assert.fail('write did not reach the gate'))]);
    await assert.rejects(() => h.p.execute(second.id, { confirmed: true }), /另一个同步任务/);
    await assert.rejects(() => h.p.retry(second.id), /另一个同步任务/);
    await assert.rejects(() => h.prepare(['zhihu']), /另一个同步任务/);
    assert.equal(h.count('execute', 'cnblogs'), 0);
    assert.equal((await h.read(second.id)).targets.cnblogs.state, 'ready');
  } finally {
    release.resolve();
    await active;
  }
  assert.equal(h.p.running, false);
  assert.deepEqual(h.events.filter(event => event.type === 'busy').slice(-2).map(event => event.busy), [true, false]);
  assert.equal((await h.p.execute(second.id, { confirmed: true })).targets.cnblogs.state, 'published');
});

test('a dead process lock is reclaimed before recovery; its interrupted write remains unknown', async t => {
  const h = await fixture(t);
  const job = await h.prepare(['zhihu']);
  const interrupted = await h.read(job.id);
  interrupted.targets.zhihu.state = 'submitting';
  await h.p.save(interrupted);
  // Obtain a real exited PID instead of assuming an arbitrary PID is unused.
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await fs.promises.writeFile(`${h.p.file(job.id)}.lock`, JSON.stringify({ pid: child.pid }), { mode: 0o600 });
  const result = await h.publisher().list(h.source);
  assert.equal(result[0].targets.zhihu.state, 'unknown');
  assert.equal((await h.read(job.id)).targets.zhihu.state, 'unknown');
  assert.equal(h.count('execute'), 0);
});
