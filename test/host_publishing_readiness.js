'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { deriveMetadata } = require('../lib/publishing/metadata');
const { checkPlatform, checkConnection } = require('../lib/publishing/checks');
const wechat = require('../lib/publishing/wechat');
const zhihu = require('../lib/publishing/zhihu-official');
const cnblogs = require('../lib/publishing/cnblogs');
const rpc = require('../lib/publishing/xmlrpc');

const tests = [];
const test = (name, run) => tests.push({ name, run });
let dir;
let sourcePath;
const credentials = {
  wechat: { appId: 'test-app-id', appSecret: 'secret & <"中/?>' },
  zhihu: { appKey: 'test-app-key', appSecret: 'zhihu-secret' },
  cnblogs: { blogName: 'test-blog', username: 'test-user', token: 'cnblogs-token' },
};
const warning = '配置完整，官方没有只读授权校验；生成预览可验证媒体上传，发布权限以提交为准';
const jsonResponse = data => ({ status: 200, body: Buffer.from(JSON.stringify(data)) });
const rpcResponse = data => ({
  status: 200, body: Buffer.from(`<methodResponse><params><param>${rpc.serializeValue(data)}</param></params></methodResponse>`),
});
const write = text => fs.promises.writeFile(sourcePath, text);
const entry = (result, label) => result.checks.find(check => check.label === label);
const article = () => ({ title: '文章标题', html: '<p>这里是一段完整的文章正文，供平台验证使用。</p>',
  coverPath: path.join(dir, 'cover.png'), baseDir: dir });
function fakeSnapshot(platform, value = article()) {
  return async (_source, config, options) => {
    assert.equal(_source, sourcePath);
    assert.deepEqual(config.targets, [platform]);
    assert.deepEqual(Object.keys(config.options), [platform]);
    assert.equal(options.render, true);
    return { platforms: { [platform]: value } };
  };
}
const forbidden = () => { throw new Error('Readiness must not prepare, execute, upload, or create jobs'); };
function fakeAdapter(overrides = {}) {
  return { validate: () => ({ valid: true }), check: async () => ({ verified: true }),
    prepare: forbidden, execute: forbidden, upload: forbidden, createJob: forbidden, ...overrides };
}
function inspect(platform, overrides = {}) {
  return checkPlatform({ platform, sourcePath, config: { targets: ['wechat', 'zhihu', 'cnblogs'] },
    getCredentials: async selected => {
      assert.equal(selected, platform);
      return credentials[selected];
    },
    snapshot: fakeSnapshot(platform), adapter: fakeAdapter(), ...overrides });
}
function assertPublic(result) {
  assert.deepEqual(Object.keys(result).sort(), ['platform', 'status', 'message', 'checks', 'durationMs', 'checkedAt'].sort());
  assert.ok(['passed', 'warning', 'failed'].includes(result.status));
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt);
  for (const check of result.checks) {
    assert.deepEqual(Object.keys(check).sort(), ['label', 'message', 'status']);
    assert.ok(['passed', 'warning', 'failed'].includes(check.status));
  }
}
function assertNoSecrets(result, values) {
  const serialized = JSON.stringify(result);
  for (const value of values) assert.ok(!serialized.includes(value), `Secret leaked: ${value}`);
  assert.ok(!serialized.includes('"payload"'));
  assert.ok(!serialized.includes('"credentials"') || !serialized.includes('"appSecret"'));
}

test('metadata prefers frontmatter, returns plain strings/lists and resolves local cover', async () => {
  await write('---\ntitle: "**Frontmatter** &amp; title"\nsummary: "A **short** summary with `hidden code` ![alt](remote.png)."\n' +
    'author:\n  name: "Writer &amp; Co"\ncover: cover.png\ntags: [node, "two words", node]\n' +
    'categories: "开发，工具;示例|其他、最后"\n---\n# Heading\n\nActual prose.\n');
  const result = await deriveMetadata(sourcePath);
  assert.equal(result.title, 'Frontmatter & title');
  assert.equal(result.summary, 'A short summary with .');
  assert.equal(result.author, 'Writer & Co');
  assert.equal(result.coverPath, path.join(dir, 'cover.png'));
  assert.deepEqual(result.tags, ['node', 'two words']);
  assert.deepEqual(result.categories, ['开发', '工具', '示例', '其他', '最后']);
  assert.equal(result.titleSource, 'frontmatter.title');
  assert.equal(result.summarySource, 'frontmatter.summary');
});

test('metadata summary uses actual prose, excluding headings, fenced/inline code, images and non-prose blocks', async () => {
  await write('# Heading should not be summary\n\n```md\n# Fake heading\nFake summary\n```\n\n' +
    '![Filename and alt must not spill](secret-filename.png)\n\n' +
    '> Quoted text is not introductory prose.\n\n- List text is not prose.\n\n' +
    '<h2>Raw heading</h2>\n\n<pre><code>raw code</code></pre>\n\n' +
    '<p><img src="remote.png" alt="image only"></p>\n\n' +
    'First **actual** prose with `code excluded` and [a link](https://example.invalid).\n\nSecond paragraph.\n');
  const result = await deriveMetadata(sourcePath);
  assert.equal(result.title, 'Heading should not be summary');
  assert.equal(result.summary, 'First actual prose with and a link. Second paragraph.');
  assert.equal(result.summarySource, 'prose');
});

test('metadata title priority handles H1, setext, nested/fenced headings and basename without summary filename spill', async () => {
  await write('> # Quoted heading\n\n```md\n# Fenced heading\n```\n\n## Section\n\n# Real **title**\n\nProse.');
  assert.equal((await deriveMetadata(sourcePath)).title, 'Real title');
  await write('Setext title\n============\n\nProse.');
  assert.equal((await deriveMetadata(sourcePath)).title, 'Setext title');
  await write('## Only second level\n\nProse.');
  assert.equal((await deriveMetadata(sourcePath)).title, 'Only second level');
  await write('![Just image](unknown.png)\n\n```\nJust code\n```');
  const noProse = await deriveMetadata(sourcePath);
  assert.equal(noProse.title, path.basename(sourcePath, '.md'));
  assert.equal(noProse.summary, '');
  assert.equal(noProse.titleSource, 'basename');
  assert.equal(noProse.summarySource, '');
  await write('Plain introductory prose.');
  const first = await deriveMetadata(sourcePath);
  const other = path.join(dir, 'different-filename.md');
  await fs.promises.writeFile(other, 'Plain introductory prose.');
  const second = await deriveMetadata(other);
  assert.notEqual(first.title, second.title);
  assert.equal(first.summary, second.summary);
  assert.equal(first.author, '');
  assert.deepEqual(first.tags, []);
  assert.deepEqual(first.categories, []);
});

test('metadata summaries use field precedence and truncate at 120 Unicode code points without broken surrogates', async () => {
  for (const [frontmatter, expectedSource, expected] of [
    ['summary: "   "\ndescription: "Description **wins**"\nexcerpt: "Excerpt"', 'frontmatter.description', 'Description wins'],
    ['summary: 42\ndescription: []\nexcerpt: "Excerpt &amp; text"', 'frontmatter.excerpt', 'Excerpt & text'],
    [`summary: "${'😀汉'.repeat(90)}"`, 'frontmatter.summary', '😀汉'.repeat(60)],
    ['', 'prose', '🚀文'.repeat(60)],
  ]) {
    await write(`---\n${frontmatter}\n---\n# Title\n\n${'🚀文'.repeat(90)}`);
    const result = await deriveMetadata(sourcePath);
    assert.equal(result.summarySource, expectedSource);
    assert.equal(result.summary, expected);
    assert.ok(Array.from(result.summary).length <= 120);
    assert.ok(!/[\uD800-\uDBFF]$/.test(result.summary));
  }
});

test('metadata rejects remote/missing/directory covers and accepts coverImage fallback and absolute files', async () => {
  for (const cover of ['https://example.invalid/cover.png', '//example.invalid/x', 'data:image/png;base64,AA==',
    'file:///tmp/cover.png', 'missing.png', '.']) {
    await write(`---\ncover: "${cover}"\n---\n# Title`);
    assert.equal((await deriveMetadata(sourcePath)).coverPath, '');
  }
  await write('---\ncover: missing.png\ncoverImage: cover.png\nauthor: "Plain Author"\ntags: "a,b；c\\nd"\n---\nBody');
  const result = await deriveMetadata(sourcePath);
  assert.equal(result.coverPath, path.join(dir, 'cover.png'));
  assert.equal(result.author, 'Plain Author');
  assert.deepEqual(result.tags, ['a', 'b', 'c', 'd']);
  await write(`---\ncover: "${path.join(dir, 'cover.png')}"\n---\nBody`);
  assert.equal((await deriveMetadata(sourcePath)).coverPath, path.join(dir, 'cover.png'));
});

test('metadata never fetches remote media, calls an LLM, writes source, or persists defaults', async () => {
  const original = '# Offline\n\nProse survives.\n\n![remote](https://example.invalid/figure.svg)\n\n' +
    '<script>not prose</script>\n\n<img src="https://example.invalid/other.png">';
  await write(original);
  const files = await fs.promises.readdir(dir);
  const previous = [http.request, http.get, https.request, https.get, global.fetch];
  try {
    http.request = http.get = https.request = https.get = global.fetch = forbidden;
    const result = await deriveMetadata(sourcePath);
    assert.equal(result.summary, 'Prose survives.');
    assert.equal(await fs.promises.readFile(sourcePath, 'utf8'), original);
    assert.deepEqual(await fs.promises.readdir(dir), files);
  } finally {
    [http.request, http.get, https.request, https.get, global.fetch] = previous;
  }
  await assert.rejects(() => deriveMetadata(path.join(dir, 'absent.md')), { code: 'ENOENT' });
});

test('diagnostics call only selected snapshot/validate/check, pass theme and isolate other options without mutation', async () => {
  const calls = [];
  const unrelated = { topics: 99, coverPath: '/missing-unrelated-cover.png' };
  unrelated.circular = unrelated;
  const selected = { categories: ['Tech'], mode: 'draft' };
  const config = Object.freeze({ targets: Object.freeze(['wechat', 'zhihu']),
    title: 'Configured title', options: Object.freeze({ zhihu: unrelated, cnblogs: Object.freeze(selected) }) });
  const result = await inspect('cnblogs', {
    config, themeId: 'claude',
    snapshot: async (source, scoped, options) => {
      calls.push('snapshot');
      assert.equal(source, sourcePath);
      assert.deepEqual(scoped.targets, ['cnblogs']);
      assert.deepEqual(scoped.options, { cnblogs: selected });
      assert.deepEqual(options, { themeId: 'claude', render: true });
      scoped.options.cnblogs.categories.push('detached');
      return { platforms: { cnblogs: article() } };
    },
    adapter: fakeAdapter({
      validate: async ctx => { calls.push('validate'); assert.equal(ctx.options.mode, 'draft'); return { valid: true }; },
      check: async ctx => {
        calls.push('check');
        assert.equal(ctx.credentials, credentials.cnblogs);
        assert.ok(!Object.hasOwn(ctx, 'prepared'));
        assert.ok(!Object.hasOwn(ctx, 'saveCache'));
        return { blogId: '9', payload: credentials.cnblogs };
      },
    }),
  });
  assertPublic(result);
  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['snapshot', 'validate', 'check']);
  assert.deepEqual(selected.categories, ['Tech']);
  assert.deepEqual(config.targets, ['wechat', 'zhihu']);
  assertNoSecrets(result, Object.values(credentials.cnblogs));
});

test('missing credentials do not hide empty title and missing cover; no API or write methods run', async () => {
  let snapshots = 0;
  const result = await inspect('wechat', {
    getCredentials: async () => ({ appId: 'partial-account' }),
    snapshot: async (...args) => { snapshots++; return fakeSnapshot('wechat', { ...article(), title: '', coverPath: '' })(...args); },
    adapter: fakeAdapter({ validate: forbidden, check: forbidden }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(snapshots, 1);
  assert.equal(entry(result, 'credentials').status, 'failed');
  assert.match(entry(result, 'credentials').message, /appSecret/);
  assert.equal(entry(result, 'title').status, 'failed');
  assert.equal(entry(result, 'cover').status, 'failed');
  assert.equal(entry(result, 'api').status, 'warning');
});

test('local missing image errors and invalid title still allow independent readonly account feedback', async () => {
  let accountChecks = 0;
  const result = await inspect('wechat', {
    config: { title: '😀'.repeat(33), coverPath: 'cover.png' },
    snapshot: async (_source, scoped) => {
      assert.deepEqual(scoped.targets, ['wechat']);
      throw new Error('正文本地图片不存在或无法读取');
    },
    adapter: fakeAdapter({ validate: forbidden, check: async () => {
      accountChecks++;
      return { draftAccess: true };
    } }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(entry(result, 'local-images').status, 'failed');
  assert.equal(entry(result, 'title').status, 'failed');
  assert.equal(entry(result, 'cover').status, 'warning');
  assert.equal(entry(result, 'api').status, 'passed');
  assert.equal(accountChecks, 1);
});

test('snapshot cover failure is not reported as a passed cover; platform HTML validation failures are independent of API', async () => {
  const missing = await inspect('wechat', {
    config: { coverPath: 'missing.png' },
    snapshot: async () => { throw new Error('封面图片不存在或无法读取'); },
    adapter: fakeAdapter({ check: async () => ({ draftAccess: true }) }),
  });
  assert.equal(entry(missing, 'cover').status, 'failed');
  assert.equal(entry(missing, 'api').status, 'passed');
  const invalid = await inspect('wechat', {
    snapshot: fakeSnapshot('wechat', { ...article(), html: '<svg><path/></svg>' }),
    adapter: wechat,
    transport: async url => new URL(url).pathname.endsWith('/token') ?
      jsonResponse({ access_token: 'private-token', expires_in: 7200 }) : jsonResponse({ total_count: 0 }),
  });
  assert.equal(invalid.status, 'failed');
  assert.match(entry(invalid, 'validation').message, /不支持 SVG/);
  assert.equal(entry(invalid, 'api').status, 'passed');
});

test('official Zhihu verified:false is an honest warning and never calls transport', async () => {
  const value = { ...article(), coverPath: '' };
  const result = await inspect('zhihu', { adapter: zhihu, snapshot: fakeSnapshot('zhihu', value), transport: forbidden });
  assert.equal(result.status, 'warning');
  assert.equal(entry(result, 'api').status, 'warning');
  assert.equal(entry(result, 'api').message, warning);
  assert.equal(entry(result, 'credentials').status, 'passed');
  assert.match(entry(result, 'credentials').message, /官方没有只读授权校验/);
  assert.match(entry(result, 'credentials').message, /尚未验证密钥有效性或发布权限/);
  assert.doesNotMatch(entry(result, 'credentials').message, /有效性由只读接口检查/);
  assert.match(result.message, /发布权限以提交为准/);
  assertNoSecrets(result, Object.values(credentials.zhihu));
});

test('Zhihu readiness uses actual local snapshot and topic validation for comma, Chinese comma, whitespace and empty options', async () => {
  await write('# Offline topic validation\n\nThis is enough original prose for Zhihu validation without any LLM or network.');
  const links = ['https://www.zhihu.com/topic/19555547/hot', 'https://www.zhihu.com/topic/19555548/newest'];
  for (const topics of [undefined, null, '', [], ' ，,\t', links, ...[',', '，', '\n\t', ' ，,\t'].map(separator => links.join(separator))]) {
    const result = await checkPlatform({
      platform: 'zhihu', sourcePath, config: { options: { zhihu: { topics } } },
      getCredentials: async () => credentials.zhihu, adapter: zhihu, transport: forbidden,
    });
    assert.equal(result.status, 'warning');
    assert.equal(entry(result, 'document').status, 'passed');
    assert.equal(entry(result, 'validation').status, 'passed');
    assert.equal(entry(result, 'api').message, warning);
  }
  for (const topics of ['private-local-topic-name', '987654321', 'https://evil.invalid/topic/private-local-topic-name']) {
    const result = await checkPlatform({
      platform: 'zhihu', sourcePath, config: { options: { zhihu: { topics } } },
      getCredentials: async () => credentials.zhihu, adapter: zhihu, transport: forbidden,
    });
    assert.equal(result.status, 'failed');
    assert.equal(entry(result, 'validation').status, 'failed');
    assert.match(entry(result, 'validation').message, /选填，可留空/);
    assert.match(entry(result, 'validation').message, /例如 https:\/\/www\.zhihu\.com\/topic\//);
    assert(!JSON.stringify(result).includes(topics));
    assert.equal(entry(result, 'api').message, warning);
  }
});

test('WeChat readonly check verifies draft access with GET only and returns no account/token/payload', async () => {
  const paths = [];
  const result = await inspect('wechat', {
    adapter: wechat,
    transport: async (url, options = {}) => {
      const address = new URL(url);
      paths.push(address.pathname);
      assert.equal(options.method || 'GET', 'GET');
      assert.equal(options.body, undefined);
      assert.equal(options.json, undefined);
      if (address.pathname === '/cgi-bin/token') return jsonResponse({ access_token: 'EPHEMERAL_API_TOKEN', expires_in: 7200 });
      assert.equal(address.pathname, '/cgi-bin/draft/count');
      assert.equal(address.searchParams.get('access_token'), 'EPHEMERAL_API_TOKEN');
      return jsonResponse({ total_count: 12 });
    },
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(paths, ['/cgi-bin/token', '/cgi-bin/draft/count']);
  assert.match(entry(result, 'api').message, /草稿数量只读接口访问成功/);
  assert.match(entry(result, 'api').message, /写入权限以提交为准/);
  assertNoSecrets(result, [...Object.values(credentials.wechat), 'EPHEMERAL_API_TOKEN']);
});

test('WeChat token-only responses warn; draft-count authorization denial and network failure fail without writes', async () => {
  const tokenOnly = await inspect('wechat', { adapter: fakeAdapter({ check: async () => ({ appId: 'test-app-id' }) }) });
  assert.equal(tokenOnly.status, 'warning');
  assert.match(entry(tokenOnly, 'api').message, /尚未验证草稿接口访问/);
  for (const kind of ['denied', 'network']) {
    const paths = [];
    const result = await inspect('wechat', {
      adapter: wechat,
      transport: async url => {
        const address = new URL(url);
        paths.push(address.pathname);
        if (address.pathname.endsWith('/token')) return jsonResponse({ access_token: 'PRIVATE_TOKEN', expires_in: 7200 });
        assert.equal(address.pathname, '/cgi-bin/draft/count');
        if (kind === 'network') throw new Error('PRIVATE_TOKEN');
        return jsonResponse({ errcode: 48001, errmsg: 'PRIVATE_TOKEN secret' });
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(entry(result, 'api').status, 'failed');
    assert.deepEqual(paths, ['/cgi-bin/token', '/cgi-bin/draft/count']);
    assertNoSecrets(result, ['PRIVATE_TOKEN', credentials.wechat.appSecret]);
  }
});

test('CNBlogs diagnostics use only getUsersBlogs and reject a different blog without writing', async () => {
  for (const correct of [true, false]) {
    const methods = [];
    const result = await inspect('cnblogs', {
      adapter: cnblogs,
      transport: async (url, options) => {
        assert.equal(url, 'https://rpc.cnblogs.com/metaweblog/test-blog');
        assert.equal(options.method, 'POST');
        const method = options.body.toString().match(/<methodName>([^<]+)<\/methodName>/)[1];
        methods.push(method);
        assert.equal(method, 'blogger.getUsersBlogs');
        return rpcResponse([{ blogid: '100', blogName: 'Actual blog',
          url: `https://www.cnblogs.com/${correct ? 'test-blog' : 'other'}/` }]);
      },
    });
    assert.equal(result.status, correct ? 'passed' : 'failed');
    assert.deepEqual(methods, ['blogger.getUsersBlogs']);
    assertNoSecrets(result, Object.values(credentials.cnblogs));
    if (correct) assert.match(entry(result, 'api').message, /写入权限以提交为准/);
  }
});

test('caught adversarial adapter diagnostics redact raw, JSON, URL, form, XML and base64 credentials recursively', async () => {
  const secret = credentials.wechat.appSecret;
  const sensitive = { ...credentials.wechat, nested: { password: 'another-private-password' } };
  const forms = [secret, encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2),
    JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64'),
    secret.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]))];
  const echo = `Bad diagnostics ${JSON.stringify(sensitive)} ${forms.join(' ')} access_token=server-token`;
  const result = await inspect('wechat', {
    getCredentials: async () => sensitive,
    adapter: fakeAdapter({
      validate: async () => { throw Object.assign(new Error(echo), { payload: sensitive }); },
      check: async () => { throw Object.assign(new Error(echo), { credentials: sensitive }); },
    }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(entry(result, 'validation').status, 'failed');
  assert.equal(entry(result, 'api').status, 'failed');
  assertNoSecrets(result, [...forms, sensitive.appId, sensitive.nested.password, 'server-token']);
  assert.match(result.message, /REDACTED/);
});

test('all returned warning/failed messages are sanitized and adapter payloads are discarded', async () => {
  const secret = credentials.cnblogs.token;
  const result = await inspect('cnblogs', {
    adapter: fakeAdapter({
      validate: () => ({ warnings: [`Warning ${secret}`], payload: credentials.cnblogs }),
      check: async () => ({ status: 'failed', message: `Rejected ${secret}`, payload: credentials.cnblogs }),
    }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(entry(result, 'api').status, 'failed');
  assert.ok(result.checks.some(check => check.status === 'warning' && check.label === 'validation'));
  assertNoSecrets(result, [secret]);
  const invalid = await inspect('cnblogs', {
    adapter: fakeAdapter({ validate: () => ({ valid: false, message: `Invalid ${secret}` }) }),
  });
  assert.equal(invalid.status, 'failed');
  assertNoSecrets(invalid, [secret]);
  const snapshotError = await inspect('cnblogs', {
    snapshot: async () => { throw new Error(`Local failure ${secret}`); },
  });
  assert.equal(snapshotError.status, 'failed');
  assertNoSecrets(snapshotError, [secret]);
});

test('credential store errors, arbitrary throws, missing check responses and unknown platforms return structured feedback', async () => {
  const storeError = await inspect('cnblogs', {
    getCredentials: async () => { throw new Error('UNKNOWN_SECRET_FROM_STORE'); },
    adapter: fakeAdapter({ check: forbidden }),
  });
  assert.equal(storeError.status, 'failed');
  assertNoSecrets(storeError, ['UNKNOWN_SECRET_FROM_STORE']);
  const arbitrary = await inspect('cnblogs', { adapter: fakeAdapter({ check: async () => { throw { token: 'RAW_OBJECT_SECRET' }; } }) });
  assert.equal(arbitrary.status, 'failed');
  assertNoSecrets(arbitrary, ['RAW_OBJECT_SECRET']);
  const empty = await inspect('cnblogs', { adapter: fakeAdapter({ check: async () => undefined }) });
  assert.equal(empty.status, 'warning');
  const emptyObject = await inspect('cnblogs', { adapter: fakeAdapter({ check: async () => ({}) }) });
  assert.equal(emptyObject.status, 'warning');
  const unknown = await inspect('unsupported', { getCredentials: forbidden, snapshot: forbidden });
  assert.equal(unknown.status, 'failed');
  for (const result of [storeError, arbitrary, empty, emptyObject, unknown]) assertPublic(result);
});

test('default document snapshot and runtime adapters work locally, scoped to the selected platform, without jobs or uploads', async () => {
  await write('# Default snapshot\n\nThis is actual prose with enough text for the official article validator.');
  const files = await fs.promises.readdir(dir);
  const result = await checkPlatform({
    platform: 'zhihu', sourcePath,
    config: { targets: ['wechat', 'zhihu', 'cnblogs'], coverPath: '/missing-shared-cover.png',
      options: { wechat: { coverPath: '/missing-wechat-cover.png' }, cnblogs: { mode: 'bad', tags: 44 } } },
    getCredentials: async platform => credentials[platform],
    transport: forbidden,
  });
  assert.equal(result.status, 'warning');
  assert.equal(entry(result, 'document').status, 'passed');
  assert.equal(entry(result, 'api').message, warning);
  assert.deepEqual(await fs.promises.readdir(dir), files);
});

test('default snapshot reports missing local images and covers while keeping official readonly account diagnostics', async () => {
  for (const missing of ['image', 'cover']) {
    await write(`# Local checks\n\nParagraph.\n\n${missing === 'image' ? '![missing](absent.png)' : ''}`);
    const result = await checkPlatform({
      platform: 'wechat', sourcePath, config: { coverPath: missing === 'image' ? 'cover.png' : 'missing-cover.png' },
      getCredentials: async () => credentials.wechat,
      transport: async url => new URL(url).pathname.endsWith('/token') ?
        jsonResponse({ access_token: 'LOCAL_CHECK_TOKEN', expires_in: 7200 }) : jsonResponse({ total_count: 0 }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(entry(result, missing === 'image' ? 'local-images' : 'cover').status, 'failed');
    assert.equal(entry(result, 'api').status, 'passed');
  }
});

function connection(platform, overrides = {}) {
  return checkConnection({ platform, getCredentials: async selected => credentials[selected],
    adapter: fakeAdapter({ validate: forbidden }), transport: forbidden, ...overrides });
}

test('connection-only WeChat checks token and draft count, without validation or writes', async () => {
  const paths = [];
  const result = await connection('wechat', {
    adapter: wechat,
    transport: async (url, options = {}) => {
      const address = new URL(url);
      paths.push(address.pathname);
      assert.equal(options.method || 'GET', 'GET');
      assert.equal(options.body, undefined);
      assert.equal(options.json, undefined);
      if (address.pathname === '/cgi-bin/token') return jsonResponse({ access_token: 'CONNECTION_TOKEN', expires_in: 7200 });
      assert.equal(address.pathname, '/cgi-bin/draft/count');
      return jsonResponse({ total_count: 3 });
    },
  });
  assertPublic(result);
  assert.equal(result.status, 'passed');
  assert.deepEqual(paths, ['/cgi-bin/token', '/cgi-bin/draft/count']);
  assert.match(result.message, /写入权限尚未验证/);
  assertNoSecrets(result, [...Object.values(credentials.wechat), 'CONNECTION_TOKEN']);
});

test('connection-only CNBlogs checks blog identity using getUsersBlogs only', async () => {
  for (const correct of [true, false]) {
    const methods = [];
    const result = await connection('cnblogs', {
      adapter: cnblogs,
      transport: async (_url, options) => {
        const method = options.body.toString().match(/<methodName>([^<]+)<\/methodName>/)[1];
        methods.push(method);
        return rpcResponse([{ blogid: '100', url: `https://www.cnblogs.com/${correct ? 'test-blog' : 'other'}/` }]);
      },
    });
    assert.equal(result.status, correct ? 'passed' : 'failed');
    assert.deepEqual(methods, ['blogger.getUsersBlogs']);
    if (!correct) assert.match(result.message, /后台设置.*MetaWeblog/);
    assertNoSecrets(result, Object.values(credentials.cnblogs));
  }
});

test('connection-only Zhihu gives honest optional generated-image guidance without invoking any adapter', async () => {
  const input = { platform: 'zhihu', getCredentials: async () => credentials.zhihu,
    adapter: new Proxy({}, { get: forbidden }), transport: forbidden };
  for (const field of ['config', 'sourcePath', 'snapshot', 'title', 'topics', 'coverPath']) {
    Object.defineProperty(input, field, { get: forbidden });
  }
  const result = await checkConnection(input);
  assertPublic(result);
  assert.equal(result.status, 'warning');
  assert.match(result.message, /官方没有只读授权校验/);
  assert.match(result.message, /测试图片上传/);
  assert.match(result.message, /仅上传生成的测试图，不读取或发布文章/);
  assert.match(result.message, /尚未验证密钥有效性或发布权限/);
  assert.doesNotMatch(result.message, /生成预览|发布成功|完整写入流程已验证/);
});

test('connection-only missing fields use human labels and secret-store errors never echo unknown secrets', async () => {
  for (const [platform, fields] of [
    ['wechat', /AppID（公众号标识）.*AppSecret（应用密钥）/],
    ['zhihu', /AppKey（应用标识）.*AppSecret（应用密钥）/],
    ['cnblogs', /博客名.*用户名.*MetaWeblog 访问令牌/],
  ]) {
    const result = await connection(platform, { getCredentials: async () => null,
      adapter: new Proxy({}, { get: forbidden }) });
    assert.equal(result.status, 'failed');
    assert.match(result.message, fields);
    assert.match(result.message, /设置/);
    assertPublic(result);
  }
  const failed = await connection('wechat', { getCredentials: async () => { throw new Error('UNKNOWN_STORE_SECRET'); } });
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /重新保存账号/);
  assertNoSecrets(failed, ['UNKNOWN_STORE_SECRET']);
  assert.equal((await connection('unsupported', { getCredentials: forbidden })).status, 'failed');
});

test('connection-only warnings cannot imply a verified write flow or blog identity without evidence', async () => {
  for (const [platform, result] of [
    ['wechat', undefined], ['wechat', {}], ['wechat', { verified: true }],
    ['wechat', { draftAccess: true, verified: false }], ['cnblogs', { verified: true }],
    ['cnblogs', { blogId: '' }], ['cnblogs', { blogId: '42', status: 'warning' }],
  ]) {
    const value = await connection(platform, { adapter: { check: async () => result } });
    assertPublic(value);
    assert.equal(value.status, 'warning');
    assert.match(value.message, /写入权限尚未验证/);
    assert.match(value.message, /设置/);
  }
});

test('connection-only failures retain adapter diagnostics, give steps and redact every credential encoding', async () => {
  const secret = credentials.wechat.appSecret;
  const forms = [secret, encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2),
    JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64'),
    secret.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]))];
  for (const kind of ['throw', 'failed', 'warning', 'passed']) {
    const value = await connection('wechat', { adapter: { check: async () => {
      const message = `IP whitelist blocked: ${forms.join(' ')} access_token=SERVER_SECRET`;
      if (kind === 'throw') throw Object.assign(new Error(message), { payload: credentials.wechat });
      return { draftAccess: true, ...(kind === 'passed' ? {} : { status: kind }), message, payload: credentials.wechat };
    } } });
    assert.equal(value.status, kind === 'throw' ? 'failed' : kind);
    assert.match(value.message, /IP whitelist blocked/);
    if (value.status !== 'passed') assert.match(value.message, /平台设置.*IP 白名单/);
    assertNoSecrets(value, [...forms, 'SERVER_SECRET']);
    assert.ok(!JSON.stringify(value).includes('"payload"'));
  }
  const arbitrary = await connection('wechat', { adapter: { check: async () => { throw { secret: 'ARBITRARY_SECRET' }; } } });
  assert.equal(arbitrary.status, 'failed');
  assertNoSecrets(arbitrary, ['ARBITRARY_SECRET']);
});

test('connection-only draft denial sanitizes ephemeral tokens from the actual WeChat adapter', async () => {
  const result = await connection('wechat', { adapter: wechat, transport: async url => {
    if (new URL(url).pathname.endsWith('/token')) return jsonResponse({ access_token: 'EPHEMERAL_CONNECTION_SECRET', expires_in: 7200 });
    return jsonResponse({ errcode: 48001, errmsg: 'denied EPHEMERAL_CONNECTION_SECRET' });
  } });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /平台设置/);
  assertNoSecrets(result, ['EPHEMERAL_CONNECTION_SECRET']);
});

(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm2a-readiness-'));
  sourcePath = path.join(dir, 'private-filename.md');
  let failed = 0;
  const network = [http.request, http.get, https.request, https.get, global.fetch];
  try {
    http.request = http.get = https.request = https.get = global.fetch = forbidden;
    await fs.promises.writeFile(path.join(dir, 'cover.png'), Buffer.from('local-cover-fixture'));
    for (const { name, run } of tests) {
      try { await run(); console.log(`PASS ${name}`); }
      catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
    }
  } finally {
    [http.request, http.get, https.request, https.get, global.fetch] = network;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  console.log(`${tests.length - failed}/${tests.length} publishing readiness tests passed`);
  process.exitCode = failed ? 1 : 0;
})();
