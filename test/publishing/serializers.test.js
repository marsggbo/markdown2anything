'use strict';
const assert = require('assert');
const { serializeWechat } = require('../../lib/publishing/serializers/wechat');
const { serializeZhihuBrowser } = require('../../lib/publishing/serializers/zhihu-browser');
const { serializeCnblogs } = require('../../lib/publishing/serializers/cnblogs');
const article = { body: { segments: [{ kind: 'text', value: 'Before\n\n' }, { kind: 'asset', assetId: 'asset-0000' }, { kind: 'text', value: '\n\nAfter' }] } };
const assets = [{ assetId: 'asset-0000', role: 'body', alt: 'A', caption: 'Caption' }];
const result = { 'asset-0000': { state: 'uploaded', confirmedUrl: 'https://pic.zhimg.com/a.png' } };
assert.ok(serializeWechat(article, assets, result).includes('Caption'));
assert.ok(serializeZhihuBrowser(article, assets, result).includes('pic.zhimg.com'));
assert.ok(serializeCnblogs(article, assets, result, 'job-serializer-0001').includes('m2a-publish-job:job-serializer-0001'));
assert.throws(() => serializeWechat(article, assets, {}), /ASSET_NOT_CONFIRMED/);
const unsafeLink = { body: { segments: [{ kind: 'text', value: '[unsafe](javascript:alert(1))' }] } };
for (const serialize of [serializeWechat, serializeZhihuBrowser, (value, input, results) => serializeCnblogs(value, input, results, 'job-serializer-0001')]) {
  assert.throws(() => serialize(unsafeLink, [], {}), /UNSAFE_RAW_HTML/);
}
console.log('✓ publishing serializers');
