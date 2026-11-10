'use strict';

const cheerio = require('cheerio');
const { prepareImages, uploadImages, imageSources, contentSignature, isZhihuImageUrl } = require('./publish-images');

async function clearEditor(page, editor) {
  await editor.click();
  await editor.evaluate(el => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press('Backspace');
  // 通过编辑器事件更新 Draft.js 状态，禁止直接删除 DOM 节点。
  await editor.evaluate(el => {
    if ((el.innerText || '').trim() || el.querySelector('img')) {
      throw new Error('无法清空知乎编辑器，已停止');
    }
  });
}

async function prepareEditor(page, editor, html, {
  baseDir, cache = {}, onProgress, onCache,
  uploadTimeoutMs = 60000, verifyTimeoutMs = 30000,
} = {}) {
  const occupied = await editor.evaluate(el => !!((el.innerText || '').trim() || el.querySelector('img')));
  if (occupied) throw new Error('编辑器已有内容，已停止覆盖；请创建空白草稿后重试');
  const plan = await prepareImages(html, { baseDir });
  await clearEditor(page, editor);
  const result = await uploadImages(plan, async asset => {
    const known = await editor.locator('img').evaluateAll(imgs => imgs.map(img => img.getAttribute('src') || ''));
    const input = page.locator('input[type="file"][accept*="image"]').first();
    await input.setInputFiles({
      name: asset.name, mimeType: asset.mimeType, buffer: asset.buffer,
    }, { timeout: uploadTimeoutMs });
    const deadline = Date.now() + uploadTimeoutMs;
    while (Date.now() < deadline) {
      const candidates = await editor.locator('img').evaluateAll(imgs => imgs
        .filter(img => img.complete && img.naturalWidth > 0)
        .map(img => img.getAttribute('src') || ''));
      const urls = candidates.filter(url => isZhihuImageUrl(url) && !known.includes(url));
      if (urls.length === 1) return urls[0];
      if (urls.length > 1) throw new Error('图片上传结果无法唯一对应，已停止以免错配');
      await page.waitForTimeout(300);
    }
    // 一张超时后不能继续下一张，否则迟到的上传结果可能被误认成下一张。
    throw new Error('图片上传超时，未继续上传后续图片');
  }, {
    cache,
    onProgress: (done, total) => {
      if (onCache) onCache(cache);
      if (onProgress) onProgress(done, total);
    },
  });

  await clearEditor(page, editor);
  const $ = cheerio.load(result.html, null, false);
  const plain = $.root().text();
  await editor.evaluate((el, { html: h, plain: p }) => {
    el.focus();
    const data = new DataTransfer();
    data.setData('text/html', h);
    data.setData('text/plain', p);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { html: result.html, plain });

  const expected = imageSources(result.html);
  const expectedSignature = contentSignature(result.html);
  const deadline = Date.now() + verifyTimeoutMs;
  while (Date.now() < deadline) {
    const actual = await editor.evaluate(el => {
      function visit(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (node.nodeName === 'IMG') return node.hasAttribute('eeimg') ? '' : `\ufffc${node.getAttribute('src')}\ufffc`;
        return [...node.childNodes].map(visit).join('');
      }
      return {
        signature: visit(el).replace(/[\s\u200b\ufeff]/g, ''),
        images: [...el.querySelectorAll('img')].filter(img => !img.hasAttribute('eeimg')).map(img => ({
          src: img.getAttribute('src') || '',
          loaded: img.complete && img.naturalWidth > 0,
        })),
        failed: !!el.querySelector('.Editable-imageUploader.is-error'),
      };
    });
    if (!actual.failed && actual.signature === expectedSignature &&
        actual.images.length === expected.length &&
        actual.images.every((img, i) => img.loaded && img.src === expected[i])) {
      return result;
    }
    await page.waitForTimeout(300);
  }
  throw new Error('正文或图片回读校验失败（数量、顺序或加载状态不符），未标记就绪');
}

module.exports = { prepareEditor };
