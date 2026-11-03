'use strict';

const path = require('path');
const matter = require('gray-matter');
const cheerio = require('cheerio');
const { assetIdFor, sha256 } = require('./model');

const ALLOWED_RAW_ELEMENTS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul', 'm2a-asset']);
const GLOBAL_ATTRIBUTES = new Set(['title']);
const ELEMENT_ATTRIBUTES = Object.freeze({ a: new Set(['href', 'title']), ol: new Set(['start']), li: new Set(['value']), td: new Set(['colspan', 'rowspan', 'align']), th: new Set(['colspan', 'rowspan', 'align']), 'm2a-asset': new Set(['data-asset-id']) });
const FORBIDDEN_ELEMENTS = /<(?:script|style|iframe|object|embed|svg|video|audio|source|track|link|form)\b/i;
const URL_ATTRIBUTES = new Set(['src', 'srcset', 'poster', 'action', 'srcdoc', 'background']);

function documentError(code, details) { const error = new Error(code); error.code = code; if (details) error.details = details; return error; }

function parseSavedDocument(source, options) {
  if (typeof source !== 'string') throw documentError('INVALID_SOURCE');
  options = options || {};
  const parsed = matter(source);
  rejectSecretFrontMatter(parsed.data);
  const content = parsed.content;
  if (/<m2a-asset\b/i.test(content)) throw documentError('UNMODELED_IMAGE_SOURCE');
  const protectedRanges = protectedSourceRanges(content);
  const occurrences = collectOccurrences(content, protectedRanges);
  occurrences.sort((a, b) => a.start - b.start);
  assertNoOverlap(occurrences);
  const assets = occurrences.map((occurrence, bodyOrder) => createAsset(occurrence, content, bodyOrder, options.documentPath));
  const segments = [];
  let cursor = 0;
  occurrences.forEach((occurrence, index) => {
    if (occurrence.start > cursor) segments.push({ kind: 'text', value: content.slice(cursor, occurrence.start) });
    segments.push({ kind: 'asset', assetId: assets[index].assetId });
    cursor = occurrence.end;
  });
  if (cursor < content.length || !segments.length) segments.push({ kind: 'text', value: content.slice(cursor) });
  validateSourceHtml(content, occurrences, protectedRanges);
  const title = deriveTitle({ frontMatter: parsed.data, content, documentPath: options.documentPath, title: options.title, titleOverride: options.titleOverride });
  return {
    frontMatter: parsed.data,
    article: {
      title: title.value, titleSource: title.source,
      author: optionalString(options.author !== undefined ? options.author : parsed.data.author),
      digest: optionalString(options.digest !== undefined ? options.digest : (parsed.data.digest || parsed.data.summary)),
      coverAssetId: null,
      body: { segments, plainText: plainText(content, occurrences) },
    },
    assets,
    sourceInputs: Object.fromEntries(assets.map(asset => [asset.assetId, asset.inputSource])),
  };
}

function deriveTitle({ frontMatter, content, documentPath, title, titleOverride }) {
  if (nonBlank(titleOverride)) return { value: titleOverride.trim(), source: 'uiOverride' };
  if (nonBlank(title)) return { value: title.trim(), source: 'uiOverride' };
  if (frontMatter && nonBlank(frontMatter.title)) return { value: String(frontMatter.title).trim(), source: 'frontMatter' };
  const line = content.split(/\r?\n/).find(value => /^\s{0,3}#(?!#)\s+\S/.test(value));
  if (line) return { value: line.replace(/^\s{0,3}#\s+/, '').replace(/\s+#*\s*$/, '').trim(), source: 'h1' };
  const fallback = documentPath ? path.basename(documentPath, path.extname(documentPath)).trim() : '';
  if (nonBlank(fallback)) return { value: fallback, source: 'filename' };
  throw documentError('MISSING_TITLE');
}
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function optionalString(value) { return value === undefined || value === null ? null : String(value); }
function rejectSecretFrontMatter(value, key) {
  if (Array.isArray(value)) return value.forEach(item => rejectSecretFrontMatter(item, key));
  if (value && typeof value === 'object') return Object.keys(value).forEach(child => rejectSecretFrontMatter(value[child], child));
  if (key && /(?:appsecret|token|authorization|cookie|password|publishing.*secret|publishing.*token)/i.test(key)) throw documentError('UNSAFE_RAW_HTML');
}

function protectedSourceRanges(content) {
  const ranges = [];
  const lines = content.match(/.*(?:\r?\n|$)/g) || [];
  let offset = 0; let fence = null;
  lines.forEach(line => {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) { ranges.push([offset, offset + line.length]); if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null; offset += line.length; return; }
    if (fenceMatch) { fence = fenceMatch[1]; ranges.push([offset, offset + line.length]); }
    else if (/^(?: {4}|\t)/.test(line)) ranges.push([offset, offset + line.length]);
    offset += line.length;
  });
  let commentStart = -1; let ticks = -1;
  for (let i = 0; i < content.length; i++) {
    if (content.startsWith('<!--', i)) { commentStart = i; i += 3; continue; }
    if (commentStart >= 0 && content.startsWith('-->', i)) { ranges.push([commentStart, i + 3]); commentStart = -1; i += 2; continue; }
    if (commentStart >= 0) continue;
    if (content[i] === '`') {
      let width = 1; while (content[i + width] === '`') width++;
      const marker = '`'.repeat(width); const close = content.indexOf(marker, i + width);
      if (close >= 0) { ranges.push([i, close + width]); i = close + width - 1; }
      else if (ticks < 0) ticks = i;
      continue;
    }
  }
  if (commentStart >= 0) ranges.push([commentStart, content.length]);
  return ranges;
}
function protectedAt(index, ranges) { return ranges.some(range => index >= range[0] && index < range[1]); }
function escaped(content, index) { let slashes = 0; for (let p = index - 1; p >= 0 && content[p] === '\\'; p--) slashes++; return slashes % 2 === 1; }

function collectOccurrences(content, ranges) {
  const occurrences = [];
  const markdown = /!\[([^\]]*)\]\(\s*(<[^>\n]+>|(?:\\.|[^\s)])+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*\)/g;
  let match;
  while ((match = markdown.exec(content))) {
    if (protectedAt(match.index, ranges) || escaped(content, match.index)) continue;
    const rawSource = match[2].startsWith('<') ? match[2].slice(1, -1) : unescapeMarkdownDestination(match[2]);
    occurrences.push({ kind: 'markdown', start: match.index, end: markdown.lastIndex, source: rawSource, alt: match[1], caption: match[3] || match[4] || match[5] || null });
  }
  const html = /<img\b[^>]*>/gi;
  while ((match = html.exec(content))) {
    if (protectedAt(match.index, ranges) || escaped(content, match.index)) continue;
    const attrs = parseImgAttributes(match[0]);
    const caption = figureCaptionFor(content, match.index, html.lastIndex) || attrs.title || null;
    occurrences.push({ kind: 'html', start: match.index, end: html.lastIndex, source: attrs.src, alt: attrs.alt || '', caption, dimensions: dimensionsFromAttributes(attrs) });
  }
  return occurrences;
}
function unescapeMarkdownDestination(value) { return value.replace(/\\([()\\])/g, '$1'); }
function parseImgAttributes(tag) {
  const attrs = {}; const seen = new Set();
  const rest = tag.replace(/^<img\b/i, '').replace(/>$/, '');
  const attr = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attr.exec(rest))) {
    const name = match[1].toLowerCase();
    if (name === '/') continue;
    if (seen.has(name) || !['src', 'alt', 'title', 'width', 'height'].includes(name)) throw documentError(name === 'srcset' || URL_ATTRIBUTES.has(name) ? 'UNMODELED_IMAGE_SOURCE' : 'UNSUPPORTED_IMAGE_ATTRIBUTE');
    seen.add(name); attrs[name] = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : (match[4] !== undefined ? match[4] : ''));
  }
  if (!nonBlank(attrs.src)) throw documentError('UNMODELED_IMAGE_SOURCE');
  if ((attrs.alt && Buffer.byteLength(attrs.alt, 'utf8') > 4096) || (attrs.title && Buffer.byteLength(attrs.title, 'utf8') > 4096)) throw documentError('UNSUPPORTED_IMAGE_ATTRIBUTE');
  return attrs;
}
function dimensionsFromAttributes(attrs) {
  const dimensions = {};
  for (const key of ['width', 'height']) if (attrs[key] !== undefined) { if (!/^\d+$/.test(attrs[key]) || Number(attrs[key]) < 1 || Number(attrs[key]) > 100000) throw documentError('UNSUPPORTED_IMAGE_ATTRIBUTE'); dimensions[key] = Number(attrs[key]); }
  return Object.keys(dimensions).length ? dimensions : null;
}
function figureCaptionFor(content, start, end) {
  const open = content.lastIndexOf('<figure', start);
  if (open < 0 || content.lastIndexOf('</figure>', start) > open) return null;
  const close = content.indexOf('</figure>', end);
  if (close < 0) return null;
  const section = content.slice(open, close + 9); const match = section.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
  return match ? cheerio.load(match[1]).text().trim() || null : null;
}
function assertNoOverlap(occurrences) { for (let index = 1; index < occurrences.length; index++) if (occurrences[index].start < occurrences[index - 1].end) throw documentError('UNMODELED_IMAGE_SOURCE'); }
function createAsset(occurrence, content, bodyOrder, documentPath) {
  const source = describeSource(occurrence.source, documentPath);
  return {
    assetId: assetIdFor(bodyOrder), role: 'body', bodyOrder, syntax: occurrence.kind,
    source, alt: occurrence.alt || null, caption: occurrence.caption || null, dimensions: occurrence.dimensions || null,
    acquisition: 'pending', cachePath: null, mime: null, byteLength: null, contentSha256: null, targetResults: {}, error: null,
    inputSource: occurrence.source,
  };
}
function describeSource(input, documentPath) {
  if (/^data:/i.test(input)) return { kind: 'data', mime: (input.match(/^data:([^;,]+)/i) || [])[1] || null, sha256: sha256(input) };
  try { const url = new URL(input); if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'remote', origin: url.origin, pathname: url.pathname, urlSha256: sha256(url.toString()) }; } catch (_) {}
  return { kind: 'local', path: path.normalize(path.resolve(documentPath ? path.dirname(documentPath) : process.cwd(), input)) };
}
function plainText(content, occurrences) { let output = ''; let cursor = 0; occurrences.forEach(occurrence => { output += content.slice(cursor, occurrence.start); cursor = occurrence.end; }); return (output + content.slice(cursor)).replace(/<[^>]+>/g, '').replace(/[#*_`]/g, '').trim(); }

function renderAssetMarkers(article) {
  if (!article || !article.body || !Array.isArray(article.body.segments)) throw documentError('INVALID_BODY');
  return article.body.segments.map(segment => segment.kind === 'asset' ? `<m2a-asset data-asset-id="${segment.assetId}"></m2a-asset>` : segment.value).join('');
}
function validateMarkerOrder(html, expectedAssetIds) {
  const $ = cheerio.load(html, { xmlMode: false, decodeEntities: false });
  const actual = $('m2a-asset').map((_, element) => $(element).attr('data-asset-id')).get();
  if (actual.length !== expectedAssetIds.length || actual.some((value, index) => value !== expectedAssetIds[index])) throw documentError('INVALID_BODY_ASSET_ORDER');
  return true;
}
function validateSourceHtml(content, occurrences, ignoredRanges) {
  const skipRanges = (occurrences || []).map(item => [item.start, item.end]).concat(ignoredRanges || []);
  const tag = /<\/?([A-Za-z][\w-]*)\b([^>]*)>/g; let match;
  while ((match = tag.exec(content))) {
    if (skipRanges.some(range => match.index >= range[0] && match.index < range[1])) continue;
    const name = match[1].toLowerCase();
    if (FORBIDDEN_ELEMENTS.test(match[0]) || !ALLOWED_RAW_ELEMENTS.has(name)) throw documentError('UNSAFE_RAW_HTML');
    validateRawAttributes(name, match[2]);
  }
  return true;
}
function validateRawAttributes(name, source) {
  const attr = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g; let match;
  while ((match = attr.exec(source))) {
    const key = match[1].toLowerCase(); if (key === '/') continue;
    if (key.startsWith('on') || URL_ATTRIBUTES.has(key) || key === 'style') throw documentError('UNSAFE_RAW_HTML');
    const allowed = GLOBAL_ATTRIBUTES.has(key) || (ELEMENT_ATTRIBUTES[name] && ELEMENT_ATTRIBUTES[name].has(key));
    if (!allowed) throw documentError('UNSUPPORTED_IMAGE_ATTRIBUTE');
    const value = match[2] || match[3] || match[4] || '';
    if (key === 'href' && !safeHref(value)) throw documentError('UNSAFE_RAW_HTML');
  }
}
function safeHref(value) { try { const url = new URL(value, 'https://m2a.invalid'); return ['http:', 'https:', 'mailto:'].includes(url.protocol); } catch (_) { return false; } }
function validateTargetHtml(html, expectedAssetIds) { validateMarkerOrder(html, expectedAssetIds || []); validateSourceHtml(html, []); return true; }

module.exports = {
  parseSavedDocument, parseDocument: parseSavedDocument, deriveTitle, renderAssetMarkers,
  validateMarkerOrder, validateTargetHtml, describeSource, protectedSourceRanges,
};
