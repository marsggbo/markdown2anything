// 渲染链路回归：核心 markdown → 各平台 HTML 的转换完整可执行、关键结构存在
// （覆盖 mathjax/katex 数学公式、表格、微信/知乎/小红书导出链）
const assert = require('assert');

// ── 加载真实 lib 模块（项目内 node_modules 完整）──
const path = require('path');
const fs = require('fs');
const os = require('os');
const root = path.join(__dirname, '..');
const { renderMarkdown, buildFullHtml, buildWechatCopyHtml, buildZhihuCopyHtml, buildXhsRenderHtmlByMode } = require(path.join(root, 'lib', 'converter'));
const { getTheme, DEFAULT_THEME_ID } = require(path.join(root, 'lib', 'themes'));

// 写入临时文件（renderMarkdown 需要文件路径）
const MD_FILE = path.join(os.tmpdir(), 'm2a-render-test-' + Date.now() + '.md');
fs.writeFileSync(MD_FILE, `# 标题 H1

正文段落 **加粗** 和 \`行内代码\`。

## 数学公式
行内公式 $E=mc^2$ 与块级：

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

## 表格
| 平台 | 状态 |
| --- | --- |
| 微信 | ✅ |
| 知乎 | ✅ |

- 列表项一
- 列表项二

> 引用文字
`);

function safe(fn, label) {
  try {
    const out = fn();
    const len = typeof out === 'string' ? out.length : (out && (out.bodyHtml || '').length || 0);
    assert.ok(out && len > 100, label + ' 输出过短(len=' + len + ')');
    return out;
  } catch (e) {
    throw new Error(label + ' 抛错: ' + e.message);
  }
}

(async () => {
  // 1. markdown → HTML 渲染（含 KaTeX 数学）
  const md = safe(() => renderMarkdown(MD_FILE), 'renderMarkdown');
  assert.ok(md.rawMarkdown.includes('标题 H1'), 'rawMarkdown 保留原文');
  assert.ok(md.bodyHtml.includes('标题 H1'), 'html 含标题');
  assert.ok(md.bodyHtml.includes('<table'), 'html 含表格');
  assert.ok(md.bodyHtml.includes('<blockquote'), 'html 含引用');
  assert.ok(/katex|math|MathJax|MJX/i.test(md.bodyHtml), '数学公式有渲染标记');
  console.log('✓ renderMarkdown: 标题/表格/引用/数学 结构齐全');

  // 2. 完整 HTML 文档
  const theme = getTheme(DEFAULT_THEME_ID);
  const full = safe(() => buildFullHtml(md.bodyHtml, MD_FILE, { theme, extVersion: '3.4.8-test' }), 'buildFullHtml');
  assert.ok(full.includes('<!DOCTYPE html>') || full.includes('<html'), 'full html 含文档壳');
  console.log('✓ buildFullHtml: 文档壳完整');

  // 3. 微信复制链
  const wechat = safe(() => buildWechatCopyHtml(md.bodyHtml, MD_FILE), 'buildWechatCopyHtml');
  assert.ok(wechat.includes('标题 H1'), '微信链含标题');
  assert.ok(wechat.includes('<table'), '微信链含表格');
  console.log('✓ 微信复制链 OK');

  // 4. 知乎复制链
  const zhihu = safe(() => buildZhihuCopyHtml(md.bodyHtml, MD_FILE), 'buildZhihuCopyHtml');
  assert.ok(zhihu.includes('标题 H1'), '知乎链含标题');
  console.log('✓ 知乎复制链 OK');

  // 5. 小红书渲染（classic 模式）
  const xhs = safe(() => buildXhsRenderHtmlByMode({ html: md.bodyHtml, markdown: MD_FILE, mode: 'classic', theme, adaptiveUseTheme: false }), '小红书渲染');
  assert.ok(xhs.length > 100, '小红书输出长度足够');
  console.log('✓ 小红书渲染链 OK（输出 ' + xhs.length + ' 字符）');

  // 6. markdown → 微信 HTML 文件
  const { convertMarkdownToWeChat } = require(path.join(root, 'lib', 'converter'));
  const outHtml = path.join(os.tmpdir(), 'm2a-wechat-' + Date.now() + '.html');
  safe(() => { convertMarkdownToWeChat(MD_FILE, MD_FILE, outHtml); return fs.readFileSync(outHtml, 'utf8'); }, 'convertMarkdownToWeChat');
  const wcText = fs.readFileSync(outHtml, 'utf8');
  assert.ok(wcText.includes('标题 H1'), '微信输出含标题');
  fs.unlinkSync(outHtml);
  console.log('✓ markdown→微信 HTML OK');

  fs.unlinkSync(MD_FILE);
  console.log('\n✅ 渲染链路回归全部通过');
})().catch(e => { console.error('✗', e.message); process.exit(1); });
