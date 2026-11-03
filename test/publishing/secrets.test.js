'use strict';
const assert = require('assert');
const { SecretStore, validateZhihuCookies, redact, assertSecretFreePersistence } = require('../../lib/publishing/secrets');
const values = new Map(); const port = { availability: async () => ({ available: true }), get: async key => values.get(key) || null, set: async (key, value) => values.set(key, value), delete: async key => values.delete(key) };
(async () => {
  const store = new SecretStore(port); await store.set('publishing.wechat.appSecret', 'top-secret-value'); assert.strictEqual(await store.get('publishing.wechat.appSecret'), 'top-secret-value');
  const cookie = JSON.stringify([{ name: 'z_c0', value: 'abc', domain: '.zhihu.com', path: '/', expires: -1 }]); assert.strictEqual(validateZhihuCookies(cookie), cookie);
  assert.throws(() => validateZhihuCookies('[]'), /INVALID_COOKIE/);
  assert.deepStrictEqual(redact({ authorization: 'Bearer top-secret-value', url: 'https://x/?token=abc' }, ['top-secret-value']), { authorization: '[redacted]', url: 'https://x/?token=[redacted]' });
  assert.throws(() => assertSecretFreePersistence({ body: 'top-secret-value' }, ['top-secret-value']), /SECRET_PERSISTENCE_FORBIDDEN/);
  console.log('✓ publishing secrets');
})().catch(error => { console.error(error); process.exit(1); });
