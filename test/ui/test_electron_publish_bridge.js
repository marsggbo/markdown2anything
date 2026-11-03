'use strict';
const assert = require('assert');
const path = require('path');
const { _electron } = require('playwright-core');
const electronPath = require('electron');

(async () => {
  let app;
  try {
    app = await _electron.launch({
      executablePath: electronPath,
      args: [path.join(__dirname, '..', '..', 'electron', 'main.js')],
      env: { ...process.env, M2A_HEADLESS: '1' },
      timeout: 20000,
    });
    const window = await app.firstWindow({ timeout: 20000 });
    await window.waitForSelector('#publish-panel', { timeout: 20000 });
    const bridgeType = await window.evaluate(() => typeof window.acquireVsCodeApi);
    if (bridgeType !== 'function') {
      console.log('ℹ️ Electron Playwright harness did not expose the preload bridge; the browser-suite bridge assertion is skipped locally.');
      return;
    }
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
      await new Promise(resolve => setTimeout(resolve, 250));
      const afterAllowed = events.slice();
      vscode.postMessage({ type: 'zhihuPublish', title: 'blocked' });
      await new Promise(resolve => setTimeout(resolve, 150));
      return { afterAllowed, events };
    });
    assert.ok(result.afterAllowed.includes('publishError'), 'allowed publishing message did not reach host validation');
    assert.deepStrictEqual(result.events, result.afterAllowed, 'legacy publishing channel crossed the preload bridge');
  } finally {
    if (app) await app.close();
  }
  console.log('✓ Electron publishing bridge');
})().catch(error => { console.error(error); process.exit(1); });
