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

  // 模拟 llmConfig：一个已保存的 free 配置 + 历史遗留扁平配置（legacy）
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmConfig', llm: {
    baseUrl: 'https://openrouter.ai/api/v1', model: 'inclusionai/ling-3.0-flash-fin:free', hasKey: true, activeProfile: 'free1',
    profiles: [
      { id: 'free1', name: 'OpenRouter 免费', baseUrl: 'https://openrouter.ai/api/v1', model: 'inclusionai/ling-3.0-flash-fin:free', hasKey: true, keyHint: 'sk-or…aaaa' },
      { id: '__legacy__', name: '历史遗留配置', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', hasKey: true, keyHint: 'sk-or…bbbb', legacy: true },
    ] } } })));
  await page.waitForTimeout(150);
  const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#llm-profiles-list .llm-profile-row')).map(r => ({
    name: r.querySelector('.llm-profile-name').textContent.trim(),
    del: r.querySelector('.llm-profile-del').textContent.trim(),
  })));
  console.log('cards:', JSON.stringify(cards));

  // 二次点击删除 legacy
  await page.evaluate(() => document.querySelectorAll('#llm-profiles-list .llm-profile-del')[1].click());
  await page.waitForTimeout(50);
  const armed = await page.evaluate(() => document.querySelectorAll('#llm-profiles-list .llm-profile-del')[1].textContent);
  await page.evaluate(() => document.querySelectorAll('#llm-profiles-list .llm-profile-del')[1].click());
  await page.waitForTimeout(50);
  const delPosted = await page.evaluate(() => window.__posted.filter(m => m.type==='llmDeleteProfile'));
  console.log('delete flow: armed-text=', armed, '| posted=', JSON.stringify(delPosted));

  // 测试按钮应发送表单当前值（新模型）
  await page.evaluate(() => { document.getElementById('global-llm-model').value = 'google/gemma-4-31b-it:free'; document.getElementById('global-llm-base').value = 'https://openrouter.ai/api/v1'; });
  await page.evaluate(() => document.getElementById('global-llm-test').click());
  await page.waitForTimeout(50);
  const testPosted = await page.evaluate(() => window.__posted.filter(m => m.type==='llmTestConnection'));
  console.log('test posted:', JSON.stringify(testPosted));
  console.log('errors:', errors.length ? errors.join(' || ') : '(none)');
  await browser.close();
})();
