'use strict';
const assert = require('assert');
const { createPublishJob, calculateContentHash, aggregateJob, assertPersistable } = require('../../lib/publishing/model');
function jobInput() { return { jobId: 'job-model-0001', source: { documentPath: '/tmp/article.md', documentSha256: 'a'.repeat(64) }, selectedTargets: ['zhihu', 'wechat'], requestedMode: 'prepare', article: { title: '标题', titleSource: 'h1', body: { plainText: 'before after', segments: [{ kind: 'text', value: 'before' }, { kind: 'asset', assetId: 'asset-0000' }, { kind: 'text', value: 'after' }] } }, assets: [{ source: { kind: 'data', sha256: 'b'.repeat(64), mime: 'image/png' }, contentSha256: 'c'.repeat(64), mime: 'image/png' }] }; }
const job = createPublishJob(jobInput());
assert.strictEqual(job.assets[0].assetId, 'asset-0000');
assert.throws(() => createPublishJob({ ...jobInput(), article: { title: ' ', body: { segments: [] } } }), /MISSING_TITLE/);
const duplicate = createPublishJob({ ...jobInput(), jobId: 'job-model-0002', article: { ...jobInput().article, body: { plainText: '', segments: [{ kind: 'asset', assetId: 'asset-0000' }, { kind: 'asset', assetId: 'asset-0001' }] } }, assets: [jobInput().assets[0], { source: { kind: 'data', sha256: 'b'.repeat(64), mime: 'image/png' }, contentSha256: 'c'.repeat(64), mime: 'image/png' }] });
assert.notStrictEqual(duplicate.assets[0].assetId, duplicate.assets[1].assetId);
const hash = calculateContentHash(job); job.updatedAt = '2099-01-01T00:00:00.000Z'; assert.strictEqual(hash, calculateContentHash(job));
job.targets.zhihu.state = 'readyForReview'; job.targets.wechat.state = 'failed'; assert.deepStrictEqual(aggregateJob(job), { state: 'partial', summary: 'partialRetryable' });
assert.throws(() => assertPersistable({ token: 'secret' }), /SECRET_PERSISTENCE_FORBIDDEN/);
const unsafeReference = createPublishJob({
  ...jobInput(), jobId: 'job-model-unsafe-001',
  targets: { zhihu: { assetResults: { 'asset-0000': { state: 'uploaded', providerRef: 'https://cdn.example/image.png?signature=secret-value', confirmedUrl: 'https://cdn.example/image.png?signature=secret-value' } } } },
});
const unsafeResult = unsafeReference.targets.zhihu.assetResults['asset-0000'];
assert.strictEqual(unsafeResult.providerRef, null);
assert.strictEqual(unsafeResult.confirmedUrl, null);
assert.ok(!JSON.stringify(unsafeReference).includes('secret-value'));
console.log('✓ publishing model');
