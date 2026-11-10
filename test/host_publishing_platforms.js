'use strict';

const assert = require('assert/strict');
const cheerio = require('cheerio');
const wechat = require('../lib/publishing/wechat');
const cnblogs = require('../lib/publishing/cnblogs');
const rpc = require('../lib/publishing/xmlrpc');
const { request: httpRequest } = require('../lib/publishing/http');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');
const dataImage = buffer => `data:image/png;base64,${buffer.toString('base64')}`;
const cover = dataImage(png);
const bodyHtml = `<p>前 &amp; 后</p><img src="${cover}" alt="第一张"><p>中间</p><img src="${cover}" alt="第二张"><p>结尾</p>`;
const response = (data, status = 200) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(data)) });
const rpcResponse = value => ({ status: 200, headers: {}, body: Buffer.from(`<methodResponse><params><param>${rpc.serializeValue(value)}</param></params></methodResponse>`) });
const faultResponse = (code = 403) => ({
  status: 200, headers: {},
  body: Buffer.from(`<methodResponse><fault>${rpc.serializeValue({ faultCode: code, faultString: 'secret-token access_token=SECRET' })}</fault></methodResponse>`),
});

function wechatCtx(overrides = {}) {
  return {
    article: { title: '官方公众号草稿', html: bodyHtml, baseDir: __dirname, coverPath: cover, sourceUrl: 'https://example.com/article' },
    options: { author: '作者', digest: '摘要', comments: true, fansOnly: true },
    credentials: { appId: 'mock-app', appSecret: 'mock-secret' },
    mediaCache: {}, ...overrides,
  };
}

function wechatMock(handler) {
  const calls = [];
  const transport = async (url, options = {}) => {
    const address = new URL(url);
    const entry = { address, options };
    calls.push(entry);
    assert.equal(address.hostname, 'api.weixin.qq.com');
    if (handler) {
      const result = await handler(entry, calls);
      if (result !== undefined) return result;
    }
    switch (address.pathname) {
      case '/cgi-bin/token':
        assert.equal(address.searchParams.get('grant_type'), 'client_credential');
        assert.equal(address.searchParams.get('appid'), 'mock-app');
        assert.equal(address.searchParams.get('secret'), 'mock-secret');
        return response({ access_token: 'MEMORY_ONLY_TOKEN', expires_in: 7200 });
      case '/cgi-bin/media/uploadimg': return response({ url: 'http://mmbiz.qpic.cn/mock/body.png' });
      case '/cgi-bin/material/add_material': return response({ media_id: 'permanent-cover' });
      case '/cgi-bin/draft/count': return response({ total_count: 3 });
      case '/cgi-bin/draft/add': return response({ media_id: 'created-draft' });
      case '/cgi-bin/draft/get': {
        const write = calls.find(call => call.address.pathname === '/cgi-bin/draft/add');
        return response({ news_item: write.options.json.articles });
      }
      default: throw new Error('Unexpected WeChat API');
    }
  };
  return { transport, calls, paths: () => calls.map(call => call.address.pathname) };
}

function cnblogsCtx(overrides = {}) {
  return {
    article: { title: '博客 & <XML> "转义"', html: bodyHtml, baseDir: __dirname },
    options: { categories: ['技术 & 科学', '<编码>'], tags: ['Node.js', '中文标签'], comments: false, mode: 'draft' },
    credentials: { blogName: 'mock-blog', username: 'mock-user', token: 'mock-token<&' },
    mediaCache: {}, ...overrides,
  };
}

function decodeCall(body) {
  const $ = cheerio.load(body.toString('utf8'), { xmlMode: true });
  return {
    method: $('methodCall > methodName').text(),
    params: $('methodCall > params > param').toArray().map(param =>
      rpc.parseResponse(`<methodResponse><params><param>${$(param).html()}</param></params></methodResponse>`)),
  };
}

function cnblogsMock(handler) {
  const calls = [];
  const transport = async (url, options) => {
    assert.equal(url, 'https://rpc.cnblogs.com/metaweblog/mock-blog');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'text/xml; charset=utf-8');
    const entry = { ...decodeCall(options.body), options };
    calls.push(entry);
    if (handler) {
      const result = await handler(entry, calls);
      if (result !== undefined) return result;
    }
    switch (entry.method) {
      case 'blogger.getUsersBlogs':
        return rpcResponse([
          { blogid: 'wrong', blogName: '其他博客', url: 'https://www.cnblogs.com/other/' },
          { blogid: '987', blogName: '真实博客名称', url: 'https://www.cnblogs.com/mock-blog/' },
        ]);
      case 'metaWeblog.newMediaObject': return rpcResponse({ url: 'https://images.cnblogs.com/mock/body.png' });
      case 'metaWeblog.newPost': return rpcResponse('12345');
      case 'metaWeblog.editPost': return rpcResponse(true);
      case 'metaWeblog.getPost': {
        const write = calls.find(call => ['metaWeblog.newPost', 'metaWeblog.editPost'].includes(call.method));
        return rpcResponse({ ...write.params[3], permalink: 'https://www.cnblogs.com/mock-blog/p/12345.html' });
      }
      default: throw new Error('Unexpected XML-RPC method');
    }
  };
  return { transport, calls, methods: () => calls.map(call => call.method) };
}

async function rejects(fn, definitive, secret) {
  await assert.rejects(fn, error => {
    assert.equal(error.definitive, definitive, error.message);
    if (secret) assert.ok(!error.message.includes(secret), error.message);
    return true;
  });
}

test('XML-RPC round trips structs, arrays, escaped text, base64, booleans, numbers and dates', () => {
  const value = {
    title: '<中文>&"\'😀', array: ['42', 42, -7, 1.25, true, false],
    bits: png, date: new Date('2026-11-04T08:09:10Z'), empty: '', nested: { 'a<&': ['尾部'] },
  };
  const xml = rpc.serializeValue(value);
  assert.ok(xml.includes('&lt;中文&gt;&amp;&quot;&apos;'));
  assert.ok(xml.includes('<base64>'));
  assert.ok(xml.includes('<dateTime.iso8601>20261104T08:09:10</dateTime.iso8601>'));
  assert.deepEqual(rpc.parseResponse(rpcResponse(value).body), value);
  assert.equal(rpc.parseResponse('<methodResponse><params><param><value>implicit &amp; string</value></param></params></methodResponse>'), 'implicit & string');
  assert.deepEqual(rpc.parseResponse('<methodResponse><params><param><value><i4>7</i4></value></param></params></methodResponse>'), 7);
});

test('XML-RPC rejects DTD, XXE, entity declarations, malformed syntax and invalid scalar values', () => {
  const wrap = xml => `<methodResponse><params><param><value>${xml}</value></param></params></methodResponse>`;
  for (const xml of [
    '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]>' + wrap('<string>&leak;</string>'),
    '<!ENTITY x SYSTEM "https://example.com/secret">' + wrap('<string>x</string>'),
    wrap('<string>&unknown;</string>'), wrap('<string>&#0;</string>'),
    wrap('<string>mismatch</int>'), wrap('<boolean>true</boolean>'),
    wrap('<base64>not base64!</base64>'), wrap('<double>Infinity</double>'),
    wrap('<int>2147483648</int>'), wrap('<dateTime.iso8601>20260230T10:00:00</dateTime.iso8601>'),
    wrap('<unsupported>1</unsupported>'), wrap('<string>unclosed'),
    '<methodResponse><fault><value><string>invalid fault</string></value></fault></methodResponse>',
    wrap('<string a="attribute">x</string>'), wrap('<string>x</string>') + '<other/>',
    wrap('<struct><member><name>x</name><value>1</value></member><member><name>x</name><value>2</value></member></struct>'),
  ]) assert.throws(() => rpc.parseResponse(xml), error => error.definitive === false);
  assert.throws(() => rpc.serializeValue('\u0000'), error => error.definitive === true);
  assert.throws(() => rpc.serializeValue(undefined), error => error.definitive === true);
  const protectedValue = rpc.parseResponse(wrap('<struct><member><name>__proto__</name><value><string>safe</string></value></member></struct>'));
  assert.equal(Object.getPrototypeOf(protectedValue), Object.prototype);
  assert.equal(protectedValue.__proto__, 'safe');
});

test('XML-RPC distinguishes business faults, known 4xx, unknown 5xx/network and hides sensitive messages', async () => {
  const endpoint = 'https://rpc.cnblogs.com/metaweblog/mock-blog';
  await rejects(() => rpc.call(endpoint, 'metaWeblog.newPost', [], { request: async () => faultResponse() }), true, 'SECRET');
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
    await rejects(() => rpc.call(endpoint, 'metaWeblog.newPost', [], {
      request: async () => ({ status, body: Buffer.from('<html>mock-token</html>') }),
    }), status < 500, 'mock-token');
  }
  await rejects(() => rpc.call(endpoint, 'metaWeblog.newPost', [], {
    request: async () => { throw new Error('mock-token leaked request URL'); },
  }), false, 'mock-token');
  await rejects(() => rpc.call(endpoint, 'metaWeblog.newPost', [], {
    request: async () => ({ status: 200, body: Buffer.from('not XML') }),
  }), false);
});

test('HTTPS transport preserves safe error codes, timeout and response limit without leaking native errors', async () => {
  const https = require('https');
  const { EventEmitter } = require('events');
  const original = https.request;
  try {
    for (const kind of ['ENOTFOUND', 'ECONNRESET', 'CERT_HAS_EXPIRED', 'untrusted-code', 'timeout', 'limit']) {
      let destroyed = false;
      https.request = (_url, _options, respond) => {
        const req = new EventEmitter();
        req.write = () => {};
        req.destroy = () => { destroyed = true; req.emit('close'); };
        req.end = () => {
          if (kind === 'timeout') return;
          queueMicrotask(() => {
            if (kind === 'limit') {
              const res = new EventEmitter();
              respond(res);
              res.emit('data', Buffer.alloc(10));
              res.emit('aborted');
            } else {
              req.emit('error', Object.assign(new Error('SECRET request body'), { code: kind }));
              req.emit('close');
            }
          });
        };
        return req;
      };
      await assert.rejects(() => httpRequest('https://rpc.cnblogs.com/', { timeoutMs: 5, maxBytes: 1 }), error => {
        assert.equal(error.definitive, false);
        assert.doesNotMatch(error.message, /SECRET|untrusted-code/);
        const expected = kind === 'timeout' ? 'ETIMEDOUT' : kind === 'limit' ? 'M2A_RESPONSE_LIMIT' :
          kind === 'untrusted-code' ? undefined : kind;
        assert.equal(error.code, expected);
        if (expected) assert.ok(error.message.includes(expected));
        return true;
      });
      if (['timeout', 'limit'].includes(kind)) assert.equal(destroyed, true);
    }
  } finally { https.request = original; }
});

test('CNBlogs reports query versus upload failures and never claims an article was submitted during preparation', async () => {
  for (const stage of ['blogger.getUsersBlogs', 'metaWeblog.newMediaObject']) {
    const mock = cnblogsMock(entry => {
      if (entry.method === stage) throw Object.assign(new Error('SECRET mock-token<&'), { code: 'ECONNRESET' });
    });
    const progress = [];
    const ctx = cnblogsCtx({ request: mock.transport, onProgress: message => progress.push(message) });
    await assert.rejects(() => cnblogs.prepare(ctx), error => {
      assert.equal(error.definitive, true, 'no article write occurred');
      assert.equal(error.code, 'ECONNRESET');
      assert.doesNotMatch(error.message, /SECRET|mock-token|提交结果可能未知/);
      assert.match(error.message, stage === 'blogger.getUsersBlogs' ? /查询失败.*本次查询未提交文章/ : /图片上传失败.*尚未提交文章/);
      return true;
    });
    assert.equal(progress[0], '正在验证博客园账号');
    assert(!mock.methods().some(method => /newPost|editPost/.test(method)));
    if (stage === 'metaWeblog.newMediaObject') {
      assert(progress.some(message => /正在上传图片 1\/1.*KB/.test(message)));
      assert.equal(mock.calls.at(-1).options.timeoutMs, 120000);
    } else assert.equal(mock.calls[0].options.timeoutMs, 30000);
  }
});

test('CNBlogs retry reuses successful images after a later upload connection failure', async () => {
  let fail = true;
  let uploads = 0;
  const mock = cnblogsMock(entry => {
    if (entry.method === 'metaWeblog.newMediaObject') {
      uploads++;
      if (uploads === 2 && fail) throw Object.assign(new Error('SECRET'), { code: 'ETIMEDOUT' });
      return rpcResponse({ url: `https://images.cnblogs.com/mock/${uploads}.png` });
    }
  });
  const ctx = cnblogsCtx({ request: mock.transport });
  ctx.article.html = `<img src="${cover}" alt="first"><p>between</p><img src="${dataImage(Buffer.concat([png, Buffer.from('different')]))}" alt="second">`;
  await assert.rejects(() => cnblogs.prepare(ctx), /图片上传失败.*ETIMEDOUT.*尚未提交文章/);
  fail = false;
  const prepared = await cnblogs.prepare(ctx);
  assert.equal(uploads, 3, 'first successful upload is reused');
  const $ = cheerio.load(prepared.html, null, false);
  assert.deepEqual($('img').toArray().map(node => $(node).attr('src')), [
    'https://images.cnblogs.com/mock/1.png', 'https://images.cnblogs.com/mock/3.png',
  ]);
  assert(!mock.methods().some(method => /newPost|editPost/.test(method)));
});

test('WeChat validate is synchronous/pure and enforces current official character and UTF-8 limits', () => {
  const ctx = wechatCtx();
  const before = JSON.stringify(ctx);
  assert.deepEqual(wechat.validate(ctx), { valid: true });
  assert.equal(JSON.stringify(ctx), before);
  ctx.article.title = '中'.repeat(32);
  ctx.options.author = '作'.repeat(16);
  ctx.options.digest = '摘'.repeat(120);
  wechat.validate(ctx);
  for (const change of [
    c => { c.article.title = '中'.repeat(33); },
    c => { c.options.author = '作'.repeat(17); },
    c => { c.options.digest = '摘'.repeat(121); },
    c => { c.article.html = '中'.repeat(20000); },
    c => { c.article.html = '<svg><path/></svg>'; },
    c => { c.article.html = '<img src="data:image/svg+xml;base64,AA==">'; },
    c => { c.article.html = '<img eeimg="1" src="https://www.zhihu.com/equation?tex=x">'; },
    c => { c.options.sourceUrl = 'https://example.com/' + '中'.repeat(340); },
    c => { c.options.sourceUrl = 'https://user:password@example.com/'; },
    c => { c.options.comments = 'true'; },
    c => { c.options.comments = false; },
    c => { c.article.coverPath = ''; },
    c => { c.credentials.appSecret = ''; },
  ]) {
    const invalid = wechatCtx();
    change(invalid);
    assert.throws(() => wechat.validate(invalid), error => error.definitive === true);
  }
  const bytes = wechatCtx();
  bytes.options.sourceUrl = 'https://example.com/' + 'a'.repeat(1024 - 20);
  assert.ok(Buffer.byteLength(bytes.options.sourceUrl) <= 1024);
  wechat.validate(bytes);
});

test('WeChat check reads draft count and does not upload media or create drafts', async () => {
  const mock = wechatMock();
  const ctx = { credentials: wechatCtx().credentials, request: mock.transport };
  assert.deepEqual(await wechat.check(ctx), { appId: 'mock-app', draftAccess: true, draftCount: 3 });
  assert.deepEqual(mock.paths(), ['/cgi-bin/token', '/cgi-bin/draft/count']);
  assert.equal(mock.calls[1].options.method, 'GET');
  assert.equal(mock.calls[1].address.searchParams.get('access_token'), 'MEMORY_ONLY_TOKEN');
  for (const data of [{}, { total_count: -1 }, { total_count: '3' }, { total_count: 1.5 },
    { errcode: 48001, errmsg: 'mock-secret MEMORY_ONLY_TOKEN' }]) {
    const denied = wechatMock(entry => entry.address.pathname === '/cgi-bin/draft/count' ? response(data) : undefined);
    await rejects(() => wechat.check({ ...ctx, request: denied.transport }), true, 'mock-secret');
    assert.deepEqual(denied.paths(), ['/cgi-bin/token', '/cgi-bin/draft/count']);
  }
});

test('WeChat prepare distinguishes inline images and permanent cover, preserving image positions', async () => {
  const mock = wechatMock();
  let saved = 0;
  const progress = [];
  const ctx = wechatCtx({ request: mock.transport, saveCache: async () => { saved++; }, onProgress: message => progress.push(message) });
  const prepared = await wechat.prepare(ctx);
  assert.deepEqual(mock.paths(), ['/cgi-bin/token', '/cgi-bin/media/uploadimg', '/cgi-bin/material/add_material']);
  const upload = mock.calls.find(call => call.address.pathname === '/cgi-bin/media/uploadimg');
  const permanent = mock.calls.find(call => call.address.pathname === '/cgi-bin/material/add_material');
  assert.ok(upload.options.headers['Content-Type'].startsWith('multipart/form-data; boundary='));
  assert.ok(upload.options.body.includes(png));
  assert.ok(upload.options.body.toString().includes('name="media"'));
  assert.equal(permanent.address.searchParams.get('type'), 'image');
  assert.equal(saved, 2);
  assert.ok(progress.length > 0);
  const post = prepared.payload.articles[0];
  assert.equal(post.thumb_media_id, 'permanent-cover');
  assert.equal(post.content_source_url, 'https://example.com/article');
  assert.equal(post.need_open_comment, 1);
  assert.equal(post.only_fans_can_comment, 1);
  const $ = cheerio.load(prepared.html, null, false);
  assert.deepEqual($.root().children().toArray().map(el => el.name), ['p', 'img', 'p', 'img', 'p']);
  assert.deepEqual($('img').toArray().map(el => $(el).attr('src')), [
    'https://mmbiz.qpic.cn/mock/body.png', 'https://mmbiz.qpic.cn/mock/body.png',
  ]);
  assert.deepEqual($('img').toArray().map(el => $(el).attr('alt')), ['第一张', '第二张']);
  assert.ok(!JSON.stringify(prepared).includes('MEMORY_ONLY_TOKEN'));
  assert.ok(!JSON.stringify(ctx.mediaCache).includes('MEMORY_ONLY_TOKEN'));
  await wechat.prepare(ctx);
  assert.equal(mock.calls.length, 3, 'media cache should prevent repeated uploads');
  ctx.prepared = JSON.parse(JSON.stringify(prepared));
  const result = await wechat.execute(ctx);
  assert.deepEqual(result, { state: 'draft', id: 'created-draft', url: 'https://mp.weixin.qq.com/' });
  assert.equal(mock.paths().filter(path => path === '/cgi-bin/draft/add').length, 1);
  assert.ok(!mock.paths().some(path => path.includes('freepublish')));
});

test('WeChat rejects unsupported inline GIF and WebP and enforces different image size limits', async () => {
  const gif = `data:image/gif;base64,${Buffer.from('GIF89a12345678').toString('base64')}`;
  const webp = `data:image/webp;base64,${Buffer.from('RIFF1234WEBPdata').toString('base64')}`;
  for (const src of [gif, webp, dataImage(Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length)]))]) {
    const mock = wechatMock();
    const ctx = wechatCtx({ request: mock.transport });
    ctx.article.html = `<img src="${src}">`;
    await assert.rejects(() => wechat.prepare(ctx), error => error.definitive === true);
    assert.equal(mock.calls.length, 0);
  }
  const mock = wechatMock();
  const ctx = wechatCtx({ request: mock.transport });
  ctx.article.coverPath = dataImage(Buffer.concat([png, Buffer.alloc(1024 * 1024)]));
  await wechat.prepare(ctx); // 封面超过正文图上限，但仍在永久图片素材 10MB 上限内。
  const invalid = wechatCtx({ request: wechatMock().transport });
  invalid.article.coverPath = dataImage(Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]));
  await assert.rejects(() => wechat.prepare(invalid), error => error.definitive === true);
});

test('WeChat measures final HTML after replacing large inline base64 image data', async () => {
  const mock = wechatMock();
  const ctx = wechatCtx({ request: mock.transport });
  ctx.article.html = `<p>正文</p><img src="${dataImage(Buffer.concat([png, Buffer.alloc(900000)]))}">`;
  wechat.validate(ctx);
  const prepared = await wechat.prepare(ctx);
  assert.ok(prepared.html.length < 20000);
  assert.ok(prepared.html.includes('https://mmbiz.qpic.cn/mock/body.png'));
  assert.ok(!prepared.html.includes('base64'));
  const longUrl = wechatMock(entry => entry.address.pathname === '/cgi-bin/media/uploadimg' ?
    response({ url: 'https://mmbiz.qpic.cn/' + 'a'.repeat(20000) }) : undefined);
  await rejects(() => wechat.prepare(wechatCtx({ request: longUrl.transport })), true);
  assert.ok(!longUrl.paths().includes('/cgi-bin/draft/add'));
});

test('WeChat refreshes expired/invalidate tokens across prepare and execute without persisting credentials', async () => {
  let tokenCount = 0;
  let addCount = 0;
  const mock = wechatMock(entry => {
    if (entry.address.pathname === '/cgi-bin/token') return response({ access_token: `token-${++tokenCount}`, expires_in: 7200 });
    if (entry.address.pathname === '/cgi-bin/draft/add' && ++addCount === 1) {
      return response({ errcode: 42001, errmsg: 'token-2 mock-secret SECRET' });
    }
  });
  const ctx = wechatCtx({ request: mock.transport });
  ctx.prepared = await wechat.prepare(ctx);
  const now = Date.now;
  try {
    const future = now() + 7200 * 1000;
    Date.now = () => future;
    assert.equal((await wechat.execute(ctx)).id, 'created-draft');
  } finally { Date.now = now; }
  assert.equal(tokenCount, 3);
  assert.equal(addCount, 2);
  const additions = mock.calls.filter(call => call.address.pathname === '/cgi-bin/draft/add');
  assert.deepEqual(additions.map(call => call.address.searchParams.get('access_token')), ['token-2', 'token-3']);
  assert.ok(!JSON.stringify(ctx.prepared).includes('token-'));
});

test('WeChat separates business failure from uncertain write and retains ID if readback fails or mismatches', async () => {
  for (const kind of ['business', '4xx', '5xx', 'network', 'missing-id', 'readback', 'mismatch']) {
    let additions = 0;
    const mock = wechatMock(entry => {
      if (entry.address.pathname === '/cgi-bin/draft/add') {
        additions++;
        if (kind === 'business') return response({ errcode: 48001, errmsg: 'SECRET mock-secret MEMORY_ONLY_TOKEN' });
        if (kind === '4xx') return { status: 403, body: Buffer.from('SECRET not json') };
        if (kind === '5xx') return response({ errcode: 500 }, 500);
        if (kind === 'network') throw new Error('SECRET MEMORY_ONLY_TOKEN');
        if (kind === 'missing-id') return response({});
      }
      if (entry.address.pathname === '/cgi-bin/draft/get') {
        if (kind === 'readback') throw new Error('SECRET');
        if (kind === 'mismatch') return response({ news_item: [{ title: '不一致' }] });
      }
    });
    const ctx = wechatCtx({ request: mock.transport });
    ctx.prepared = await wechat.prepare(ctx);
    if (['readback', 'mismatch'].includes(kind)) {
      const result = await wechat.execute(ctx);
      assert.equal(result.id, 'created-draft');
      assert.equal(result.state, 'draft');
      assert.ok(result.warnings.length > 0);
      assert.ok(!JSON.stringify(result).includes('SECRET'));
    } else await rejects(() => wechat.execute(ctx), ['business', '4xx'].includes(kind), 'SECRET');
    assert.equal(additions, 1, 'uncertain writes must never be replayed');
  }
});

test('CNBlogs validates options synchronously and checks the real BlogInfo without guessing blogId', async () => {
  const ctx = cnblogsCtx();
  const before = JSON.stringify(ctx);
  assert.deepEqual(cnblogs.validate(ctx), { valid: true });
  assert.equal(JSON.stringify(ctx), before);
  for (const options of [{ categories: 'a' }, { tags: ['a,b'] }, { categories: ['[Markdown]'] },
    { mode: 'auto' }, { postId: '' }, { comments: 1 }, { coverAsFirstImage: 'true' }]) {
    assert.throws(() => cnblogs.validate(cnblogsCtx({ options })), error => error.definitive === true);
  }
  assert.throws(() => cnblogs.validate(cnblogsCtx({ credentials: { ...ctx.credentials, blogName: '../another?secret' } })));
  const mock = cnblogsMock();
  const account = await cnblogs.check({ credentials: ctx.credentials, request: mock.transport });
  assert.equal(account.blogId, '987');
  assert.deepEqual(mock.methods(), ['blogger.getUsersBlogs']);
  assert.deepEqual(mock.calls[0].params, ['', 'mock-user', 'mock-token<&']);
  const wrong = cnblogsMock(entry => entry.method === 'blogger.getUsersBlogs' ?
    rpcResponse([{ blogid: '987', blogName: 'mock-blog', url: 'https://www.cnblogs.com/someone-else/' }]) : undefined);
  await rejects(() => cnblogs.check({ ...ctx, request: wrong.transport }), true);
});

test('CNBlogs prepares FileData/HTML with categories/tags/comments and uploads all images before writing', async () => {
  const mock = cnblogsMock();
  const ctx = cnblogsCtx({ request: mock.transport });
  ctx.prepared = await cnblogs.prepare(ctx);
  assert.deepEqual(mock.methods(), ['blogger.getUsersBlogs', 'metaWeblog.newMediaObject']);
  const upload = mock.calls[1];
  assert.equal(upload.params[0], '987');
  assert.deepEqual(upload.params[3].bits, png);
  assert.equal(upload.params[3].type, 'image/png');
  assert.ok(upload.params[3].name.endsWith('.png'));
  const { post } = ctx.prepared.payload;
  assert.deepEqual(post.categories, ctx.options.categories);
  assert.equal(post.mt_keywords, 'Node.js,中文标签');
  assert.equal(post.mt_allow_comments, 0);
  assert.equal(post.title, ctx.article.title);
  assert.ok(post.dateCreated instanceof Date);
  assert.ok(!Object.hasOwn(post, 'thumb_media_id'));
  assert.ok(!JSON.stringify(ctx.prepared).includes(ctx.credentials.token));
  const $ = cheerio.load(post.description, null, false);
  assert.deepEqual($.root().children().toArray().map(el => el.name), ['p', 'img', 'p', 'img', 'p']);
  assert.deepEqual($('img').toArray().map(el => $(el).attr('src')), [
    'https://images.cnblogs.com/mock/body.png', 'https://images.cnblogs.com/mock/body.png',
  ]);
  ctx.prepared = JSON.parse(JSON.stringify(ctx.prepared));
  const result = await cnblogs.execute(ctx);
  assert.equal(result.state, 'draft');
  assert.equal(result.id, '12345');
  assert.equal(result.url, 'https://i.cnblogs.com/posts');
  const creation = mock.calls.find(call => call.method === 'metaWeblog.newPost');
  assert.equal(creation.params[0], '987');
  assert.equal(creation.params[4], false);
  assert.ok(creation.params[3].dateCreated instanceof Date);
  assert.ok(creation.options.body.toString().includes('&lt;XML&gt;'));
  assert.ok(creation.options.body.toString().includes('mock-token&lt;&amp;'));
  assert.equal(mock.methods().at(-1), 'metaWeblog.getPost');
});

test('CNBlogs defaults to omitting cover with a warning and explicitly prepends cover when opted in', async () => {
  for (const enabled of [false, true]) {
    const mock = cnblogsMock();
    const ctx = cnblogsCtx({ request: mock.transport });
    // 与正文图内容不同，以验证封面确实作为正文图上传。
    ctx.article.coverPath = dataImage(Buffer.concat([png, Buffer.from('cover')]));
    ctx.options.coverAsFirstImage = enabled;
    const prepared = await cnblogs.prepare(ctx);
    const $ = cheerio.load(prepared.html, null, false);
    assert.equal($('img').length, enabled ? 3 : 2);
    assert.equal(prepared.warnings.length, enabled ? 0 : 1);
    assert.equal(mock.methods().filter(method => method === 'metaWeblog.newMediaObject').length, enabled ? 2 : 1);
    if (enabled) assert.equal($.root().children().first().find('img').length, 1);
    assert.ok(!Object.keys(prepared.payload.post).some(key => /cover|thumb/i.test(key)));
  }
});

test('CNBlogs supports explicit publish and editPost and requires getPost readback', async () => {
  for (const edit of [false, true]) {
    const mock = cnblogsMock();
    const ctx = cnblogsCtx({ request: mock.transport });
    ctx.options.mode = 'publish';
    if (edit) ctx.options.postId = '12345';
    ctx.prepared = await cnblogs.prepare(ctx);
    const result = await cnblogs.execute(ctx);
    assert.deepEqual(result, { state: 'published', id: '12345', url: 'https://www.cnblogs.com/mock-blog/p/12345.html' });
    assert.equal(mock.methods().at(-2), edit ? 'metaWeblog.editPost' : 'metaWeblog.newPost');
    assert.equal(mock.calls.at(-2).params[4], true);
    assert.equal(mock.calls.at(-2).params[0], edit ? '12345' : '987');
    assert.equal(mock.methods().at(-1), 'metaWeblog.getPost');
  }
});

test('CNBlogs upload failure prevents article creation and edit false is a known rejection', async () => {
  const uploadFailure = cnblogsMock(entry => entry.method === 'metaWeblog.newMediaObject' ? faultResponse(401) : undefined);
  await rejects(() => cnblogs.prepare(cnblogsCtx({ request: uploadFailure.transport })), true, 'SECRET');
  assert.ok(!uploadFailure.methods().includes('metaWeblog.newPost'));
  const mock = cnblogsMock(entry => entry.method === 'metaWeblog.editPost' ? rpcResponse(false) : undefined);
  const ctx = cnblogsCtx({ request: mock.transport });
  ctx.options.postId = '12345';
  ctx.prepared = await cnblogs.prepare(ctx);
  await rejects(() => cnblogs.execute(ctx), true);
  assert.ok(!mock.methods().includes('metaWeblog.getPost'));
});

test('CNBlogs distinguishes write faults/uncertainty and retains successful IDs on readback failure/mismatch', async () => {
  for (const kind of ['fault', '4xx', '5xx', 'network', 'malformed', 'missing-id', 'readback', 'mismatch']) {
    let writes = 0;
    const mock = cnblogsMock(entry => {
      if (entry.method === 'metaWeblog.newPost') {
        writes++;
        if (kind === 'fault') return faultResponse();
        if (kind === '4xx') return { status: 403, body: Buffer.from('SECRET') };
        if (kind === '5xx') return { status: 503, body: Buffer.from('SECRET') };
        if (kind === 'network') throw new Error('SECRET mock-token<&');
        if (kind === 'malformed') return { status: 200, body: Buffer.from('SECRET invalid xml') };
        if (kind === 'missing-id') return rpcResponse('');
      }
      if (entry.method === 'metaWeblog.getPost') {
        if (kind === 'readback') return faultResponse();
        if (kind === 'mismatch') return rpcResponse({ title: '不一致', description: '' });
      }
    });
    const ctx = cnblogsCtx({ request: mock.transport });
    ctx.prepared = await cnblogs.prepare(ctx);
    if (['readback', 'mismatch'].includes(kind)) {
      const result = await cnblogs.execute(ctx);
      assert.equal(result.id, '12345');
      assert.ok(result.warnings.length > 0);
      assert.ok(!JSON.stringify(result).includes('SECRET'));
    } else await rejects(() => cnblogs.execute(ctx), ['fault', '4xx'].includes(kind), 'SECRET');
    assert.equal(writes, 1);
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} publishing platform tests passed`);
  process.exitCode = failed ? 1 : 0;
})();
