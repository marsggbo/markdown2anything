'use strict';
const assert = require('assert');
const { validatePublishMessage } = require('../../lib/publishing/messages');
const { registerVsCodePublishing, registerElectronPublishing } = require('../../lib/publishing/host-entry');

function runtime(calls) {
  const result = jobId => ({ job: { jobId, assets: [] }, targets: { zhihu: { state: 'failed' } }, aggregate: { state: 'partial', summary: 'partialRetryable' } });
  return {
    orchestrator: { onProgress: () => () => {}, requireJob: () => ({ assets: [] }) },
    inspect: async value => ({ job: { jobId: 'publish-job-0001', assets: [] }, capabilities: {}, preflightBinding: { nonce: 'a'.repeat(16), sourceFingerprint: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(), targets: value.targets } }),
    prepare: async jobId => { calls.push('prepare'); return result(jobId); },
    retry: async jobId => { calls.push('retry'); return result(jobId); },
    createDuplicate: async () => { calls.push('duplicate'); return { job: { jobId: 'publish-job-0002', assets: [] }, capabilities: {}, preflightBinding: { nonce: 'c'.repeat(16), sourceFingerprint: 'd'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(), targets: ['zhihu'] } }; },
    finalizePartial: async jobId => { calls.push('finalize'); return result(jobId); },
    discard: async jobId => { calls.push('discard'); return result(jobId); },
    cancel: async jobId => { calls.push('cancel'); return result(jobId); },
    confirmAuto: async jobId => { calls.push('auto'); return result(jobId); },
  };
}

(async () => {
  const message = { type: 'publishPreflight', targets: ['zhihu'], mode: 'prepare', autoAcknowledged: false, metadata: { cover: { kind: 'none' } }, options: { zhihu: {} } };
  assert.ok(validatePublishMessage(message).ok);
  for (const register of [registerVsCodePublishing, registerElectronPublishing]) {
    const events = [];
    const calls = [];
    const registration = register(runtime(calls), { requestCredentialEntry: async () => ({ available: true }) }, event => events.push(event));
    await registration.dispatch(message);
    assert.strictEqual(events[0].type, 'publishPreflightResult');
    assert.strictEqual(events[0].jobId, 'publish-job-0001');
    await registration.dispatch({ type: 'publishCreateDuplicate', jobId: 'publish-job-0001' });
    await registration.dispatch({ type: 'publishFinalizePartial', jobId: 'publish-job-0002', targets: ['zhihu'] });
    await registration.dispatch({ type: 'publishDiscard', jobId: 'publish-job-0002' });
    await registration.dispatch({ type: 'publishCancel', jobId: 'publish-job-0002' });
    await registration.dispatch({ type: 'publishRequestCredentialEntry', slot: 'publishing.wechat.appSecret' });
    assert.deepStrictEqual(calls, ['duplicate', 'finalize', 'discard', 'cancel']);
    const credential = events.find(event => event.type === 'publishCredentialResult');
    assert.deepStrictEqual(credential, { type: 'publishCredentialResult', slot: 'publishing.wechat.appSecret', available: true });
    registration.dispose();
  }
  console.log('✓ publishing host services');
})().catch(error => { console.error(error); process.exit(1); });
