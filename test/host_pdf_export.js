// 单元测试（无需浏览器）：验证 PDF HTML 生成与全部 14 套预览主题的一致性
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { renderMarkdown, buildPdfHtml, scopeThemeCss } = require('../lib/converter');
const { THEMES, getTheme } = require('../lib/themes');
const { isDarkColor } = require('../lib/pdf');

// ── 1. scopeThemeCss：逗号分隔多选择器 & 伪元素 & 注释 ──
{
  const raw = `
    /* 注释不应干扰 */
    p, li, td, th { color: #1a1a1a; }
    h1 + p, h2 + p { text-indent: 0; }
    ul li::before { content: "▸"; }
  `;
  const scoped = scopeThemeCss(raw, '.article-wrapper');
  assert.ok(
    scoped.includes('.article-wrapper p, .article-wrapper li, .article-wrapper td, .article-wrapper th {'),
    '逗号分隔的选择器应逐一加上 .article-wrapper 前缀: ' + scoped
  );
  assert.ok(
    scoped.includes('.article-wrapper h1 + p, .article-wrapper h2 + p {'),
    '相邻兄弟选择器应逐一加前缀: ' + scoped
  );
  assert.ok(
    scoped.includes('.article-wrapper ul li::before {'),
    '伪元素选择器应保留并加前缀: ' + scoped
  );
  assert.ok(!scoped.includes('注释不应干扰'), 'CSS 块注释应被移除');
  console.log('✓ scopeThemeCss：多选择器 / 伪元素 / 相邻选择器均正确加作用域');
}

// ── 2. isDarkColor 暗色背景识别 ──
{
  assert.strictEqual(isDarkColor('#1e1e2e'), true, '深夜极客 #1e1e2e 应识别为暗色');
  assert.strictEqual(isDarkColor('#ffffff'), false, '#ffffff 应识别为浅色');
  assert.strictEqual(isDarkColor('#fffdf7'), false, 'Claude 暖白 #fffdf7 应识别为浅色');
  console.log('✓ isDarkColor：暗色与浅色主题背景识别准确');
}

// ── 3. 全量 14 套主题 PDF HTML 一致性检查 ──
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-pdf-test-'));
  // 写入一张 1x1 本地 PNG 图片，测试图片内联
  const pngBuf = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(path.join(tmpDir, 'dot.png'), pngBuf);
  const mdFile = path.join(tmpDir, 'sample.md');
  fs.writeFileSync(mdFile, [
    '# 主题一致性 PDF 测试',
    '',
    '这是一段包含 **加粗强调**、`inline code` 以及行内公式 $E=mc^2$ 的正文。',
    '',
    '$$',
    '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
    '$$',
    '',
    '![示例图](./dot.png)',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '| 主题 | 状态 |',
    '| --- | --- |',
    '| 全部主题 | ✅ |',
    '',
    '- [x] 已完成任务',
    '- [ ] 待办任务',
    '',
    '> 引用段落样式跟随主题',
  ].join('\n'), 'utf8');

  try {
    const { bodyHtml, title } = renderMarkdown(mdFile);
    assert.strictEqual(title, '主题一致性 PDF 测试');

    // 验证每一套内置主题生成的 PDF HTML 都带有该主题专属的背景色与样式规则
    const themeHtmlSet = new Set();
    for (const theme of THEMES) {
      const html = buildPdfHtml(bodyHtml, tmpDir, theme, {
        title,
        format: 'A4',
        marginPreset: 'normal',
        customCss: '.article-wrapper p.user-custom { color: #123456; }',
      });

      assert.ok(html.includes('<!DOCTYPE html>'), `${theme.id}: 应包含完整 HTML 文档头`);
      assert.ok(html.includes(`background: ${theme.wrapperBg}`), `${theme.id}: 应应用主题背景色 ${theme.wrapperBg}`);
      assert.ok(html.includes('class="pdf-page-bg"'), `${theme.id}: 应包含整页背景铺满层`);
      assert.ok(html.includes('class="pdf-layout-table"'), `${theme.id}: A4 模式应使用分页骨架保证每页上下留白`);
      assert.ok(html.includes('data:font/woff2;base64,'), `${theme.id}: 应内联 KaTeX base64 字体`);
      assert.ok(html.includes('data:image/png;base64,'), `${theme.id}: 本地图片应转为 base64`);
      assert.ok(html.includes('hljs'), `${theme.id}: 代码块应包含 highlight.js 高亮`);
      assert.ok(html.includes('.article-wrapper p.user-custom { color: #123456; }'), `${theme.id}: 应保留用户自定义 CSS`);

      if (theme.id === 'claude-pro') {
        assert.ok(
          html.includes('-webkit-text-fill-color: #92400e !important'),
          'claude-pro 主题应包含 PDF 渐变标题可读性保护'
        );
      }
      themeHtmlSet.add(html);
    }

    assert.strictEqual(themeHtmlSet.size, THEMES.length, `全部 ${THEMES.length} 套主题生成的 PDF HTML 应各具对应主题样式`);
    console.log(`✓ 全部 ${THEMES.length} 套主题 PDF HTML 构建通过，背景色、主题规则、公式字体、代码高亮与自定义样式齐全`);

    // 验证 continuous 无分页模式与 Letter 模式
    const darkTheme = getTheme('dark');
    const contHtml = buildPdfHtml(bodyHtml, tmpDir, darkTheme, { format: 'continuous', marginPreset: 'compact' });
    assert.ok(contHtml.includes('class="pdf-continuous-wrap"'), 'continuous 模式应使用连续长页容器');
    assert.ok(!contHtml.includes('<table class="pdf-layout-table"'), 'continuous 模式不应包含分页 table 骨架');

    const letterHtml = buildPdfHtml(bodyHtml, tmpDir, darkTheme, { format: 'Letter', marginPreset: 'wide' });
    assert.ok(letterHtml.includes('size: Letter'), 'Letter 模式应设置 @page size: Letter');
    console.log('✓ A4 / Letter / continuous 多规格布局分支验证通过');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log('\n✅ PDF 主题渲染逻辑测试全部通过');
