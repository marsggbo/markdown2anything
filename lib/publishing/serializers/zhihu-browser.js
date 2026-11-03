'use strict';

const cheerio = require('cheerio');
const { marked } = require('marked');
const { renderAssetMarkers, validateMarkerOrder, validateTargetHtml, validateSerializedHtml } = require('../document');
function isZhihuImage(value) { try { const host = new URL(value).hostname; return host === 'zhimg.com' || host.endsWith('.zhimg.com'); } catch (_) { return false; } }
function serializeZhihuBrowser(article, assets, results) {
  const ids = assets.filter(asset => asset.role === 'body').map(asset => asset.assetId);
  const markdown = renderAssetMarkers(article);
  validateTargetHtml(markdown, ids);
  const $ = cheerio.load(marked.parse(markdown), { decodeEntities: false });
  const rendered = $('body').html() || $.html();
  validateTargetHtml(rendered, ids);
  validateMarkerOrder(rendered, ids);
  const confirmedUrls = [];
  $('m2a-asset').each((_, element) => {
    const id = $(element).attr('data-asset-id');
    const asset = assets.find(item => item.assetId === id);
    const result = results && results[id];
    if (!asset || !result || result.state !== 'uploaded' || !isZhihuImage(result.confirmedUrl)) throw serialError('ASSET_NOT_CONFIRMED');
    confirmedUrls.push(result.confirmedUrl);
    const replacement = $('<p>').append($('<img>').attr({ src: result.confirmedUrl, alt: asset.alt || '', 'data-size': 'normal', 'data-watermark': 'original' }));
    const caption = asset.caption ? $('<p>').text(asset.caption) : null;
    $(element).replaceWith(replacement);
    if (caption) replacement.after(caption);
  });
  const output = $('body').html() || $.html();
  validateSerializedHtml(output, confirmedUrls);
  return output;
}
function serialError(code) { const error = new Error(code); error.code = code; return error; }
module.exports = { serializeZhihuBrowser, isZhihuImage };
