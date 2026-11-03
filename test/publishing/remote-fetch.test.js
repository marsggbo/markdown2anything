'use strict';
const assert = require('assert');
const { fetchRemoteImage, isPublicAddress } = require('../../lib/publishing/remote-fetch');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
(async () => {
  let calls = 0;
  await assert.rejects(() => fetchRemoteImage('https://images.example/a.png?api_key=secret', { lookup: async () => { calls++; return []; }, transport: async () => ({}) }), error => error.code === 'REMOTE_CREDENTIAL_QUERY');
  assert.strictEqual(calls, 0);
  await assert.rejects(() => fetchRemoteImage('https://images.example/a.png', { lookup: async () => [{ address: '127.0.0.1' }], transport: async () => ({}) }), error => error.code === 'REMOTE_PRIVATE_ADDRESS');
  const result = await fetchRemoteImage('https://images.example/a.png', { lookup: async () => [{ address: '8.8.8.8' }], transport: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: png }) });
  assert.deepStrictEqual(result.buffer, png); assert.ok(isPublicAddress('8.8.8.8')); assert.ok(!isPublicAddress('::1'));
  await assert.rejects(() => fetchRemoteImage('https://images.example/a.png', { lookup: async () => [{ address: '8.8.8.8' }], maxRedirects: 0, transport: async () => ({ status: 302, headers: { location: 'https://images.example/b.png' }, body: Buffer.alloc(0) }) }), error => error.code === 'REMOTE_REDIRECT_LIMIT');
  console.log('✓ publishing remote fetch');
})().catch(error => { console.error(error); process.exit(1); });
