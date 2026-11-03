'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireAssets, uploadGroups } = require('../../lib/publishing/media');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-media-'));
  try {
    const assets = [0, 1].map(order => ({ assetId: `asset-${String(order).padStart(4, '0')}`, role: 'body', bodyOrder: order, source: { kind: 'data' }, acquisition: 'pending' }));
    const result = await acquireAssets(assets, { 'asset-0000': png, 'asset-0001': png }, { cacheRoot: root, jobId: 'job-media-0001' });
    assert.ok(result.every(asset => asset.acquisition === 'acquired'));
    assert.strictEqual(uploadGroups(result, 'zhihu', 'inline', 'same').length, 1);
    const failed = await acquireAssets([assets[0]], { 'asset-0000': 'data:image/png;base64,nope' }, { cacheRoot: root, jobId: 'job-media-0002' });
    assert.strictEqual(failed[0].acquisition, 'failed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('✓ publishing media');
})().catch(error => { console.error(error); process.exit(1); });
