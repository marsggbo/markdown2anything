'use strict';
const assert = require('assert');
const { migrateLegacyCredential } = require('../../lib/publishing/legacy-credentials');
const { validateZhihuCookies } = require('../../lib/publishing/secrets');

(async () => {
  const records = new Map();
  let cleared = false;
  const valid = JSON.stringify([{ name: 'z_c0', value: 'legacy-cookie', domain: '.zhihu.com', path: '/', expires: -1 }]);
  const migrated = await migrateLegacyCredential({
    value: valid,
    normalize: validateZhihuCookies,
    slot: 'publishing.zhihu.browserCookies',
    setSecret: async (slot, value) => records.set(slot, value),
    getSecret: async slot => records.get(slot),
    clearLegacy: async () => { cleared = true; },
  });
  assert.deepStrictEqual(migrated, { blocked: false, migrated: true, value: null });
  assert.strictEqual(cleared, true, 'a verified secure copy clears the legacy credential');
  let writes = 0;
  let clears = 0;
  const blocked = await migrateLegacyCredential({
    value: 'not-a-valid-cookie',
    normalize: validateZhihuCookies,
    slot: 'publishing.zhihu.browserCookies',
    setSecret: async () => { writes++; },
    getSecret: async () => null,
    clearLegacy: async () => { clears++; },
  });
  assert.deepStrictEqual(blocked, { blocked: true, migrated: false, value: null });
  assert.strictEqual(writes, 0, 'an unrepresentable legacy credential is never overwritten');
  assert.strictEqual(clears, 0, 'an unrepresentable legacy credential is retained for explicit recovery');
  console.log('✓ publishing legacy credential migration');
})().catch(error => { console.error(error); process.exit(1); });
