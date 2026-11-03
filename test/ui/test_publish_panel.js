'use strict';
const assert = require('assert');
const { chromium } = require('playwright-core');
const { buildTestHtml } = require('../helpers/webview');

(async () => {
  const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(buildTestHtml());
    await page.evaluate(() => document.getElementById('btn-publish').click());
    assert.strictEqual(await page.locator('#publish-controls-root input[type=password]').count(), 0, 'credentials do not enter the shared renderer');
    await page.fill('#publish-title', 'Shared publishing test');
    await page.click('#publish-preflight');
    const preflight = await page.evaluate(() => window.__posted.find(message => message.type === 'publishPreflight'));
    assert.deepStrictEqual(preflight.targets, ['wechat', 'zhihu', 'cnblogs']);
    assert.strictEqual(preflight.mode, 'prepare');
    assert.strictEqual(preflight.autoAcknowledged, false);
    assert.strictEqual(preflight.options.zhihu.creationDeclaration, undefined);

    await page.locator('#publish-controls-root details').first().locator('summary').click();
    await page.click('#publish-set-wechat-secret');
    await page.click('#publish-login-zhihu');
    await page.click('#publish-set-cnblogs-username');
    await page.click('#publish-set-cnblogs-token');
    const enrollment = await page.evaluate(() => window.__posted.filter(message => message.type === 'publishRequestCredentialEntry' || message.type === 'publishBeginBrowserLogin'));
    assert.deepStrictEqual(enrollment, [
      { type: 'publishRequestCredentialEntry', slot: 'publishing.wechat.appSecret' },
      { type: 'publishBeginBrowserLogin', slot: 'publishing.zhihu.browserCookies' },
      { type: 'publishRequestCredentialEntry', slot: 'publishing.cnblogs.username' },
      { type: 'publishRequestCredentialEntry', slot: 'publishing.cnblogs.token' },
    ]);
    assert.ok(enrollment.every(message => !Object.prototype.hasOwnProperty.call(message, 'value')));

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'publishPreflightResult', jobId: 'publish-job-0001',
      assets: [
        { assetId: 'asset-0000', role: 'body', acquisition: 'pending' },
        { assetId: 'asset-0001', role: 'body', acquisition: 'pending' },
        { assetId: 'asset-0002', role: 'body', acquisition: 'pending' },
      ],
      capabilities: {
        wechat: { availability: 'available', autoSupported: true },
        zhihu: { availability: 'available', autoSupported: true },
        cnblogs: { availability: 'available', autoSupported: true },
      },
      preflightBinding: { nonce: 'a'.repeat(16), sourceFingerprint: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(), targets: ['wechat', 'zhihu', 'cnblogs'] },
    } })));
    assert.strictEqual(await page.isDisabled('#publish-auto'), false);
    await page.click('#publish-auto');
    assert.strictEqual(await page.isDisabled('#publish-confirm-auto'), false);
    await page.click('#publish-prepare');
    const start = await page.evaluate(() => window.__posted.find(message => message.type === 'publishStart'));
    assert.strictEqual(start.mode, 'prepare');
    assert.strictEqual(start.metadata.title, 'Shared publishing test');

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'publishProgress', target: 'zhihu', assetId: 'asset-0001', state: 'failed' } })));
    assert.match(await page.textContent('#publish-asset-asset-0001'), /失败/);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'publishResult', jobId: 'publish-job-0001', aggregate: { state: 'partial', summary: 'partialRetryable' },
      targets: { wechat: { state: 'readyForReview' }, zhihu: { state: 'failed' }, cnblogs: { state: 'published' } },
    } })));
    assert.match(await page.textContent('#publish-target-results'), /待审核/);
    assert.match(await page.textContent('#publish-target-results'), /失败/);
    assert.match(await page.textContent('#publish-target-results'), /已发布/);
    assert.match(await page.textContent('#publish-status'), /部分完成/);

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'publishError', code: 'RETRY_SOURCE_CHANGED' } })));
    assert.strictEqual(await page.isDisabled('#publish-auto'), true);
    assert.strictEqual(await page.isDisabled('#publish-confirm-auto'), true);
    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
  }
  console.log('✓ shared publish panel');
})().catch(error => { console.error(error); process.exit(1); });
