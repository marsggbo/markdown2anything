'use strict';
const assert = require('assert');
const { createPublishJob } = require('../../lib/publishing/model');
const { loadBundledProfiles } = require('../../lib/publishing/profiles');
const { ZhihuBrowserAdapter, expectedBody } = require('../../lib/publishing/adapters/zhihu-browser');
const profile = loadBundledProfiles().find(item => item.profile.providerPath === 'zhihu-browser').profile;
const cookies = JSON.stringify([{ name: 'z_c0', value: 'valid-cookie', domain: '.zhihu.com', path: '/', expires: -1 }]);
function job() {
  const assets = [0, 1, 2].map(index => ({ assetId: `asset-${String(index).padStart(4, '0')}`, source: { kind: 'local', path: `/tmp/${index}.png` }, acquisition: 'acquired', cachePath: `/tmp/${index}.png`, mime: 'image/png', byteLength: 1, contentSha256: String(index + 1).repeat(64) }));
  return createPublishJob({ jobId: 'job-zhihu-browser-001', source: { documentPath: '/tmp/article.md', documentSha256: 'a'.repeat(64) }, selectedTargets: ['zhihu'], article: { title: 'Exact title', body: { plainText: 'Before middle after', segments: [{ kind: 'text', value: 'Before ' }, { kind: 'asset', assetId: 'asset-0000' }, { kind: 'text', value: ' middle ' }, { kind: 'asset', assetId: 'asset-0001' }, { kind: 'text', value: ' after ' }, { kind: 'asset', assetId: 'asset-0002' }] } }, assets });
}
(async () => {
  const requests = [];
  const failedMiddle = new ZhihuBrowserAdapter(profile, { browserClient: { prepare: async request => {
    requests.push(request);
    return { ready: false, assetResults: {
      'asset-0000': { state: 'uploaded', confirmedUrl: 'https://pic.zhimg.com/one.png' },
      'asset-0001': { state: 'failed', error: { code: 'ASSET_UPLOAD_FAILED' } },
      'asset-0002': { state: 'uploaded', confirmedUrl: 'https://pic.zhimg.com/three.png' },
    } };
  } } });
  const first = await failedMiddle.prepare({ job: job(), credentials: { browserCookies: cookies } });
  assert.strictEqual(first.state, 'failed');
  assert.strictEqual(first.assetResults['asset-0001'].state, 'failed');
  assert.strictEqual(first.assetResults['asset-0002'].confirmedUrl, 'https://pic.zhimg.com/three.png');
  assert.deepStrictEqual(requests[0].payload.groups.map(group => group.assetIds), [['asset-0000'], ['asset-0001'], ['asset-0002']]);
  assert.strictEqual(first.state === 'readyForReview', false);

  const readyJob = job();
  const urls = ['https://pic.zhimg.com/one.png', 'https://pic.zhimg.com/two.png', 'https://pic.zhimg.com/three.png'];
  const ready = new ZhihuBrowserAdapter(profile, { browserClient: { prepare: async () => {
    const results = Object.fromEntries(urls.map((url, index) => [`asset-${String(index).padStart(4, '0')}`, { state: 'uploaded', confirmedUrl: url }]));
    return { ready: true, assetResults: results, verification: { title: 'Exact title', body: expectedBody(readyJob.article, readyJob.assets, results), imageUrls: urls, pasteComplete: true, uploadError: false } };
  } } });
  assert.strictEqual((await ready.prepare({ job: readyJob, credentials: { browserCookies: cookies } })).state, 'readyForReview');
  console.log('✓ publishing Zhihu browser');
})().catch(error => { console.error(error); process.exit(1); });
