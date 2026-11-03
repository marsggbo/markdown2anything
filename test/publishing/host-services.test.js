'use strict';
const assert = require('assert');
const { validatePublishMessage } = require('../../lib/publishing/messages');
const { registerVsCodePublishing } = require('../../lib/publishing/host-entry');

(async () => {
  const events = [];
  const runtime = {
    orchestrator: { onProgress: () => () => {}, requireJob: () => ({ assets: [] }) },
    inspect: async value => ({ job: { jobId: 'publish-job-0001', assets: [] }, capabilities: {}, preflightBinding: { nonce: 'a'.repeat(16), sourceFingerprint: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(), targets: value.targets } }),
  };
  const registration = registerVsCodePublishing(runtime, {}, event => events.push(event));
  const message = { type: 'publishPreflight', targets: ['zhihu'], mode: 'prepare', autoAcknowledged: false, metadata: { cover: { kind: 'none' } }, options: { zhihu: {} } };
  assert.ok(validatePublishMessage(message).ok);
  await registration.dispatch(message);
  assert.strictEqual(events[0].type, 'publishPreflightResult');
  assert.strictEqual(events[0].jobId, 'publish-job-0001');
  registration.dispose();
  console.log('✓ publishing host services');
})().catch(error => { console.error(error); process.exit(1); });
