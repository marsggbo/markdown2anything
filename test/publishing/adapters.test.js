'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPublishJob } = require('../../lib/publishing/model');
const { loadBundledProfiles } = require('../../lib/publishing/profiles');
const { WechatOfficialAdapter } = require('../../lib/publishing/adapters/wechat-official');
const { ZhihuOfficialAdapter, buildZhihuOfficialArticleRequest } = require('../../lib/publishing/adapters/zhihu-official');
const { CnblogsMetaweblogAdapter } = require('../../lib/publishing/adapters/cnblogs-metaweblog');

const profiles = Object.fromEntries(loadBundledProfiles().map(item => [item.profile.providerPath, item.profile]));
function png() { return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'); }
function jobFor(target, cachePath) {
  return createPublishJob({
    jobId: `job-adapter-${target}-001`, source: { documentPath: '/tmp/article.md', documentSha256: 'a'.repeat(64) },
    selectedTargets: [target], article: { title: 'Title', coverAssetId: 'cover-0000', body: { segments: [{ kind: 'text', value: 'Before' }, { kind: 'asset', assetId: 'asset-0000' }] } },
    assets: [
      { assetId: 'asset-0000', source: { kind: 'local', path: cachePath }, acquisition: 'acquired', cachePath, mime: 'image/png', byteLength: 1, contentSha256: 'b'.repeat(64) },
      { assetId: 'cover-0000', role: 'cover', source: { kind: 'local', path: cachePath }, acquisition: 'acquired', cachePath, mime: 'image/png', byteLength: 1, contentSha256: 'c'.repeat(64) },
    ],
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-adapter-'));
  try {
    const image = path.join(root, 'image.png'); fs.writeFileSync(image, png());
    const calls = [];
    const wechat = new WechatOfficialAdapter(profiles['wechat-official'], { transport: async request => {
      calls.push(request);
      if (request.url.includes('/cgi-bin/token')) return { status: 200, body: Buffer.from('{"access_token":"token"}') };
      if (request.url.includes('uploadimg')) return { status: 200, body: Buffer.from('{"url":"https://mmbiz.qpic.cn/inline.png"}') };
      if (request.url.includes('add_material')) return { status: 200, body: Buffer.from('{"media_id":"cover-media"}') };
      if (request.url.includes('/draft/add')) return { status: 200, body: Buffer.from('{"media_id":"draft-media"}') };
      throw new Error('unexpected request');
    } });
    const job = jobFor('wechat', image);
    const missing = await wechat.preflight({ job, config: { wechat: { appId: 'id' } }, credentials: {} });
    assert.strictEqual(missing.error.code, 'MISSING_CREDENTIAL'); assert.strictEqual(calls.length, 0);
    const missingCover = await wechat.preflight({ job: { ...job, article: { ...job.article, coverAssetId: null } }, config: { wechat: { appId: 'id' } }, credentials: { appSecret: 'secret' } });
    assert.strictEqual(missingCover.error.code, 'WECHAT_COVER_REQUIRED'); assert.strictEqual(calls.length, 0);
    const prepared = await wechat.prepare({ job, config: { wechat: { appId: 'id' } }, credentials: { appSecret: 'secret' }, options: { comments: { enabled: true } } });
    assert.strictEqual(prepared.state, 'readyForReview'); assert.strictEqual(prepared.draftId, 'draft-media');
    assert.deepStrictEqual(calls.map(call => new URL(call.url).pathname), ['/cgi-bin/token', '/cgi-bin/media/uploadimg', '/cgi-bin/material/add_material', '/cgi-bin/draft/add']);
    assert.ok(calls.every(call => !call.url.includes('fastpen.online')));

    for (const [field, value, code] of [
      ['title', 'x'.repeat(33), 'WECHAT_TITLE_TOO_LONG'],
      ['author', 'x'.repeat(17), 'WECHAT_AUTHOR_TOO_LONG'],
      ['digest', 'x'.repeat(121), 'WECHAT_DIGEST_TOO_LONG'],
    ]) {
      const limitedJob = jobFor('wechat', image);
      limitedJob.article[field] = value;
      const limitCalls = [];
      const limited = new WechatOfficialAdapter(profiles['wechat-official'], { transport: request => { limitCalls.push(request); throw new Error('transport must not run'); } });
      await assert.rejects(limited.prepare({ job: limitedJob, config: { wechat: { appId: 'id' } }, credentials: { appSecret: 'secret' } }), error => error.code === code);
      assert.strictEqual(limitCalls.length, 0, `${field} limit reached the provider`);
    }
    const htmlLimitProfile = JSON.parse(JSON.stringify(profiles['wechat-official']));
    htmlLimitProfile.limits.maxHtmlBytes = 1;
    const htmlLimitCalls = [];
    const htmlLimited = new WechatOfficialAdapter(htmlLimitProfile, { transport: request => { htmlLimitCalls.push(request); throw new Error('transport must not run'); } });
    await assert.rejects(htmlLimited.prepare({ job: jobFor('wechat', image), config: { wechat: { appId: 'id' } }, credentials: { appSecret: 'secret' } }), error => error.code === 'WECHAT_HTML_TOO_LARGE');
    assert.strictEqual(htmlLimitCalls.length, 0, 'rendered HTML limit reached the provider');
    const unsupportedOptionCalls = [];
    const unsupportedOption = new WechatOfficialAdapter(profiles['wechat-official'], { transport: request => { unsupportedOptionCalls.push(request); throw new Error('transport must not run'); } });
    await assert.rejects(unsupportedOption.prepare({ job: jobFor('wechat', image), config: { wechat: { appId: 'id' } }, credentials: { appSecret: 'secret' }, options: { original: { kind: 'original' } } }), error => error.code === 'UNSUPPORTED_TARGET_OPTION');
    assert.strictEqual(unsupportedOptionCalls.length, 0, 'unsupported WeChat option reached the provider');
    const unsafeReferenceCalls = [];
    const unsafeReference = new WechatOfficialAdapter(profiles['wechat-official'], { transport: async request => {
      unsafeReferenceCalls.push(request);
      if (request.url.includes('/cgi-bin/token')) return { status: 200, body: Buffer.from('{"access_token":"token"}') };
      if (request.url.includes('uploadimg')) return { status: 200, body: Buffer.from('{"url":"https://mmbiz.qpic.cn/inline.png?signature=secret"}') };
      throw new Error('unexpected request');
    } });
    await assert.rejects(unsafeReference.prepare({ job: jobFor('wechat', image), config: { wechat: { appId: 'id' } }, credentials: { appSecret: 'secret' } }), error => error.code === 'INVALID_PROVIDER_RESPONSE');
    assert.strictEqual(unsafeReferenceCalls.length, 2, 'unsafe provider response was used after validation');

    const officialRequest = buildZhihuOfficialArticleRequest({ title: 'Title' }, '<p>Body</p>', {
      commentPermission: 'nobody', topics: ['https://www.zhihu.com/topic/19555547/hot'], tableOfContents: true, creationDeclaration: 'ai_creation',
    });
    assert.deepStrictEqual(officialRequest.content, {
      title: 'Title', html: '<p>Body</p>', comment_permission: 'nobody', table_of_contents_enabled: true,
      topics: [{ topic_id: '', topic_token: '19555547', topic_name: '' }], creation_statement: 'ai_creation',
    });
    assert.throws(() => buildZhihuOfficialArticleRequest({ title: 'Title' }, '<p>Body</p>', { creationDeclaration: 'original' }), error => error.code === 'UNSUPPORTED_TARGET_OPTION');

    let officialCalls = 0;
    const official = new ZhihuOfficialAdapter(profiles['zhihu-official'], { transport: () => { officialCalls++; } });
    assert.strictEqual((await official.prepare({ credentials: { appKey: 'key', appSecret: 'secret' } })).error.code, 'NO_REVIEWABLE_PREPARE_PATH');
    assert.strictEqual(officialCalls, 0, 'official direct-publish route is unavailable in prepare mode');

    let missingOfficialCalls = 0;
    const missingOfficial = new ZhihuOfficialAdapter(null, { transport: () => { missingOfficialCalls++; } });
    assert.strictEqual((await missingOfficial.prepare()).error.code, 'OFFICIAL_ARTICLE_PROFILE_MISSING'); assert.strictEqual(missingOfficialCalls, 0);

    const unavailableCalls = [];
    const cnblogsUnavailable = new CnblogsMetaweblogAdapter(profiles['cnblogs-metaweblog'], { callXmlRpc: async value => { unavailableCalls.push(value); } });
    assert.strictEqual((await cnblogsUnavailable.prepare({ job: jobFor('cnblogs', image), account: { blogId: '1', blogSlug: 'blog' }, credentials: { username: 'u', token: 't' } })).error.code, 'NO_REVIEWABLE_PREPARE_PATH');
    assert.strictEqual(unavailableCalls.length, 0);

    const profile = JSON.parse(JSON.stringify(profiles['cnblogs-metaweblog'])); profile.reviewablePrepareProof = { route: 'getRecentPosts', postIdField: 'postid', reviewUrlField: 'permaLink' };
    const rpcCalls = [];
    const cnblogs = new CnblogsMetaweblogAdapter(profile, { callXmlRpc: async value => {
      rpcCalls.push(value);
      if (value.method === 'metaWeblog.newMediaObject') return { url: 'https://images.cnblogs.com/a.png' };
      if (value.method === 'metaWeblog.newPost') return 'post-1';
      if (value.method === 'metaWeblog.getRecentPosts') return [{ postid: 'post-1', permaLink: 'https://www.cnblogs.com/blog/p/1.html' }];
      throw new Error('unexpected method');
    } });
    const cnblogsPrepared = await cnblogs.prepare({ job: jobFor('cnblogs', image), account: { blogId: '1', blogSlug: 'blog' }, credentials: { username: 'u', token: 't' }, options: { tags: ['tag'] } });
    assert.strictEqual(cnblogsPrepared.state, 'readyForReview');
    assert.deepStrictEqual(rpcCalls.map(call => call.method), ['metaWeblog.newMediaObject', 'metaWeblog.newPost', 'metaWeblog.getRecentPosts']);
    assert.strictEqual(rpcCalls[1].args[4], false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('✓ publishing adapters');
})().catch(error => { console.error(error); process.exit(1); });
