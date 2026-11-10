'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { test, before, after } = require('node:test');

const documentModule = require.resolve('../lib/publishing/document');
const documentWasLoaded = !!require.cache[documentModule];
const { createPublishingHost } = require('../lib/publishing/vscode-host');
const { normalizeConfig, publicJob, submissionFingerprint, PLATFORMS } = require('../lib/publishing/runtime');

const SECRET_PREFIX = 'markdown2anything.publishing.';
const DEFAULTS_KEY = 'publishing.defaults.v1';
const LOCAL_DISABLED_KEY = 'publishing.zhihu.localDisabled.v1';
const copy = value => JSON.parse(JSON.stringify(value));
const config = () => ({
  targets: ['wechat', 'zhihu', 'cnblogs'],
  title: 'Preview title',
  options: { cnblogs: { mode: 'publish', postId: 'current-post' } },
});
const credentials = {
  wechat: { appId: 'mock-wechat', appSecret: 'TEST_ONLY_WECHAT_SECRET_724b' },
  zhihu: { appKey: 'mock-zhihu', appSecret: 'TEST_ONLY_ZHIHU_SECRET_83d1' },
  cnblogs: { blogName: 'mock-blog', username: 'mock-user', token: 'TEST_ONLY_BLOG_TOKEN_919e' },
};
const localCredentials = {
  credentials: { appKey: 'mock-local-zhihu', appSecret: 'TEST_ONLY_LOCAL_ZHIHU_SECRET_458a' },
  source: 'shared-file', sourceLabel: 'Mock shared local credential file',
};

// Fail closed even if a future host change bypasses the injected transport.
const networkMethods = [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [global, 'fetch']];
const originalNetwork = networkMethods.map(([owner, key]) => owner[key]);
const networkAttempts = [];
before(() => {
  for (const [owner, key] of networkMethods) owner[key] = () => {
    networkAttempts.push(key);
    assert.fail('Host tests must never access the network');
  };
});
after(() => {
  networkMethods.forEach(([owner, key], index) => { owner[key] = originalNetwork[index]; });
  assert.deepEqual(networkAttempts, [], 'no host action may bypass the offline transport');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function event() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    async emit(value) {
      for (const listener of [...listeners]) await listener(value);
    },
  };
}

// Only the host is real. All publishing, account, VS Code, and transport operations
// terminate in these mocks; sources and mock job storage live in a disposable directory.
async function fixture(t, {
  trusted = true, defaults, resolveLocalCredentials = async () => null,
  testZhihuUpload = async () => assert.fail('Unexpected upload diagnostic'),
} = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm2a-vscode-host-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'article.md');
  const otherSource = path.join(directory, 'other.md');
  const storage = path.join(directory, 'host-storage');
  await fs.promises.mkdir(storage);
  await fs.promises.writeFile(source, '---\ntitle: Actual frontmatter title\n---\n# Heading title\n\nBody.\n');
  await fs.promises.writeFile(otherSource, '# Other document\n\nOther body.\n');

  const h = {
    directory, source, otherSource, storage,
    calls: [], panels: [], jobs: new Map(), hooks: {},
    secretValues: new Map(), secretWrites: [], secretReads: [], secretDeletes: [],
    state: new Map(defaults ? [[DEFAULTS_KEY, copy(defaults)]] : []), stateWrites: [],
    warnings: [], errors: [], external: [], dialogs: [], requests: [], checks: [],
    localResolutions: [], snapshots: [], validations: [], adapterWrites: [], media: [], uploadTests: [],
    themeId: 'test-theme', modalResponse: undefined, saves: [], resolutions: [],
    textChanges: event(), secretChanges: event(),
  };
  h.count = method => h.calls.filter(call => call.method === method).length;
  h.context = {
    extensionPath: path.resolve(__dirname, '..'),
    globalStorageUri: { fsPath: storage },
    subscriptions: [],
    secrets: {
      async get(key) { h.secretReads.push(key); return h.secretValues.get(key); },
      async store(key, value) { h.secretWrites.push({ key, value }); h.secretValues.set(key, value); },
      async delete(key) { h.secretDeletes.push(key); h.secretValues.delete(key); },
      onDidChange: listener => h.secretChanges.subscribe(listener),
    },
    globalState: {
      get: key => h.state.has(key) ? copy(h.state.get(key)) : undefined,
      async update(key, value) { h.stateWrites.push({ key, value: copy(value) }); h.state.set(key, copy(value)); },
    },
  };
  h.vscode = {
    ViewColumn: { Beside: 2 },
    Uri: { parse: value => ({ toString: () => value }) },
    workspace: {
      isTrusted: trusted,
      textDocuments: [],
      onDidChangeTextDocument: listener => h.textChanges.subscribe(listener),
    },
    window: {
      createWebviewPanel(viewType, title, column, options) {
        const received = event();
        const disposed = event();
        const panel = {
          viewType, title, column, options, messages: [], reveals: 0,
          webview: {
            html: '',
            async postMessage(message) { panel.messages.push(copy(message)); return true; },
            onDidReceiveMessage: listener => received.subscribe(listener),
          },
          receive: message => received.emit(message),
          onDidDispose: listener => disposed.subscribe(listener),
          reveal() { panel.reveals++; },
          dispose: () => disposed.emit(),
        };
        h.panels.push(panel);
        return panel;
      },
      async showWarningMessage(...args) {
        h.warnings.push(args);
        return h.hooks.modal ? h.hooks.modal(...args) : h.modalResponse;
      },
      async showErrorMessage(message) { h.errors.push(message); },
      async showOpenDialog(options) { h.dialogs.push(options); return h.coverSelection; },
    },
    env: { async openExternal(uri) { h.external.push(uri.toString()); return true; } },
  };
  h.transport = async (...args) => {
    h.requests.push(args);
    throw new Error('Unexpected transport call: host tests must remain offline');
  };
  h.adapters = Object.fromEntries(PLATFORMS.map(platform => [platform, {
    async validate(ctx) {
      h.validations.push({ platform, ...ctx });
      return h.hooks.validate ? h.hooks.validate(platform, ctx) : { valid: true };
    },
    async check(ctx) {
      h.checks.push({ platform, ...ctx });
      return h.hooks.check ? h.hooks.check(platform, ctx) : { verified: true, message: 'Mock account verified' };
    },
    async prepare() {
      h.adapterWrites.push({ platform, method: 'prepare' });
      assert.fail('Host must delegate preparation to the injected PublisherClass');
    },
    async execute() {
      h.adapterWrites.push({ platform, method: 'execute' });
      assert.fail('Host must delegate execution to the injected PublisherClass');
    },
    async upload() { h.media.push(platform); assert.fail('Readiness must not upload media'); },
  }]));

  class MockPublisher {
    constructor(options) {
      assert.equal(h.publisher, undefined, 'construct one injected publisher per host');
      this.options = options;
      this.running = false;
      this.snapshot = async (sourcePath, input, options) => {
        h.snapshots.push({ sourcePath, input: copy(input), options: copy(options) });
        if (h.hooks.snapshot) return h.hooks.snapshot(sourcePath, input, options);
        return {
          platforms: Object.fromEntries(input.targets.map(platform => [platform, {
            title: input.options[platform].title || input.title || 'Mock article title',
            html: '<p>Mock local article body for readiness checks.</p>',
            coverPath: platform === 'wechat' ? input.coverPath : '',
            baseDir: path.dirname(sourcePath),
          }])),
        };
      };
      h.publisher = this;
      fs.mkdirSync(options.directory, { recursive: true });
    }
    async persist(job) {
      h.jobs.set(job.id, copy(job));
      await fs.promises.writeFile(path.join(this.options.directory, `${job.id}.json`), JSON.stringify(job));
      return publicJob(job);
    }
    async read(id) {
      h.calls.push({ method: 'read', id });
      return JSON.parse(await fs.promises.readFile(path.join(this.options.directory, `${id}.json`), 'utf8'));
    }
    async list(sourcePath) {
      h.calls.push({ method: 'list', sourcePath });
      return [...h.jobs.values()].filter(job => job.sourcePath === sourcePath).map(publicJob);
    }
    async prepare(sourcePath, input, options) {
      h.calls.push({ method: 'prepare', sourcePath, input: copy(input), options });
      if (h.hooks.prepare) await h.hooks.prepare(sourcePath, input, options);
      options.notify({ type: 'busy', busy: true });
      options.notify({ type: 'progress', platform: 'wechat', message: 'Mock preview prepared' });
      const job = h.makeJob(sourcePath, input, options.themeId);
      if (h.hooks.preparedJob) await h.hooks.preparedJob(job);
      return this.persist(job);
    }
    async retry(id, notify) {
      h.calls.push({ method: 'retry', id, notify });
      notify({ type: 'progress', platform: 'wechat', message: 'Mock retry prepared' });
      return publicJob(h.jobs.get(id));
    }
    async freshSnapshot(job, render) {
      h.calls.push({ method: 'freshSnapshot', id: job.id, render });
      if (h.hooks.freshSnapshot) return h.hooks.freshSnapshot(job, render);
      return { fingerprint: 'mock-current-source' };
    }
    async execute(id, options) {
      h.calls.push({ method: 'execute', id, options });
      assert.equal(options.confirmed, true, 'only native modal confirmation can authorize execution');
      assert.match(options.expectedSubmissionFingerprint, /^[a-f0-9]{64}$/, 'host execution must bind native confirmation to the submission');
      if (h.hooks.execute) await h.hooks.execute(id, options);
      const job = await this.read(id);
      if (submissionFingerprint(job) !== options.expectedSubmissionFingerprint) {
        throw new Error('待提交内容已变化，请重新同步并确认');
      }
      for (const [platform, target] of Object.entries(job.targets)) {
        if (target.state === 'ready') target.state = platform === 'wechat' ? 'draft' : 'published';
      }
      return this.persist(job);
    }
  }
  h.makeJob = (sourcePath = source, input = config(), themeId = h.themeId) => {
    const normalized = normalizeConfig(input);
    return {
      id: crypto.randomUUID(), sourcePath, title: normalized.title || 'Mock job title',
      config: normalized, themeId, createdAt: '2026-11-04T00:00:00Z',
      targets: Object.fromEntries(normalized.targets.map(platform => [platform, {
        state: 'ready', prepared: { html: '<p>Mock preview</p>', summary: { images: 0 } },
      }])),
    };
  };
  h.seedJob = async (...args) => {
    const job = h.makeJob(...args);
    await h.publisher.persist(job);
    return job;
  };
  h.dirtyDocument = (sourcePath = source, saveResult = false) => {
    const document = {
      uri: { fsPath: sourcePath }, isDirty: true,
      async save() {
        h.saves.push(sourcePath);
        if (saveResult) {
          await fs.promises.writeFile(sourcePath, '# Saved editor title\n\nSaved editor body.\n');
          document.isDirty = false;
        }
        return saveResult;
      },
    };
    h.vscode.workspace.textDocuments.push(document);
    return document;
  };
  h.host = createPublishingHost({
    vscode: h.vscode, context: h.context, PublisherClass: MockPublisher,
    adapters: h.adapters, transport: h.transport,
    testZhihuUpload: async options => {
      h.uploadTests.push(options);
      return testZhihuUpload(options);
    },
    resolveLocalCredentials: async () => {
      h.localResolutions.push('zhihu');
      return resolveLocalCredentials();
    },
    resolveSource: async value => { h.resolutions.push(value); return value; },
    getThemeId: () => h.themeId,
  });
  t.after(() => {
    h.host.dispose();
    for (const subscription of h.context.subscriptions) subscription.dispose();
    assert.deepEqual(h.requests, [], 'no transport or real account calls are permitted');
  });
  h.open = async (sourcePath = source, options) => {
    const panel = await h.host.open(sourcePath, options);
    assert.ok(panel, `expected open() to return its panel: ${h.errors.join(', ')}`);
    return panel;
  };
  return h;
}

const messages = (panel, type) => panel.messages.filter(message => message.type === type);
function expectError(panel, pattern) {
  const error = messages(panel, 'error').at(-1);
  assert.ok(error, 'expected an error posted through the webview');
  assert.match(error.message, pattern);
}
function expectAccount(panel, success) {
  const result = messages(panel, 'accountResult').at(-1);
  assert.ok(result, 'expected an accountResult posted through the webview');
  assert.equal(result.success, success, result.message);
  return result;
}
function assertNoSecrets(h) {
  const publicData = JSON.stringify({
    panels: h.panels.map(panel => ({ html: panel.webview.html, messages: panel.messages })),
    globalState: [...h.state], writes: h.stateWrites, errors: h.errors, warnings: h.warnings,
  });
  for (const value of [...Object.values(credentials), localCredentials.credentials]) {
    assert.ok(!publicData.includes(value.appSecret || value.token), 'secret escaped SecretStorage into public host output');
  }
}

function expectTestResult(panel, platform, status) {
  const result = messages(panel, 'testResult').find(message => message.platform === platform);
  assert.ok(result, `expected a structured testResult for ${platform}`);
  assert.deepEqual(Object.keys(result).sort(), [
    'type', 'platform', 'status', 'message', 'checks', 'durationMs', 'checkedAt',
  ].sort());
  assert.equal(result.status, status);
  assert.equal(typeof result.message, 'string');
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt);
  assert.ok(result.checks.length > 0);
  for (const check of result.checks) {
    assert.deepEqual(Object.keys(check).sort(), ['label', 'message', 'status']);
    assert.equal(typeof check.label, 'string');
    assert.equal(typeof check.message, 'string');
    assert.ok(['passed', 'warning', 'failed'].includes(check.status));
  }
  const expectedStatus = result.checks.some(check => check.status === 'failed') ? 'failed' :
    result.checks.some(check => check.status === 'warning') ? 'warning' : 'passed';
  if (platform === 'zhihu' && result.status === 'passed' &&
      result.checks.some(check => check.label === 'image-upload' && check.status === 'passed')) {
    // A successful image diagnostic still warns that article publishing was not tested.
    assert.ok(!result.checks.some(check => check.status === 'failed'));
  } else assert.equal(result.status, expectedStatus, 'overall status must reflect the individual checks');
  return result;
}

async function assertReadinessOnly(h) {
  assert.deepEqual(h.calls, [], 'readiness must not list/read/create/prepare/retry/execute publishing jobs');
  assert.equal(h.jobs.size, 0);
  assert.deepEqual(await fs.promises.readdir(h.publisher.options.directory), []);
  assert.deepEqual(h.media, []);
  assert.deepEqual(h.adapterWrites, [], 'readiness must not call adapter prepare or execute, even if their errors are caught');
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.secretWrites, []);
  assert.deepEqual(h.secretDeletes, []);
  assert.deepEqual(h.stateWrites, []);
  assert.deepEqual(h.warnings, [], 'readiness must not ask for publishing confirmation');
  for (const panel of h.panels) assert.deepEqual(messages(panel, 'job'), []);
  assertNoSecrets(h);
}

function uploadDiagnosticResult() {
  return {
    platform: 'zhihu', status: 'passed', message: '测试图上传成功；本次未发布文章',
    checks: [
      { label: 'image-upload', status: 'passed', message: 'Mock image accepted' },
      { label: 'publishing', status: 'warning', message: '未调用文章发布接口' },
    ],
    checkedAt: '2026-11-05T00:00:00.000Z', durationMs: 1,
  };
}

function expectUploadResult(panel, status) {
  const results = messages(panel, 'uploadTestResult');
  assert.equal(results.length, 1);
  const result = results[0];
  assert.deepEqual(Object.keys(result).sort(), [
    'type', 'platform', 'status', 'message', 'checks', 'durationMs', 'checkedAt',
  ].sort());
  assert.equal(result.platform, 'zhihu');
  assert.equal(result.status, status);
  assert.equal(typeof result.message, 'string');
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt);
  assert.ok(result.checks.some(check => check.label === 'image-upload' && check.status === status));
  assert.deepEqual(messages(panel, 'uploadTestComplete'), [{ type: 'uploadTestComplete' }]);
  assert.equal(panel.messages.at(-1).type, 'uploadTestComplete');
  assert.deepEqual(messages(panel, 'error'), []);
  assert.deepEqual(messages(panel, 'testsComplete'), []);
  return result;
}

async function assertUploadOnly(h) {
  assert.deepEqual(h.calls, [], 'upload test must not list/read/prepare/retry/execute jobs');
  assert.equal(h.jobs.size, 0);
  assert.deepEqual(await fs.promises.readdir(h.publisher.options.directory), []);
  assert.deepEqual(h.snapshots, []);
  assert.deepEqual(h.validations, []);
  assert.deepEqual(h.checks, []);
  assert.deepEqual(h.adapterWrites, []);
  assert.deepEqual(h.media, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.secretWrites, []);
  assert.deepEqual(h.secretDeletes, []);
  assert.deepEqual(h.stateWrites, []);
  for (const panel of h.panels) assert.deepEqual(messages(panel, 'job'), []);
  assertNoSecrets(h);
}

for (const scope of [null, 'zhihu']) {
  test(`testZhihuUpload in ${scope || 'multi-platform'} scope waits for native confirmation and uploads once with saved credentials`, { timeout: 5000 }, async t => {
    const { runZhihuUploadTest } = require('../lib/publishing/zhihu-diagnostic');
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const uploads = [];
    const h = await fixture(t, {
      testZhihuUpload: options => runZhihuUploadTest({
        ...options,
        uploadImage: async (ctx, asset, options) => {
          uploads.push({ ctx, asset, options });
          return { url: 'https://pic.example.test/mock-upload.png' };
        },
      }),
    });
    h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
    const panel = await h.open(h.source, { platform: scope });
    h.dirtyDocument();
    await fs.promises.unlink(h.source);
    h.hooks.modal = async () => {
      entered.resolve();
      await release.promise;
      return '上传测试图';
    };
    const pending = panel.receive({
      type: 'testZhihuUpload', confirmed: true, jobId: 'untrusted-job',
      credentials: { appKey: 'webview-account', appSecret: 'webview-secret' },
      config: { targets: ['invalid-platform'], options: { zhihu: { topics: ['bad topic'] } } },
    });
    await entered.promise;
    assert.equal(h.uploadTests.length, 0, 'webview confirmation cannot authorize an upload');
    assert.equal(uploads.length, 0);
    assert.deepEqual(messages(panel, 'uploadTestComplete'), []);
    assert.equal(h.warnings.length, 1);
    const [title, options, ...buttons] = h.warnings[0];
    assert.match(title, /知乎.*上传/);
    assert.equal(options.modal, true);
    assert.match(options.detail, /320.*180/);
    assert.ok(options.detail.includes(credentials.zhihu.appKey));
    assert.deepEqual(buttons, ['上传测试图']);
    release.resolve();
    await pending;
    assert.equal(h.uploadTests.length, 1);
    assert.deepEqual(Object.keys(h.uploadTests[0]).sort(), ['credentials', 'request']);
    assert.deepEqual(h.uploadTests[0].credentials, credentials.zhihu);
    assert.equal(h.uploadTests[0].request, h.transport);
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].ctx.credentials, credentials.zhihu);
    assert.equal(uploads[0].ctx.request, h.transport);
    assert.ok(uploads[0].options.warnings instanceof Set);
    const result = expectUploadResult(panel, 'passed');
    assert.match(result.message, /未发布/);
    assert.ok(result.checks.some(check => check.label === 'publishing' && check.status === 'warning'));
    assert.deepEqual(messages(panel, 'busy').map(message => message.busy), [true, false]);
    await assertUploadOnly(h);
  });
}

for (const response of [undefined, '取消', '确认同步', true]) {
  test(`testZhihuUpload native response ${String(response)} cancels without uploading`, async t => {
    const h = await fixture(t);
    h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
    const panel = await h.open();
    h.modalResponse = response;
    await panel.receive({ type: 'testZhihuUpload', confirmed: true });
    assert.equal(h.warnings.length, 1);
    assert.deepEqual(h.uploadTests, []);
    assert.deepEqual(messages(panel, 'cancelled'), [{ type: 'cancelled', operation: 'testZhihuUpload' }]);
    assert.deepEqual(messages(panel, 'uploadTestResult'), []);
    assert.deepEqual(messages(panel, 'uploadTestComplete'), [{ type: 'uploadTestComplete' }]);
    assert.equal(panel.messages.at(-1).type, 'uploadTestComplete');
    assert.deepEqual(messages(panel, 'busy').map(message => message.busy), [true, false]);
    await assertUploadOnly(h);
  });
}

for (const scope of ['wechat', 'cnblogs']) {
  test(`testZhihuUpload rejects ${scope} scope even when webview claims Zhihu`, async t => {
    const h = await fixture(t);
    h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
    const panel = await h.open(h.source, { platform: scope });
    h.modalResponse = '上传测试图';
    await panel.receive({ type: 'testZhihuUpload', platform: 'zhihu' });
    assert.match(expectUploadResult(panel, 'failed').message, /知乎或多平台/);
    assert.deepEqual(h.uploadTests, []);
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(messages(panel, 'busy'), []);
    await assertUploadOnly(h);
  });
}

for (const reason of ['untrusted', 'missing account', 'empty appKey', 'empty appSecret', 'publisher busy', 'diagnostic failure', 'modal failure']) {
  test(`testZhihuUpload always completes with structured failure for ${reason}`, async t => {
    const h = await fixture(t, {
      testZhihuUpload: async () => { throw new Error(`Mock upload rejected ${credentials.zhihu.appSecret}`); },
    });
    const saved = { ...credentials.zhihu };
    if (reason === 'empty appKey') saved.appKey = '';
    if (reason === 'empty appSecret') saved.appSecret = '';
    if (reason !== 'missing account') h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(saved));
    const panel = await h.open();
    h.modalResponse = '上传测试图';
    if (reason === 'untrusted') h.vscode.workspace.isTrusted = false;
    if (reason === 'publisher busy') h.publisher.running = true;
    if (reason === 'modal failure') h.hooks.modal = async () => { throw new Error('Mock modal failed'); };
    await panel.receive({ type: 'testZhihuUpload' });
    const result = expectUploadResult(panel, 'failed');
    const attempted = reason === 'diagnostic failure';
    assert.equal(h.uploadTests.length, attempted ? 1 : 0);
    assert.equal(h.warnings.length, attempted || reason === 'modal failure' ? 1 : 0);
    assert.deepEqual(messages(panel, 'busy').map(message => message.busy),
      ['untrusted', 'publisher busy'].includes(reason) ? [] : [true, false]);
    if (attempted) {
      assert.match(result.message, /Mock upload rejected/);
      assert.match(result.message, /已隐藏密钥/);
    }
    await assertUploadOnly(h);
  });
}

test('testZhihuUpload redacts raw and URL-encoded secrets in successful nested diagnostics', async t => {
  const secret = 'TEST_ONLY_UPLOAD_SECRET +/?';
  const h = await fixture(t, {
    testZhihuUpload: async () => {
      const result = uploadDiagnosticResult();
      result.message = `Mock response ${secret}`;
      result.checks[0].message = `Mock check ${encodeURIComponent(secret)}`;
      result.checks[0].warnings = [secret, encodeURIComponent(secret)];
      return result;
    },
  });
  h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify({ ...credentials.zhihu, appSecret: secret }));
  const panel = await h.open();
  h.modalResponse = '上传测试图';
  await panel.receive({ type: 'testZhihuUpload' });
  const result = expectUploadResult(panel, 'passed');
  assert.match(result.message, /已隐藏密钥/);
  assert.match(result.checks[0].message, /已隐藏密钥/);
  assert.deepEqual(result.checks[0].warnings, ['[已隐藏密钥]', '[已隐藏密钥]']);
  for (const value of [secret, encodeURIComponent(secret)]) {
    assert.ok(!JSON.stringify({ messages: panel.messages, warnings: h.warnings }).includes(value));
  }
  await assertUploadOnly(h);
});

for (const source of ['secret storage', 'local fallback']) {
  test(`testZhihuUpload blocks an account change in ${source} during the modal`, async t => {
    let fallback = copy(localCredentials);
    const replacement = { appKey: 'replacement-account', appSecret: 'TEST_ONLY_REPLACEMENT_UPLOAD_SECRET' };
    const h = await fixture(t, { resolveLocalCredentials: async () => copy(fallback) });
    if (source === 'secret storage') h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
    const panel = await h.open();
    h.hooks.modal = async () => {
      if (source === 'secret storage') h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(replacement));
      else fallback.credentials = replacement;
      return '上传测试图';
    };
    await panel.receive({ type: 'testZhihuUpload' });
    assert.match(expectUploadResult(panel, 'failed').message, /账号.*变化/);
    assert.deepEqual(h.uploadTests, []);
    assert.equal(h.warnings.length, 1);
    assert.equal(messages(panel, 'invalidated').length, 1);
    assert.equal(messages(panel, 'accounts').at(-1).accounts.zhihu.appKey, replacement.appKey);
    assert.ok(!JSON.stringify(panel.messages).includes(replacement.appSecret));
    await assertUploadOnly(h);
  });
}

test('testZhihuUpload verifies the account shown at initialization before asking for confirmation', async t => {
  const h = await fixture(t);
  h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
  const panel = await h.open();
  await panel.receive({ type: 'ready' });
  h.calls.length = 0;
  panel.messages.length = 0;
  h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify({ ...credentials.zhihu, appKey: 'changed-before-modal' }));
  await panel.receive({ type: 'testZhihuUpload' });
  assert.match(expectUploadResult(panel, 'failed').message, /账号.*变化/);
  assert.deepEqual(h.warnings, []);
  assert.deepEqual(h.uploadTests, []);
  await assertUploadOnly(h);
});

test('testZhihuUpload completes a busy rejection without releasing another panel operation', { timeout: 5000 }, async t => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const h = await fixture(t, { testZhihuUpload: async () => uploadDiagnosticResult() });
  h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
  const panel = await h.open();
  const other = await h.open(h.otherSource);
  h.hooks.modal = async () => { entered.resolve(); await release.promise; return '上传测试图'; };
  const pending = panel.receive({ type: 'testZhihuUpload' });
  await entered.promise;
  await other.receive({ type: 'testZhihuUpload', confirmed: true });
  assert.match(expectUploadResult(other, 'failed').message, /另一个同步操作/);
  assert.deepEqual(h.uploadTests, []);
  assert.equal(h.warnings.length, 1);
  for (const receiver of [panel, other]) {
    assert.deepEqual(messages(receiver, 'busy').map(message => message.busy), [true]);
  }
  assert.deepEqual(messages(panel, 'uploadTestComplete'), []);
  release.resolve();
  await pending;
  expectUploadResult(panel, 'passed');
  assert.equal(h.uploadTests.length, 1);
  for (const receiver of [panel, other]) {
    assert.deepEqual(messages(receiver, 'busy').map(message => message.busy), [true, false]);
  }
  h.hooks.modal = undefined;
  h.modalResponse = undefined;
  panel.messages.length = 0;
  await panel.receive({ type: 'testZhihuUpload' });
  assert.equal(messages(panel, 'cancelled').length, 1, 'host exclusivity must be released');
  assert.equal(h.uploadTests.length, 1);
  await assertUploadOnly(h);
});

test('injected PublisherClass receives the actual host options without loading the production snapshot', async t => {
  const h = await fixture(t);
  assert.equal(h.publisher.options.directory, path.join(h.storage, 'publishing'));
  assert.equal(h.publisher.options.adapters, h.adapters);
  assert.equal(h.publisher.options.transport, h.transport);
  assert.equal(typeof h.publisher.options.getCredentials, 'function');
  assert.equal(await h.publisher.options.getCredentials('wechat'), null);
  assert.equal(await h.publisher.options.getCredentials('zhihu'), null, 'the default resolver is a null mock, never the user credential resolver');
  assert.deepEqual(h.localResolutions, ['zhihu']);
  h.secretValues.set(SECRET_PREFIX + 'wechat', JSON.stringify(credentials.wechat));
  assert.deepEqual(await h.publisher.options.getCredentials('wechat'), credentials.wechat);
  const panel = await h.open();
  await panel.receive({ type: 'prepare', config: config() });
  assert.equal(h.count('prepare'), 1);
  assert.equal(!!require.cache[documentModule], documentWasLoaded, 'mock injection must not load the default document snapshot');
});

test('open returns and reuses each document panel, with CSP and no local resource roots', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  assert.equal(await h.open(), panel);
  assert.equal(panel.reveals, 1);
  const other = await h.open(h.otherSource);
  assert.notEqual(other, panel);
  assert.equal(h.panels.length, 2);
  assert.deepEqual(panel.options.localResourceRoots, []);
  assert.equal(panel.options.enableScripts, true);
  assert.match(panel.webview.html, /connect-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /__PUBLISH_(?:CSP|NONCE)__/);
});

for (const platform of PLATFORMS) {
  test(`${platform}: open(source, { platform }) initializes and prepares only the host-selected target`, async t => {
    const h = await fixture(t);
    const panel = await h.open(h.source, { platform });
    await panel.receive({ type: 'ready', platform: 'untrusted-platform' });
    const init = messages(panel, 'init').at(-1);
    assert.equal(init.scope, platform);
    assert.equal(init.sourcePath, h.source);
    assert.deepEqual(init.defaults.targets, [platform]);
    assert.equal(init.defaults.title, 'Actual frontmatter title');
    assert.equal(init.defaults.summary, 'Body.');
    for (const targets of [PLATFORMS, PLATFORMS.filter(target => target !== platform), ['unknown']]) {
      const input = {
        ...config(), targets, title: '  Selected platform title  ', summary: '  Selected summary  ',
        credentials, ignored: 'discard-me',
      };
      const original = copy(input);
      const before = h.count('prepare');
      await panel.receive({ type: 'prepare', platform: 'unknown', sourcePath: h.otherSource, config: input });
      assert.equal(h.count('prepare'), before + 1);
      const call = h.calls.filter(item => item.method === 'prepare').at(-1);
      assert.equal(call.sourcePath, h.source);
      assert.deepEqual(call.input, normalizeConfig({ ...input, targets: [platform] }));
      assert.deepEqual(input, original, 'normalization must not mutate the webview input');
      assert.deepEqual(Object.keys(messages(panel, 'job').at(-1).job.targets), [platform]);
    }
    assert.equal(h.count('execute'), 0);
    assert.deepEqual(h.warnings, []);
    assertNoSecrets(h);
  });
}

test('one document panel changes between multi-platform and single-platform scopes and keeps the current scope on reuse', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const other = await h.open(h.otherSource, { platform: 'wechat' });
  for (const platform of ['zhihu', 'zhihu', 'cnblogs', null]) {
    assert.equal(await h.open(h.source, { platform }), panel);
    await panel.receive({ type: 'ready' });
    const init = messages(panel, 'init').at(-1);
    assert.equal(init.scope, platform);
    assert.deepEqual(init.defaults.targets, platform ? [platform] : ['wechat', 'cnblogs']);
  }
  assert.equal(h.panels.length, 2);
  assert.equal(panel.reveals, 4);
  assert.deepEqual(messages(panel, 'scopeChanged'), [
    { type: 'scopeChanged', platform: 'zhihu' },
    { type: 'scopeChanged', platform: 'cnblogs' },
    { type: 'scopeChanged', platform: null },
  ]);
  assert.deepEqual(messages(other, 'scopeChanged'), []);
  assert.match(panel.title, /多平台同步/);
  await panel.receive({ type: 'prepare', config: config() });
  assert.deepEqual(h.calls.find(call => call.method === 'prepare').input, normalizeConfig(config()));
});

test('open rejects an invalid platform before resolving a source or changing an existing scope', async t => {
  const h = await fixture(t);
  const panel = await h.open(h.source, { platform: 'zhihu' });
  const resolutions = [...h.resolutions];
  assert.equal(await h.host.open(h.source, { platform: 'unknown' }), undefined);
  assert.match(h.errors.at(-1), /无效的平台/);
  assert.deepEqual(h.resolutions, resolutions);
  assert.deepEqual(messages(panel, 'scopeChanged'), []);
  await panel.receive({ type: 'ready' });
  assert.equal(messages(panel, 'init').at(-1).scope, 'zhihu');
  assert.equal(h.panels.length, 1);
});

for (const type of ['loadJob', 'retry', 'execute']) {
  for (const targets of [PLATFORMS, ['cnblogs']]) {
    test(`single-platform ${type} rejects a ${targets.length === 1 ? 'different-platform' : 'multi-platform'} job for the same source`, async t => {
      const h = await fixture(t);
      const panel = await h.open(h.source, { platform: 'zhihu' });
      const job = await h.seedJob(h.source, { ...config(), targets });
      h.modalResponse = '确认同步';
      await panel.receive({ type, jobId: job.id, platform: null, confirmed: true });
      expectError(panel, /此任务包含其他平台/);
      assert.deepEqual(h.calls.map(call => call.method), ['read']);
      assert.deepEqual(messages(panel, 'job'), []);
      assert.deepEqual(h.warnings, []);
      assert.deepEqual(h.jobs.get(job.id), job, 'scope rejection must not modify any target');
    });
  }
}

test('single-platform scope accepts its own saved job for load, retry and confirmed execute', async t => {
  const h = await fixture(t);
  const panel = await h.open(h.source, { platform: 'zhihu' });
  const job = await h.seedJob(h.source, { ...config(), targets: ['zhihu'] });
  await panel.receive({ type: 'loadJob', jobId: job.id });
  assert.equal(messages(panel, 'job').at(-1).job.reviewable, true);
  await panel.receive({ type: 'retry', jobId: job.id });
  h.modalResponse = '确认同步';
  await panel.receive({ type: 'execute', jobId: job.id });
  assert.equal(h.count('retry'), 1);
  assert.equal(h.count('execute'), 1);
  assert.deepEqual(Object.keys(messages(panel, 'job').at(-1).job.targets), ['zhihu']);
  assert.equal(messages(panel, 'job').at(-1).job.targets.zhihu.state, 'published');
  assert.match(h.warnings[0][1].detail, /知乎公开发布/);
  assert.doesNotMatch(h.warnings[0][1].detail, /公众号|博客园/);
  assert.deepEqual(messages(panel, 'error'), []);
});

for (const operation of ['prepare', 'modal', 'publisher.running']) {
  test(`busy ${operation} prevents a scope switch and preserves the bound scope`, { timeout: 5000 }, async t => {
    const h = await fixture(t);
    const panel = await h.open(h.source, { platform: 'zhihu' });
    const job = await h.seedJob(h.source, { ...config(), targets: ['zhihu'] });
    const entered = deferred();
    const release = deferred();
    let active;
    if (operation === 'publisher.running') h.publisher.running = true;
    else {
      const hook = async () => { entered.resolve(); await release.promise; return '确认同步'; };
      h.hooks[operation] = hook;
      active = panel.receive(operation === 'prepare'
        ? { type: 'prepare', config: config() }
        : { type: 'execute', jobId: job.id });
    }
    try {
      if (active) await Promise.race([entered.promise, active.then(() => assert.fail('operation did not reach the gate'))]);
      assert.equal(await h.open(h.source, { platform: 'zhihu' }), panel, 'same-scope reuse is still allowed');
      for (const platform of [null, 'cnblogs']) {
        assert.equal(await h.host.open(h.source, { platform }), undefined);
        assert.match(h.errors.at(-1), /同步操作正在运行.*切换平台/);
      }
      assert.deepEqual(messages(panel, 'scopeChanged'), []);
      await panel.receive({ type: 'ready' });
      assert.equal(messages(panel, 'init').at(-1).scope, 'zhihu');
      assert.equal(h.panels.length, 1);
    } finally {
      release.resolve();
      if (active) await active;
      h.publisher.running = false;
    }
    assert.equal(await h.open(), panel);
    assert.deepEqual(messages(panel, 'scopeChanged'), [{ type: 'scopeChanged', platform: null }]);
  });
}

for (const platform of PLATFORMS) {
  test(`${platform}: save credentials only in SecretStorage; check and remove use injected dependencies`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    const other = await h.open(h.otherSource);
    const supplied = Object.fromEntries(Object.entries(credentials[platform]).map(([key, value]) => [key, ` ${value} `]));
    await panel.receive({ type: 'saveAccount', platform, credentials: { ...supplied, ignored: 'discard-me' } });
    expectAccount(panel, true);
    assert.deepEqual(h.secretWrites, [{ key: SECRET_PREFIX + platform, value: JSON.stringify(credentials[platform]) }]);
    assert.deepEqual(h.stateWrites, []);
    for (const receiver of [panel, other]) {
      const status = messages(receiver, 'accounts').at(-1).accounts[platform];
      assert.equal(status.configured, true);
      assert.ok(!Object.hasOwn(status, 'appSecret'));
      assert.ok(!Object.hasOwn(status, 'token'));
      assert.equal(messages(receiver, 'invalidated').length, 1);
    }
    await panel.receive({ type: 'ready' });
    await panel.receive({ type: 'checkAccount', platform });
    expectAccount(panel, true);
    assert.equal(h.checks.length, 1);
    assert.equal(h.checks[0].request, h.transport);
    assert.deepEqual(h.checks[0].credentials, credentials[platform]);
    await panel.receive({ type: 'saveDefaults', config: { ...config(), credentials } });
    assert.deepEqual([...h.state.keys()], [DEFAULTS_KEY]);
    assertNoSecrets(h);
    const jobFiles = await fs.promises.readdir(h.publisher.options.directory);
    assert.deepEqual(jobFiles, [], 'saving accounts must not create plaintext files in host storage');
    await panel.receive({ type: 'removeAccount', platform });
    expectAccount(panel, true);
    assert.deepEqual(h.secretDeletes, [SECRET_PREFIX + platform]);
    assert.equal(await h.publisher.options.getCredentials(platform), null);
    assert.equal(messages(other, 'accounts').at(-1).accounts[platform].configured, false);
    assertNoSecrets(h);
  });

  test(`${platform}: a blank secret preserves the same identity; every changed identity field requires a secret`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    await panel.receive({ type: 'saveAccount', platform, credentials: credentials[platform] });
    const secretField = platform === 'cnblogs' ? 'token' : 'appSecret';
    const blank = { ...credentials[platform], [secretField]: '   ' };
    await panel.receive({ type: 'saveAccount', platform, credentials: blank });
    expectAccount(panel, true);
    assert.deepEqual(await h.publisher.options.getCredentials(platform), credentials[platform]);
    const savedCount = h.secretWrites.length;
    for (const field of Object.keys(blank).filter(key => key !== secretField)) {
      await panel.receive({
        type: 'saveAccount', platform, credentials: { ...blank, [field]: 'replacement-identity' },
      });
      assert.match(expectAccount(panel, false).message, /更换账号标识.*重新输入密钥/);
      assert.equal(h.secretWrites.length, savedCount, 'rejection must leave the previous SecretStorage entry intact');
      assert.deepEqual(await h.publisher.options.getCredentials(platform), credentials[platform]);
    }
    const identityField = Object.keys(blank).find(key => key !== secretField);
    const replacement = { ...credentials[platform], [identityField]: 'replacement-identity' };
    await panel.receive({ type: 'saveAccount', platform, credentials: replacement });
    expectAccount(panel, true);
    assert.deepEqual(await h.publisher.options.getCredentials(platform), replacement);
    assertNoSecrets(h);
  });

  test(`${platform}: trimmed identity is still the same account when its secret is left blank`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    await panel.receive({ type: 'saveAccount', platform, credentials: credentials[platform] });
    const secretField = platform === 'cnblogs' ? 'token' : 'appSecret';
    const supplied = Object.fromEntries(Object.entries(credentials[platform]).map(([field, value]) => [
      field, field === secretField ? '' : ` ${value} `,
    ]));
    await panel.receive({ type: 'saveAccount', platform, credentials: supplied });
    expectAccount(panel, true);
    assert.deepEqual(await h.publisher.options.getCredentials(platform), credentials[platform]);
    assertNoSecrets(h);
  });
}

test('first account save needs a secret and invalid platforms cannot write credentials', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  await panel.receive({ type: 'saveAccount', platform: 'wechat', credentials: { appId: 'new-id', appSecret: '' } });
  expectAccount(panel, false);
  await panel.receive({ type: 'saveAccount', platform: 'unknown', credentials: credentials.wechat });
  assert.match(expectAccount(panel, false).message, /无效的平台/);
  assert.deepEqual(h.secretWrites, []);
});

test('account check errors do not expose a credential echoed by an adapter', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  await panel.receive({ type: 'saveAccount', platform: 'wechat', credentials: credentials.wechat });
  h.hooks.check = (_platform, ctx) => { throw new Error(`Mock adapter rejected ${ctx.credentials.appSecret}`); };
  await panel.receive({ type: 'checkAccount', platform: 'wechat' });
  expectAccount(panel, false);
  assertNoSecrets(h);
});

test('account check result messages do not expose a credential echoed by an adapter', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  await panel.receive({ type: 'saveAccount', platform: 'cnblogs', credentials: credentials.cnblogs });
  h.hooks.check = (_platform, ctx) => ({ verified: false, message: `Mock response echoed ${ctx.credentials.token}` });
  await panel.receive({ type: 'checkAccount', platform: 'cnblogs' });
  expectAccount(panel, false);
  assertNoSecrets(h);
});

test('local Zhihu fallback exposes only identity and source information; SecretStorage takes precedence', async t => {
  const h = await fixture(t, { resolveLocalCredentials: async () => copy(localCredentials) });
  const panel = await h.open();
  await panel.receive({ type: 'ready' });
  assert.deepEqual(messages(panel, 'init').at(-1).accounts.zhihu, {
    configured: true, appKey: localCredentials.credentials.appKey,
    source: localCredentials.source, sourceLabel: localCredentials.sourceLabel,
  });
  assert.deepEqual(await h.publisher.options.getCredentials('zhihu'), localCredentials.credentials);
  assert.ok(h.localResolutions.length > 0);
  assert.deepEqual(h.secretWrites, [], 'automatic fallback does not import credentials');
  assert.deepEqual(h.stateWrites, []);
  await panel.receive({ type: 'checkAccount', platform: 'zhihu' });
  assert.deepEqual(h.checks.at(-1).credentials, localCredentials.credentials);
  assert.equal(h.checks.at(-1).request, h.transport);
  const localReads = h.localResolutions.length;
  h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
  await panel.receive({ type: 'ready' });
  assert.deepEqual(messages(panel, 'init').at(-1).accounts.zhihu, {
    configured: true, appKey: credentials.zhihu.appKey, source: 'secret-storage', sourceLabel: '系统安全存储',
  });
  assert.deepEqual(await h.publisher.options.getCredentials('zhihu'), credentials.zhihu);
  await panel.receive({ type: 'checkAccount', platform: 'zhihu' });
  assert.deepEqual(h.checks.at(-1).credentials, credentials.zhihu);
  assert.equal(h.localResolutions.length, localReads, 'a saved account must not consult the local resolver');
  assertNoSecrets(h);
  assert.deepEqual(await fs.promises.readdir(h.publisher.options.directory), []);
});

test('a fallback account change after initialization aborts preparation until the updated account is explicitly accepted', async t => {
  let fallback = copy(localCredentials);
  const replacement = {
    credentials: copy(credentials.zhihu), source: 'environment', sourceLabel: 'Mock replacement local account',
  };
  const h = await fixture(t, { resolveLocalCredentials: async () => copy(fallback) });
  const panel = await h.open(h.source, { platform: 'zhihu' });
  await panel.receive({ type: 'ready' });
  assert.deepEqual(messages(panel, 'init').at(-1).accounts.zhihu, {
    configured: true, appKey: localCredentials.credentials.appKey,
    source: localCredentials.source, sourceLabel: localCredentials.sourceLabel,
  });
  fallback = replacement;
  const before = panel.messages.length;
  await panel.receive({ type: 'prepare', config: config() });
  expectError(panel, /账号已变化.*核对当前显示的账号/);
  assert.equal(h.count('prepare'), 0, 'account drift must abort before entering the publisher');
  const reply = panel.messages.slice(before);
  assert.deepEqual(reply.map(message => message.type), ['busy', 'accounts', 'invalidated', 'busy', 'error']);
  assert.deepEqual(messages(panel, 'accounts').at(-1).accounts.zhihu, {
    configured: true, appKey: replacement.credentials.appKey,
    source: replacement.source, sourceLabel: replacement.sourceLabel,
  });
  assert.match(messages(panel, 'invalidated').at(-1).message, /账号来源已变化.*核对/);
  assert.equal(h.jobs.size, 0);
  assert.deepEqual(messages(panel, 'job'), []);
  assert.deepEqual(await fs.promises.readdir(h.publisher.options.directory), []);
  assert.deepEqual(h.media, []);
  assert.deepEqual(h.adapterWrites, []);

  let preparedCredentials;
  h.hooks.prepare = async () => {
    preparedCredentials = await h.publisher.options.getCredentials('zhihu');
  };
  await panel.receive({ type: 'prepare', config: config() });
  assert.equal(h.count('prepare'), 1, 'a second explicit prepare can use the newly displayed account');
  assert.deepEqual(preparedCredentials, replacement.credentials);
  assert.equal(messages(panel, 'error').length, 1);
  assert.equal(messages(panel, 'invalidated').length, 1);
  assert.deepEqual(Object.keys(messages(panel, 'job').at(-1).job.targets), ['zhihu']);
  assert.equal(h.jobs.size, 1);
  assert.deepEqual(h.secretWrites, [], 'acknowledging a fallback account must not import it');
  assert.deepEqual(h.stateWrites, []);
  assertNoSecrets(h);
});

test('a fallback change inside publisher.prepare rejects credential access before upload and clears the preparation expectation on error', async t => {
  let fallback = copy(localCredentials);
  const replacement = {
    credentials: copy(credentials.zhihu), source: 'environment', sourceLabel: 'Mock replacement local account',
  };
  const h = await fixture(t, { resolveLocalCredentials: async () => copy(fallback) });
  const panel = await h.open(h.source, { platform: 'zhihu' });
  await panel.receive({ type: 'ready' });
  let enteredPrepare = false;
  h.hooks.prepare = async () => {
    enteredPrepare = true;
    // This callback runs inside the fake publisher, after withPreparedAccounts
    // snapshots the account. Use the constructor-injected credential callback
    // exactly where the runtime would request credentials before an upload.
    assert.deepEqual(await h.publisher.options.getCredentials('zhihu'), localCredentials.credentials);
    fallback = replacement;
    await h.publisher.options.getCredentials('zhihu');
    await h.adapters.zhihu.upload();
  };
  const before = panel.messages.length;
  await panel.receive({ type: 'prepare', config: config() });
  assert.equal(enteredPrepare, true, 'the test must reach the publisher after the host account snapshot');
  assert.equal(h.count('prepare'), 1);
  expectError(panel, /账号在准备期间发生变化.*重新同步/);
  assert.deepEqual(messages(panel, 'busy').slice(-2).map(message => message.busy), [true, false]);
  assert.equal(messages(panel, 'error').length, 1);
  assert.deepEqual(messages(panel, 'job'), []);
  assert.equal(h.jobs.size, 0);
  assert.deepEqual(await fs.promises.readdir(h.publisher.options.directory), []);
  assert.deepEqual(h.media, [], 'changed credentials must be rejected before reaching adapter upload');
  assert.deepEqual(h.adapterWrites, []);
  assert.equal(panel.messages.slice(before).some(message => message.type === 'progress'), false);
  assert.deepEqual(await h.publisher.options.getCredentials('zhihu'), replacement.credentials,
    'the failed prepare must clear its account expectation before later credential reads');

  delete h.hooks.prepare;
  await panel.receive({ type: 'ready' });
  assert.equal(messages(panel, 'init').at(-1).accounts.zhihu.appKey, replacement.credentials.appKey);
  let preparedCredentials;
  h.hooks.prepare = async () => {
    preparedCredentials = await h.publisher.options.getCredentials('zhihu');
  };
  await panel.receive({ type: 'prepare', config: config() });
  assert.equal(h.count('prepare'), 2);
  assert.deepEqual(preparedCredentials, replacement.credentials);
  assert.equal(messages(panel, 'error').length, 1);
  assert.equal(messages(panel, 'job').length, 1);
  assert.deepEqual(h.media, []);
  assert.deepEqual(h.secretWrites, []);
  assert.deepEqual(h.stateWrites, []);
  assertNoSecrets(h);
});

test('a complete manual Zhihu replacement saves despite a local resolver conflict; blank-secret reuse still reads the previous account', async t => {
  const h = await fixture(t, {
    resolveLocalCredentials: async () => {
      throw Object.assign(new Error('Mock conflicting local credential sources'), { code: 'conflict' });
    },
  });
  const panel = await h.open(h.source, { platform: 'zhihu' });
  await panel.receive({ type: 'ready' });
  assert.match(messages(panel, 'init').at(-1).accounts.zhihu.error, /来源不一致/);
  const localReads = h.localResolutions.length;
  await panel.receive({
    type: 'saveAccount', platform: 'zhihu',
    credentials: { appKey: credentials.zhihu.appKey, appSecret: '   ' },
  });
  assert.match(expectAccount(panel, false).message, /来源不一致/);
  assert.equal(h.localResolutions.length, localReads + 1, 'preserving a blank secret requires reading the previous account');
  assert.deepEqual(h.secretWrites, []);
  const readsBeforeReplacement = h.localResolutions.length;
  await panel.receive({
    type: 'saveAccount', platform: 'zhihu',
    credentials: { appKey: ` ${credentials.zhihu.appKey} `, appSecret: ` ${credentials.zhihu.appSecret} ` },
  });
  assert.equal(expectAccount(panel, true).platform, 'zhihu');
  assert.deepEqual(h.secretWrites, [{
    key: SECRET_PREFIX + 'zhihu', value: JSON.stringify(credentials.zhihu),
  }]);
  assert.equal(h.localResolutions.length, readsBeforeReplacement,
    'a complete manual replacement must not depend on the conflicting local resolver');
  assert.deepEqual(messages(panel, 'accounts').at(-1).accounts.zhihu, {
    configured: true, appKey: credentials.zhihu.appKey, source: 'secret-storage', sourceLabel: '系统安全存储',
  });
  assert.deepEqual(await h.publisher.options.getCredentials('zhihu'), credentials.zhihu);
  await panel.receive({
    type: 'saveAccount', platform: 'zhihu',
    credentials: { appKey: credentials.zhihu.appKey, appSecret: '' },
  });
  expectAccount(panel, true);
  assert.deepEqual(await h.publisher.options.getCredentials('zhihu'), credentials.zhihu);
  assert.equal(h.localResolutions.length, readsBeforeReplacement, 'blank-secret reuse now reads SecretStorage');
  assert.deepEqual(h.stateWrites, []);
  assert.deepEqual(messages(panel, 'error'), []);
  assert.equal(h.jobs.size, 0);
  assertNoSecrets(h);
});

test('useLocalZhihu imports into SecretStorage, clear disables fallback, and explicit import enables it again', async t => {
  const h = await fixture(t, { resolveLocalCredentials: async () => copy(localCredentials) });
  const panel = await h.open(h.source, { platform: 'zhihu' });
  const other = await h.open(h.otherSource);
  h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
  for (let cycle = 0; cycle < 2; cycle++) {
    await panel.receive({ type: 'useLocalZhihu', platform: 'wechat' });
    const imported = expectAccount(panel, true);
    assert.equal(imported.platform, 'zhihu', 'the import action always addresses Zhihu');
    assert.equal(h.state.get(LOCAL_DISABLED_KEY), false);
    assert.deepEqual(h.secretWrites.at(-1), {
      key: SECRET_PREFIX + 'zhihu', value: JSON.stringify(localCredentials.credentials),
    });
    assert.deepEqual(await h.publisher.options.getCredentials('zhihu'), localCredentials.credentials);
    for (const receiver of [panel, other]) {
      assert.deepEqual(messages(receiver, 'accounts').at(-1).accounts.zhihu, {
        configured: true, appKey: localCredentials.credentials.appKey, source: 'secret-storage', sourceLabel: '系统安全存储',
      });
      assert.equal(messages(receiver, 'invalidated').length, cycle * 2 + 1);
    }
    await panel.receive({ type: 'removeAccount', platform: 'zhihu' });
    expectAccount(panel, true);
    assert.equal(h.state.get(LOCAL_DISABLED_KEY), true);
    assert.equal(h.secretValues.has(SECRET_PREFIX + 'zhihu'), false);
    const localReads = h.localResolutions.length;
    assert.equal(await h.publisher.options.getCredentials('zhihu'), null);
    await panel.receive({ type: 'ready' });
    assert.deepEqual(messages(panel, 'init').at(-1).accounts.zhihu, {
      configured: false, appKey: '', source: '', sourceLabel: '',
    });
    assert.equal(messages(other, 'accounts').at(-1).accounts.zhihu.configured, false);
    assert.equal(h.localResolutions.length, localReads, 'clearing must not silently rediscover the local account');
    assertNoSecrets(h);
  }
  assert.deepEqual(h.secretDeletes, [SECRET_PREFIX + 'zhihu', SECRET_PREFIX + 'zhihu']);
  assert.deepEqual(h.stateWrites.map(write => write.value), [false, true, false, true]);
  assert.ok(h.stateWrites.every(write => write.key === LOCAL_DISABLED_KEY));
  assert.deepEqual(h.jobs.size, 0);
  assert.deepEqual(await fs.promises.readdir(h.publisher.options.directory), []);
});

test('useLocalZhihu with no mocked credentials fails without writing or clearing a saved account', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
  await panel.receive({ type: 'useLocalZhihu' });
  const result = expectAccount(panel, false);
  assert.equal(result.platform, 'zhihu');
  assert.match(result.message, /未找到完整的本地知乎凭证/);
  assert.deepEqual(h.secretWrites, []);
  assert.deepEqual(h.secretDeletes, []);
  assert.deepEqual(h.stateWrites, []);
  assert.deepEqual(await h.publisher.options.getCredentials('zhihu'), credentials.zhihu);
  assert.deepEqual(messages(panel, 'busy').map(message => message.busy), [true, false]);
});

test('a local credential conflict affects only Zhihu account status and leaves other accounts usable', async t => {
  const h = await fixture(t, {
    resolveLocalCredentials: async () => {
      throw Object.assign(new Error(`Conflict must not echo ${localCredentials.credentials.appSecret}`), { code: 'conflict' });
    },
  });
  const panel = await h.open();
  for (const platform of ['wechat', 'cnblogs']) {
    h.secretValues.set(SECRET_PREFIX + platform, JSON.stringify(credentials[platform]));
  }
  await panel.receive({ type: 'ready' });
  const accounts = messages(panel, 'init').at(-1).accounts;
  assert.equal(accounts.wechat.configured, true);
  assert.equal(accounts.cnblogs.configured, true);
  assert.equal(accounts.zhihu.configured, false);
  assert.match(accounts.zhihu.error, /知乎环境变量与本地凭证来源不一致/);
  for (const platform of ['wechat', 'cnblogs']) {
    await panel.receive({ type: 'saveAccount', platform, credentials: credentials[platform] });
    assert.equal(expectAccount(panel, true).platform, platform);
    await panel.receive({ type: 'checkAccount', platform });
    assert.equal(expectAccount(panel, true).platform, platform);
  }
  assert.deepEqual(h.checks.map(check => check.platform), ['wechat', 'cnblogs']);
  for (const type of ['checkAccount', 'useLocalZhihu']) {
    await panel.receive({ type, platform: 'zhihu' });
    const result = expectAccount(panel, false);
    assert.equal(result.platform, 'zhihu');
    assert.match(result.message, /知乎环境变量与本地凭证来源不一致/);
  }
  assert.deepEqual(messages(panel, 'error'), []);
  assert.deepEqual(h.secretWrites.map(write => write.key), [SECRET_PREFIX + 'wechat', SECRET_PREFIX + 'cnblogs']);
  assertNoSecrets(h);
});

for (const platform of PLATFORMS) {
  test(`${platform}: testPlatform reports structured readonly diagnostics for only the requested platform`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    const other = await h.open(h.otherSource);
    h.secretValues.set(SECRET_PREFIX + platform, JSON.stringify(credentials[platform]));
    h.hooks.check = () => platform === 'wechat' ? { draftAccess: true } :
      platform === 'zhihu' ? { verified: false } : { blogId: 'mock-blog-id' };
    const input = {
      ...config(), title: '  Readiness title  ', summary: '  Readiness summary  ',
      targets: PLATFORMS.filter(target => target !== platform), coverPath: path.join(h.directory, 'mock-cover.png'),
    };
    const original = copy(input);
    const sourceText = await fs.promises.readFile(h.source, 'utf8');
    await panel.receive({ type: 'testPlatform', platform, sourcePath: h.otherSource, config: input });
    const result = expectTestResult(panel, platform, platform === 'zhihu' ? 'warning' : 'passed');
    const api = result.checks.find(check => check.label === 'api');
    assert.equal(api.status, platform === 'zhihu' ? 'warning' : 'passed');
    if (platform === 'zhihu') assert.match(api.message, /官方没有只读授权校验.*发布权限以提交为准/);
    const normalized = normalizeConfig({ ...input, targets: [platform] });
    assert.deepEqual(h.snapshots, [{
      sourcePath: h.source,
      input: { ...normalized, options: { [platform]: normalized.options[platform] } },
      options: { themeId: h.themeId, render: true },
    }]);
    assert.deepEqual(h.validations.map(validation => validation.platform), [platform]);
    assert.deepEqual(h.checks.map(check => check.platform), [platform]);
    assert.deepEqual(h.checks[0].credentials, credentials[platform]);
    assert.equal(h.checks[0].request, h.transport);
    assert.equal(h.validations[0].article, h.checks[0].article);
    assert.deepEqual(h.checks[0].options, normalized.options[platform]);
    assert.deepEqual(input, original);
    assert.equal(await fs.promises.readFile(h.source, 'utf8'), sourceText);
    assert.deepEqual(messages(panel, 'testsComplete'), [{ type: 'testsComplete' }]);
    assert.deepEqual(messages(panel, 'error'), []);
    assert.deepEqual(messages(other, 'testResult'), []);
    assert.deepEqual(messages(other, 'testsComplete'), []);
    for (const receiver of [panel, other]) {
      assert.deepEqual(messages(receiver, 'busy').map(message => message.busy), [true, false]);
    }
    assert.equal(!!require.cache[documentModule], documentWasLoaded, 'readiness must use the injected snapshot');
    await assertReadinessOnly(h);
  });
}

test('testPlatforms reports independent passed, warning and failed statuses and completes after an adapter error', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  for (const platform of PLATFORMS) {
    h.secretValues.set(SECRET_PREFIX + platform, JSON.stringify(credentials[platform]));
  }
  h.hooks.check = (platform, ctx) => {
    if (platform === 'wechat') return { draftAccess: true, payload: ctx.credentials };
    if (platform === 'zhihu') return { verified: false, payload: ctx.credentials };
    throw Object.assign(new Error(`Mock readonly denial ${ctx.credentials.token}`), { payload: ctx.credentials });
  };
  const input = { ...config(), coverPath: path.join(h.directory, 'mock-cover.png') };
  await panel.receive({ type: 'testPlatforms', platform: 'unknown', config: input });
  assert.deepEqual(messages(panel, 'testResult').map(result => result.platform), PLATFORMS);
  expectTestResult(panel, 'wechat', 'passed');
  expectTestResult(panel, 'zhihu', 'warning');
  const failure = expectTestResult(panel, 'cnblogs', 'failed');
  assert.match(failure.checks.find(check => check.label === 'api').message, /Mock readonly denial.*REDACTED/);
  assert.deepEqual(h.checks.map(check => check.platform), PLATFORMS, 'a failed account check must not abort the remaining batch');
  assert.deepEqual(h.snapshots.map(snapshot => snapshot.input.targets), PLATFORMS.map(platform => [platform]));
  assert.deepEqual(messages(panel, 'testsComplete'), [{ type: 'testsComplete' }]);
  assert.equal(panel.messages.at(-1).type, 'testsComplete');
  assert.deepEqual(messages(panel, 'error'), []);
  await assertReadinessOnly(h);
});

for (const platform of PLATFORMS) {
  test(`${platform}: single-platform testPlatforms forces the host scope and testPlatform rejects a different platform`, async t => {
    const h = await fixture(t);
    const panel = await h.open(h.source, { platform });
    h.secretValues.set(SECRET_PREFIX + platform, JSON.stringify(credentials[platform]));
    h.hooks.check = () => ({ verified: true, draftAccess: true });
    const input = {
      ...config(), targets: ['unknown'], coverPath: path.join(h.directory, 'mock-cover.png'),
    };
    await panel.receive({ type: 'testPlatforms', config: input });
    expectTestResult(panel, platform, 'passed');
    assert.deepEqual(h.checks.map(check => check.platform), [platform]);
    assert.deepEqual(h.snapshots.map(snapshot => snapshot.input.targets), [[platform]]);
    const otherPlatform = PLATFORMS.find(target => target !== platform);
    await panel.receive({ type: 'testPlatform', platform: otherPlatform, config: config() });
    expectError(panel, /请选择当前平台进行测试/);
    assert.equal(h.checks.length, 1);
    assert.equal(h.snapshots.length, 1);
    assert.equal(messages(panel, 'testResult').length, 1);
    assert.deepEqual(messages(panel, 'testsComplete'), [{ type: 'testsComplete' }, { type: 'testsComplete' }]);
    await assertReadinessOnly(h);
  });
}

test('testPlatforms continues after a failed first target and skips API calls for missing credentials', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
  await panel.receive({ type: 'testPlatforms', config: config() });
  expectTestResult(panel, 'wechat', 'failed');
  expectTestResult(panel, 'zhihu', 'passed');
  expectTestResult(panel, 'cnblogs', 'failed');
  assert.deepEqual(h.snapshots.map(snapshot => snapshot.input.targets), PLATFORMS.map(platform => [platform]));
  assert.deepEqual(h.checks.map(check => check.platform), ['zhihu']);
  assert.deepEqual(h.validations.map(validation => validation.platform), ['zhihu']);
  assert.deepEqual(messages(panel, 'testsComplete'), [{ type: 'testsComplete' }]);
  await assertReadinessOnly(h);
});

for (const type of ['testPlatform', 'testPlatforms']) {
  for (const reason of ['dirty source', 'invalid config', 'publisher busy', 'untrusted workspace']) {
    test(`${type} sends testsComplete when rejected for ${reason}`, async t => {
      const h = await fixture(t);
      const panel = await h.open();
      const input = { type, platform: 'zhihu', config: config() };
      let pattern;
      if (reason === 'dirty source') {
        h.dirtyDocument();
        pattern = /文档尚未保存/;
      } else if (reason === 'invalid config') {
        input.config.options.zhihu = { topics: 42 };
        pattern = /话题、分类和标签必须为字符串列表/;
      } else if (reason === 'publisher busy') {
        h.publisher.running = true;
        pattern = /另一个同步操作正在运行/;
      } else {
        h.vscode.workspace.isTrusted = false;
        pattern = /信任此工作区/;
      }
      await panel.receive(input);
      expectError(panel, pattern);
      assert.deepEqual(messages(panel, 'testsComplete'), [{ type: 'testsComplete' }], 'every requested test batch must terminate, including rejection');
      assert.deepEqual(messages(panel, 'testResult'), []);
      assert.deepEqual(h.snapshots, []);
      assert.deepEqual(h.checks, []);
      assert.deepEqual(messages(panel, 'busy').map(message => message.busy),
        reason === 'dirty source' || reason === 'invalid config' ? [true, false] : []);
      await assertReadinessOnly(h);
    });
  }

  test(`${type} sends testsComplete while another panel is busy without ending its operation`, { timeout: 5000 }, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    const other = await h.open(h.otherSource);
    const entered = deferred();
    const release = deferred();
    h.hooks.prepare = async () => { entered.resolve(); await release.promise; };
    const active = panel.receive({ type: 'prepare', config: config() });
    try {
      await Promise.race([entered.promise, active.then(() => assert.fail('preparation did not reach the gate'))]);
      await other.receive({ type, platform: 'zhihu', config: config() });
      expectError(other, /另一个同步操作正在运行/);
      assert.deepEqual(messages(other, 'testsComplete'), [{ type: 'testsComplete' }]);
      assert.deepEqual(messages(other, 'testResult'), []);
      assert.deepEqual(h.snapshots, []);
      assert.deepEqual(h.checks, []);
      assert.deepEqual(messages(other, 'busy').map(message => message.busy), [true], 'a rejected test must not release another operation');
      assert.equal(h.count('prepare'), 1);
      assert.equal(h.jobs.size, 0);
      assert.deepEqual(h.stateWrites, []);
      assert.deepEqual(h.secretWrites, []);
    } finally {
      release.resolve();
      await active;
    }
    assert.deepEqual(messages(other, 'busy').map(message => message.busy), [true, false]);
    assert.equal(h.count('execute'), 0);
  });
}

test('invalid testPlatform requests still complete without snapshots, accounts or publishing work', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  await panel.receive({ type: 'testPlatform', platform: 'unknown', config: config() });
  expectError(panel, /请选择当前平台进行测试/);
  assert.deepEqual(messages(panel, 'testsComplete'), [{ type: 'testsComplete' }]);
  assert.deepEqual(h.secretReads, []);
  assert.deepEqual(h.localResolutions, []);
  assert.deepEqual(h.snapshots, []);
  await assertReadinessOnly(h);
});

test('untrusted workspace cannot resolve a source or open a publishing panel', async t => {
  const h = await fixture(t, { trusted: false });
  assert.equal(await h.host.open(h.source), undefined);
  assert.match(h.errors.at(-1), /信任此工作区/);
  assert.deepEqual(h.resolutions, []);
  assert.deepEqual(h.panels, []);
  assert.deepEqual(h.secretReads, []);
  assert.deepEqual(h.calls, []);
});

test('trust is rechecked on every webview action after a panel has opened', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const job = await h.seedJob();
  h.vscode.workspace.isTrusted = false;
  const actions = [
    { type: 'ready' },
    { type: 'saveAccount', platform: 'wechat', credentials: credentials.wechat },
    { type: 'removeAccount', platform: 'wechat' },
    { type: 'checkAccount', platform: 'wechat' },
    { type: 'prepare', config: config() },
    { type: 'retry', jobId: job.id },
    { type: 'loadJob', jobId: job.id },
    { type: 'execute', jobId: job.id, confirmed: true },
    { type: 'saveDefaults', config: config() },
    { type: 'chooseCover' },
    { type: 'openUrl', url: 'https://www.zhihu.com/' },
  ];
  for (const action of actions) {
    const before = panel.messages.length;
    await panel.receive(action);
    const reply = panel.messages.slice(before);
    assert.equal(reply.length, 1, action.type);
    assert.match(reply[0].message, /信任此工作区/, action.type);
    assert.ok(reply[0].type === 'error' || (reply[0].type === 'accountResult' && !reply[0].success));
  }
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.secretWrites, []);
  assert.deepEqual(h.secretReads, []);
  assert.deepEqual(h.secretDeletes, []);
  assert.deepEqual(h.stateWrites, []);
  assert.deepEqual(h.checks, []);
  assert.deepEqual(h.dialogs, []);
  assert.deepEqual(h.warnings, []);
  assert.deepEqual(h.external, []);
});

test('dirty document save failure prevents opening a panel', async t => {
  const h = await fixture(t);
  h.dirtyDocument();
  assert.equal(await h.host.open(h.source), undefined);
  assert.match(h.errors.at(-1), /文档尚未保存/);
  assert.deepEqual(h.saves, [h.source]);
  assert.deepEqual(h.panels, []);
  assert.deepEqual(h.calls, []);
});

for (const type of ['ready', 'prepare', 'loadJob', 'retry', 'execute']) {
  test(`dirty save failure stops ${type} before any publishing work or native confirmation`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    const job = await h.seedJob();
    h.dirtyDocument();
    await panel.receive({ type, jobId: job.id, config: config() });
    expectError(panel, /文档尚未保存/);
    assert.deepEqual(h.saves, [h.source]);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(messages(panel, 'job'), []);
    assert.deepEqual(messages(panel, 'busy').map(message => message.busy), type === 'ready' || type === 'loadJob' ? [] : [true, false]);
  });
}

test('successful dirty save precedes initialization and preparation of the bound source', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  h.dirtyDocument(h.source, true);
  await panel.receive({ type: 'ready' });
  assert.equal(messages(panel, 'init').at(-1).title, 'Saved editor title');
  h.vscode.workspace.textDocuments[0].isDirty = true;
  h.hooks.prepare = async sourcePath => {
    assert.equal(h.vscode.workspace.textDocuments[0].isDirty, false);
    assert.match(await fs.promises.readFile(sourcePath, 'utf8'), /Saved editor body/);
  };
  await panel.receive({ type: 'prepare', sourcePath: h.otherSource, config: config() });
  assert.deepEqual(h.saves, [h.source, h.source]);
  assert.equal(h.calls.find(call => call.method === 'prepare').sourcePath, h.source, 'webview cannot substitute another source');
});

for (const type of ['loadJob', 'retry', 'execute']) {
  test(`${type} rejects another document's job even when the webview claims that source`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    const foreign = await h.seedJob(h.otherSource);
    h.modalResponse = '确认同步';
    await panel.receive({ type, jobId: foreign.id, sourcePath: h.otherSource, confirmed: true });
    expectError(panel, /任务属于另一篇文档/);
    assert.deepEqual(h.calls.map(call => call.method), ['read']);
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(messages(panel, 'job'), []);
    assert.deepEqual(h.jobs.get(foreign.id).targets, foreign.targets);
  });
}

test('loadJob and retry accept the current document; job output and progress stay in its panel', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const other = await h.open(h.otherSource);
  const job = await h.seedJob();
  await panel.receive({ type: 'loadJob', jobId: job.id });
  assert.equal(messages(panel, 'job').at(-1).job.reviewable, true);
  assert.deepEqual(h.calls.find(call => call.method === 'freshSnapshot'), {
    method: 'freshSnapshot', id: job.id, render: false,
  });
  await panel.receive({ type: 'retry', jobId: job.id });
  assert.equal(h.count('retry'), 1);
  assert.equal(h.count('execute'), 0);
  assert.equal(messages(panel, 'progress').length, 1);
  assert.deepEqual(messages(other, 'job'), []);
  assert.deepEqual(messages(other, 'progress'), []);
});

test('prepare delegates source/config/theme and returns a preview without confirmation or execution', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const other = await h.open(h.otherSource);
  const input = config();
  await panel.receive({ type: 'prepare', config: input, confirmed: true, execute: true });
  assert.equal(h.count('prepare'), 1);
  const call = h.calls.find(item => item.method === 'prepare');
  assert.equal(call.sourcePath, h.source);
  assert.deepEqual(call.input, normalizeConfig(input), 'delegate the complete normalized public config');
  assert.equal(call.options.themeId, h.themeId);
  assert.equal(typeof call.options.notify, 'function');
  assert.equal(h.count('execute'), 0);
  assert.equal(h.count('retry'), 0);
  assert.deepEqual(h.warnings, []);
  const job = messages(panel, 'job').at(-1).job;
  assert.equal(job.sourcePath, h.source);
  assert.ok(Object.values(job.targets).every(target => target.state === 'ready'));
  assert.equal(messages(panel, 'progress').length, 1);
  assert.deepEqual(messages(other, 'job'), []);
  for (const receiver of [panel, other]) {
    assert.deepEqual(messages(receiver, 'busy').map(message => message.busy), [true, false], 'suppress duplicate publisher busy events');
  }
  assert.equal((await fs.promises.readdir(h.publisher.options.directory)).length, 1);
  assertNoSecrets(h);
});

for (const response of [undefined, 'Cancel', true]) {
  test(`native modal response ${String(response)} cancels execute despite webview confirmed=true`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    const job = await h.seedJob();
    h.modalResponse = response;
    await panel.receive({ type: 'execute', jobId: job.id, confirmed: true });
    assert.equal(h.warnings.length, 1);
    const [title, options, confirm] = h.warnings[0];
    assert.match(title, /Preview title/);
    assert.equal(options.modal, true);
    assert.match(options.detail, /公众号草稿/);
    assert.match(options.detail, /知乎公开发布/);
    assert.match(options.detail, /更新文章 current-post.*公开发布/);
    assert.equal(confirm, '确认同步');
    assert.equal(h.count('execute'), 0);
    assert.equal(messages(panel, 'cancelled').length, 1);
    assert.deepEqual(messages(panel, 'job'), []);
    assert.deepEqual(h.jobs.get(job.id).targets, job.targets);
    assert.deepEqual(messages(panel, 'busy').map(message => message.busy), [true, false]);
  });
}

test('native confirmation invokes execute once with confirmed=true; completed targets cannot be resent', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const job = await h.seedJob();
  h.modalResponse = '确认同步';
  await panel.receive({ type: 'execute', jobId: job.id, confirmed: false });
  assert.equal(h.warnings.length, 1);
  assert.equal(h.count('execute'), 1);
  const call = h.calls.find(item => item.method === 'execute');
  assert.equal(call.id, job.id);
  assert.equal(call.options.confirmed, true);
  assert.equal(call.options.expectedSubmissionFingerprint, submissionFingerprint(job));
  assert.equal(typeof call.options.notify, 'function');
  assert.equal(messages(panel, 'job').at(-1).job.targets.zhihu.state, 'published');
  const snapshotIndex = h.calls.findIndex(item => item.method === 'freshSnapshot');
  assert.ok(snapshotIndex >= 0 && snapshotIndex < h.calls.indexOf(call), 'validate freshness before execution');
  await panel.receive({ type: 'execute', jobId: job.id, confirmed: true });
  expectError(panel, /没有待提交的平台/);
  assert.equal(h.count('execute'), 1);
  assert.equal(h.warnings.length, 1);
});

test('stale theme blocks retry and execute before native confirmation; loadJob marks the preview unreviewable', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const job = await h.seedJob();
  h.themeId = 'changed-theme';
  for (const type of ['retry', 'execute']) {
    await panel.receive({ type, jobId: job.id });
    expectError(panel, /主题已变化/);
  }
  await panel.receive({ type: 'loadJob', jobId: job.id });
  assert.equal(messages(panel, 'job').at(-1).job.reviewable, false);
  assert.equal(h.count('retry'), 0);
  assert.equal(h.count('execute'), 0);
  assert.deepEqual(h.warnings, []);
});

test('stale snapshot prevents confirmation and execution; loading it disables review', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const job = await h.seedJob();
  h.hooks.freshSnapshot = () => { throw new Error('Mock document changed since preview'); };
  await panel.receive({ type: 'execute', jobId: job.id });
  expectError(panel, /changed since preview/);
  assert.equal(h.count('execute'), 0);
  assert.deepEqual(h.warnings, []);
  await panel.receive({ type: 'loadJob', jobId: job.id });
  assert.equal(messages(panel, 'job').at(-1).job.reviewable, false);
});

for (const host of ['mp.weixin.qq.com', 'developers.weixin.qq.com', 'www.zhihu.com', 'zhuanlan.zhihu.com', 'www.cnblogs.com', 'i.cnblogs.com']) {
  test(`openUrl allows an HTTPS page on ${host}`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    const url = `https://${host}/article?id=123#preview`;
    await panel.receive({ type: 'openUrl', url });
    assert.deepEqual(messages(panel, 'error'), [], 'an allowlisted HTTPS URL should open successfully');
    assert.deepEqual(h.external, [url]);
  });
}

test('openUrl rejects unsafe schemes, embedded credentials, invalid URLs and hosts outside the exact allowlist', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  for (const url of [
    'http://www.zhihu.com/', 'javascript:alert(1)', 'command:workbench.action.openSettings',
    'file:///tmp/private.md', 'data:text/html,test', '//www.zhihu.com/', 'not a URL',
    'https://user:password@www.zhihu.com/', 'https://user@www.cnblogs.com/',
    'https://www.zhihu.com.evil.invalid/', 'https://evil.invalid/?next=https://www.zhihu.com/',
    'https://www.zhihu.com@evil.invalid/', 'https://127.0.0.1/', 'https://localhost/', '',
    'https://developers.weixin.qq.com.evil.invalid/',
    'https://user:secret@developers.weixin.qq.com/doc/',
    'https://developers.weixin.qq.com/doc/?access_token=private',
    'https://developers.weixin.qq.com/doc/?next=javascript%3Aalert(1)',
    'https://www.cnblogs.com/?next=command%3Aworkbench.action.openSettings',
  ]) {
    const before = messages(panel, 'error').length;
    await panel.receive({ type: 'openUrl', url });
    assert.equal(messages(panel, 'error').length, before + 1, url);
    assert.deepEqual(h.external, [], url);
  }
});

for (const [name, body, expected, summary, titleSource, summarySource] of [
  ['frontmatter', '---\ntitle: Actual title\nsummary: Actual **summary**\n---\n# Ignored heading\n', 'Actual title', 'Actual summary', 'frontmatter.title', 'frontmatter.summary'],
  ['heading', 'Intro.\n\n# Actual heading\n\nBody.\n', 'Actual heading', 'Intro. Body.', 'heading', 'prose'],
  ['filename fallback', 'Body without a heading.\n', 'article', 'Body without a heading.', 'basename', 'prose'],
]) {
  test(`init derives title and summary from the actual document (${name})`, async t => {
    const input = {
      ...config(), title: 'Previous document', summary: 'Previous summary', coverPath: '/old/cover.png',
      options: { wechat: { digest: 'Previous digest' }, cnblogs: { mode: 'publish', postId: 'old-post' } },
    };
    const h = await fixture(t, { defaults: input });
    await fs.promises.writeFile(h.source, body);
    const own = await h.seedJob();
    await h.seedJob(h.otherSource);
    const panel = await h.open();
    await panel.receive({ type: 'ready', sourcePath: h.otherSource, title: 'Untrusted webview title' });
    const init = messages(panel, 'init').at(-1);
    assert.equal(init.sourcePath, h.source);
    assert.equal(init.title, expected);
    assert.equal(init.defaults.title, expected);
    assert.equal(init.defaults.summary, summary);
    assert.equal(init.defaults.coverPath, '');
    assert.equal(init.defaults.options.wechat.digest, '');
    assert.deepEqual(init.metadata, {
      title: expected, summary, author: '', coverPath: '', tags: [], categories: [], titleSource, summarySource,
    });
    const expectedDefaults = normalizeConfig(input);
    expectedDefaults.title = expected;
    expectedDefaults.summary = summary;
    expectedDefaults.coverPath = '';
    expectedDefaults.options.wechat.digest = '';
    delete expectedDefaults.options.cnblogs.postId;
    assert.deepEqual(init.defaults, expectedDefaults, 'initialization must retain the full normalized config contract');
    assert.deepEqual(init.jobs.map(job => job.id), [own.id]);
    assert.deepEqual(h.stateWrites, [], 'initialization must not rewrite preferences');
    assertNoSecrets(h);
  });
}

test('init uses source author, tags, categories and local cover without reusing another document summary or digest', async t => {
  const input = {
    ...config(), title: 'Previous title', summary: 'Previous summary', coverPath: '/previous/cover.png',
    options: {
      wechat: { author: 'Saved author', digest: 'Previous digest', comments: true },
      zhihu: { topics: ['Saved topic'] },
      cnblogs: { categories: ['Saved category'], tags: ['Saved tag'], postId: 'old-post', mode: 'publish' },
    },
  };
  const h = await fixture(t, { defaults: input });
  const coverPath = path.join(h.directory, 'cover.png');
  await fs.promises.writeFile(coverPath, 'mock local cover');
  await fs.promises.writeFile(h.source,
    '---\ntitle: Current **title**\nsummary: Current **summary**\nauthor: Current author\n' +
    'cover: cover.png\ntags: [current-tag]\ncategories: [current-category]\n---\n# Heading\n\nBody.\n');
  const panel = await h.open();
  await panel.receive({ type: 'ready' });
  const init = messages(panel, 'init').at(-1);
  assert.deepEqual(init.metadata, {
    title: 'Current title', summary: 'Current summary', author: 'Current author', coverPath,
    tags: ['current-tag'], categories: ['current-category'],
    titleSource: 'frontmatter.title', summarySource: 'frontmatter.summary',
  });
  assert.equal(init.defaults.title, init.metadata.title);
  assert.equal(init.defaults.summary, init.metadata.summary);
  assert.equal(init.defaults.coverPath, coverPath);
  assert.equal(init.defaults.options.wechat.author, 'Current author');
  assert.equal(init.defaults.options.wechat.digest, '');
  assert.equal(init.defaults.options.wechat.comments, true);
  assert.deepEqual(init.defaults.options.zhihu.topics, ['Saved topic']);
  assert.deepEqual(init.defaults.options.cnblogs.tags, ['current-tag']);
  assert.deepEqual(init.defaults.options.cnblogs.categories, ['current-category']);
  assert.ok(!Object.hasOwn(init.defaults.options.cnblogs, 'postId'));
  assert.deepEqual(h.state.get(DEFAULTS_KEY), input, 'source suggestions must not overwrite saved preferences');
  assert.deepEqual(h.stateWrites, []);
});

test('a source with no prose has an empty summary even when defaults contain summary, digest and titles', async t => {
  const h = await fixture(t, { defaults: {
    ...config(), title: 'Previous title', summary: 'Previous summary',
    options: { wechat: { title: 'Previous platform title', digest: 'Previous digest' } },
  } });
  await fs.promises.writeFile(h.source, '```\nOnly code, no prose or heading.\n```\n');
  const panel = await h.open();
  await panel.receive({ type: 'ready' });
  const init = messages(panel, 'init').at(-1);
  assert.equal(init.title, 'article');
  assert.equal(init.defaults.title, 'article');
  assert.equal(init.defaults.summary, '');
  assert.equal(init.defaults.options.wechat.digest, '');
  assert.equal(init.defaults.options.wechat.title, '');
  assert.equal(init.metadata.summary, '');
  assert.equal(init.metadata.summarySource, '');
  assert.deepEqual(h.stateWrites, []);
});

test('refreshMetadata explicitly rereads only the bound source and does not change defaults or user-entered preparation fields', async t => {
  const input = { ...config(), title: 'Saved old title', summary: 'Saved old summary' };
  const h = await fixture(t, { defaults: input });
  const panel = await h.open(h.source, { platform: 'zhihu' });
  const other = await h.open(h.otherSource);
  await panel.receive({ type: 'ready' });
  const initial = copy(messages(panel, 'init').at(-1));
  const body = '---\ntitle: Refreshed **title**\nsummary: Refreshed **summary**\n---\n# Heading\n\nChanged body.\n';
  await fs.promises.writeFile(h.source, body);
  await h.textChanges.emit({ document: { uri: { fsPath: h.source } } });
  assert.equal(messages(panel, 'invalidated').length, 1);
  assert.deepEqual(messages(panel, 'metadata'), [], 'editing invalidates the preview; metadata refresh must be explicit');
  assert.equal(messages(panel, 'init').length, 1);
  const calls = [...h.calls];
  const secretReads = [...h.secretReads];
  await panel.receive({ type: 'refreshMetadata', sourcePath: h.otherSource, title: 'Untrusted title' });
  assert.deepEqual(messages(panel, 'metadata'), [{
    type: 'metadata',
    metadata: {
      title: 'Refreshed title', summary: 'Refreshed summary', author: '', coverPath: '', tags: [], categories: [],
      titleSource: 'frontmatter.title', summarySource: 'frontmatter.summary',
    },
  }]);
  assert.deepEqual(messages(panel, 'init'), [initial], 'refresh must not reinitialize the form');
  assert.deepEqual(messages(other, 'metadata'), []);
  assert.deepEqual(h.calls, calls, 'metadata refresh must not read or create publishing jobs');
  assert.deepEqual(h.secretReads, secretReads, 'metadata refresh must not consult account credentials');
  assert.deepEqual(h.stateWrites, []);
  assert.deepEqual(h.state.get(DEFAULTS_KEY), input);
  assert.equal(await fs.promises.readFile(h.source, 'utf8'), body);
  assert.deepEqual(h.snapshots, []);
  const manual = { ...config(), title: 'User-entered title', summary: 'User-entered summary' };
  await panel.receive({ type: 'prepare', config: manual });
  assert.deepEqual(h.calls.find(call => call.method === 'prepare').input,
    normalizeConfig({ ...manual, targets: ['zhihu'] }), 'refresh suggestions must not override explicit preparation values');
});

for (const saved of [false, true]) {
  test(`refreshMetadata ${saved ? 'uses a successful dirty save' : 'stops when a dirty save fails'}`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    h.dirtyDocument(h.source, saved);
    await panel.receive({ type: 'refreshMetadata', sourcePath: h.otherSource });
    assert.deepEqual(h.saves, [h.source]);
    if (saved) {
      const metadata = messages(panel, 'metadata').at(-1).metadata;
      assert.equal(metadata.title, 'Saved editor title');
      assert.equal(metadata.summary, 'Saved editor body.');
      assert.deepEqual(messages(panel, 'error'), []);
    } else {
      expectError(panel, /文档尚未保存/);
      assert.deepEqual(messages(panel, 'metadata'), []);
    }
    assert.deepEqual(h.secretReads, []);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.stateWrites, []);
    assert.deepEqual(h.snapshots, []);
  });
}

test('init must not inherit a previous document cnblogs postId from stored defaults', async t => {
  const h = await fixture(t, { defaults: config() });
  const panel = await h.open();
  await panel.receive({ type: 'ready' });
  const defaults = messages(panel, 'init').at(-1).defaults;
  assert.ok(!Object.hasOwn(defaults.options.cnblogs, 'postId'), 'a new document must not default to updating a previous post');
});

test('init must not inherit previous per-platform title overrides from stored defaults', async t => {
  const input = config();
  input.options.wechat = { title: 'Previous WeChat title' };
  input.options.zhihu = { title: 'Previous Zhihu title' };
  input.options.cnblogs.title = 'Previous blog title';
  const h = await fixture(t, { defaults: input });
  const panel = await h.open();
  await panel.receive({ type: 'ready' });
  const defaults = messages(panel, 'init').at(-1).defaults;
  for (const platform of PLATFORMS) {
    assert.equal(defaults.options[platform].title, '', `${platform} should use the current document title`);
  }
});

test('invalid stored defaults fall back to safe targets and the actual document title', async t => {
  const h = await fixture(t, { defaults: { targets: ['invalid-platform'] } });
  const panel = await h.open();
  await panel.receive({ type: 'ready' });
  const init = messages(panel, 'init').at(-1);
  assert.equal(init.defaults.title, 'Actual frontmatter title');
  assert.deepEqual(init.defaults.targets, ['wechat', 'cnblogs']);
  assert.ok(!Object.hasOwn(init.defaults.options.cnblogs, 'postId'));
});

test('saveDefaults persists reusable options and clears title, summary, digest, cover, postId and credentials', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const input = config();
  input.coverPath = '/previous/cover.png';
  input.summary = 'Previous document summary';
  input.credentials = credentials;
  for (const platform of PLATFORMS) input.options[platform] = { ...input.options[platform], title: 'Old title' };
  input.options.wechat.digest = 'Previous WeChat digest';
  input.options.wechat.author = 'Reusable author';
  input.options.zhihu.topics = ['Reusable topic'];
  input.options.cnblogs.tags = ['Reusable tag'];
  await panel.receive({ type: 'saveDefaults', config: input });
  const stored = h.state.get(DEFAULTS_KEY);
  assert.equal(stored.title, '');
  assert.equal(stored.summary, '');
  assert.equal(stored.coverPath, '');
  assert.equal(stored.options.wechat.digest, '');
  assert.equal(stored.options.cnblogs.mode, 'publish');
  assert.ok(!Object.hasOwn(stored.options.cnblogs, 'postId'));
  assert.ok(!Object.hasOwn(stored, 'credentials'));
  for (const platform of PLATFORMS) assert.equal(stored.options[platform].title, '');
  assert.equal(stored.options.wechat.author, 'Reusable author');
  assert.deepEqual(stored.options.zhihu.topics, ['Reusable topic']);
  assert.deepEqual(stored.options.cnblogs.tags, ['Reusable tag']);
  assert.equal(messages(panel, 'defaultsSaved').length, 1);
  assertNoSecrets(h);
  const other = await h.open(h.otherSource);
  await other.receive({ type: 'ready' });
  const defaults = messages(other, 'init').at(-1).defaults;
  assert.equal(defaults.title, 'Other document');
  assert.equal(defaults.summary, 'Other body.');
  assert.equal(defaults.options.wechat.digest, '');
  assert.equal(defaults.options.wechat.author, 'Reusable author');
  assert.deepEqual(defaults.options.zhihu.topics, ['Reusable topic']);
  assert.deepEqual(defaults.options.cnblogs.tags, ['Reusable tag']);
  assert.ok(!Object.hasOwn(defaults.options.cnblogs, 'postId'));
});

for (const platform of PLATFORMS) {
  test(`${platform}: scoped saveDefaults preserves shared targets and other platform preferences while clearing article metadata`, async t => {
    const storedInput = {
      targets: ['cnblogs', 'wechat'], title: 'Previous article title', summary: 'Previous article summary',
      coverPath: '/previous/article-cover.png',
      options: {
        wechat: {
          title: 'Previous WeChat title', author: 'Stored author', digest: 'Previous article digest',
          comments: true, fansOnly: true, sourceUrl: 'https://www.cnblogs.com/stored/',
        },
        zhihu: {
          title: 'Previous Zhihu title', topics: ['Stored topic'], commentPermission: 'all',
          creationStatement: 'Stored statement', tableOfContentsEnabled: true,
        },
        cnblogs: {
          title: 'Previous blog title', categories: ['Stored category'], tags: ['Stored tag'],
          mode: 'publish', comments: false, coverAsFirstImage: true, postId: 'previous-article-id',
        },
      },
    };
    const h = await fixture(t, { defaults: storedInput });
    const panel = await h.open(h.source, { platform });
    await panel.receive({ type: 'ready' });
    const input = {
      targets: [platform], title: 'Current article title', summary: 'Current article summary',
      coverPath: '/current/article-cover.png', credentials,
      options: {
        wechat: {
          title: 'Current WeChat title', author: 'Updated author', digest: 'Current article digest',
          comments: false, fansOnly: false, sourceUrl: 'https://www.cnblogs.com/updated/',
        },
        zhihu: {
          title: 'Current Zhihu title', topics: ['Updated topic'], commentPermission: 'none',
          creationStatement: 'Updated statement', tableOfContentsEnabled: false,
        },
        cnblogs: {
          title: 'Current blog title', categories: ['Updated category'], tags: ['Updated tag'],
          mode: 'draft', comments: true, coverAsFirstImage: false, postId: 'current-article-id',
        },
      },
    };
    const original = copy(input);
    const expected = normalizeConfig(storedInput);
    expected.options[platform] = normalizeConfig(input).options[platform];
    expected.title = '';
    expected.summary = '';
    expected.coverPath = '';
    expected.options.wechat.digest = '';
    for (const options of Object.values(expected.options)) options.title = '';
    delete expected.options.cnblogs.postId;

    await panel.receive({ type: 'saveDefaults', config: input });
    assert.deepEqual(h.stateWrites, [{ key: DEFAULTS_KEY, value: expected }]);
    assert.deepEqual(h.state.get(DEFAULTS_KEY), expected, 'merge only the selected platform preferences into shared defaults');
    assert.deepEqual(expected.targets, storedInput.targets, 'a scoped save must not change the multi-platform selection');
    assert.deepEqual(input, original, 'clearing persisted metadata must not mutate the current form values');
    assert.deepEqual(messages(panel, 'defaultsSaved'), [{ type: 'defaultsSaved' }]);
    assert.deepEqual(messages(panel, 'error'), []);
    assert.equal(h.count('prepare'), 0);
    assert.equal(h.count('execute'), 0);
    assert.equal(h.jobs.size, 0);
    assert.deepEqual(h.secretWrites, []);
    assertNoSecrets(h);

    const other = await h.open(h.otherSource);
    await other.receive({ type: 'ready' });
    const defaults = messages(other, 'init').at(-1).defaults;
    assert.deepEqual(defaults, { ...expected, title: 'Other document', summary: 'Other body.' },
      'a later multi-platform form must retain the merged preferences and use its own article metadata');
    assert.equal(h.stateWrites.length, 1, 'initializing another document must not rewrite the merged defaults');
  });
}

for (const operation of ['prepare', 'modal']) {
  test(`busy ${operation} rejects concurrent publishing and account mutations across panels and then releases`, { timeout: 5000 }, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    const other = await h.open(h.otherSource);
    const job = await h.seedJob();
    const foreign = await h.seedJob(h.otherSource);
    const entered = deferred();
    const release = deferred();
    if (operation === 'prepare') {
      h.hooks.prepare = async () => { entered.resolve(); await release.promise; };
    } else {
      h.hooks.modal = async () => { entered.resolve(); await release.promise; return '确认同步'; };
    }
    const active = panel.receive(operation === 'prepare'
      ? { type: 'prepare', config: config() }
      : { type: 'execute', jobId: job.id });
    try {
      await Promise.race([entered.promise, active.then(() => assert.fail('operation did not reach the gate'))]);
      for (const action of [
        { type: 'prepare', config: config() },
        { type: 'retry', jobId: foreign.id },
        { type: 'execute', jobId: foreign.id, confirmed: true },
        { type: 'saveAccount', platform: 'wechat', credentials: credentials.wechat },
        { type: 'removeAccount', platform: 'wechat' },
        { type: 'checkAccount', platform: 'wechat' },
      ]) {
        const before = other.messages.length;
        await other.receive(action);
        const reply = other.messages.slice(before);
        assert.equal(reply.length, 1, action.type);
        assert.match(reply[0].message, /另一个同步操作正在运行/, action.type);
        assert.ok(reply[0].type === 'error' || (reply[0].type === 'accountResult' && !reply[0].success));
      }
      assert.equal(h.count('prepare'), operation === 'prepare' ? 1 : 0);
      assert.equal(h.count('retry'), 0);
      assert.equal(h.count('execute'), 0);
      assert.deepEqual(h.secretWrites, []);
      assert.deepEqual(h.secretDeletes, []);
      assert.deepEqual(h.checks, []);
    } finally {
      release.resolve();
      await active;
    }
    for (const receiver of [panel, other]) assert.deepEqual(messages(receiver, 'busy').map(message => message.busy), [true, false]);
    delete h.hooks.prepare;
    await other.receive({ type: 'prepare', config: config() });
    assert.equal(messages(other, 'job').at(-1).job.sourcePath, h.otherSource);
  });
}

test('publisher.running independently rejects new operations; failures release the host busy flag', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  h.publisher.running = true;
  await panel.receive({ type: 'prepare', config: config() });
  expectError(panel, /另一个同步操作正在运行/);
  assert.equal(h.count('prepare'), 0);
  assert.deepEqual(messages(panel, 'busy'), []);
  h.publisher.running = false;
  h.hooks.prepare = () => { throw new Error('Mock preparation failure'); };
  await panel.receive({ type: 'prepare', config: config() });
  expectError(panel, /Mock preparation failure/);
  delete h.hooks.prepare;
  await panel.receive({ type: 'prepare', config: config() });
  assert.equal(messages(panel, 'job').length, 1);
  assert.deepEqual(messages(panel, 'busy').map(message => message.busy), [true, false, true, false]);
});

test('testConnections ignores hostile article fields and never reads, saves, snapshots or creates jobs', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  for (const platform of PLATFORMS) h.secretValues.set(SECRET_PREFIX + platform, JSON.stringify(credentials[platform]));
  h.hooks.check = platform => platform === 'wechat' ? { draftAccess: true } : { blogId: '42' };
  h.dirtyDocument(h.source, false);
  const readFile = fs.promises.readFile;
  const files = await fs.promises.readdir(h.publisher.options.directory);
  fs.promises.readFile = async (file, ...args) => {
    assert.notEqual(file, h.source, 'connection tests must never read the article');
    return readFile(file, ...args);
  };
  Object.defineProperty(h.vscode.workspace, 'textDocuments', {
    configurable: true, get() { assert.fail('connection tests must not inspect editor documents'); },
  });
  const hostile = {
    type: 'testConnections', targets: ['wechat', 'zhihu', 'cnblogs', 'wechat'],
    sourcePath: h.otherSource, confirmed: true, credentials: { token: 'untrusted' },
  };
  Object.defineProperty(hostile, 'config', { get() { assert.fail('must not read article config'); } });
  try { await panel.receive(hostile); }
  finally { fs.promises.readFile = readFile; }
  expectTestResult(panel, 'wechat', 'passed');
  const zhihuResult = expectTestResult(panel, 'zhihu', 'warning');
  assert.equal(zhihuResult.message, '已取消测试，尚未验证授权');
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.uploadTests, [], 'default modal cancellation must not upload media');
  expectTestResult(panel, 'cnblogs', 'passed');
  assert.equal(messages(panel, 'testResult').length, 3);
  assert.equal(messages(panel, 'testsComplete').length, 1);
  assert.deepEqual(h.checks.map(item => item.platform), ['wechat', 'cnblogs']);
  for (const ctx of h.checks) assert.deepEqual(Object.keys(ctx).sort(), ['platform', 'credentials', 'request'].sort());
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.snapshots, []);
  assert.deepEqual(h.validations, []);
  assert.deepEqual(h.adapterWrites, []);
  assert.deepEqual(h.secretWrites, []);
  assert.deepEqual(await fs.promises.readdir(h.publisher.options.directory), files);
  assertNoSecrets(h);
});

test('testConnections continues after failures, redacts diagnostics and leaves article validation untouched', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  for (const platform of PLATFORMS) h.secretValues.set(SECRET_PREFIX + platform, JSON.stringify(credentials[platform]));
  h.hooks.check = platform => {
    if (platform === 'wechat') throw new Error(`IP whitelist denied ${credentials.wechat.appSecret}`);
    return { blogId: '42' };
  };
  await panel.receive({ type: 'testConnections', targets: PLATFORMS,
    config: { title: '', coverPath: '/missing', options: { zhihu: { topics: 99 }, cnblogs: { tags: 42 } } } });
  expectTestResult(panel, 'wechat', 'failed');
  expectTestResult(panel, 'zhihu', 'warning');
  expectTestResult(panel, 'cnblogs', 'passed');
  assert.match(messages(panel, 'testResult')[0].message, /IP whitelist denied/);
  assert.match(messages(panel, 'testResult')[0].message, /平台设置/);
  assert.equal(messages(panel, 'testsComplete').length, 1);
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.uploadTests, []);
  assertNoSecrets(h);
});

for (const scope of [null, 'zhihu']) {
  test(`testConnections in ${scope || 'multi-platform'} scope confirms once and runs the generated PNG diagnostic`, async t => {
    const { runZhihuUploadTest } = require('../lib/publishing/zhihu-diagnostic');
    const { PNG } = require('pngjs');
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const uploads = [];
    const h = await fixture(t, {
      testZhihuUpload: options => runZhihuUploadTest({
        ...options,
        uploadImage: async (ctx, asset) => {
          uploads.push({ ctx, asset });
          return { url: 'https://pic.example.test/connection-test.png' };
        },
      }),
    });
    const panel = await h.open(h.source, { platform: scope });
    h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
    h.dirtyDocument();
    const sourceBefore = await fs.promises.readFile(h.source);
    const readFile = fs.promises.readFile;
    const writeFile = fs.promises.writeFile;
    Object.defineProperty(h.vscode.workspace, 'textDocuments', {
      configurable: true, get() { assert.fail('connection diagnostic must not inspect editor documents'); },
    });
    h.hooks.modal = async () => {
      entered.resolve();
      await release.promise;
      return '上传测试图';
    };
    const message = { type: 'testConnections', targets: ['zhihu', 'zhihu'], confirmed: true,
      sourcePath: h.otherSource, credentials: { appKey: 'hostile-key', appSecret: 'hostile-secret' } };
    Object.defineProperty(message, 'config', { get() { assert.fail('must ignore article configuration'); } });
    fs.promises.readFile = async (file, ...args) => {
      assert.ok(file !== h.source && file !== h.otherSource, 'diagnostic must not read either article');
      return readFile(file, ...args);
    };
    fs.promises.writeFile = async (file, ...args) => {
      assert.ok(file !== h.source && file !== h.otherSource, 'diagnostic must not write either article');
      return writeFile(file, ...args);
    };
    try {
      const pending = panel.receive(message);
      await entered.promise;
      assert.deepEqual(h.uploadTests, []);
      assert.deepEqual(uploads, []);
      assert.deepEqual(messages(panel, 'testsComplete'), []);
      const [title, options, ...buttons] = h.warnings[0];
      assert.match(title, /知乎连接.*图片上传/);
      assert.equal(options.modal, true);
      assert.match(options.detail, /320.*180.*PNG/);
      assert.match(options.detail, /不读取当前文章.*不会创建文章草稿或发布文章/);
      assert.ok(options.detail.includes(credentials.zhihu.appKey));
      assert.deepEqual(buttons, ['上传测试图']);
      release.resolve();
      await pending;
    } finally {
      release.resolve();
      fs.promises.readFile = readFile;
      fs.promises.writeFile = writeFile;
    }
    assert.equal(h.warnings.length, 1, 'the primary action must not trigger a second confirmation');
    assert.equal(h.uploadTests.length, 1);
    assert.deepEqual(Object.keys(h.uploadTests[0]).sort(), ['credentials', 'request']);
    assert.deepEqual(h.uploadTests[0].credentials, credentials.zhihu);
    assert.equal(h.uploadTests[0].request, h.transport);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].ctx.request, h.transport);
    assert.deepEqual(uploads[0].ctx.credentials, credentials.zhihu);
    assert.equal(uploads[0].asset.mimeType, 'image/png');
    const png = PNG.sync.read(uploads[0].asset.buffer);
    assert.equal(png.width, 320);
    assert.equal(png.height, 180);
    const result = expectTestResult(panel, 'zhihu', 'passed');
    assert.equal(result.message, '连接与图片上传通过；文章发布权限尚未验证');
    assert.ok(result.checks.some(check => check.label === 'publishing' && check.status === 'warning'));
    assert.deepEqual(messages(panel, 'testsComplete'), [{ type: 'testsComplete' }]);
    assert.equal(panel.messages.at(-1).type, 'testsComplete');
    assert.deepEqual(messages(panel, 'uploadTestResult'), [], 'use the primary testResult protocol');
    assert.deepEqual(messages(panel, 'error'), []);
    assert.deepEqual(messages(panel, 'busy').map(message => message.busy), [true, false]);
    assert.deepEqual(await fs.promises.readFile(h.source), sourceBefore);
    await assertUploadOnly(h);
  });
}

for (const response of [undefined, true, '确认同步', '取消']) {
  test(`testConnections Zhihu response ${String(response)} reports unverified cancellation without media`, async t => {
    const h = await fixture(t);
    h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
    const panel = await h.open();
    h.modalResponse = response;
    await panel.receive({ type: 'testConnections', targets: ['zhihu'], confirmed: true });
    assert.equal(expectTestResult(panel, 'zhihu', 'warning').message, '已取消测试，尚未验证授权');
    assert.deepEqual(h.uploadTests, []);
    assert.equal(h.warnings.length, 1);
    assert.equal(messages(panel, 'testsComplete').length, 1);
    await assertUploadOnly(h);
  });
}

for (const invalid of [null, { appKey: 'partial' }, { appSecret: 'TEST_SECRET_ONLY' },
  { appKey: 'partial', appSecret: ' ' }]) {
  test(`testConnections incomplete Zhihu configuration ${JSON.stringify(Object.keys(invalid || {}))} skips prompt and media`, async t => {
    const h = await fixture(t);
    if (invalid) h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(invalid));
    const panel = await h.open();
    h.modalResponse = '上传测试图';
    await panel.receive({ type: 'testConnections', targets: ['zhihu'] });
    expectTestResult(panel, 'zhihu', 'failed');
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(h.uploadTests, []);
    assert.equal(messages(panel, 'testsComplete').length, 1);
    await assertUploadOnly(h);
  });
}

for (const mutation of ['secret', 'local secret', 'source', 'source with refresh', 'trust']) {
  test(`testConnections blocks Zhihu ${mutation} drift during confirmation`, async t => {
    let local = copy(localCredentials);
    const h = await fixture(t, { resolveLocalCredentials: async () => local });
    if (mutation === 'secret') h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
    const panel = await h.open();
    h.hooks.modal = async () => {
      if (mutation === 'secret') {
        h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify({ ...credentials.zhihu, appSecret: 'CHANGED_SECRET' }));
      } else if (mutation === 'local secret') local.credentials.appSecret = 'CHANGED_LOCAL_SECRET';
      else if (mutation === 'trust') h.vscode.workspace.isTrusted = false;
      else local.source = 'environment'; // Keep identical credential values.
      if (mutation === 'source with refresh') await h.secretChanges.emit({ key: SECRET_PREFIX + 'zhihu' });
      return '上传测试图';
    };
    await panel.receive({ type: 'testConnections', targets: ['zhihu'] });
    const result = expectTestResult(panel, 'zhihu', 'failed');
    assert.match(result.message, mutation === 'trust' ? /信任/ : /账号.*变化/);
    assert.match(result.message, /知乎开放平台设置/);
    assert.equal(h.warnings.length, 1);
    assert.deepEqual(h.uploadTests, []);
    assert.equal(messages(panel, 'testsComplete').length, 1);
    assert.deepEqual(messages(panel, 'error'), []);
    await assertUploadOnly(h);
  });
}

for (const outcome of ['passed', 'failed', 'warning', 'throw', 'empty', 'modal failure']) {
  test(`testConnections combines Zhihu ${outcome} with other platform results and keeps diagnostics redacted`, async t => {
    const secret = credentials.zhihu.appSecret;
    const forms = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'),
      new URLSearchParams({ v: secret }).toString().slice(2), JSON.stringify(secret).slice(1, -1)];
    const detail = `Mock image diagnostic ${forms.join(' ')} access_token=SERVER_TEST_SECRET`;
    const h = await fixture(t, { testZhihuUpload: async () => {
      if (outcome === 'throw') throw Object.assign(new Error(detail), { payload: credentials.zhihu });
      if (outcome === 'empty') return undefined;
      return { ...uploadDiagnosticResult(), status: outcome, message: detail,
        checks: [{ label: 'image-upload', status: outcome, message: detail }], credentials: credentials.zhihu };
    } });
    for (const platform of PLATFORMS) h.secretValues.set(SECRET_PREFIX + platform, JSON.stringify(credentials[platform]));
    const panel = await h.open();
    h.hooks.check = platform => platform === 'wechat' ? { draftAccess: true } : { blogId: '42' };
    h.modalResponse = '上传测试图';
    if (outcome === 'modal failure') h.hooks.modal = () => { throw new Error(detail); };
    await panel.receive({ type: 'testConnections', targets: ['zhihu', 'wechat', 'cnblogs'],
      config: { title: '', coverPath: '/missing', options: { zhihu: { topics: 42 } } } });
    const result = expectTestResult(panel, 'zhihu', outcome === 'passed' ? 'passed' : outcome === 'warning' ? 'warning' : 'failed');
    if (!['passed', 'empty'].includes(outcome)) {
      assert.match(result.message, /Mock image diagnostic/);
      assert.match(result.message, /知乎开放平台设置/);
    }
    expectTestResult(panel, 'wechat', 'passed');
    expectTestResult(panel, 'cnblogs', 'passed');
    assert.equal(messages(panel, 'testResult').length, 3);
    assert.equal(h.uploadTests.length, outcome === 'modal failure' ? 0 : 1);
    assert.equal(h.warnings.length, 1);
    assert.equal(messages(panel, 'testsComplete').length, 1);
    assert.deepEqual(messages(panel, 'error'), []);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.snapshots, []);
    assert.deepEqual(h.validations, []);
    assert.deepEqual(h.adapterWrites, []);
    const output = JSON.stringify(panel.messages);
    for (const value of [...forms, 'SERVER_TEST_SECRET']) assert.ok(!output.includes(value), 'diagnostic secrets must be redacted');
    assert.ok(!output.includes('"payload"'));
    assertNoSecrets(h);
  });
}

for (const scope of PLATFORMS) {
  test(`testConnections validates ${scope} scope without overriding requested targets`, async t => {
    const h = await fixture(t);
    const panel = await h.open(h.source, { platform: scope });
    h.secretValues.set(SECRET_PREFIX + scope, JSON.stringify(credentials[scope]));
    h.hooks.check = platform => platform === 'wechat' ? { draftAccess: true } : { blogId: '42' };
    const other = PLATFORMS.find(platform => platform !== scope);
    for (const targets of [[other], [scope, other], [], ['invalid'], undefined, scope]) {
      await panel.receive({ type: 'testConnections', targets, platform: scope });
    }
    assert.equal(messages(panel, 'testsComplete').length, 6);
    assert.deepEqual(messages(panel, 'testResult'), []);
    assert.deepEqual(h.secretReads, []);
    await panel.receive({ type: 'testConnections', targets: [scope] });
    expectTestResult(panel, scope, scope === 'zhihu' ? 'warning' : 'passed');
    assert.equal(messages(panel, 'testsComplete').length, 7);
  });
}

test('sync saves and prepares the bound source, posts the job before native confirmation and executes once', async t => {
  const h = await fixture(t);
  const panel = await h.open(h.source, { platform: 'cnblogs' });
  h.dirtyDocument(h.source, true);
  const input = { targets: ['zhihu'], title: 'Sync title', credentials: credentials,
    options: {}, confirmed: true };
  h.hooks.modal = () => {
    assert.equal(messages(panel, 'job').length, 1, 'prepared job must be visible before confirmation');
    assert.equal(h.count('execute'), 0);
    assert.match(h.warnings[0][1].detail, /博客园新建文章（草稿）/);
    assert.doesNotMatch(h.warnings[0][1].detail, /已预览|知乎公开发布/);
    return '确认同步';
  };
  await panel.receive({ type: 'sync', config: input, sourcePath: h.otherSource,
    jobId: 'hostile', themeId: 'hostile', confirmed: false, previewed: false });
  const prepared = h.calls.find(call => call.method === 'prepare');
  assert.equal(prepared.sourcePath, h.source);
  assert.equal(prepared.options.themeId, h.themeId);
  assert.deepEqual(prepared.input.targets, ['cnblogs']);
  assert.equal(prepared.input.credentials, undefined);
  assert.deepEqual(h.saves, [h.source]);
  assert.equal(h.count('execute'), 1);
  assert.equal(h.count('freshSnapshot'), 2);
  assert.equal(messages(panel, 'job').length, 2);
  assert.equal(messages(panel, 'syncComplete').length, 1);
  assert.deepEqual(messages(panel, 'busy').map(item => item.busy), [true, false]);
});

test('sync cancellation ignores frontend confirmation and preserves the prepared job without submitting', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  await panel.receive({ type: 'sync', config: config(), confirmed: true, previewed: true });
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.count('execute'), 0);
  assert.deepEqual(messages(panel, 'cancelled'), [{ type: 'cancelled', operation: 'sync' }]);
  assert.equal(messages(panel, 'syncComplete').length, 1);
});

test('sync with no ready targets reports failed preparation without asking to submit', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  h.hooks.preparedJob = job => {
    for (const target of Object.values(job.targets)) target.state = 'failed';
  };
  h.modalResponse = '确认同步';
  await panel.receive({ type: 'sync', config: config() });
  expectError(panel, /没有待提交的平台/);
  assert.equal(h.count('execute'), 0);
  assert.deepEqual(h.warnings, []);
  assert.equal(messages(panel, 'job').length, 1);
  assert.equal(messages(panel, 'syncComplete').length, 1);
});

test('partial sync confirms only ready actions and lists failed platforms without claiming preview', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  h.hooks.preparedJob = job => {
    job.targets.wechat.state = 'failed';
    job.targets.cnblogs.state = 'unknown';
  };
  h.modalResponse = '确认同步';
  await panel.receive({ type: 'sync', config: config() });
  const detail = h.warnings[0][1].detail;
  assert.match(detail, /^知乎公开发布\n/);
  assert.match(detail, /准备失败，本次不提交：公众号/);
  assert.doesNotMatch(detail, /公众号草稿|更新文章|已预览/);
  const final = messages(panel, 'job').at(-1).job;
  assert.equal(final.targets.wechat.state, 'failed');
  assert.equal(final.targets.zhihu.state, 'published');
  assert.equal(final.targets.cnblogs.state, 'unknown');
  await panel.receive({ type: 'execute', jobId: final.id });
  expectError(panel, /没有待提交的平台/);
  assert.equal(h.count('execute'), 1, 'unknown and successful platforms never resend');
});

for (const mutation of ['article', 'dirty save', 'theme', 'trust', 'scope', 'job source', 'job config', 'ready set', 'account', 'account source']) {
  test(`sync blocks writes after ${mutation} changes during the native modal`, async t => {
    let local = copy(localCredentials);
    const h = await fixture(t, { resolveLocalCredentials: async () => local });
    const panel = await h.open(h.source, { platform: 'zhihu' });
    h.hooks.modal = async () => {
      if (mutation === 'article') {
        await fs.promises.writeFile(h.source, '# Changed during modal');
        h.hooks.freshSnapshot = () => { throw new Error('Article changed during modal'); };
      } else if (mutation === 'dirty save') {
        h.dirtyDocument(h.source, false);
      } else if (mutation === 'theme') h.themeId = 'changed-theme';
      else if (mutation === 'trust') h.vscode.workspace.isTrusted = false;
      else if (['scope', 'job source', 'job config', 'ready set'].includes(mutation)) {
        const job = copy([...h.jobs.values()][0]);
        if (mutation === 'scope') job.config.targets.push('cnblogs');
        else if (mutation === 'job source') job.sourcePath = h.otherSource;
        else if (mutation === 'job config') job.config.options.zhihu.creationStatement = 'changed';
        else job.targets.zhihu.state = 'unknown';
        await h.publisher.persist(job);
      } else {
        if (mutation === 'account') local.credentials.appSecret = 'TEST_CHANGED_SECRET';
        else local.source = 'environment'; // Identical credentials, different SOURCE.
        // Simulate a refresh that updates entry.accountBindings during the modal.
        await h.secretChanges.emit({ key: SECRET_PREFIX + 'zhihu' });
      }
      return '确认同步';
    };
    await panel.receive({ type: 'sync', config: { targets: ['zhihu'] } });
    assert.equal(h.warnings.length, 1);
    assert.equal(h.count('execute'), 0);
    assert.equal(messages(panel, 'error').length, 1);
    assert.equal(messages(panel, 'syncComplete').length, 1);
  });
}

for (const operation of ['sync', 'execute']) {
  for (const mutation of ['HTML', 'payload', 'media attributes', 'binding', 'platform options']) {
    test(`${operation} rejects changed ready ${mutation} during native confirmation`, async t => {
      const h = await fixture(t);
      const panel = await h.open();
      let original;
      h.hooks.preparedJob = job => {
        job.fingerprint = 'mock-unchanged-source-fingerprint';
        for (const target of Object.values(job.targets)) {
          target.binding = 'mock-original-account-binding';
          target.prepared = {
            html: '<p>Original<img src="https://media.invalid/original.png" width="320"></p>',
            payload: { title: 'Original payload', media: { url: 'https://media.invalid/original.png', width: 320 } },
          };
        }
      };
      let seeded;
      if (operation === 'execute') {
        seeded = h.makeJob();
        h.hooks.preparedJob(seeded);
        await h.publisher.persist(seeded);
      }
      h.hooks.modal = async () => {
        const job = await h.publisher.read([...h.jobs.keys()][0]);
        original = copy(job);
        const target = job.targets.wechat;
        if (mutation === 'HTML') target.prepared.html += '<p>Changed body</p>';
        else if (mutation === 'payload') target.prepared.payload.title = 'Changed payload only';
        else if (mutation === 'media attributes') target.prepared.payload.media.width = 640;
        else if (mutation === 'binding') target.binding = 'mock-replacement-binding';
        else job.config.options.wechat.comments = !job.config.options.wechat.comments;
        // Change the actual persisted data without changing the source snapshot
        // or ready set; the webview's public job does not expose payload/binding.
        await h.publisher.persist(job);
        return '确认同步';
      };
      await panel.receive({ type: operation, jobId: seeded && seeded.id, config: config(), confirmed: true });
      assert.equal(h.warnings.length, 1);
      expectError(panel, /任务已变化/);
      assert.equal(h.count('execute'), 0);
      const current = await h.publisher.read(original.id);
      assert.deepEqual(current.config.targets, original.config.targets);
      assert.equal(current.fingerprint, original.fingerprint);
      assert.deepEqual(Object.values(current.targets).map(target => target.state), ['ready', 'ready', 'ready']);
      if (mutation !== 'platform options') assert.deepEqual(current.config, original.config);
      if (operation === 'sync') assert.equal(messages(panel, 'syncComplete').length, 1);
    });
  }
}

test('host passes the pre-dialog fingerprint so a later persisted payload swap cannot execute', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const job = await h.seedJob();
  const confirmedFingerprint = submissionFingerprint(job);
  h.modalResponse = '确认同步';
  h.hooks.execute = async (id, options) => {
    assert.equal(options.expectedSubmissionFingerprint, confirmedFingerprint);
    const current = await h.publisher.read(id);
    current.targets.zhihu.prepared.payload = { html: '<p>Swapped after host freshness check</p>' };
    await h.publisher.persist(current);
  };
  await panel.receive({ type: 'execute', jobId: job.id, expectedSubmissionFingerprint: 'untrusted-webview-hash' });
  expectError(panel, /待提交内容已变化/);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.count('execute'), 1);
  assert.deepEqual(Object.values(h.jobs.get(job.id).targets).map(target => target.state), ['ready', 'ready', 'ready']);
  assert.deepEqual(messages(panel, 'job'), []);
});

test('sync saves dirty edits after confirmation and checks the saved article before execution', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  h.hooks.modal = () => { h.dirtyDocument(h.source, true); return '确认同步'; };
  h.hooks.freshSnapshot = () => {
    if (h.saves.length) throw new Error('Saved article no longer matches prepared content');
  };
  await panel.receive({ type: 'sync', config: config() });
  assert.deepEqual(h.saves, [h.source]);
  expectError(panel, /no longer matches/);
  assert.equal(h.count('execute'), 0);
  assert.equal(messages(panel, 'syncComplete').length, 1);
});

test('execution credentials remain source-bound after modal verification until credential access', async t => {
  let local = copy(localCredentials);
  const h = await fixture(t, { resolveLocalCredentials: async () => local });
  const panel = await h.open(h.source, { platform: 'zhihu' });
  h.modalResponse = '确认同步';
  h.hooks.execute = async () => {
    local.source = 'environment';
    await h.publisher.options.getCredentials('zhihu');
    assert.fail('source change must stop execution before writes');
  };
  await panel.receive({ type: 'sync', config: { targets: ['zhihu'] } });
  expectError(panel, /账号在准备期间发生变化/);
  assert.equal(messages(panel, 'job').at(-1).job.targets.zhihu.state, 'ready');
  assert.equal(messages(panel, 'syncComplete').length, 1);
});

for (const type of ['sync', 'testConnections']) {
  for (const reason of ['trust', 'publisher busy', 'invalid input', 'credential failure', 'operation error']) {
    test(`${type} always completes on ${reason}`, async t => {
      const h = await fixture(t);
      const panel = await h.open();
      if (reason === 'trust') h.vscode.workspace.isTrusted = false;
      if (reason === 'publisher busy') h.publisher.running = true;
      if (reason === 'credential failure') {
        h.context.secrets.get = async () => { throw new Error('UNKNOWN_SECRET'); };
        h.hooks.prepare = async () => h.publisher.options.getCredentials('wechat');
      }
      if (reason === 'operation error') {
        h.hooks.prepare = () => { throw new Error('Mock prepare failure'); };
        h.secretValues.set(SECRET_PREFIX + 'wechat', JSON.stringify(credentials.wechat));
        h.hooks.check = () => { throw new Error('Mock connection failure'); };
      }
      await panel.receive({ type, config: reason === 'invalid input' ? null : config(),
        targets: reason === 'invalid input' ? ['invalid'] : ['wechat'] });
      assert.equal(messages(panel, type === 'sync' ? 'syncComplete' : 'testsComplete').length, 1);
      assert.equal(h.count('execute'), 0);
      assert.ok(!JSON.stringify(panel.messages).includes('UNKNOWN_SECRET'));
      if (type === 'sync') {
        assert.equal(messages(panel, 'error').length, 1);
        assert.deepEqual(h.warnings, []);
      } else if (['credential failure', 'operation error'].includes(reason)) {
        expectTestResult(panel, 'wechat', 'failed');
      }
    });
  }
  test(`${type} busy completion does not release another panel's operation`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    const other = await h.open(h.otherSource);
    const entered = deferred();
    const release = deferred();
    h.hooks.prepare = async () => { entered.resolve(); await release.promise; };
    const active = panel.receive({ type: 'prepare', config: config() });
    await entered.promise;
    try {
      await other.receive({ type, config: config(), targets: ['wechat'] });
      expectError(other, /另一个同步操作正在运行/);
      assert.equal(messages(other, type === 'sync' ? 'syncComplete' : 'testsComplete').length, 1);
      assert.deepEqual(messages(other, 'busy').map(item => item.busy), [true]);
    } finally {
      release.resolve();
      await active;
    }
    assert.deepEqual(messages(other, 'busy').map(item => item.busy), [true, false]);
  });
}

for (const reason of ['dirty save', 'modal error']) {
  test(`sync completion survives ${reason} and releases the exclusive operation`, async t => {
    const h = await fixture(t);
    const panel = await h.open();
    if (reason === 'dirty save') h.dirtyDocument(h.source, false);
    else h.hooks.modal = () => { throw new Error('Mock native dialog failure'); };
    await panel.receive({ type: 'sync', config: config() });
    assert.equal(h.count('execute'), 0);
    assert.equal(messages(panel, 'error').length, 1);
    assert.equal(messages(panel, 'syncComplete').length, 1);
    assert.deepEqual(messages(panel, 'busy').map(item => item.busy), [true, false]);
  });
}

test('document edits invalidate only the bound panel and SecretStorage changes broadcast safe account status', async t => {
  const h = await fixture(t);
  const panel = await h.open();
  const other = await h.open(h.otherSource);
  await h.textChanges.emit({ document: { uri: { fsPath: h.source } } });
  assert.equal(messages(panel, 'invalidated').length, 1);
  assert.equal(messages(other, 'invalidated').length, 0);
  await h.secretChanges.emit({ key: 'unrelated.key' });
  assert.deepEqual(messages(panel, 'accounts'), []);
  h.secretValues.set(SECRET_PREFIX + 'zhihu', JSON.stringify(credentials.zhihu));
  await h.secretChanges.emit({ key: SECRET_PREFIX + 'zhihu' });
  for (const receiver of [panel, other]) {
    assert.equal(messages(receiver, 'accounts').at(-1).accounts.zhihu.configured, true);
  }
  assertNoSecrets(h);
});
