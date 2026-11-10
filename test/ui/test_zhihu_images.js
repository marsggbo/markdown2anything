'use strict';

// 本地编辑器夹具：验证真实 file input / paste / 图片加载和位置校验，不访问知乎账号。
const assert = require('assert');
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const { prepareEditor } = require('../../lib/zhihu-browser');

const png = new PNG({ width: 1, height: 1 });
png.data.set([255, 0, 0, 255]);
const buffer = PNG.sync.write(png);
const src = `data:image/png;base64,${buffer.toString('base64')}`;

(async () => {
  const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
  try {
    const page = await browser.newPage();
    await page.route('https://pic4.zhimg.com/**', route => route.fulfill({ body: buffer, contentType: 'image/png' }));
    async function fixture(mode = 'normal') {
      await page.setContent(`<div contenteditable="true" id="editor"></div>
        <input type="file" accept="image/*"><script>(() => {
        window.uploads = 0;
        const editor = document.getElementById('editor');
        document.querySelector('input').addEventListener('change', () => {
          window.uploads++;
          if (${JSON.stringify(mode)} === 'timeout') return;
          const img = document.createElement('img');
          img.src = 'https://pic4.zhimg.com/upload-' + window.uploads + '.png';
          editor.append(img);
        });
        editor.addEventListener('paste', event => {
          event.preventDefault();
          editor.innerHTML = event.clipboardData.getData('text/html');
          if (${JSON.stringify(mode)} === 'append') editor.querySelectorAll('img').forEach(img => editor.append(img));
          if (${JSON.stringify(mode)} === 'missing') editor.querySelector('img').remove();
        });
      })();</script>`);
      return page.locator('#editor');
    }
    const html = `<p>第一段</p><img src="${src}" alt="图注一"><p>中间一段</p>` +
      `<img src="${src}" alt="图注二"><p>最后一段</p>`;
    let editor = await fixture();
    const result = await prepareEditor(page, editor, html, { uploadTimeoutMs: 1500, verifyTimeoutMs: 1500 });
    assert.strictEqual(result.total, 2);
    assert.strictEqual(await page.evaluate(() => window.uploads), 1);
    assert.deepStrictEqual(
      await editor.locator('img').evaluateAll(imgs => imgs.map(img => img.alt)), ['图注一', '图注二']
    );
    console.log('✓ 真实浏览器上传去重并原位插入重复图片');

    editor = await fixture('append');
    await assert.rejects(
      prepareEditor(page, editor, html, { uploadTimeoutMs: 1500, verifyTimeoutMs: 600 }), /回读校验失败/
    );
    console.log('✓ 图片顺序未变但全在文末时不能就绪');
    editor = await fixture('missing');
    await assert.rejects(
      prepareEditor(page, editor, html, { uploadTimeoutMs: 1500, verifyTimeoutMs: 600 }), /回读校验失败/
    );
    console.log('✓ 粘贴漏图不能就绪');
    editor = await fixture('timeout');
    await assert.rejects(prepareEditor(page, editor, html, { uploadTimeoutMs: 600 }), /上传超时/);
    assert.strictEqual(await page.evaluate(() => window.uploads), 1);
    console.log('✓ 上传超时中断，不继续粘贴正文或处理下一张');
    editor = await fixture();
    await editor.fill('已有文章内容');
    await assert.rejects(prepareEditor(page, editor, html), /编辑器已有内容/);
    assert.strictEqual(await editor.innerText(), '已有文章内容');
    assert.strictEqual(await page.evaluate(() => window.uploads), 0);
    console.log('✓ 非空编辑器保留原文，不开始上传或覆盖');
  } finally { await browser.close(); }
})().catch(err => { console.error('✗', err.stack); process.exitCode = 1; });
