'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { BrowserClient, sanitizedWorkerEnvironment, sanitizeResult } = require('../../lib/publishing/browser-client');

(async () => {
  const sent = []; let spawnOptions;
  const child = new EventEmitter();
  child.send = (message, callback) => {
    sent.push(message);
    if (callback) callback();
    if (message.type === 'publishBrowserPrepare') process.nextTick(() => child.emit('message', { type: 'publishBrowserResult', result: { ready: false, assetResults: { 'asset-0000': { state: 'failed', error: { code: 'secret-cookie-value' } } } } }));
    if (message.type === 'publishBrowserLogin') process.nextTick(() => child.emit('message', { type: 'publishBrowserLoginResult', result: { cookies: JSON.stringify([{ name: 'z_c0', value: 'login-cookie', domain: '.zhihu.com', path: '/', expires: -1 }]) } }));
  };
  const client = new BrowserClient({ environment: { PATH: '/bin', HOME: '/tmp/home', APP_SECRET: 'must-not-pass', COOKIE: 'must-not-pass' }, readyTimeoutMs: 100, fork: (_script, _args, options) => { spawnOptions = options; process.nextTick(() => child.emit('message', { type: 'workerReady' })); return child; } });
  const output = await client.prepare({ cookies: '[{"name":"z_c0"}]', payload: { assets: [{ cachePath: '/private/cache/image.png' }] } });
  assert.strictEqual(spawnOptions.env.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(spawnOptions.env.APP_SECRET, undefined);
  assert.strictEqual(spawnOptions.env.COOKIE, undefined);
  assert.deepStrictEqual(sent.map(message => message.type), ['publishBrowserCredentials', 'publishBrowserPrepare']);
  assert.deepStrictEqual(output.assetResults['asset-0000'].error, { code: 'BROWSER_PREPARE_FAILED' });
  const login = await client.login({ profile: { providerPath: 'zhihu-browser' } });
  assert.strictEqual(JSON.parse(login.cookies)[0].value, 'login-cookie');
  assert.deepStrictEqual(sent.map(message => message.type), ['publishBrowserCredentials', 'publishBrowserPrepare', 'publishBrowserLogin']);
  const silent = new EventEmitter(); silent.send = () => {};
  const blocked = new BrowserClient({ readyTimeoutMs: 5, fork: () => silent });
  await assert.rejects(blocked.start(), error => error.code === 'WORKER_HANDSHAKE_FAILED');
  assert.deepStrictEqual(sanitizedWorkerEnvironment({ PATH: '/bin', TOKEN: 'secret' }), { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
  assert.throws(() => sanitizeResult({ ready: false, assetResults: { 'asset-0000': { state: 'uploaded', confirmedUrl: 'https://pic.zhimg.com/a.png?token=secret', providerRef: 'https://pic.zhimg.com/a.png?token=secret' } } }), /BROWSER_PREPARE_FAILED/);
  console.log('✓ publishing browser client');
})().catch(error => { console.error(error); process.exit(1); });
