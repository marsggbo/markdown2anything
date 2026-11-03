const { chromium } = require('playwright-core');
const { buildTestHtml } = require('../helpers/webview');

(async () => {
  const finalHtml = buildTestHtml();
  const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/invalid source: 'vscode-resource/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.setContent(finalHtml);
  await page.waitForTimeout(300);

  // zones
  const zones = await page.evaluate(() => Array.from(document.querySelectorAll('.toolbar-zone')).map(z => z.className.replace('toolbar-zone ', '').replace(/toolbar-zone-/g,'')));
  console.log('zones:', zones.join(', '));

  // update with table + theme, toggle + sync
  const { renderMarkdown } = require('/Users/hexin/Desktop/markdown2anything/lib/converter');
  const { bodyHtml } = renderMarkdown('/tmp/wide_table_test.md');
  await page.evaluate((bh) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'update', bodyHtml: bh, title: 't', theme: { id: 'wechat', css: '', wrapperBg: '#ffffff' } } })), bodyHtml);
  await page.waitForTimeout(250);
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--m2a-accent').trim());
  await page.click('#btn-table-mode', { timeout: 3000 });
  const tog = await page.evaluate(() => ({ text: document.getElementById('btn-table-mode').textContent, expanded: document.body.classList.contains('tables-expanded') }));
  await page.click('#btn-sync-to-preview');
  const synced = await page.evaluate(() => window.__posted.includes('requestCursorLine'));
  console.log('accent:', accent, '| toggle:', JSON.stringify(tog), '| sync:', synced);

  // LLM profiles render via llmConfig
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmConfig', llm: { baseUrl: 'x', model: 'm', hasKey: true, activeProfile: 'a', profiles: [{ id: 'a', name: 'A', baseUrl: 'https://a.com/v1', model: 'm', hasKey: true }, { id: 'b', name: 'B', baseUrl: 'http://localhost:8000/v1', model: 'n', hasKey: false, keyOptional: true }] } } })));
  await page.waitForTimeout(200);
  const rows = await page.evaluate(() => document.querySelectorAll('#llm-profiles-list .llm-profile-row').length);
  console.log('llm profile rows:', rows);

  console.log('ERRORS:', errors.length ? errors.join(' || ') : '(none)');
  await browser.close();
})();
