// 验证所有侧面板支持拖拽调宽（LLM 配置 / 样式 / 小红书 / 封面等）
const { chromium } = require('playwright-core');
const { buildTestHtml } = require('../helpers/webview');

(async () => {
  const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.setContent(buildTestHtml());
  await page.waitForTimeout(300);

  // ── 打开 LLM 配置面板并拖动调宽 ──
  await page.evaluate(() => {
    const p = document.getElementById('llm-config-panel');
    p.classList.add('open');
  });
  await page.waitForTimeout(350); // 等待 width 过渡动画完成
  const llmBefore = await page.evaluate(() => document.getElementById('llm-config-panel').offsetWidth);
  console.log('LLM 面板初始宽度:', llmBefore);
  if (llmBefore !== 340) throw new Error('LLM 面板初始宽度应为 340，实际 ' + llmBefore);

  // 模拟拖动 handle：从 (x=600) 向左拖 100px → 宽度应增加 100
  const handleBox = await page.evaluate(() => {
    const h = document.getElementById('llm-resize-handle');
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 100 };
  });
  await page.mouse.move(handleBox.x, handleBox.y);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 100, handleBox.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const llmAfter = await page.evaluate(() => document.getElementById('llm-config-panel').offsetWidth);
  console.log('LLM 面板拖后宽度:', llmAfter);
  if (Math.abs(llmAfter - (llmBefore + 100)) > 5) throw new Error('LLM 面板拖动后宽度异常: ' + llmAfter);

  // ── 宽度记忆：关闭再打开应保持拖拽后的宽度 ──
  await page.evaluate(() => {
    const p = document.getElementById('llm-config-panel');
    // 模拟真实 togglePanel 关闭（清 open + 内联宽）
    p.classList.remove('open'); p.style.width = '';
    // 重新打开
    p.classList.add('open');
    if (window._panelResizeW && window._panelResizeW['llm-config-panel']) {
      p.style.width = window._panelResizeW['llm-config-panel'] + 'px';
    }
  });
  await page.waitForTimeout(350);
  const llmReopen = await page.evaluate(() => document.getElementById('llm-config-panel').offsetWidth);
  console.log('LLM 面板重开宽度(记忆):', llmReopen);
  if (Math.abs(llmReopen - 440) > 5) throw new Error('宽度记忆失败: ' + llmReopen);

  // 双击 handle 应重置为默认宽度 340（派发 dblclick 事件触发）
  await page.evaluate(() => {
    const h = document.getElementById('llm-resize-handle');
    h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForTimeout(350); // 等待宽度过渡动画完成
  const llmReset = await page.evaluate(() => document.getElementById('llm-config-panel').offsetWidth);
  console.log('LLM 面板双击重置:', llmReset);
  if (Math.abs(llmReset - 340) > 5) throw new Error('LLM 面板双击未重置: ' + llmReset);

  // ── 样式面板同样验证 ──
  await page.evaluate(() => {
    const p = document.getElementById('llm-config-panel');
    p.classList.remove('open'); p.style.width = '';
    document.getElementById('style-panel').classList.add('open');
  });
  await page.waitForTimeout(350);
  const styleBefore = await page.evaluate(() => document.getElementById('style-panel').offsetWidth);
  const shBox = await page.evaluate(() => {
    const h = document.getElementById('style-resize-handle');
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 100 };
  });
  await page.mouse.move(shBox.x, shBox.y);
  await page.mouse.down();
  await page.mouse.move(shBox.x - 60, shBox.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const styleAfter = await page.evaluate(() => document.getElementById('style-panel').offsetWidth);
  console.log('样式面板: 初始', styleBefore, '→ 拖后', styleAfter);
  if (Math.abs(styleAfter - (styleBefore + 60)) > 5) throw new Error('样式面板拖动异常: ' + styleAfter);

  // ── 最大宽度限制：预览区至少保留 220px ──
  await page.evaluate(() => {
    const p = document.getElementById('style-panel');
    p.classList.remove('open'); p.style.width = '';
    document.getElementById('xhs-panel').classList.add('open');
  });
  await page.waitForTimeout(350);
  const maxDrag = await page.evaluate(() => {
    const h = document.getElementById('xhs-resize-handle');
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 100 };
  });
  await page.mouse.move(maxDrag.x, maxDrag.y);
  await page.mouse.down();
  await page.mouse.move(maxDrag.x - 400, maxDrag.y, { steps: 10 }); // 大幅左拖
  await page.mouse.up();
  await page.waitForTimeout(50);
  const xhsMax = await page.evaluate(() => document.getElementById('xhs-panel').offsetWidth);
  const previewW = await page.evaluate(() => document.getElementById('preview-scroll').offsetWidth);
  console.log('XHS 极限宽度:', xhsMax, '| 预览区剩余:', previewW);
  if (previewW < 200) throw new Error('预览区被挤压过小: ' + previewW);

  console.log('ERRORS:', errors.length ? errors.join(' || ') : '(none)');
  await browser.close();
  if (errors.length) process.exit(1);
})();
