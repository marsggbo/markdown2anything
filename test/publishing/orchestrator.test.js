'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JobStore } = require('../../lib/publishing/job-store');
const { PublishingOrchestrator } = require('../../lib/publishing/orchestrator');

function adapter(target, state) {
  return {
    profile: { id: `${target}-profile`, version: '1', providerPath: `${target}-fake`, evidence: { id: `${target}-evidence` } },
    binding: async context => `${target}:${state.revision}:${JSON.stringify(context.settings || {})}`,
    preflight: async context => state.available === false ? { state: 'unavailable', error: { code: 'MISSING_CREDENTIAL' }, capability: { availability: 'unavailable', reason: 'MISSING_CREDENTIAL' }, binding: `${target}:${state.revision}:${JSON.stringify(context.settings || {})}` } : { state: 'available', capability: { availability: 'available', autoSupported: !!state.autoSupported }, binding: `${target}:${state.revision}:${JSON.stringify(context.settings || {})}` },
    prepare: async () => { state.prepares++; return { state: 'readyForReview', assetResults: {} }; },
    promote: state.autoSupported ? async () => { state.promotes++; return { state: 'published', assetResults: {} }; } : undefined,
    lookup: async () => { state.lookups = (state.lookups || 0) + 1; return { state: 'readyForReview', assetResults: {} }; },
  };
}
function input(targets) { return { source: { documentPath: '/tmp/article.md', documentSha256: 'a'.repeat(64) }, article: { title: 'Title', body: { segments: [] } }, assets: [], targets, targetContexts: Object.fromEntries(targets.map(target => [target, {}])), options: Object.fromEntries(targets.map(target => [target, {}])) }; }
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-orchestrator-'));
  try {
    const states = { wechat: { revision: 'one', prepares: 0 }, zhihu: { revision: 'one', prepares: 0, available: false }, cnblogs: { revision: 'one', prepares: 0, autoSupported: true, promotes: 0 } };
    const jobStore = new JobStore(root);
    const orchestrator = new PublishingOrchestrator({ jobStore, adapters: { wechat: adapter('wechat', states.wechat), zhihu: adapter('zhihu', states.zhihu), cnblogs: adapter('cnblogs', states.cnblogs) } });
    const inspected = await orchestrator.inspect(input(['wechat', 'zhihu']));
    assert.strictEqual(inspected.capabilities.zhihu.reason, 'MISSING_CREDENTIAL');
    const prepared = await orchestrator.prepare(inspected.job.jobId, { targets: ['wechat'] });
    assert.strictEqual(prepared.targets.wechat.state, 'readyForReview');
    assert.strictEqual(states.wechat.prepares, 1);
    assert.strictEqual(states.zhihu.prepares, 0);
    states.wechat.revision = 'two';
    await assert.rejects(orchestrator.retry(inspected.job.jobId, { targets: ['wechat'] }), error => error.code === 'RETRY_ACCOUNT_CHANGED');
    const finalized = await orchestrator.finalizePartial(inspected.job.jobId, ['zhihu']);
    assert.deepStrictEqual(finalized.aggregate, { state: 'partial', summary: 'finalizedPartial' });
    await assert.rejects(orchestrator.retry(inspected.job.jobId, { targets: ['wechat'] }), error => error.code === 'INVALID_STATE_TRANSITION');

    const automatic = await orchestrator.inspect({ ...input(['cnblogs']), mode: 'auto' });
    await orchestrator.prepare(automatic.job.jobId, { targets: ['cnblogs'] });
    assert.strictEqual(states.cnblogs.promotes, 0);
    await assert.rejects(orchestrator.confirmAuto(automatic.job.jobId, automatic.preflightBinding), error => error.code === 'INVALID_PUBLISH_REQUEST');
    await orchestrator.confirmAuto(automatic.job.jobId, automatic.preflightBinding, { autoAcknowledged: true });
    assert.strictEqual(states.cnblogs.promotes, 1);

    const duplicate = await orchestrator.createDuplicate(automatic.job.jobId, input(['cnblogs']));
    assert.notStrictEqual(duplicate.job.jobId, automatic.job.jobId);
    assert.ok(duplicate.job.duplicateNonce);
    assert.strictEqual(duplicate.job.targets.cnblogs.draftId, null);
    assert.deepStrictEqual(duplicate.job.assets, []);

    const ambiguous = await orchestrator.inspect(input(['wechat']));
    jobStore.intent(ambiguous.job.jobId, 'wechat', 'createDraft');
    jobStore.recover();
    const recovered = await orchestrator.cancel(ambiguous.job.jobId);
    assert.strictEqual(states.wechat.lookups, 1);
    assert.notStrictEqual(recovered.job.status, 'cancelled', 'cancellation after an ambiguous intent only looks up the provider outcome');

    const disposableInput = input(['wechat']);
    disposableInput.source = { documentPath: '/tmp/disposable.md', documentSha256: 'c'.repeat(64) };
    const disposable = await orchestrator.inspect(disposableInput);
    const discarded = await orchestrator.discard(disposable.job.jobId);
    assert.strictEqual(discarded.job.status, 'discarded');

    const failingState = { revision: 'one', prepares: 0 };
    const failing = new PublishingOrchestrator({ jobStore: new JobStore(path.join(root, 'fail')), adapters: { wechat: adapter('wechat', failingState) }, acquireAssets: async assets => assets.map(asset => ({ ...asset, acquisition: 'failed', error: { code: 'MISSING_LOCAL_FILE' } })) });
    const assetInput = { ...input(['wechat']), assets: [{ source: { kind: 'local', path: '/missing.png' } }], article: { title: 'Title', body: { segments: [{ kind: 'asset', assetId: 'asset-0000' }] } }, sourceInputs: { 'asset-0000': '/missing.png' } };
    const failed = await failing.inspect(assetInput);
    const outcome = await failing.prepare(failed.job.jobId, { targets: ['wechat'] });
    assert.strictEqual(outcome.targets.wechat.state, 'failed');
    assert.strictEqual(failingState.prepares, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('✓ publishing orchestrator');
})().catch(error => { console.error(error); process.exit(1); });
