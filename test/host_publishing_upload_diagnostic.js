'use strict';

const assert = require('assert/strict');
const http = require('http');
const https = require('https');
const { test, before, after } = require('node:test');
const { PNG } = require('pngjs');
const { runZhihuUploadTest } = require('../lib/publishing/zhihu-diagnostic');

const credentials = { appKey: 'TEST_ONLY_UPLOAD_APP_KEY', appSecret: 'TEST_ONLY_UPLOAD_APP_SECRET' };
const imageUrl = 'https://pic.example.test/diagnostic.png?signature=TEST_ONLY_URL_SIGNATURE';
const networkMethods = [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [global, 'fetch']];
const originalNetwork = networkMethods.map(([owner, key]) => owner[key]);
let networkAttempts = 0;
before(() => {
  for (const [owner, key] of networkMethods) owner[key] = () => {
    networkAttempts++;
    throw new Error('Live network forbidden in upload diagnostic tests');
  };
});
after(() => {
  networkMethods.forEach(([owner, key], index) => { owner[key] = originalNetwork[index]; });
  assert.equal(networkAttempts, 0);
});

function assertPublicResult(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    'platform', 'status', 'message', 'checks', 'durationMs', 'checkedAt',
  ].sort());
  assert.equal(result.platform, 'zhihu');
  assert.equal(result.status, 'passed');
  assert.equal(typeof result.message, 'string');
  assert.match(result.message, /未发布文章/);
  assert.match(result.message, /发布权限尚未验证/);
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt);
  assert.ok(result.checks.some(check => check.label === 'image-upload' && check.status === 'passed'));
  assert.ok(result.checks.some(check => check.label === 'publishing' && check.status === 'warning' &&
    /未调用文章发布接口/.test(check.message)));
  const serialized = JSON.stringify(result);
  for (const value of [...Object.values(credentials), imageUrl, 'TEST_ONLY_URL_SIGNATURE', 'TEST_ONLY_STS_SECRET']) {
    assert.ok(!serialized.includes(value), 'private upload data escaped into diagnostic result');
  }
  assert.ok(!/https?:\/\//.test(serialized), 'diagnostic must not expose media or API URLs');
  assert.ok(!serialized.includes('"published"'));
}

test('diagnostic uploads one valid synthetic 320x180 PNG through uploadImage(ctx, asset, { warnings })', async () => {
  let uploads = 0;
  const request = async () => assert.fail('Injected upload stub must not make requests');
  const result = await runZhihuUploadTest({
    credentials, request,
    uploadImage: async (ctx, asset, options) => {
      uploads++;
      assert.deepEqual(Object.keys(ctx).sort(), ['credentials', 'request']);
      assert.equal(ctx.credentials, credentials);
      assert.equal(ctx.request, request);
      assert.deepEqual(Object.keys(asset).sort(), ['buffer', 'mimeType', 'name']);
      assert.equal(asset.name, 'markdown2anything-upload-test.png');
      assert.equal(asset.mimeType, 'image/png');
      assert.ok(Buffer.isBuffer(asset.buffer));
      assert.deepEqual(asset.buffer.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const image = PNG.sync.read(asset.buffer, { checkCRC: true });
      assert.equal(image.width, 320);
      assert.equal(image.height, 180);
      assert.equal(image.data.length, 320 * 180 * 4);
      assert.deepEqual(Object.keys(options), ['warnings']);
      assert.ok(options.warnings instanceof Set);
      assert.equal(options.warnings.size, 0);
      options.warnings.add('Mock watermark unavailable');
      return { url: imageUrl, appSecret: credentials.appSecret, upload_auth: 'TEST_ONLY_STS_SECRET' };
    },
  });
  assert.equal(uploads, 1);
  assertPublicResult(result);
  assert.deepEqual(result.checks.filter(check => check.label === 'watermark'), [
    { label: 'watermark', status: 'warning', message: 'Mock watermark unavailable' },
  ]);
});

test('diagnostic without request passes only credentials to the shared upload contract', async () => {
  let uploads = 0;
  const result = await runZhihuUploadTest({
    credentials,
    uploadImage: async ctx => {
      uploads++;
      assert.deepEqual(Object.keys(ctx), ['credentials']);
      assert.equal(ctx.credentials, credentials);
      return { url: imageUrl };
    },
  });
  assert.equal(uploads, 1);
  assertPublicResult(result);
});

test('missing, empty, whitespace and non-string credentials fail before upload or request', async () => {
  for (const invalid of [
    undefined, null, {}, { appKey: credentials.appKey }, { appSecret: credentials.appSecret },
    ...['appKey', 'appSecret'].flatMap(field => ['', ' \n\t', 123, {}, null].map(value => ({
      ...credentials, [field]: value,
    }))),
  ]) {
    let uploads = 0;
    let requests = 0;
    await assert.rejects(() => runZhihuUploadTest({
      credentials: invalid,
      request: async () => { requests++; assert.fail('Invalid credentials must not request'); },
      uploadImage: async () => { uploads++; assert.fail('Invalid credentials must not upload'); },
    }), error => {
      assert.equal(error.definitive, true);
      assert.match(error.message, /AppKey.*AppSecret/);
      return true;
    });
    assert.equal(uploads, 0);
    assert.equal(requests, 0);
  }
});

test('missing and unsafe upload URLs never become a successful diagnostic', async () => {
  for (const uploaded of [
    undefined, null, {}, { url: '' }, { url: 'not a URL' }, { url: '//pic.example.test/test.png' },
    { url: 'http://pic.example.test/test.png' }, { url: 'file:///tmp/test.png' },
    { url: 'data:image/png;base64,AAAA' }, { url: 'javascript:alert(1)' },
    { url: 'https://user:pass@pic.example.test/test.png' },
  ]) {
    let uploads = 0;
    await assert.rejects(() => runZhihuUploadTest({
      credentials,
      uploadImage: async () => { uploads++; return uploaded; },
    }), error => {
      assert.equal(error.definitive, true);
      assert.match(error.message, /有效的 HTTPS 地址/);
      assert.ok(!error.message.includes(credentials.appSecret));
      return true;
    });
    assert.equal(uploads, 1);
  }
});

test('shared upload failures propagate without retrying or reporting success', async () => {
  const failure = new Error('Mock media upload refused');
  let uploads = 0;
  await assert.rejects(() => runZhihuUploadTest({
    credentials,
    uploadImage: async () => { uploads++; throw failure; },
  }), error => error === failure);
  assert.equal(uploads, 1);
});
