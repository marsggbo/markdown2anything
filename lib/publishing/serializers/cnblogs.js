'use strict';

const cheerio = require('cheerio');
const { marked } = require('marked');
const { renderAssetMarkers, validateMarkerOrder, validateTargetHtml, validateSerializedHtml } = require('../document');
const { sha256 } = require('../model');
function serializeCnblogs(article, assets, results, jobId) {
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
    if (!asset || !result || result.state !== 'uploaded' || !result.confirmedUrl) throw serialError('ASSET_NOT_CONFIRMED');
    confirmedUrls.push(result.confirmedUrl);
    const replacement = $('<span>').append($('<img>').attr('src', result.confirmedUrl).attr('alt', asset.alt || ''));
    const caption = asset.caption ? $('<p>').text(asset.caption) : null;
    $(element).replaceWith(replacement);
    if (caption) replacement.after(caption);
  });
  const output = $('body').html() || $.html();
  validateSerializedHtml(output, confirmedUrls);
  return `${output}<!-- m2a-publish-job:${jobId} -->`;
}
function normalizedLookupHash(title, description) { return sha256({ title: String(title).trim().replace(/\s+/g, ' '), description: String(description).replace(/\s+/g, ' ') }); }
function serialError(code) { const error = new Error(code); error.code = code; return error; }
module.exports = { serializeCnblogs, normalizedLookupHash };
