const { chromium } = require('playwright-core');
const { buildTestHtml } = require('../helpers/webview');
(async () => {
  const finalHtml = buildTestHtml();
  const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.setContent(finalHtml);
  await page.waitForTimeout(300);
  await page.evaluate(() => { const p = document.getElementById('llm-config-panel'); if (p) p.style.display=''; });
  const PROFILES = [
    { id: 'pA', name: 'A', baseUrl: 'https://openrouter.ai/api/v1', model: 'm1:free', hasKey: true, keyHint: 'sk-or…aB3f' },
    { id: 'pB', name: 'B', baseUrl: 'https://openrouter.ai/api/v1', model: 'm2:free', hasKey: true, keyHint: 'sk-or…aB3f' },
    { id: 'pC', name: 'C', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, keyHint: 'sk-ds…c7Q' },
  ];
  await page.evaluate((PROFILES) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmConfig', llm: { baseUrl: 'https://openrouter.ai/api/v1', model: 'm1:free', hasKey: true, activeProfile: 'pA', profiles: PROFILES } } })), PROFILES);
  await page.waitForTimeout(150);
  // 编辑 pC
  await page.evaluate(() => { const rows = document.querySelectorAll('.llm-profile-row'); Array.from(rows).find(r => r.dataset.pid === 'pC').querySelector('.llm-profile-edit').click(); });
  await page.waitForTimeout(60);
  console.log('after edit pC:', await page.evaluate(() => JSON.stringify({ editing: window._llmEditingId, label: document.getElementById('llm-form-label').textContent })));
  // 切换 pB
  await page.evaluate(() => { const rows = document.querySelectorAll('.llm-profile-row'); Array.from(rows).find(r => r.dataset.pid === "pB").click(); });
  await page.waitForTimeout(60);
  console.log('after switch pB:', await page.evaluate(() => JSON.stringify({ editing: window._llmEditingId, label: document.getElementById('llm-form-label').textContent, posted: window.__posted.filter(m=>m.type==='llmSwitchProfile') })));
  // 模拟切换成功回执（activeProfile -> pA），表单回填 pA
  await page.evaluate((PROFILES) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmConfigSaved', llm: { baseUrl: 'https://openrouter.ai/api/v1', model: 'm1:free', hasKey: true, activeProfile: 'pA', profiles: PROFILES } } })), PROFILES);
  await page.waitForTimeout(80);
  console.log('after saved ack:', await page.evaluate(() => JSON.stringify({ editing: window._llmEditingId, label: document.getElementById('llm-form-label').textContent, base: document.getElementById('global-llm-base').value, model: document.getElementById('global-llm-model').value })));
  console.log('errors:', errors.length ? errors.join(' || ') : '(none)');
  await browser.close();
})();
