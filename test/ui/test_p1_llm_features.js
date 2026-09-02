const { chromium } = require('playwright-core');
const { buildTestHtml } = require('../helpers/webview');

(async () => {
  const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.setContent(buildTestHtml());
  await page.waitForTimeout(300);

  // 打开 LLM 面板
  await page.evaluate(() => { const p = document.getElementById('llm-config-panel'); if (p) p.style.display=''; });

  // 注入 4 个配置：2 平台 × 2 key
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmConfig', llm: {
    baseUrl: 'https://openrouter.ai/api/v1', model: 'm1', hasKey: true, activeProfile: 'pA',
    profiles: [
      { id: 'pA', name: 'A1', baseUrl: 'https://openrouter.ai/api/v1', model: 'm1', hasKey: true, keyHint: 'sk-or…aB3f' },
      { id: 'pB', name: 'A2', baseUrl: 'https://openrouter.ai/api/v1', model: 'm2', hasKey: true, keyHint: 'sk-or…aB3f' },
      { id: 'pC', name: 'B1', baseUrl: 'https://api.deepseek.com/v1', model: 'm3', hasKey: true, keyHint: 'sk-ds…c7Q' },
      { id: 'pD', name: 'B2', baseUrl: 'https://api.deepseek.com/v1', model: 'm4', hasKey: false },
    ] } } })));
  await page.waitForTimeout(150);

  // ── 1. 分组折叠 ──
  const groups = await page.evaluate(() => {
    const plats = Array.from(document.querySelectorAll('#llm-profiles-list .llm-plat-group'));
    const tokens = Array.from(document.querySelectorAll('#llm-profiles-list .llm-token-group'));
    const keyBtns = document.querySelectorAll('#llm-profiles-list .llm-profile-key').length;
    return { platCount: plats.length, tokenCount: tokens.length, keyBtns };
  });
  console.log('平台组:', groups.platCount, '| token组:', groups.tokenCount, '| 显示Key按钮:', groups.keyBtns);
  if (groups.platCount !== 2) throw new Error('平台分组应为 2');
  if (groups.tokenCount !== 3) throw new Error('token 分组应为 3（2 key + 1 无key）');
  if (groups.keyBtns !== 3) throw new Error('有 key 的配置应有 3 个显示按钮');

  // 点击平台头折叠 → 该组内容隐藏
  const fold = await page.evaluate(() => {
    const platHead = document.querySelector('#llm-profiles-list .llm-plat-head');
    platHead.click();
    const group = platHead.closest('.llm-plat-group');
    const collapsedCls = group.classList.contains('llm-collapsed');
    const bodyHidden = getComputedStyle(group.querySelector('.llm-plat-body')).display === 'none';
    // 再点开恢复
    platHead.click();
    const bodyShown = getComputedStyle(group.querySelector('.llm-plat-body')).display !== 'none';
    return { collapsedCls, bodyHidden, bodyShown };
  });
  console.log('平台折叠:', JSON.stringify(fold));
  if (!fold.collapsedCls || !fold.bodyHidden || !fold.bodyShown) throw new Error('平台折叠/展开失败');

  // token 头折叠
  const tfold = await page.evaluate(() => {
    const tokenHead = document.querySelector('#llm-profiles-list .llm-token-head');
    tokenHead.click();
    const group = tokenHead.closest('.llm-token-group');
    const hidden = getComputedStyle(group.querySelector('.llm-token-body')).display === 'none';
    tokenHead.click();
    return hidden;
  });
  console.log('token折叠生效:', tfold);
  if (!tfold) throw new Error('token 折叠失败');

  // ── 2. 导出（走 host mock：webview postMessage 应该发 llmExportConfig）──
  const before = await page.evaluate(() => window.__posted.length);
  await page.evaluate(() => document.getElementById('global-llm-export').click());
  await page.waitForTimeout(50);
  const posted = await page.evaluate(() => window.__posted);
  const exportMsg = posted.find(m => m.type === 'llmExportConfig');
  console.log('导出消息已发:', !!exportMsg, '| 消息数:', posted.length, '→', before);
  if (!exportMsg) throw new Error('点击导出未发送 llmExportConfig');

  // 模拟 host 返回导出 JSON
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'llmExportResult', ok: true,
    json: JSON.stringify([{ id: 'pA', name: 'A1', baseUrl: 'https://openrouter.ai/api/v1', model: 'm1', hasKey: true, keyHint: 'sk-or…aB3f' }], null, 2),
  } })));
  await page.waitForTimeout(100);
  const dl = await page.evaluate(() => {
    const a = document.querySelector('#global-llm-export');
    return { label: a.textContent, downloadTag: !!Array.from(document.querySelectorAll('a')).find(x => x.download) };
  });
  console.log('导出后按钮恢复:', dl.label, '| 触发下载:', dl.downloadTag);

  // ── 3. 导入 ──
  await page.evaluate(() => document.getElementById('global-llm-import').click());
  const boxVisible = await page.evaluate(() => document.getElementById('global-llm-import-box').style.display !== 'none');
  console.log('导入框显示:', boxVisible);
  if (!boxVisible) throw new Error('导入框未显示');
  await page.evaluate(() => { const ta = document.getElementById('global-llm-import-json'); ta.value = "[{ name: '新配置', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }]"; });
  await page.evaluate(() => document.getElementById('global-llm-import-confirm').click());
  await page.waitForTimeout(50);
  const importMsg = (await page.evaluate(() => window.__posted)).find(m => m.type === 'llmImportConfig');
  console.log('导入消息已发:', !!importMsg, '| json:', importMsg && importMsg.json);
  if (!importMsg) throw new Error('导入消息未发送');

  // 模拟 host 返回导入成功
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmImportResult', ok: true, imported: 1, llm: {
    baseUrl: 'https://openrouter.ai/api/v1', model: 'm1', hasKey: true, activeProfile: 'pA',
    profiles: [
      { id: 'pA', name: 'A1', baseUrl: 'https://openrouter.ai/api/v1', model: 'm1', hasKey: true, keyHint: 'sk-or…aB3f' },
      { id: 'pE', name: '新配置', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, keyHint: 'sk-ds…c7Q' },
    ] } } })));
  await page.waitForTimeout(100);
  const afterImport = await page.evaluate(() => {
    const rows = document.querySelectorAll('#llm-profiles-list .llm-profile-row');
    const names = Array.from(rows).map(r => r.querySelector('.llm-profile-name').textContent.trim());
    return { count: rows.length, names };
  });
  console.log('导入后配置:', afterImport.count, '个 →', afterImport.names.join(', '));
  if (afterImport.count !== 2) throw new Error('导入后应显示 2 个配置');

  // ── 4. 显示 Key ──
  await page.evaluate(() => {
    const kb = document.querySelector('#llm-profiles-list .llm-profile-key');
    kb.click();
  });
  await page.waitForTimeout(50);
  const keyReq = (await page.evaluate(() => window.__posted)).find(m => m.type === 'llmGetProfileKey');
  const popShown = await page.evaluate(() => document.getElementById('global-llm-key-pop').style.display);
  console.log('显示Key: 请求已发:', !!keyReq, '| 弹窗显示:', popShown);
  if (!keyReq || popShown !== 'flex') throw new Error('显示 Key 弹窗未打开');
  // host 返回 key
  await page.evaluate((pid) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmProfileKey', profileId: pid, key: 'sk-test-1234567890abcdef' } })), keyReq.profileId);
  await page.waitForTimeout(50);
  const keyText = await page.evaluate(() => document.getElementById('llm-key-pop-value').textContent);
  console.log('Key 内容:', keyText);
  if (keyText !== 'sk-test-1234567890abcdef') throw new Error('Key 未显示');
  await page.evaluate(() => window.hideLlmKeyPop());
  const popHidden = await page.evaluate(() => document.getElementById('global-llm-key-pop').style.display);
  console.log('关闭弹窗:', popHidden);

  // ── 5. 批量测试 ──
  await page.evaluate(() => document.getElementById('global-llm-testall').click());
  await page.waitForTimeout(50);
  const testAll = (await page.evaluate(() => window.__posted)).find(m => m.type === 'llmTestAll');
  const btnLabel = await page.evaluate(() => document.getElementById('global-llm-testall').textContent);
  console.log('全部测试: 消息已发:', !!testAll, '| 按钮:', btnLabel);
  if (!testAll) throw new Error('批量测试消息未发送');
  // host 逐个回结果
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmTestAllProgress', total: 2, done: 1 } })));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmTestProfileResult', profileId: 'pA', ok: true, reply: 'ok' } })));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'llmTestAllProgress', total: 2, done: 2 } })));
  await page.waitForTimeout(80);
  const progress = await page.evaluate(() => document.getElementById('global-llm-testall-progress').textContent);
  const btnRestored = await page.evaluate(() => document.getElementById('global-llm-testall').textContent);
  console.log('进度:', JSON.stringify(progress), '| 按钮恢复:', btnRestored);
  const status = await page.evaluate(() => Array.from(document.querySelectorAll('.llm-status')).map(s => s.textContent.trim()));
  console.log('状态徽标:', status.join(', '));
  if (!status.some(t => t.includes('成功') || t.includes('✓'))) throw new Error('测试状态未更新');

  console.log('ERRORS:', errors.length ? errors.join(' || ') : '(none)');
  await browser.close();
  if (errors.length) process.exit(1);
})();
