'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JobStore } = require('../../lib/publishing/job-store');
function input(id) { return { jobId: id, source: { documentPath: '/tmp/article.md', documentSha256: 'a'.repeat(64) }, selectedTargets: ['zhihu'], article: { title: 'Title', body: { segments: [] } }, assets: [] }; }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-store-'));
try {
  const store = new JobStore(root); const result = store.start(input('job-store-0001'));
  assert.strictEqual(result.job.status, 'claimed'); assert.ok(store.load(result.job.jobId));
  store.intent(result.job.jobId, 'zhihu', 'createDraft');
  const recovery = store.recover(); assert.ok(recovery.some(item => item.code === 'AMBIGUOUS_CREATE'));
  assert.strictEqual(store.load(result.job.jobId).targets.zhihu.state, 'ambiguous');
  const orphan = store.create(input('job-store-0002')); assert.strictEqual(orphan.status, 'created');
  assert.ok(store.recover().some(item => item.jobId === orphan.jobId && item.code === 'ORPHAN_DISCARDED'));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('✓ publishing job store');
