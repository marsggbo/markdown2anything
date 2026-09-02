// 回归测试：图片上下空行清理 + 远程图片内联（知乎/微信粘贴显示）
// 背景：
//  1. markdown 空行渲染成 <p></p>，旧 trimImageBlankParagraphs 只压缩连续多个，
//     单个空段落残留 → 粘贴到微信/知乎后图片上下有空行（移动端阅读体验差）
//  2. 远程 http(s) 图片在 renderMarkdown 阶段被跳过（只转本地文件），
//     粘贴到知乎/微信后外链图片被编辑器拒绝 → 图片不显示
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  renderMarkdown,
  buildWechatCopyHtml,
  buildZhihuCopyHtml,
  inlineRemoteImages,
  trimImageBlankParagraphs,
} = require('../lib/converter');

const EMPTY_P = /<p[^>]*>(?:&nbsp;|\s|<br\s*\/?>)*<\/p>/g;

// ── 1. trimImageBlankParagraphs 单元断言 ──
{
  const input = '<p>第一段</p><p></p><figure><img src="x.png"></figure><p></p><p>第二段</p>';
  const out = trimImageBlankParagraphs(input);
  assert.strictEqual((out.match(EMPTY_P) || []).length, 0, '图片前后单个空段落应删除: ' + out);
}
{
  const input = '<p>a</p><p></p><p></p><p></p><figure><img src="x"></figure><p></p><p></p><p>b</p>';
  const out = trimImageBlankParagraphs(input);
  assert.strictEqual((out.match(EMPTY_P) || []).length, 0, '图片前后多个空段落应全删: ' + out);
}
{
  const input = '<p>a</p><p></p><p></p><p></p><p>b</p>';
  const out = trimImageBlankParagraphs(input);
  assert.strictEqual((out.match(EMPTY_P) || []).length, 1, '非图片区连续空段落压缩为 1: ' + out);
}
console.log('✓ trimImageBlankParagraphs：图片上下空段落全部清除');

// ── 2. inlineRemoteImages：远程图片转 base64，失败保留原 URL ──
(async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const server = http.createServer((req, res) => {
    if (req.url === '/ok.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }
    else { res.writeHead(404); res.end('nope'); }
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    const html =
      `<p>图</p><p></p><img src="http://127.0.0.1:${port}/ok.png" alt="ok"><p></p>` +
      `<p><img src="http://127.0.0.1:${port}/missing.png"></p>`;
    const out = await inlineRemoteImages(html);
    assert.ok(out.includes('data:image/png;base64,'), '远程图片应转 base64 内联');
    assert.ok(out.includes('/missing.png'), '下载失败的图片应保留原 URL');
    console.log('✓ inlineRemoteImages：远程图片内联 base64，失败保底');

    // ── 3. 完整链路：markdown → 复制 HTML（空段落 0 + 图片内联）──
    const mdPath = path.join(os.tmpdir(), `m2a-img-${Date.now()}.md`);
    fs.writeFileSync(mdPath, [
      '# 图片测试',
      '',
      '第一段',
      '',
      `![远程图](http://127.0.0.1:${port}/ok.png)`,
      '',
      '第二段',
      '',
      '结尾',
    ].join('\n'));
    const { bodyHtml } = renderMarkdown(mdPath);
    fs.unlinkSync(mdPath);
    const inlined = await inlineRemoteImages(bodyHtml);

    for (const [name, html] of [
      ['微信复制', buildWechatCopyHtml(inlined, null, null)],
      ['知乎复制', buildZhihuCopyHtml(inlined, null, null)],
    ]) {
      const empties = (html.match(EMPTY_P) || []).length;
      const dataImgs = (html.match(/data:image/g) || []).length;
      const remote = (html.match(/127\.0\.0\.1/g) || []).length;
      assert.strictEqual(empties, 0, `${name}: 图片上下不应有空段落，实际 ${empties}`);
      assert.ok(dataImgs >= 1, `${name}: 应含内联 data 图片，实际 ${dataImgs}`);
      assert.strictEqual(remote, 0, `${name}: 不应残留外链图片 URL，实际 ${remote}`);
      console.log(`✓ ${name}：空段落 0 / 内联图片 ${dataImgs} / 外链残留 ${remote}`);
    }
  } finally {
    server.close();
  }
  console.log('\n✅ 图片空行清理 + 远程图片内联回归检查通过');
})().catch(e => { console.error('✗', e.message); process.exit(1); });
