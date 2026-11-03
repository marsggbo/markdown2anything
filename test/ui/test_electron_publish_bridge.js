'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');
const electronPath = require('electron');

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-electron-bridge-'));
  let app;
  try {
    app = await _electron.launch({
      executablePath: electronPath,
      args: [path.join(__dirname, '..', 'electron', 'publish-bridge-fixture.js')],
      env: { ...process.env, M2A_HEADLESS: '1', M2A_PUBLISH_TEST_USER_DATA: userData },
      timeout: 20000,
    });
    const window = await app.firstWindow({ timeout: 20000 });
    await window.waitForFunction(() => window.__m2aHostReady === true, undefined, { timeout: 20000 });
    await window.waitForSelector('#publish-panel', { timeout: 20000 });
    assert.strictEqual(await window.evaluate(() => typeof window.acquireVsCodeApi), 'function', 'the real preload bridge was unavailable');
    const result = await window.evaluate(async () => {
      const events = [];
      window.addEventListener('message', event => {
        if (event.data && String(event.data.type || '').startsWith('publish')) events.push(event.data.type);
      });
      const vscode = window.acquireVsCodeApi();
      vscode.postMessage({
        type: 'publishPreflight', targets: ['zhihu'], mode: 'prepare', autoAcknowledged: false,
        metadata: { cover: { kind: 'none' } }, options: { zhihu: {} },
      });
      const deadline = Date.now() + 3000;
      while (!events.includes('publishError') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      const afterAllowed = events.slice();
      vscode.postMessage({ type: 'zhihuPublish', title: 'blocked' });
      await new Promise(resolve => setTimeout(resolve, 150));
      return { afterAllowed, events };
    });
    assert.ok(result.afterAllowed.includes('publishError'), 'allowed publishing message did not reach host validation');
    assert.deepStrictEqual(result.events, result.afterAllowed, 'legacy publishing channel crossed the preload bridge');
  } finally {
    if (app) await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log('✓ Electron publishing bridge');
})().catch(error => { console.error(error); process.exit(1); });
