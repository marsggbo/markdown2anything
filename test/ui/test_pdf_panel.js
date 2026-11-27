// UI 与端到端 PDF 生成测试：
// 1. 验证预览面板「💾 导出 → 📕 PDF」交互、主题联动徽标、消息收发与拖拽调宽
// 2. 验证真实 Chromium 导出不同主题（Claude / 深夜极客暗色 / 微信经典 / 无分页长页）PDF 文件有效且互异
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const { buildTestHtml } = require('../helpers/webview');
const { renderMarkdown, buildPdfHtml } = require('../../lib/converter');
const { THEMES, getTheme } = require('../../lib/themes');
const { exportHtmlToPdf } = require('../../lib/pdf');

function findTestChromium() {
  if (process.env.EXE && fs.existsSync(process.env.EXE)) return process.env.EXE;
  const home = os.homedir();
  const cacheDirs = [
    path.join(home, '.cache', 'ms-playwright'),
    process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : null,
  ].filter(Boolean);
  for (const cacheDir of cacheDirs) {
    if (!fs.existsSync(cacheDir)) continue;
    for (const entry of fs.readdirSync(cacheDir).filter(e => e.startsWith('chromium'))) {
      const candidates = [
        path.join(cacheDir, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(cacheDir, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        path.join(cacheDir, entry, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
        path.join(cacheDir, entry, 'chrome-linux', 'chrome'),
      ];
      for (const c of candidates) if (fs.existsSync(c)) return c;
    }
  }
  const sys = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const s of sys) if (fs.existsSync(s)) return s;
  return null;
}

(async () => {
  const executablePath = findTestChromium();
  const browser = await chromium.launch(executablePath ? { executablePath, args: ['--no-sandbox'] } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  await page.setContent(buildTestHtml());
  await page.waitForTimeout(200);

  // 模拟扩展推送主题列表与初始内容（默认 claude 主题）
  const claudeTheme = getTheme('claude');
  await page.evaluate(({ themes, theme }) => {
    window.postMessage({
      type: 'themeList',
      themes: themes.map(t => ({ id: t.id, name: t.name })),
      currentId: 'claude',
    }, '*');
    window.postMessage({
      type: 'update',
      bodyHtml: '<h1>测试文章</h1><p>内容段落</p>',
      title: '测试文章',
      theme: { id: theme.id, css: theme.css, wrapperBg: theme.wrapperBg },
    }, '*');
  }, { themes: THEMES, theme: claudeTheme });
  await page.waitForTimeout(100);

  // 1. 点击「💾 导出」下拉并打开「📕 PDF」侧面板
  await page.click('#btn-dd-export');
  const menuOpen = await page.evaluate(() => document.getElementById('menu-export').classList.contains('open'));
  assert.ok(menuOpen, '导出下拉菜单应展开');

  await page.click('#btn-pdf');
  await page.waitForTimeout(300);
  const pdfOpen = await page.evaluate(() => document.getElementById('pdf-panel').classList.contains('open'));
  assert.ok(pdfOpen, '点击 PDF 菜单项应打开 #pdf-panel');

  // 验证当前导出主题徽标与预览主题一致
  const initialBadge = await page.textContent('#pdf-current-theme');
  assert.strictEqual(initialBadge.trim(), claudeTheme.name, '初始导出主题应显示 Claude 风格');

  // 2. 切换预览主题为「🌙 深夜极客」(dark)，导出面板徽标应实时同步
  const darkTheme = getTheme('dark');
  await page.selectOption('#theme-select', 'dark');
  await page.evaluate((theme) => {
    window.postMessage({
      type: 'update',
      bodyHtml: '<h1>测试文章</h1><p>暗色内容</p>',
      title: '测试文章',
      theme: { id: theme.id, css: theme.css, wrapperBg: theme.wrapperBg },
    }, '*');
  }, darkTheme);
  await page.waitForTimeout(80);
  const darkBadge = await page.textContent('#pdf-current-theme');
  assert.strictEqual(darkBadge.trim(), darkTheme.name, '切换主题后导出面板应实时显示「🌙 深夜极客」');

  // 3. 应用自定义 CSS，选择规格与页码，点击「📕 生成 PDF」验证发送给扩展的消息载荷
  await page.evaluate(() => {
    document.getElementById('custom-style').textContent = '.article-wrapper h1 { letter-spacing: 2px; }';
  });
  await page.selectOption('#pdf-format', 'continuous');
  const pageNumHidden = await page.evaluate(() => getComputedStyle(document.getElementById('pdf-pagenum-row')).display === 'none');
  assert.ok(pageNumHidden, 'continuous 无分页模式下应隐藏页码复选框');

  await page.selectOption('#pdf-format', 'A4');
  await page.selectOption('#pdf-margin', 'compact');
  await page.check('#pdf-page-numbers');
  await page.fill('#pdf-output-path', 'out/custom.pdf');
  await page.click('#btn-pdf-export');

  const exportMsg = await page.evaluate(() => window.__posted.filter(m => m.type === 'exportPdf').pop());
  assert.ok(exportMsg, '点击生成 PDF 应向扩展发送 exportPdf 消息');
  assert.strictEqual(exportMsg.themeId, 'dark', 'exportPdf 应携带当前选中的预览主题 ID');
  assert.strictEqual(exportMsg.format, 'A4');
  assert.strictEqual(exportMsg.marginPreset, 'compact');
  assert.strictEqual(exportMsg.pageNumbers, true);
  assert.strictEqual(exportMsg.outputPath, 'out/custom.pdf');
  assert.ok(exportMsg.customCss.includes('letter-spacing: 2px'), 'exportPdf 应携带自定义 CSS');

  // 验证 pdfResult 消息恢复按钮状态并展示结果
  await page.evaluate(() => {
    window.postMessage({
      type: 'pdfResult',
      success: true,
      filename: 'custom.pdf',
      themeName: '🌙 深夜极客',
    }, '*');
  });
  await page.waitForTimeout(80);
  const resText = await page.textContent('#pdf-result');
  assert.ok(resText.includes('🌙 深夜极客') && resText.includes('custom.pdf'), '应显示导出成功及主题名称');

  assert.strictEqual(errors.length, 0, '页面不应有任何 JS 报错: ' + errors.join(' | '));
  console.log('✓ Webview PDF 面板交互、主题切换联动、参数透传全部正常');

  await browser.close();

  // 4. 真实导出多主题 PDF 文件验证（Claude 暖白 vs Dark 暗色 vs 无分页长页）
  if (executablePath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-pdf-e2e-'));
    const mdPath = path.join(tmpDir, 'doc.md');
    fs.writeFileSync(mdPath, [
      '# 多主题 PDF 导出实测',
      '',
      '当前测试覆盖 **主题配色**、行内公式 $a^2+b^2=c^2$ 与代码块：',
      '',
      '$$',
      'e^{i\\pi} + 1 = 0',
      '$$',
      '',
      '```python',
      'def greet(name: str) -> str:',
      '    return f"Hello, {name}!"',
      '```',
      '',
      '> 选择什么预览主题，就导出什么风格的 PDF。',
    ].join('\n'), 'utf8');

    try {
      const { bodyHtml, title } = renderMarkdown(mdPath);
      const outClaude = path.join(tmpDir, 'claude.pdf');
      const outDark   = path.join(tmpDir, 'dark.pdf');
      const outCont   = path.join(tmpDir, 'continuous.pdf');

      await exportHtmlToPdf({
        htmlContent: buildPdfHtml(bodyHtml, tmpDir, claudeTheme, { title, format: 'A4', pageNumbers: true }),
        outFile: outClaude,
        executablePath,
        format: 'A4',
        pageNumbers: true,
        bgColor: claudeTheme.wrapperBg,
      });

      await exportHtmlToPdf({
        htmlContent: buildPdfHtml(bodyHtml, tmpDir, darkTheme, { title, format: 'A4' }),
        outFile: outDark,
        executablePath,
        format: 'A4',
        bgColor: darkTheme.wrapperBg,
      });

      await exportHtmlToPdf({
        htmlContent: buildPdfHtml(bodyHtml, tmpDir, getTheme('wechat'), { title, format: 'continuous' }),
        outFile: outCont,
        executablePath,
        format: 'continuous',
        bgColor: '#ffffff',
      });

      for (const f of [outClaude, outDark, outCont]) {
        assert.ok(fs.existsSync(f), `PDF 文件应已生成: ${f}`);
        const buf = fs.readFileSync(f);
        assert.strictEqual(buf.slice(0, 5).toString('ascii'), '%PDF-', `应为合法 PDF 文件头: ${f}`);
        assert.ok(buf.length > 5000, `PDF 体积应包含真实字体与矢量内容 (${buf.length} bytes): ${f}`);
      }
      const claudeBuf = fs.readFileSync(outClaude);
      const darkBuf   = fs.readFileSync(outDark);
      assert.notStrictEqual(claudeBuf.equals(darkBuf), true, '不同预览主题导出的 PDF 内容样式应不同');
      console.log(`✓ 端到端 PDF 生成通过: claude=${claudeBuf.length}B, dark=${darkBuf.length}B, continuous=${fs.statSync(outCont).size}B`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
})().catch((e) => {
  console.error('✗', e.stack || e.message);
  process.exit(1);
});
