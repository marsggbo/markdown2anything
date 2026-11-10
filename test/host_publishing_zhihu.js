'use strict';

// Standalone contract tests. All API, downloader and OSS I/O is mocked; there
// are no account credentials, live services, browser sessions or publishing.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const cheerio = require('cheerio');
const adapter = require('../lib/publishing/zhihu-official');
const client = require('../lib/publishing/zhihu-client');
const { uploadImage } = require('../lib/publishing/zhihu-media');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const BASE = 'https://openapi.zhihu.com';
const PUBLISH = `${BASE}/openapi/publish`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVhQAAAAASUVORK5CYII=', 'base64');
const DATA = `data:image/png;base64,${PNG.toString('base64')}`;
const HASH = crypto.createHash('md5').update(PNG).digest('hex');
const ORIGINAL = 'https://pic-private.zhihu.com/original.png?auth=a%2Bb&width=700';
const WATERMARK = 'https://pic-private.zhihu.com/watermark.png?auth=c%2Fd&width=700';
const TEXT = '<p>这是一段至少九字的测试正文。</p>';
const SECRET = 'mock-app-secret-never-log';
const STS = 'mock-sts-token-never-log';
const STS_SECRET = 'mock-sts-secret-never-log';
const reply = (data, status = 200) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(data)) });
const $html = html => cheerio.load(html, null, false);
const success = () => reply({ status: 0, data: { type: 'article', content_token: '123456', url: 'https://zhuanlan.zhihu.com/p/123456' } });

function context(extra = {}) {
  return {
    article: { title: '标题与内容保持原样', html: TEXT, baseDir: __dirname },
    credentials: { appKey: 'mock-member', appSecret: SECRET },
    options: {}, mediaCache: {},
    watermarkPoll: { maxAttempts: 2, intervalMs: 0 },
    request: async () => { throw new Error('Unexpected API request'); },
    ...extra,
  };
}

function applyUpload(extra = {}) {
  return {
    upload_state: 'UPLOADING', session_key: 'image-session',
    upload_config: { vendor_code: 'ali', address: {
      endpoint: 'https://oss-cn-beijing.aliyuncs.com', bucket_name: 'zhihu-test', object_name: 'images/file.png',
      region: 'oss-cn-beijing', is_cname: false,
    } },
    upload_auth: { access_key_id: 'mock-ak', secret_access_key: STS_SECRET, security_token: STS },
    upload_media: { key: 'image-key', processes: 'opaque-processes' },
    ...extra,
  };
}

function instant(extra = {}) {
  return {
    upload_state: 'UPLOAD_SUCCESS', session_key: 'instant-session', upload_media: { key: 'opaque-key' },
    extra_params: { width: 700, height: 400, url: { primary: ORIGINAL } }, ...extra,
  };
}

function signature(options) {
  const h = options.headers;
  assert.strictEqual(h['X-App-Key'], 'mock-member');
  assert.strictEqual(h['X-Extra-Info'], '');
  assert(/^\d+$/.test(h['X-Timestamp']));
  assert(/^req_[a-f0-9]{32}$/.test(h['X-Log-Id']));
  const expected = crypto.createHmac('sha256', SECRET)
    .update(`app_key:mock-member|ts:${h['X-Timestamp']}|logid:${h['X-Log-Id']}|extra_info:`).digest('base64');
  assert.strictEqual(h['X-Sign'], expected);
  assert.strictEqual(h['Content-Type'], 'application/json');
  assert(!JSON.stringify(options.json || null).includes(SECRET));
  assert(!Object.values(h).includes(SECRET));
}

async function rejects(fn, definitive, pattern) {
  await assert.rejects(fn, error => {
    assert.strictEqual(error.definitive, definitive, error.message);
    if (pattern) assert.match(error.message, pattern);
    for (const secret of [SECRET, STS, STS_SECRET]) assert(!error.message.includes(secret));
    return true;
  });
}

test('公开接口、同步无副作用校验和诚实的只读 check', async () => {
  assert.deepStrictEqual(Object.keys(adapter).sort(), ['check', 'execute', 'id', 'prepare', 'validate']);
  assert.strictEqual(adapter.id, 'zhihu');
  let effects = 0;
  const ctx = context({ onProgress: () => effects++, saveCache: () => effects++,
    request: () => { effects++; throw new Error('No requests allowed'); } });
  ctx.article.html += '<img src="/does/not/exist.png">';
  const before = JSON.stringify(ctx);
  assert(!(adapter.validate(ctx) instanceof Promise));
  const checked = await adapter.check({ credentials: ctx.credentials, request: ctx.request });
  assert.strictEqual(checked.verified, false);
  assert.match(checked.message, /未验证/);
  assert.strictEqual(effects, 0);
  assert.strictEqual(JSON.stringify(ctx), before);
  adapter.validate(context({ options: { mode: 'prepare' } }));
  assert.throws(() => adapter.validate(context({ credentials: {} })), /appKey/);
});

test('独立 uploadImage 无需文章，沿用 apply → OSS → commit → watermark 并与 prepare 返回相同媒体属性', async () => {
  const asset = Object.freeze({ buffer: PNG, name: 'diagnostic image.png', mimeType: 'image/png' });
  const callback = { url: `${BASE}/callback`, body: 'opaque-callback', body_type: 'application/json' };
  const makeContext = expectedName => {
    const calls = [];
    let putFinished = false;
    return {
      credentials: Object.freeze({ appKey: 'mock-member', appSecret: SECRET }),
      sensitiveValues: new Set(), watermarkPoll: { maxAttempts: 2, intervalMs: 0 }, calls,
      ossPut: async received => {
        calls.push('OSS');
        assert.deepStrictEqual(received.asset.buffer, PNG);
        assert.strictEqual(received.asset.name, expectedName);
        assert.strictEqual(received.asset.mimeType, 'image/png');
        assert.strictEqual(received.auth.security_token, STS);
        assert.deepStrictEqual(received.callback, callback);
        await Promise.resolve();
        putFinished = true;
      },
      request: async (url, opts) => {
        calls.push(`${opts.method} ${url}`);
        signature(opts);
        assert.strictEqual(opts.maxBytes, 2 * 1024 * 1024);
        if (url === `${BASE}/openapi/media/uploads`) {
          assert.strictEqual(opts.method, 'POST');
          assert.deepStrictEqual(opts.json, {
            template_name: 'image-upload-default', media_type: 'image', file_name: expectedName,
            file_extension: '.png', file_size: PNG.length,
          });
          assert.strictEqual(opts.headers['X-Upload-Content-Hash'], HASH);
          const applied = applyUpload();
          applied.upload_config.callback = callback;
          return reply(applied);
        }
        if (url === `${BASE}/openapi/media/uploads/image-session`) {
          assert.strictEqual(opts.method, 'PATCH');
          assert(putFinished);
          assert.strictEqual(opts.headers['X-Security-Token'], STS);
          return reply({ upload_results: 'UPLOAD_SUCCESS', media_meta: { width: 700, height: 400 },
            media_url: { primary: ORIGINAL } });
        }
        assert.strictEqual(url, `${BASE}/openapi/media/images/image-session/watermark`);
        assert.strictEqual(opts.method, 'GET');
        assert(!Object.hasOwn(opts.headers, 'X-Security-Token'));
        return reply({ state: 'success', watermark_image_token: 'standalone-watermark',
          watermark_image_url: { primary: WATERMARK } });
      },
    };
  };
  const ctx = Object.freeze(makeContext(asset.name));
  const warnings = new Set();
  const result = await uploadImage(ctx, asset, { warnings });
  assert.deepStrictEqual(Object.keys(result).sort(), ['attrs', 'url']);
  assert.strictEqual(result.url, WATERMARK);
  assert.strictEqual(warnings.size, 0);
  assert.deepStrictEqual(ctx.calls, [
    `POST ${BASE}/openapi/media/uploads`, 'OSS', `PATCH ${BASE}/openapi/media/uploads/image-session`,
    `GET ${BASE}/openapi/media/images/image-session/watermark`,
  ]);
  assert(ctx.sensitiveValues.has(STS));
  assert(ctx.sensitiveValues.has(STS_SECRET));
  assert(!Object.hasOwn(ctx, 'article'));
  const preparedCtx = context(makeContext(`${crypto.createHash('sha256').update(PNG).digest('hex')}.png`));
  preparedCtx.article.html += `<img src="${DATA}">`;
  const prepared = await adapter.prepare(preparedCtx);
  const img = $html(prepared.html)('img');
  assert.strictEqual(img.attr('src'), result.url);
  for (const [key, value] of Object.entries(result.attrs)) assert.strictEqual(img.attr(key), value);
  assert.deepStrictEqual(preparedCtx.calls, ctx.calls);
  assert.deepStrictEqual(prepared.warnings, [...warnings]);
  for (const secret of [SECRET, STS, STS_SECRET, 'standalone-watermark']) {
    assert(!JSON.stringify({ result, prepared, warnings: [...warnings] }).includes(secret));
  }
});

test('独立 uploadImage 瞬传支持可选 warnings，水印回退仅追加安全警告且不发布', async () => {
  let applies = 0;
  let polls = 0;
  const ctx = {
    credentials: { appKey: 'mock-member', appSecret: SECRET },
    watermarkPoll: { maxAttempts: 1, intervalMs: 0 },
    ossPut: async () => assert.fail('瞬传不得调用 OSS'),
    request: async (url, opts) => {
      if (url === `${BASE}/openapi/media/uploads`) {
        applies++;
        assert.strictEqual(opts.method, 'POST');
        return reply(instant());
      }
      polls++;
      assert.strictEqual(opts.method, 'GET');
      assert.strictEqual(url, `${BASE}/openapi/media/images/instant-session/watermark`);
      return reply({ state: 'failed', msg: STS });
    },
  };
  const asset = { buffer: PNG, name: 'instant.png', mimeType: 'image/png' };
  const warnings = new Set(['existing warning']);
  const withWarnings = await uploadImage(ctx, asset, { warnings });
  assert.strictEqual(withWarnings.url, ORIGINAL);
  assert.strictEqual(warnings.size, 2);
  assert(warnings.has('existing warning'));
  assert([...warnings].some(value => value.includes('水印')));
  const before = [...warnings];
  assert.deepStrictEqual(await uploadImage(ctx, asset), withWarnings);
  assert.deepStrictEqual(await uploadImage(ctx, asset, {}), withWarnings);
  assert.deepStrictEqual([...warnings], before);
  assert.strictEqual(applies, 3);
  assert.strictEqual(polls, 3);
  assert(!JSON.stringify({ withWarnings, warnings: [...warnings] }).includes(STS));
});

test('独立 client 在发送凭证前拒绝非官方 URL，保留共享 ctx 的历史签名和凭证脱敏', async () => {
  let requests = 0;
  const externalSecret = 'prior-step &/"private';
  const sensitiveValues = new Set([externalSecret]);
  const ctx = {
    credentials: { appKey: 'mock-member', appSecret: SECRET }, sensitiveValues,
    request: async (_, opts) => {
      requests++;
      signature(opts);
      assert.strictEqual(opts.timeoutMs, 1250);
      return reply({ status: 0 });
    },
  };
  await rejects(() => client.api(ctx, 'https://evil.invalid/uploads', 'POST'), true, /接口地址/);
  assert.strictEqual(requests, 0);
  assert.deepStrictEqual([...sensitiveValues], [externalSecret]);
  await client.api(ctx, `${BASE}/openapi/media/uploads`, 'POST', {}, { 'X-Security-Token': STS }, 1250, [STS_SECRET]);
  assert.strictEqual(requests, 1);
  assert(sensitiveValues.has(SECRET));
  assert(sensitiveValues.has(STS));
  assert(sensitiveValues.has(STS_SECRET));
  const earlierValues = [...sensitiveValues];
  ctx.request = async (_, opts) => {
    requests++;
    assert.strictEqual(opts.method, 'GET');
    assert(!Object.hasOwn(opts.headers, 'X-Security-Token'));
    return reply({ status: 17, msg: `safe media error ${earlierValues.map(value =>
      `${value} ${encodeURIComponent(value)} ${JSON.stringify(value).slice(1, -1)} ${Buffer.from(value).toString('base64')}`).join(' | ')}`,
    data: { private: 'RAW_RESPONSE_SENTINEL' } }, 403);
  };
  await assert.rejects(() => client.api(ctx, `${BASE}/openapi/media/images/session/watermark`, 'GET'), error => {
    assert.strictEqual(error.definitive, true);
    assert.strictEqual(error.status, 403);
    assert.strictEqual(error.apiStatus, 17);
    assert.match(error.message, /safe media error/);
    assert.match(error.message, /REDACTED/);
    const diagnostic = `${error.stack} ${JSON.stringify(error)}`;
    for (const value of earlierValues) {
      for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64')]) {
        assert(!diagnostic.includes(form), 'Shared sensitive value leaked');
      }
    }
    assert(!diagnostic.includes('RAW_RESPONSE_SENTINEL'));
    assert(!Object.hasOwn(error, 'sensitiveValues'));
    return true;
  });
  assert.strictEqual(requests, 2);
});

test('独立媒体 commit 错误沿用 API 脱敏和 definitive 分类并保留共享敏感值', async () => {
  for (const status of [200, 403, 503]) {
    const sensitiveValues = new Set(['caller-private-value']);
    const calls = [];
    const ctx = {
      credentials: { appKey: 'mock-member', appSecret: SECRET }, sensitiveValues,
      ossPut: async () => calls.push('OSS'),
      request: async (url, opts) => {
        calls.push(opts.method);
        if (opts.method === 'POST') {
          assert.strictEqual(url, `${BASE}/openapi/media/uploads`);
          return reply(applyUpload());
        }
        assert.strictEqual(opts.method, 'PATCH');
        return reply({ status: 29, msg: `commit error caller-private-value ${SECRET} ${STS} ${STS_SECRET} ${opts.headers['X-Sign']}`,
          data: applyUpload() }, status);
      },
    };
    const warnings = new Set();
    await assert.rejects(() => uploadImage(ctx, { buffer: PNG, name: 'one.png', mimeType: 'image/png' }, { warnings }), error => {
      assert.strictEqual(error.status, status);
      assert.strictEqual(error.apiStatus, 29);
      assert.strictEqual(error.definitive, status !== 503);
      assert.match(error.message, /commit error/);
      for (const value of sensitiveValues) {
        assert(!`${error.stack} ${JSON.stringify(error)}`.includes(value), 'Media error leaked sensitive context');
      }
      return true;
    });
    assert.deepStrictEqual(calls, ['POST', 'OSS', 'PATCH']);
    assert(sensitiveValues.has(STS));
    assert(sensitiveValues.has(STS_SECRET));
    assert.strictEqual(warnings.size, 0);
  }
});

test('标题与纯文本边界按 Unicode 字符计数，无静默截断', () => {
  for (const title of ['', 'x\nx', 'x'.repeat(101)]) {
    const ctx = context(); ctx.article.title = title;
    assert.throws(() => adapter.validate(ctx), /标题/);
  }
  const unicode = context(); unicode.article.title = '😀'.repeat(100);
  unicode.article.html = '<p>一二三四五六七八九</p>';
  adapter.validate(unicode);
  unicode.article.html = '<p>一二三四五六七八</p>';
  assert.throws(() => adapter.validate(unicode), /9～100000/);
  unicode.article.html = `<p>${'字'.repeat(100000)}</p>`;
  adapter.validate(unicode);
  unicode.article.html = `<p>${'字'.repeat(100001)}</p>`;
  assert.throws(() => adapter.validate(unicode), /100001/);
});

test('只接受文章、明确拒绝独立封面和旧文更新', () => {
  for (const options of [{ type: 'pin' }, { type: 'question' }, { coverPath: 'cover.png' },
    { cover_url: 'https://example.com/cover.png' }, { articleId: '123' }, { update: true }, { mode: 'update' }]) {
    assert.throws(() => adapter.validate(context({ options })), /仅支持文章|独立封面|更新旧文章/);
  }
  const ctx = context(); ctx.article.coverPath = 'cover.png';
  assert.throws(() => adapter.validate(ctx), /独立封面/);
  ctx.article.coverPath = ''; ctx.article.id = '123';
  assert.throws(() => adapter.validate(ctx), /更新旧文章/);
});

test('话题链接、五种评论权限、目录和创作声明契约', async () => {
  for (const commentPermission of ['all', 'nobody', 'followee', 'censor', 'follower']) {
    adapter.validate(context({ options: { commentPermission } }));
  }
  for (const creationStatement of ['', null, 'spoiler', 'medical_advice', 'fictional_creation', 'contain_finance', 'ai_creation']) {
    adapter.validate(context({ options: { creationStatement } }));
  }
  for (const options of [
    { commentPermission: 'follower_n_days' }, { tableOfContentsEnabled: 'true' },
    { creationStatement: 'none' }, { creationStatement: {} },
    { topics: ['19555547'] }, { topics: ['https://evil.com/topic/123'] },
    { topics: ['https://www.zhihu.com/question/123'] }, { topics: ['https://www.zhihu.com/topic/123/evil'] },
    { topics: ['https://www.zhihu.com@evil.com/topic/123'] },
    { topics: [1, 2] }, { topics: ['1', '2', '3', '4'].map(id => `https://www.zhihu.com/topic/${id}`) },
    { commentPermission: 'all', comment_permission: 'nobody' },
  ]) assert.throws(() => adapter.validate(context({ options })));
  const options = { topics: 'https://www.zhihu.com/topic/19555547/hot https://www.zhihu.com/topic/19555547/newest',
    commentPermission: 'followee', tableOfContentsEnabled: true, creationStatement: 'ai_creation' };
  const prepared = await adapter.prepare(context({ options }));
  assert.deepStrictEqual(prepared.payload.content.topics, [{ topic_id: '', topic_token: '19555547', topic_name: '' }]);
  assert.strictEqual(prepared.payload.content.comment_permission, 'followee');
  assert.strictEqual(prepared.payload.content.table_of_contents_enabled, true);
  assert.strictEqual(prepared.payload.content.creation_statement, 'ai_creation');
  const defaults = await adapter.prepare(context());
  assert.strictEqual(defaults.payload.content.comment_permission, 'all');
  assert.strictEqual(defaults.payload.content.table_of_contents_enabled, false);
  assert(!Object.hasOwn(defaults.payload.content, 'topics'));
  assert(!Object.hasOwn(defaults.payload.content, 'creation_statement'));
});

test('话题字符串统一分隔、去重，validate → prepare → execute 保留 token 且不猜测名称或 ID', async () => {
  const links = ['https://www.zhihu.com/topic/19555547/hot',
    'https://zhihu.com/topic/test-token_2/top-answers/', 'https://www.zhihu.com/topic/19555547/newest'];
  const expected = ['19555547', 'test-token_2'].map(topic_token => ({ topic_id: '', topic_token, topic_name: '' }));
  for (const topics of [links, ...[',', '，', ' ', '\n\t', ' ，,\t'].map(separator => links.join(separator))]) {
    const ctx = context({ options: { topics } });
    adapter.validate(ctx);
    ctx.prepared = await adapter.prepare(ctx);
    assert.deepStrictEqual(ctx.prepared.payload.content.topics, expected);
    assert.deepStrictEqual(ctx.prepared.summary.topics, expected);
    let calls = 0;
    ctx.request = async (url, opts) => {
      calls++;
      assert.strictEqual(url, PUBLISH);
      assert.deepStrictEqual(opts.json.content.topics, expected);
      return success();
    };
    assert.strictEqual((await adapter.execute(ctx)).state, 'published');
    assert.strictEqual(calls, 1);
  }
  for (const topics of [undefined, null, '', ' \n\t', '，, \t，', []]) {
    const ctx = context({ options: { topics } });
    adapter.validate(ctx);
    const prepared = await adapter.prepare(ctx);
    assert(!Object.hasOwn(prepared.payload.content, 'topics'));
    assert.deepStrictEqual(prepared.summary.topics, []);
  }
  for (const topics of ['private-topic-name', '19555547', { topic_name: 'private-topic-name' },
    'https://evil.invalid/topic/private-topic-name', ['https://www.zhihu.com/topic/19555547', 'private-topic-name']]) {
    const ctx = context({ options: { topics } });
    const safeHint = error => {
      assert.strictEqual(error.definitive, true);
      assert.match(error.message, /选填，可留空/);
      assert.match(error.message, /例如 https:\/\/www\.zhihu\.com\/topic\//);
      assert(!error.message.includes('private-topic-name'));
      assert(!error.message.includes('evil.invalid'));
      return true;
    };
    assert.throws(() => adapter.validate(ctx), safeHint);
    await assert.rejects(() => adapter.prepare(ctx), safeHint);
  }
});

test('白名单转换、表格 metadata、代码和转义，不改写可见文字', async () => {
  const ctx = context();
  ctx.article.html = '<h1>一级</h1><h2>二级</h2><section><p style="color:red" class="x" data-private="x">' +
    '她说："你好" &amp; &lt;原文&gt; <strong>加粗</strong><em>斜体</em><span>保留文字</span></p></section>' +
    '<pre><code class="language-javascript">const x = "&lt;unsafe&gt;";\n</code></pre>' +
    '<table class="grid"><thead><tr><th><b>列 A</b></th><th>列 B</th></tr></thead>' +
    '<tbody><tr><td>&lt;data&gt;<br>第二行</td><td>普通文字</td></tr></tbody></table><p></p>';
  const prepared = await adapter.prepare(ctx);
  const $ = $html(prepared.html);
  assert.strictEqual($('h2').text(), '一级');
  assert.strictEqual($('h3').text(), '二级');
  assert.strictEqual($('b').first().text(), '加粗');
  assert.strictEqual($('i').text(), '斜体');
  assert.strictEqual($('pre').attr('lang'), 'js');
  assert.strictEqual($('pre').text(), 'const x = "<unsafe>";\n');
  assert.strictEqual($('pre code').length, 0);
  assert.strictEqual($('table').attr('data-draft-type'), 'table');
  assert.strictEqual($('table').attr('data-draft-node'), 'block');
  assert.strictEqual($('table').attr('data-row-style'), 'normal');
  assert.strictEqual($('table').attr('data-size'), 'normal');
  assert.strictEqual($('table thead').length, 0);
  assert.strictEqual($('table tbody').length, 1);
  assert.strictEqual($('td b, th b').length, 0);
  assert.strictEqual($('td br').length, 1);
  assert.strictEqual($('[style],[class],[data-private]').length, 0);
  assert.strictEqual($('p').last().html(), '<br>');
  assert(prepared.warnings.length > 0);
  ctx.prepared = prepared;
  ctx.request = async (url, opts) => { assert.strictEqual(url, PUBLISH); signature(opts); return success(); };
  assert.strictEqual((await adapter.execute(ctx)).state, 'published', '规范化应幂等，可直接发布预览内容');
});

test('eeimg 1/2 和 data-math 公式完整保留 LaTeX 内侧空白，不上传公式图片', async () => {
  const latex = ' \\eta = \\frac{t_s}{t_s + 2t_p} ';
  const ctx = context();
  ctx.article.html = TEXT + '<img eeimg="1" alt=" E=mc^2 " src="//www.zhihu.com/equation?tex=ignored">' +
    '<img eeimg="2" alt=" a+b " src="https://www.zhihu.com/equation?tex=ignored">' +
    `<div class="math-block" data-display="true" data-math="${latex}"><span>显示树</span></div>`;
  const prepared = await adapter.prepare(ctx);
  const images = $html(prepared.html)('img').toArray();
  assert.deepStrictEqual(images.map(img => img.attribs.eeimg), ['1', '2', '2']);
  assert.deepStrictEqual(images.map(img => img.attribs.alt), [' E=mc^2 ', ' a+b ', latex]);
  for (const img of images) {
    assert.strictEqual(new URL(img.attribs.src, 'https://www.zhihu.com').searchParams.get('tex'), img.attribs.alt);
    assert(img.attribs.src.includes('%20'));
    assert.deepStrictEqual(Object.keys(img.attribs).sort(), ['alt', 'eeimg', 'src']);
  }
  assert.strictEqual(prepared.summary.imageCount, 0);
  assert(!prepared.html.includes('显示树'));
});

test('表格标题、单元格段落和引用末尾换行保留，不因格式适配丢失内容', async () => {
  const ctx = context();
  ctx.article.html = TEXT + '<table><caption>不能丢失的表标题</caption><tr><td><p>段落一</p><p>段落二</p></td></tr></table>' +
    '<blockquote>保留末尾换行<br></blockquote><blockquote><p>引用一</p><p>引用二</p></blockquote>';
  const prepared = await adapter.prepare(ctx);
  const $ = $html(prepared.html);
  assert.strictEqual($('table').prev('p').text(), '不能丢失的表标题');
  assert.strictEqual($('td').html(), '段落一<br>段落二');
  assert.strictEqual($('blockquote').first().html(), '保留末尾换行<br>');
  assert.strictEqual($('blockquote').last().html(), '引用一<br>引用二');
  ctx.prepared = prepared;
  ctx.request = async () => success();
  assert.strictEqual((await adapter.execute(ctx)).state, 'published');
});

test('表格内公式保留 LaTeX 文本并提示，表格外公式继续使用知乎公式', async () => {
  const ctx = context();
  ctx.article.html = TEXT + '<table><tr><td>维度 <span data-math="d">重复渲染树</span></td>' +
    '<td><img eeimg="1" alt="a &lt; b" src="//www.zhihu.com/equation?tex=x"></td></tr></table>' +
    '<span data-math="x^2">公式树</span>';
  const prepared = await adapter.prepare(ctx);
  const $ = $html(prepared.html);
  assert.deepStrictEqual($('td').map((_, cell) => $(cell).text()).get(), ['维度 d', 'a < b']);
  assert.strictEqual($('table img').length, 0);
  assert.strictEqual($('img[eeimg]').attr('alt'), 'x^2');
  assert(prepared.warnings.some(message => message.includes('表格内公式')));
  assert(!prepared.html.includes('重复渲染树'));
  ctx.prepared = prepared;
  ctx.request = async () => success();
  assert.strictEqual((await adapter.execute(ctx)).state, 'published');
});

test('危险标签和属性提前拒绝，不发请求；表格合并或媒体不静默丢失', async () => {
  for (const unsafe of [
    '<script>alert(1)</script>', '<iframe src="https://evil.com"></iframe>', '<svg><a>x</a></svg>',
    '<img src="x" onerror="oops()">', '<p srcdoc="danger">文字</p>',
    '<a href="java&#x73;cript:alert(1)">链接</a>', '<a href="file:///tmp/x">链接</a>',
    '<img src="vbscript:x">', '<img src="x" style="background:url(javascript:evil)">',
    '<table><tr><td colspan="2">数据</td></tr></table>',
    `<table><tr><td><img src="${DATA}"></td></tr></table>`,
  ]) {
    const ctx = context(); ctx.article.html += unsafe;
    await rejects(() => adapter.prepare(ctx), true);
  }
});

test('签名 Apply → async OSS → PATCH Commit → 水印，去重并保留每处注释及真实 URL', async () => {
  const calls = [];
  const progress = [];
  let saved = 0;
  let putFinished = false;
  let puts = 0;
  const ctx = context({ onProgress: message => progress.push(message), saveCache: async () => saved++,
    ossPut: async ({ address, auth, asset }) => {
      puts++;
      assert.strictEqual(address.object_name, 'images/file.png');
      assert.strictEqual(auth.security_token, STS);
      assert.strictEqual(auth.secret_access_key, STS_SECRET);
      assert.deepStrictEqual(asset.buffer, PNG);
      await Promise.resolve();
      putFinished = true;
    },
    request: async (url, options) => {
      calls.push({ url, options });
      signature(options);
      assert.strictEqual(options.headers['X-Media-Scene-Name'], 'article');
      if (url.endsWith('/uploads')) {
        assert.strictEqual(options.method, 'POST');
        assert.deepStrictEqual(options.json, { template_name: 'image-upload-default', media_type: 'image',
          file_name: `${crypto.createHash('sha256').update(PNG).digest('hex')}.png`, file_extension: '.png', file_size: PNG.length });
        assert.strictEqual(options.headers['X-Upload-Content-Hash'], HASH);
        assert.strictEqual(options.headers['X-Upload-Content-Type'], 'image/png');
        assert.strictEqual(options.headers['X-Media-Upload-Platform'], 'web');
        assert(!Object.hasOwn(options.json, 'data'));
        return reply(applyUpload());
      }
      if (options.method === 'PATCH') {
        assert(putFinished, '必须 await OSS 完成再 commit');
        assert.strictEqual(url, `${BASE}/openapi/media/uploads/image-session`);
        assert.deepStrictEqual(options.json, { media_type: 'image', client_upload_state: 'UPLOAD_SUCCESS', processes: 'opaque-processes' });
        assert.strictEqual(options.headers['X-Security-Token'], STS);
        assert.strictEqual(options.headers['X-Media-Upload-Platform'], 'web');
        return reply({ upload_results: 'UPLOAD_SUCCESS', media_meta: { width: 700, height: 400 }, media_url: { primary: ORIGINAL } });
      }
      assert.strictEqual(options.method, 'GET');
      assert.strictEqual(url, `${BASE}/openapi/media/images/image-session/watermark`);
      assert(!Object.hasOwn(options.headers, 'X-Security-Token'));
      return reply({ state: 'success', original_image_token: `v2-${HASH}`, watermark_image_token: 'real-watermark-token',
        watermark_image_url: { primary: WATERMARK } });
    } });
  ctx.article.html += `<img src="${DATA}" alt="第一处 &quot;注释&quot;"><p>图片之间的文字</p><img src="${DATA}" data-caption="第二处">`;
  const prepared = await adapter.prepare(ctx);
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(puts, 1);
  assert.strictEqual(saved, 1);
  assert.strictEqual(prepared.summary.imageCount, 2);
  const $ = $html(prepared.html);
  assert.deepStrictEqual($('img').toArray().map(img => img.attribs['data-caption']), ['第一处 "注释"', '第二处']);
  $('img').each((_, img) => {
    assert.strictEqual($(img).attr('src'), WATERMARK);
    assert.strictEqual($(img).attr('data-original-src'), ORIGINAL);
    assert.strictEqual($(img).attr('data-watermark-src'), WATERMARK);
    assert.strictEqual($(img).attr('data-private-watermark-src'), WATERMARK);
    assert.strictEqual($(img).attr('data-watermark'), 'watermark');
    assert.strictEqual($(img).attr('data-rawwidth'), '700');
    assert.strictEqual($(img).attr('data-rawheight'), '400');
  });
  for (const secret of [SECRET, STS, STS_SECRET, 'real-watermark-token']) {
    assert(!JSON.stringify({ prepared, cache: ctx.mediaCache, progress }).includes(secret));
  }
  ctx.request = async () => { throw new Error('缓存不应重新上传'); };
  const reused = await adapter.prepare(ctx);
  assert.strictEqual(reused.html, prepared.html);
  assert.strictEqual(saved, 1);
});

test('瞬传使用 extra_params.url，无 OSS 或 commit，不拼造缺失 URL', async () => {
  let calls = 0;
  const ctx = context({ ossPut: async () => assert.fail('瞬传不调用 OSS'), request: async (url, opts) => {
    calls++;
    if (opts.method === 'POST') return reply(instant({ extra_params: { width: 100, height: 200, url: { primary: ORIGINAL } } }));
    assert(url.endsWith('/instant-session/watermark'));
    return reply({ state: 'failed' });
  } });
  ctx.article.html += `<img src="${DATA}" alt="瞬传">`;
  const prepared = await adapter.prepare(ctx);
  assert.strictEqual(calls, 2);
  const img = $html(prepared.html)('img');
  assert.strictEqual(img.attr('src'), ORIGINAL);
  assert.strictEqual(img.attr('data-size'), 'small');
  assert.strictEqual(img.attr('data-watermark'), 'original');
  assert.strictEqual(img.attr('data-watermark-src'), '');
  assert(prepared.warnings.some(value => value.includes('水印')));
  ctx.mediaCache = {};
  ctx.request = async () => reply(instant({ extra_params: { width: 100, height: 200 } }));
  await rejects(() => adapter.prepare(ctx), false, /真实原图/);
});

test('水印仅接受 success 且真实不同 token/URL；处理、异常和鉴权失败都有界回退', async () => {
  const cases = [
    { watermark: reply({ state: 'processing' }), expectedPolls: 2 },
    { watermark: reply({ state: 'failed', watermark_image_token: 'wm', watermark_image_url: { primary: WATERMARK } }), expectedPolls: 1 },
    { watermark: reply({ state: 'success', watermark_image_token: 'wm' }), expectedPolls: 1 },
    { watermark: reply({ state: 'success', watermark_image_token: `v2-${HASH}`, watermark_image_url: { primary: WATERMARK } }), expectedPolls: 1 },
    { watermark: reply({ state: 'success', original_image_token: 'same', watermark_image_token: 'same',
      watermark_image_url: { primary: WATERMARK } }), expectedPolls: 1 },
    { watermark: { status: 401, body: Buffer.from('not-json') }, expectedPolls: 1 },
    { watermark: reply({}, 503), expectedPolls: 2 },
    { watermark: { status: 200, body: Buffer.from('not-json') }, expectedPolls: 2 },
  ];
  for (const item of cases) {
    let polls = 0;
    const ctx = context({ request: async (_, opts) => {
      if (opts.method === 'POST') return reply(instant());
      polls++; return item.watermark;
    } });
    ctx.article.html += `<img src="${DATA}">`;
    const prepared = await adapter.prepare(ctx);
    assert.strictEqual(polls, item.expectedPolls);
    assert.strictEqual($html(prepared.html)('img').attr('src'), ORIGINAL);
    assert.strictEqual($html(prepared.html)('img').attr('data-watermark-src'), '');
    assert(prepared.warnings.length > 0);
  }
});

test('瞬传缺少宽高不编造媒体尺寸或水印属性；水印瞬态错误可恢复', async () => {
  let polls = 0;
  const ctx = context({ request: async (_, opts) => {
    if (opts.method === 'POST') return reply(instant({ extra_params: { url: { primary: ORIGINAL } } }));
    if (++polls === 1) return reply({}, 503);
    return reply({ state: 'success', watermark_image_token: 'wm', watermark_image_url: { primary: WATERMARK } });
  } });
  ctx.article.html += `<img src="${DATA}">`;
  const prepared = await adapter.prepare(ctx);
  const img = $html(prepared.html)('img');
  assert.strictEqual(img.attr('src'), WATERMARK);
  for (const attr of ['data-rawwidth', 'data-rawheight', 'data-watermark']) assert.strictEqual(img.attr(attr), undefined);
  assert.strictEqual(polls, 2);
});

test('动态 commit 地址仅允许官方 HTTPS，校验发生在 OSS 和携带凭证请求之前', async () => {
  for (const address of ['https://evil.com/commit', 'http://openapi.zhihu.com/commit',
    'https://openapi.zhihu.com.evil.com/commit', 'https://user:pass@openapi.zhihu.com/commit',
    'https://openapi.zhihu.com:444/commit', '//openapi.zhihu.com/commit']) {
    let requests = 0;
    const ctx = context({ request: async () => {
      requests++; return reply(applyUpload({ upload_media: { commit_address: address } }));
    }, ossPut: async () => assert.fail('不得向不可信 commit 配置执行 OSS') });
    ctx.article.html += `<img src="${DATA}">`;
    await rejects(() => adapter.prepare(ctx), true, /commit/);
    assert.strictEqual(requests, 1);
  }
});

test('合法动态 commit URL 原样保留查询参数；只认 upload_results 完整成功', async () => {
  const commitUrl = `${BASE}/openapi/media/uploads/custom?opaque=one%2Btwo&version=1`;
  for (const [commit, definitive] of [
    [{ upload_result: 'UPLOAD_SUCCESS', media_url: { primary: ORIGINAL } }, false],
    [{ upload_results: 'UPLOAD_FAIL' }, true],
  ]) {
    const ctx = context({ ossPut: async () => {}, request: async (url, opts) => {
      if (opts.method === 'POST') return reply(applyUpload({ upload_media: { commit_address: commitUrl } }));
      assert.strictEqual(url, commitUrl);
      assert.strictEqual(opts.method, 'PATCH');
      return reply(commit);
    } });
    ctx.article.html += `<img src="${DATA}">`;
    await rejects(() => adapter.prepare(ctx), definitive, /commit/);
  }
  const wrapped = context({ request: async () => reply({ data: instant() }) });
  wrapped.article.html += `<img src="${DATA}">`;
  await rejects(() => adapter.prepare(wrapped), false, /图片申请/);
});

test('默认路径使用真实 ali-oss Node SDK 的 endpoint/cname/bucket/STS 配置，PUT 也被 mock', async () => {
  const OSS = require('ali-oss');
  const originalPut = OSS.prototype.put;
  const captured = [];
  OSS.prototype.put = async function (name, buffer, options) {
    captured.push({ config: this.options, name, buffer, options });
    return { res: { status: 200 }, url: 'https://must-not-use.example/guessed.png' };
  };
  try {
    for (const cname of [false, true]) {
      const applied = applyUpload();
      applied.upload_config.address.endpoint = cname ? 'https://upload.zhihu.com' : 'oss-cn-beijing.aliyuncs.com';
      applied.upload_config.address.is_cname = cname;
      const ctx = context({ request: async (_, opts) => {
        if (opts.method === 'POST') return reply(applied);
        if (opts.method === 'PATCH') return reply({ upload_results: 'UPLOAD_SUCCESS',
          media_meta: { width: 700, height: 400 }, media_url: { primary: ORIGINAL } });
        return reply({ state: 'failed' });
      } });
      ctx.article.html += `<img src="${DATA}">`;
      const prepared = await adapter.prepare(ctx);
      const result = captured[captured.length - 1];
      assert.strictEqual(result.config.cname, cname);
      assert.strictEqual(result.config.bucket, 'zhihu-test');
      assert.strictEqual(result.config.endpoint.protocol, 'https:');
      assert.strictEqual(result.config.endpoint.hostname, cname ? 'upload.zhihu.com' : 'oss-cn-beijing.aliyuncs.com');
      assert.strictEqual(result.config.accessKeyId, 'mock-ak');
      assert.strictEqual(result.config.accessKeySecret, STS_SECRET);
      assert.strictEqual(result.config.stsToken, STS);
      assert.strictEqual(result.name, 'images/file.png');
      assert.deepStrictEqual(result.buffer, PNG);
      assert.strictEqual(result.options.mime, 'image/png');
      assert.strictEqual($html(prepared.html)('img').attr('src'), ORIGINAL);
    }
  } finally { OSS.prototype.put = originalPut; }
});

test('OSS 失败只上报固定错误，不泄漏 SDK 消息中的凭证或继续发布', async () => {
  const methods = [];
  const ctx = context({ ossPut: async () => { throw new Error(`${SECRET} ${STS} ${STS_SECRET}`); },
    request: async (_, opts) => {
      methods.push(opts.method);
      if (opts.method === 'POST') return reply(applyUpload());
      assert.strictEqual(opts.json.client_upload_state, 'UPLOAD_FAIL');
      assert.strictEqual(opts.json.error_log, 'OSS upload failed');
      return reply({ upload_results: 'UPLOAD_FAIL' });
    } });
  ctx.article.html += `<img src="${DATA}">`;
  await rejects(() => adapter.prepare(ctx), true, /OSS/);
  assert.deepStrictEqual(methods, ['POST', 'PATCH']);
  assert.deepStrictEqual(ctx.mediaCache, {});
});

test('本地图片通过共享 mapImages 读取，同内容跨引用仍只上传一次', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-official-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'image one.png'), PNG);
    let applies = 0;
    const ctx = context({ request: async (_, opts) => {
      if (opts.method === 'POST') { applies++; return reply(instant()); }
      return reply({ state: 'failed' });
    } });
    ctx.article.baseDir = tempDir;
    ctx.article.html += `<img src="image%20one.png" alt="本地"><img src="${DATA}" alt="内嵌">`;
    const prepared = await adapter.prepare(ctx);
    assert.strictEqual(applies, 1);
    assert.strictEqual($html(prepared.html)('img').length, 2);
    assert(!prepared.html.includes(tempDir));
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('远程下载经过共享 mapImages，下载器使用完整原始 URL，所有网络均被 mock', async () => {
  const realGet = https.get;
  const source = 'https://example.test/image.png?signature=a%2Bb&key=c';
  let downloads = 0;
  https.get = (url, options, callback) => {
    downloads++;
    assert.strictEqual(String(url), source);
    const req = new EventEmitter();
    req.destroy = error => req.emit('error', error);
    process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.resume = () => {};
      callback(res);
      res.emit('data', PNG);
      res.emit('end');
      req.emit('close');
    });
    return req;
  };
  try {
    const ctx = context({ request: async (_, opts) => opts.method === 'POST' ? reply(instant()) : reply({ state: 'failed' }) });
    ctx.article.html += '<img src="https://example.test/image.png?signature=a%2Bb&amp;key=c">';
    const prepared = await adapter.prepare(ctx);
    assert.strictEqual(downloads, 1);
    assert.strictEqual($html(prepared.html)('img').attr('src'), ORIGINAL);
  } finally { https.get = realGet; }
});

test('execute 只发一次最终 POST，使用已预览快照和正确签名，不重新准备内容', async () => {
  const ctx = context();
  ctx.prepared = await adapter.prepare(ctx);
  const before = JSON.stringify(ctx.prepared);
  ctx.article = { title: '预览后改动，不得替换快照', html: '<script>changed</script>' };
  ctx.options = { creationStatement: 'ai_creation' };
  let finals = 0;
  ctx.request = async (url, opts) => {
    finals++;
    assert.strictEqual(url, PUBLISH);
    assert.strictEqual(opts.method, 'POST');
    assert.deepStrictEqual(opts.json, JSON.parse(before).payload);
    assert.strictEqual(opts.json.type, 'article');
    assert.strictEqual(opts.json.confirmed, true);
    assert(!Object.hasOwn(opts.headers, 'X-Security-Token'));
    signature(opts);
    return success();
  };
  assert.deepStrictEqual(await adapter.execute(ctx), { state: 'published', id: '123456', url: 'https://zhuanlan.zhihu.com/p/123456' });
  assert.strictEqual(finals, 1);
  assert.strictEqual(JSON.stringify(ctx.prepared), before);
});

test('最终发布 HTTP/业务拒绝为 definitive，网络/5xx/非法响应保持未知且不自动重试', async () => {
  const prepared = await adapter.prepare(context());
  const cases = [
    [async () => ({ status: 401, body: Buffer.from('unauthorized') }), true],
    [async () => reply({ status: 0 }, 429), true],
    [async () => reply({ status: 1, msg: SECRET }), true],
    [async () => { throw new Error(`${SECRET} ${STS}`); }, false],
    [async () => reply({ status: 1 }, 503), false],
    [async () => ({ status: 200, body: Buffer.from('invalid-json') }), false],
    [async () => ({ status: 302, body: Buffer.from('{}'), headers: { location: 'https://evil.com' } }), false],
    [async () => reply(null), false],
    [async () => reply([]), false],
    [async () => reply({}), false],
    [async () => reply({ status: '0', data: {} }), false],
    [async () => reply({ status: 0 }), false],
    ...[
      'https://evil.com/p/123456', 'http://zhuanlan.zhihu.com/p/123456',
      'https://zhuanlan.zhihu.com/p/999', 'https://zhuanlan.zhihu.com.evil.com/p/123456',
      'https://user:pass@zhuanlan.zhihu.com/p/123456', 'https://zhuanlan.zhihu.com/p/123456#fragment',
    ].map(url => [async () => reply({ status: 0, data: { content_token: '123456', url } }), false]),
  ];
  for (const [response, definitive] of cases) {
    let calls = 0;
    const ctx = context({ prepared, request: async () => { calls++; return response(); } });
    await rejects(() => adapter.execute(ctx), definitive);
    assert.strictEqual(calls, 1);
  }
});

test('HTTP 与业务错误保留安全 msg 和数值 status，绝不返回原始 data 或响应', async () => {
  const prepared = await adapter.prepare(context());
  for (const [httpStatus, businessStatus, definitive] of [
    [200, 1001, true], [422, 1002, true], [403, undefined, true], [503, 1003, false],
  ]) {
    const ctx = context({ prepared, request: async () => reply({
      ...(businessStatus === undefined ? {} : { status: businessStatus }),
      msg: '话题链接格式不正确，请使用话题主页链接',
      data: { upload_auth: { security_token: STS, secret_access_key: STS_SECRET }, private: 'RAW_DATA_SENTINEL' },
    }, httpStatus) });
    await assert.rejects(() => adapter.execute(ctx), error => {
      assert.strictEqual(error.definitive, definitive);
      assert.strictEqual(error.status, httpStatus);
      assert.strictEqual(error.apiStatus, businessStatus);
      assert(error.message.includes(`HTTP ${httpStatus}`));
      if (businessStatus !== undefined) assert(error.message.includes(`status ${businessStatus}`));
      assert.match(error.message, /话题链接格式不正确/);
      const diagnostic = `${error.stack} ${JSON.stringify(error)}`;
      for (const value of [STS, STS_SECRET, 'RAW_DATA_SENTINEL']) assert(!diagnostic.includes(value));
      assert(!Object.hasOwn(error, 'data'));
      assert(!Object.hasOwn(error, 'response'));
      return true;
    });
  }
});

test('诊断脱敏覆盖凭证及所有请求头的原文、URL、JSON、base64 和未知 token 赋值', async () => {
  const secret = 'private &/"\\中?+ secret';
  const forms = value => {
    const base64 = Buffer.from(value).toString('base64');
    return [value, encodeURIComponent(value), encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, part => part.toLowerCase()),
      encodeURIComponent(encodeURIComponent(value)), new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1), base64, base64.replace(/=+$/, ''),
      base64.replace(/\+/g, '-').replace(/\//g, '_'),
      base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      Array.from(value).map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')];
  };
  const prepared = await adapter.prepare(context());
  for (const httpStatus of [200, 401, 503]) {
    // Separate responses keep each adversarial form below the diagnostic limit.
    for (let index = 0; index < forms(secret).length; index++) {
      let echoed = [];
      const ctx = context({ prepared, credentials: { appKey: 'private-app-key', appSecret: secret },
        request: async (_, opts) => {
          echoed = [secret, ...Object.values(opts.headers).filter(Boolean)].map(value => forms(value)[index]);
          return reply({ status: 1004, msg: `安全诊断 ${echoed.join(' | ')} token=unknown-token-value ` +
            '"refresh_token":"unknown refresh value" X-Security-Token=unknown-sts-value ' +
            'Authorization: Bearer unknown-bearer-value secret_access_key=unknown-oss-secret',
          data: { private: 'RAW_DATA_SENTINEL' } }, httpStatus);
        } });
      await assert.rejects(() => adapter.execute(ctx), error => {
        assert.strictEqual(error.definitive, httpStatus !== 503);
        assert.match(error.message, /安全诊断/);
        assert.match(error.message, /REDACTED/);
        const diagnostic = `${error.stack} ${JSON.stringify(error)}`;
        for (const value of [...forms(secret), ...echoed, 'private-app-key', 'unknown-token-value',
          'unknown refresh value', 'unknown-sts-value', 'unknown-bearer-value', 'unknown-oss-secret', 'RAW_DATA_SENTINEL']) {
          assert(!diagnostic.includes(value), 'Sensitive diagnostic value leaked');
        }
        assert(Array.from(error.message).length < 400);
        assert(!/[\x00-\x1f\u202a-\u202e]/.test(error.message));
        return true;
      });
    }
  }
});

test('未知 token、签名和授权赋值即使包含空白、转义引号或嵌套结构也不泄漏', async () => {
  const prepared = await adapter.prepare(context());
  for (const assignment of [
    'token=unknown-secret', '"refreshToken": "unknown secret with spaces"',
    '"security_token": "unknown \\"quoted\\" secret"',
    'token={"nested":"unknown-secret"}', 'token%3D%22unknown%20secret%22',
    '"\\u0074oken": "unknown \\u0022quoted\\u0022 secret"',
    'Authorization: Bearer unknown-secret', 'Authorization=Basic unknown-secret',
    'X-Custom-Auth: unknown-secret', 'sts=unknown-secret',
  ]) {
    await assert.rejects(() => adapter.execute(context({ prepared,
      request: async () => reply({ status: 9, msg: `安全原因 ${assignment}` }),
    })), error => {
      assert.match(error.message, /安全原因/);
      assert.match(error.message, /REDACTED/);
      assert(!error.message.includes('unknown'));
      assert(!error.message.includes('quoted'));
      assert(!error.message.includes('nested'));
      return true;
    });
  }
});

test('commit 错误脱敏 X-Security-Token 等动态请求头，不泄漏 STS 或 SDK 数据', async () => {
  for (const httpStatus of [200, 403, 503]) {
    const ctx = context({ ossPut: async () => {}, request: async (_, opts) => {
      if (opts.method === 'POST') return reply(applyUpload());
      assert.strictEqual(opts.method, 'PATCH');
      const token = opts.headers['X-Security-Token'];
      return reply({ status: 1005, msg: `commit denied ${STS_SECRET} mock-ak ${Buffer.from(STS_SECRET).toString('base64')} ` +
        `${token} ${encodeURIComponent(token)} ` +
        `${Buffer.from(token).toString('base64')} ${opts.headers['X-Sign']} ` +
        `secret_access_key="${STS_SECRET}"`, data: applyUpload() }, httpStatus);
    } });
    ctx.article.html += `<img src="${DATA}">`;
    await rejects(() => adapter.prepare(ctx), httpStatus !== 503, /commit denied/);
  }
});

test('诊断有界、清除控制符，非法或过大响应不回显正文且保留 HTTP 错误分类', async () => {
  const prepared = await adapter.prepare(context());
  const cases = [
    [reply({ status: 1, msg: `safe\u001b\u202e\n${'😀'.repeat(400)} ${SECRET}` }), true, /safe/],
    [reply({ status: 1, msg: `OVERSIZED_MESSAGE ${'x'.repeat(8192)} ${SECRET}` }), true, /业务拒绝/],
    [reply({ status: 1, msg: { private: SECRET } }), true, /业务拒绝/],
    [{ status: 400, body: Buffer.from(`RAW_BODY_SENTINEL ${SECRET}`) }, true, /HTTP 400/],
    [{ status: 503, body: Buffer.from(`RAW_BODY_SENTINEL ${STS}`) }, false, /HTTP 503/],
    ...[200, 413, 503].map(status => [reply({ status: 1, msg: 'OVERSIZED_BODY', data: 'x'.repeat(2 * 1024 * 1024) }, status),
      status === 413, new RegExp(`HTTP ${status}`)]),
    [reply({ status: 'private-status', msg: SECRET }), false, /响应状态无效/],
    [reply({ status: 1.5, msg: SECRET }), false, /响应状态无效/],
    [reply({ status: Number.MAX_SAFE_INTEGER + 1, msg: SECRET }), false, /响应状态无效/],
    [{ status: 200, body: { toString: () => assert.fail('Never stringify arbitrary bodies') } }, false, /非法 JSON/],
  ];
  for (const [response, definitive, pattern] of cases) {
    await assert.rejects(() => adapter.execute(context({ prepared, request: async () => response })), error => {
      assert.strictEqual(error.definitive, definitive);
      assert.strictEqual(error.status, response.status);
      assert.match(error.message, pattern);
      assert(Array.from(error.message).length < 400);
      assert(!/[\x00-\x1f\u202a-\u202e]/.test(error.message));
      for (const value of [SECRET, STS, 'RAW_BODY_SENTINEL', 'OVERSIZED_BODY', 'OVERSIZED_MESSAGE', 'private-status']) {
        assert(!error.message.includes(value));
      }
      return true;
    });
  }
});

test('execute 缺少 prepare 或快照被注入更新/封面/未知字段时本地拒绝', async () => {
  await rejects(() => adapter.execute(context()), true, /prepare/);
  for (const mutate of [
    prepared => { prepared.payload.confirmed = false; },
    prepared => { prepared.payload.content.article_id = '123'; },
    prepared => { prepared.payload.content.images = []; },
    prepared => { prepared.payload.content.cover = 'x'; },
    prepared => { delete prepared.payload.content.comment_permission; },
    prepared => { delete prepared.payload.content.table_of_contents_enabled; },
    prepared => { prepared.payload.content.creation_statement = ''; },
    prepared => { prepared.html = 'different'; },
    prepared => { prepared.payload.content.topics = [{ topic_id: 'invented', topic_token: '123', topic_name: '' }]; },
    prepared => { prepared.payload.content.html += '<span style="color:red">注入</span>'; prepared.html = prepared.payload.content.html; },
  ]) {
    const ctx = context(); ctx.prepared = await adapter.prepare(ctx);
    mutate(ctx.prepared);
    await rejects(() => adapter.execute(ctx), true);
  }
});

(async () => {
  // Fail closed if any test accidentally reaches the actual network.
  const realGet = https.get;
  const realRequest = https.request;
  const realHttpGet = http.get;
  const realHttpRequest = http.request;
  const realFetch = global.fetch;
  https.get = () => { throw new Error('Live downloads forbidden in contract tests'); };
  https.request = () => { throw new Error('Live requests forbidden in contract tests'); };
  http.get = () => { throw new Error('Live HTTP downloads forbidden in contract tests'); };
  http.request = () => { throw new Error('Live HTTP requests forbidden in contract tests'); };
  global.fetch = () => { throw new Error('Live fetch forbidden in contract tests'); };
  try {
    for (const { name, run } of tests) {
      await run();
      console.log(`PASS ${name}`);
    }
    console.log(`知乎官方发布契约测试：${tests.length}/${tests.length} 通过（全部 mock）`);
  } finally {
    https.get = realGet;
    https.request = realRequest;
    http.get = realHttpGet;
    http.request = realHttpRequest;
    global.fetch = realFetch;
  }
})().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
