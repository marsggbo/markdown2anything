// 复现/验证：知乎复制后按钮卡"处理中"（用户报告）
// 模拟：点 btn-dd-zhihu 打开下拉 → 点 btn-zhihu（应显示处理中）→
//      模拟 host 返回 zhihuHtml 消息（按钮应恢复）→ 断言状态
const { chromium } = require('playwright-core');
const { buildTestHtml } = require('../helpers/webview');

(async () => {
  const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.setContent(buildTestHtml());
  await page.waitForTimeout(300);

  // 打开知乎下拉菜单
  await page.evaluate(() => {
    document.getElementById('btn-dd-zhihu').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(200);

  // 点击"复制到剪贴板"
  await page.evaluate(() => {
    document.getElementById('btn-zhihu').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(200);

  const clickState = await page.evaluate(() => {
    const btn = document.getElementById('btn-zhihu');
    const label = btn.querySelector('.item-label');
    return { text: label.textContent, disabled: btn.disabled };
  });
  console.log('点击后按钮状态:', JSON.stringify(clickState));
  if (clickState.text !== '⏳ 处理中...' || clickState.disabled !== true) {
    throw new Error('点击后应为处理中+禁用: ' + JSON.stringify(clickState));
  }

  // 模拟 host 返回 zhihuHtml 消息（与 getWebviewHtml 注入一致：window.addEventListener('message')）
  const gotMsg = await page.evaluate(() => {
    let handled = false;
    // panel.html 用 window.addEventListener('message', ...) 接收 host 消息
    const candidates = [];
    // 直接派发 MessageEvent
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'zhihuHtml', html: '<p>知乎内容 <b>测试</b></p>' },
    }));
    // 等一拍后看按钮状态（在 evaluate 内无法等，返回后外部再查）
    return handled;
  });
  await page.waitForTimeout(600);

  const afterState = await page.evaluate(() => {
    const btn = document.getElementById('btn-zhihu');
    const label = btn.querySelector('.item-label');
    return { text: label.textContent, disabled: btn.disabled };
  });
  console.log('收到 zhihuHtml 后按钮状态:', JSON.stringify(afterState));
  if (afterState.text !== '复制到剪贴板' || afterState.disabled !== false) {
    // 可能消息没被处理 → 打印错误
    console.log('页面错误:', errors.join('; '));
    throw new Error('收到 zhihuHtml 后按钮应恢复: ' + JSON.stringify(afterState));
  }

  if (errors.length) {
    console.log('页面错误(不阻塞):', errors.join('; '));
  }
  console.log('✅ 知乎复制按钮状态恢复正常（处理中→复制到剪贴板）');
  await browser.close();
})().catch(e => { console.error('✗', e.message); process.exit(1); });
