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

  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmConfig', llm: {
    baseUrl: 'https://openrouter.ai/api/v1', model: 'inclusionai/ling-3.0-flash-fin:free', hasKey: true, activeProfile: 'pA',
    profiles: [
      { id: 'pA', name: 'OpenRouter 免费', baseUrl: 'https://openrouter.ai/api/v1', model: 'inclusionai/ling-3.0-flash-fin:free', hasKey: true, keyHint: 'sk-or…aB3f' },
      { id: 'pB', name: 'OpenRouter 免费2', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemma-4-31b-it:free', hasKey: true, keyHint: 'sk-or…aB3f' },
      { id: 'pC', name: 'OpenRouter 付费key', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', hasKey: true, keyHint: 'sk-or…Zz9x' },
      { id: 'pD', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, keyHint: 'sk-ds…c7Q' },
      { id: 'pE', name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', hasKey: false, keyOptional: true },
      { id: 'pF', name: '无Key配置', baseUrl: 'https://openrouter.ai/api/v1', model: 'some/model:free', hasKey: false, keyOptional: false },
    ] } } })));
  await page.waitForTimeout(150);
  const summary = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('.llm-plat-group')).map(g => ({
      head: g.querySelector('.llm-plat-head').textContent.trim(),
      tokens: Array.from(g.querySelectorAll('.llm-token-head')).map(t => t.textContent.trim()),
      rows: g.querySelectorAll('.llm-profile-row').length,
    }));
    return { groups };
  });
  console.log('GROUPS:');
  summary.groups.forEach(g => console.log('  ' + g.head + ' => ' + JSON.stringify(g.tokens)));

  await page.evaluate(() => { window._llmEditingId = ''; document.getElementById('global-llm-name').value = '新配置'; document.getElementById('global-llm-base').value = 'https://openrouter.ai/api/v1'; document.getElementById('global-llm-model').value = 'abc/model:free'; document.getElementById('global-llm-key').value = ''; document.getElementById('global-llm-save').click(); });
  await page.waitForTimeout(60);
  const saves = await page.evaluate(() => window.__posted.filter(m => m.type==='llmSaveConfig'));
  console.log('SAVE (new):', JSON.stringify(saves[saves.length-1]));

  await page.evaluate(() => { document.getElementById('global-llm-model').value = 'xyz:free'; document.getElementById('global-llm-test').click(); });
  await page.waitForTimeout(60);
  const tests = await page.evaluate(() => window.__posted.filter(m => m.type==='llmTestConnection'));
  console.log('TEST:', JSON.stringify(tests[tests.length-1]));

  await page.evaluate(() => document.querySelectorAll('.llm-profile-del')[0].click());
  await page.evaluate(() => document.querySelectorAll('.llm-profile-del')[0].click());
  await page.waitForTimeout(60);
  const dels = await page.evaluate(() => window.__posted.filter(m => m.type==='llmDeleteProfile'));
  console.log('DELETE:', JSON.stringify(dels[dels.length-1]));

  await page.evaluate(() => document.getElementById('global-llm-clear').click());
  await page.waitForTimeout(60);
  const clears = await page.evaluate(() => window.__posted.filter(m => m.type==='llmSaveConfig' && m.apiKey === ''));
  console.log('CLEAR:', JSON.stringify(clears[clears.length-1]));

  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmFreeModels', models: [{id:'google/gemma-4-31b-it:free',name:'Gemma',context_length:262144}], fetchedAt: Date.now()-3600e3, forced: false } })));
  await page.waitForTimeout(60);
  console.log('CACHE UI:', await page.evaluate(() => JSON.stringify({ refresh: document.getElementById('global-llm-free-refresh').style.display, cache: document.getElementById('global-llm-free-cache').textContent })));

  console.log('ERRORS:', errors.length ? errors.join(' || ') : '(none)');
  await browser.close();
})();
