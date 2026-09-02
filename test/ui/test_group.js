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

  // 模拟多平台多 key 多模型
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmConfig', llm: {
    baseUrl: 'https://openrouter.ai/api/v1', model: 'inclusionai/ling-3.0-flash-fin:free', hasKey: true, activeProfile: 'pA',
    profiles: [
      { id: 'pA', name: 'OpenRouter 免费', baseUrl: 'https://openrouter.ai/api/v1', model: 'inclusionai/ling-3.0-flash-fin:free', hasKey: true, keyHint: 'sk-or…aB3f' },
      { id: 'pB', name: 'OpenRouter 免费2', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemma-4-31b-it:free', hasKey: true, keyHint: 'sk-or…aB3f' },
      { id: 'pC', name: 'OpenRouter 付费key', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', hasKey: true, keyHint: 'sk-or…Zz9x' },
      { id: 'pD', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, keyHint: 'sk-ds…c7Q' },
      { id: 'pE', name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', hasKey: false, keyOptional: true },
    ] } } })));
  await page.waitForTimeout(150);
  const groups = await page.evaluate(() => Array.from(document.querySelectorAll('.llm-plat-group')).map(g => ({
    head: g.querySelector('.llm-plat-head').textContent.trim(),
    tokens: Array.from(g.querySelectorAll('.llm-token-head')).map(t => t.textContent.trim()),
    rows: g.querySelectorAll('.llm-profile-row').length,
  })));
  console.log('platform groups:', JSON.stringify(groups, null, 1));
  const activeRow = await page.evaluate(() => document.querySelector('.llm-profile-row.llm-profile-active .llm-profile-name').textContent.trim());
  console.log('active row:', activeRow);

  // 编辑 pC → 保存应复用 id
  await page.evaluate(() => document.querySelectorAll('.llm-profile-edit')[2].click());
  await page.waitForTimeout(60);
  const editing = await page.evaluate(() => ({
    editingId: window._llmEditingId,
    label: document.getElementById('llm-form-label').textContent,
    name: document.getElementById('global-llm-name').value,
    base: document.getElementById('global-llm-base').value,
    model: document.getElementById('global-llm-model').value,
    newBtn: document.getElementById('global-llm-new').style.display,
  }));
  console.log('edit state:', JSON.stringify(editing));

  // 编辑态下保存 → profileId = pC
  await page.evaluate(() => document.getElementById('global-llm-save').click());
  await page.waitForTimeout(60);
  const savePosted = await page.evaluate(() => window.__posted.filter(m => m.type==='llmSaveConfig'));
  console.log('save posted:', JSON.stringify(savePosted));

  // 「＋ 新建」→ 清除编辑态
  await page.evaluate(() => document.getElementById('global-llm-new').click());
  const afterNew = await page.evaluate(() => ({ editingId: window._llmEditingId, label: document.getElementById('llm-form-label').textContent }));
  console.log('after new:', JSON.stringify(afterNew));

  // 免费模型：点按钮 → llmFetchFreeModels；收到缓存消息 → 显示刷新按钮 + 缓存提示
  await page.evaluate(() => document.getElementById('global-llm-free-btn').click());
  await page.waitForTimeout(60);
  const freePosted = await page.evaluate(() => window.__posted.filter(m => m.type==='llmFetchFreeModels'));
  console.log('free posted:', JSON.stringify(freePosted));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmFreeModels', models: [{id:'google/gemma-4-31b-it:free',name:'Gemma 4 31B',context_length:262144}], fetchedAt: Date.now() - 60000*30, forced: false } })));
  await page.waitForTimeout(60);
  const cacheUi = await page.evaluate(() => ({
    refreshVisible: document.getElementById('global-llm-free-refresh').style.display !== 'none',
    cacheText: document.getElementById('global-llm-free-cache').textContent,
    listItems: document.querySelectorAll('#global-llm-free-list [data-slug]').length,
  }));
  console.log('free cache UI:', JSON.stringify(cacheUi));
  await page.evaluate(() => document.getElementById('global-llm-free-refresh').click());
  await page.waitForTimeout(60);
  const refreshPosted = await page.evaluate(() => window.__posted.filter(m => m.type==='llmFetchFreeModels'));
  console.log('refresh posted:', JSON.stringify(refreshPosted));

  console.log('errors:', errors.length ? errors.join(' || ') : '(none)');
  await browser.close();
})();
