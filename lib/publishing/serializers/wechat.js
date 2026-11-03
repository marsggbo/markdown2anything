'use strict';

const cheerio = require('cheerio');
const { marked } = require('marked');
const { renderAssetMarkers, validateMarkerOrder, validateTargetHtml, validateSerializedHtml } = require('../document');

function serializeWechat(article, assets, results) {
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
    const image = $('<img>').attr('src', result.confirmedUrl).attr('alt', asset.alt || '');
    const figure = $('<figure>').append(image);
    if (asset.caption) figure.append($('<figcaption>').text(asset.caption));
    $(element).replaceWith(figure);
  });
  const output = $('body').html() || $.html();
  validateSerializedHtml(output, confirmedUrls);
  return output;
}
function serialError(code) { const error = new Error(code); error.code = code; return error; }
module.exports = { serializeWechat };
