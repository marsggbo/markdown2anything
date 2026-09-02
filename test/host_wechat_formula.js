// 回归测试：微信公式在复制/导出两条链路都必须转成内联 SVG
// 背景：导出 HTML（buildFullHtml）曾用 KaTeX HTML + 去掉 @font-face 的 CSS，
//       粘贴到无 KaTeX 字体的网页后公式渲染为空白/消失；复制链（buildWechatCopyHtml）
//       一直转内联 SVG。本测试断言两条链路都产出 SVG 且不残留 KaTeX 依赖。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { renderMarkdown, buildWechatCopyHtml, buildFullHtml } = require('../lib/converter');

function mdWithFormulas() {
  const f = path.join(os.tmpdir(), `m2a-fmt-${Date.now()}.md`);
  fs.writeFileSync(f, [
    '# 公式回归测试',
    '',
    '行内公式 $E=mc^2$，块级：',
    '',
    '$$\\frac{a}{b} + \\sqrt{x} + \\int_0^1 x dx$$',
  ].join('\n'));
  const { bodyHtml } = renderMarkdown(f);
  fs.unlinkSync(f);
  return bodyHtml;
}

const bodyHtml = mdWithFormulas();
assert.ok((bodyHtml.match(/data-math/g) || []).length === 2, 'markdown 应产出 2 个公式元素');

// ── 复制路径 ──
const copyHtml = buildWechatCopyHtml(bodyHtml, null, null);
const copySvg = (copyHtml.match(/<svg/g) || []).length;
const copyKatex = (copyHtml.match(/class="katex/g) || []).length;
const copyZhihu = (copyHtml.match(/zhihu\.com\/equation/g) || []).length;
assert.strictEqual(copySvg, 2, `复制链应产出 2 个内联 SVG，实际 ${copySvg}`);
assert.strictEqual(copyKatex, 0, `复制链不应残留 KaTeX HTML，实际 ${copyKatex}`);
assert.strictEqual(copyZhihu, 0, `复制链不应降级到 zhihu 公式图片，实际 ${copyZhihu}`);
console.log('✓ 复制链：2 SVG / 0 KaTeX / 0 zhihu 降级');

// ── 导出路径（修复：公式转 SVG，不依赖 KaTeX 字体）──
const templatePath = path.join(__dirname, '..', 'templates', 'wechat.html');
const fullHtml = buildFullHtml(bodyHtml, templatePath);
const fullSvg = (fullHtml.match(/<svg/g) || []).length;
const fullKatex = (fullHtml.match(/class="katex/g) || []).length;
const fullZhihu = (fullHtml.match(/zhihu\.com\/equation/g) || []).length;
assert.strictEqual(fullSvg, 2, `导出链应产出 2 个内联 SVG，实际 ${fullSvg}`);
assert.strictEqual(fullKatex, 0, `导出链不应残留 KaTeX HTML（否则粘贴到无字体网页公式消失），实际 ${fullKatex}`);
assert.strictEqual(fullZhihu, 0, `导出链不应降级到 zhihu 公式图片，实际 ${fullZhihu}`);
console.log('✓ 导出链：2 SVG / 0 KaTeX / 0 zhihu 降级');

// 复杂公式也不降级（矩阵/求和/希腊字母）
const f2 = path.join(os.tmpdir(), `m2a-fmt2-${Date.now()}.md`);
fs.writeFileSync(f2, [
  '$$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$$',
  '',
  '$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$',
  '',
  '$$\\alpha + \\beta = \\gamma$$',
].join('\n'));
const { bodyHtml: bh2 } = renderMarkdown(f2);
fs.unlinkSync(f2);
const copy2 = buildWechatCopyHtml(bh2, null, null);
assert.strictEqual((copy2.match(/zhihu\.com\/equation/g) || []).length, 0, '复杂公式不应降级到 zhihu 图片');
assert.strictEqual((copy2.match(/<svg/g) || []).length, 3, '复杂公式应全部转 SVG');
console.log('✓ 复杂公式：3 个全部转 SVG，无降级');

// \bm 粗体公式：MathJax 发行版无 bm 宏包，曾被当作未知命令渲染成红色 "bm"
// 修复后 \bm/\boldsymbol/\pmb 都应是正常粗体 SVG，不含 fill="red"
const f3 = path.join(os.tmpdir(), `m2a-fmt3-${Date.now()}.md`);
fs.writeFileSync(f3, [
  '$$\\bm{x} + \\boldsymbol{y} + \\pmb{z}$$',
  '',
  '$$\\hat{\\bm{\\mu}} + \\bm{\\alpha}$$',
].join('\n'));
const { bodyHtml: bh3 } = renderMarkdown(f3);
fs.unlinkSync(f3);
const copy3 = buildWechatCopyHtml(bh3, null, null);
assert.ok(!copy3.includes('fill="red"'), '\\bm 不应渲染成红色未知命令文字');
assert.strictEqual((copy3.match(/<svg/g) || []).length, 2, '\\bm 公式应正常转 SVG');
console.log('✓ \\bm/\\boldsymbol/\\pmb：2 个公式正常粗体渲染，无红色降级');

console.log('\n✅ 微信公式 SVG 回归检查通过');
