'use strict';

const cheerio = require('cheerio');
const { prepareImages } = require('../publish-images');
const { safeUrl, failure } = require('./http');

async function mapImages(html, { baseDir, cache = {}, upload, onProgress, saveCache } = {}) {
  const plan = await prepareImages(html, { baseDir, reuseUrl: () => false });
  const $ = cheerio.load(plan.html, null, false);
  let done = 0;
  let index = 0;
  for (const asset of plan.assets) {
    index++;
    let result = cache[asset.id];
    if (!result || !safeUrl(result.url)) {
      if (onProgress) onProgress(`正在上传图片 ${index}/${plan.assets.length}（${Math.max(1, Math.ceil(asset.buffer.length / 1024))} KB）`);
      result = await upload(asset);
      if (!result || !safeUrl(result.url)) throw failure('图片上传未返回有效的 HTTPS 地址');
      cache[asset.id] = result;
      if (saveCache) await saveCache();
    }
    for (const ref of plan.references.filter(item => item.assetId === asset.id)) {
      const img = $(`img[data-m2a-image-ref="${ref.id}"]`);
      const caption = img.attr('data-caption') || img.attr('alt') || '';
      if (result.attrs) img.attr(result.attrs);
      img.attr('src', result.url).removeAttr('srcset').removeAttr('sizes').removeAttr('data-m2a-image-ref');
      if (result.attrs && Object.hasOwn(result.attrs, 'data-caption')) img.attr('data-caption', caption);
      done++;
    }
    if (onProgress) onProgress(`已确认正文图片 ${done}/${plan.references.length}`);
  }
  if ($('img[data-m2a-image-ref]').length) throw failure('正文图片映射不完整');
  return { html: $.html(), count: plan.references.length };
}

async function coverAsset(filePath, baseDir) {
  if (!filePath) throw failure('请选择公众号封面图片');
  const $ = cheerio.load('<img>', null, false);
  $('img').attr('src', filePath);
  const plan = await prepareImages($.html(), { baseDir, reuseUrl: () => false });
  return plan.assets[0];
}

module.exports = { mapImages, coverAsset };
