'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');
const cheerio = require('cheerio');

function plainText(markdown, { prose = false } = {}) {
  if (typeof markdown !== 'string' || !markdown.trim()) return '';
  const $ = cheerio.load(marked.parse(markdown, { async: false }), null, false);
  $('script, style, template, noscript, img, svg').remove();
  if (prose) $('pre, code, h1, h2, h3, h4, h5, h6').remove();
  $('br').replaceWith(' ');
  $('p, div, li, blockquote').append(' ');
  return $.root().text().replace(/\s+/gu, ' ').trim();
}

function list(value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，;；|、\n]+/u) : [];
  return [...new Set(items.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

async function localCover(data, baseDir) {
  for (const value of [data.cover, data.coverImage]) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    // Even file: URLs are excluded: metadata only suggests ordinary local paths.
    if (!name || (!path.isAbsolute(name) && /^[a-z][a-z0-9+.-]*:/i.test(name)) || /^[/\\]{2}/.test(name)) continue;
    const resolved = path.resolve(baseDir, name);
    try {
      if ((await fs.promises.stat(resolved)).isFile()) return resolved;
    } catch (_) { /* A missing optional cover is not a metadata extraction error. */ }
  }
  return '';
}

/**
 * Derive document suggestions locally. No host defaults, persistence, body
 * rewriting, media loading, or network requests belong in this function.
 * Summary length is measured in Unicode code points, as in WeChat validation.
 */
async function deriveMetadata(sourcePath) {
  const raw = await fs.promises.readFile(sourcePath, 'utf8');
  const { data, content } = matter(raw);
  const tokens = marked.lexer(content);
  const headings = tokens.filter(token => token.type === 'heading');
  const heading = headings.find(token => token.depth === 1) || headings[0];
  const frontTitle = plainText(data.title);
  const headingTitle = heading ? plainText(heading.text) : '';
  const title = frontTitle || headingTitle || path.basename(sourcePath, path.extname(sourcePath));

  let summary = '';
  let summarySource = '';
  for (const key of ['summary', 'description', 'excerpt']) {
    summary = plainText(data[key], { prose: true });
    if (summary) { summarySource = `frontmatter.${key}`; break; }
  }
  if (!summary) {
    const $ = cheerio.load(marked.parse(content, { async: false }), null, false);
    const paragraphs = [];
    for (const node of $('p').toArray()) {
      // Lists, quotations and table cells are not introductory prose.
      if ($(node).parents('pre, blockquote, li, table, script, style, template').length) continue;
      const text = plainText($.html(node), { prose: true });
      if (!text) continue;
      paragraphs.push(text);
      if (Array.from(paragraphs.join(' ')).length >= 120) break;
    }
    summary = paragraphs.join(' ');
    if (summary) summarySource = 'prose';
  }
  const author = typeof data.author === 'string' ? data.author :
    data.author && typeof data.author.name === 'string' ? data.author.name : '';
  return {
    title, summary: Array.from(summary).slice(0, 120).join(''),
    author: plainText(author),
    coverPath: await localCover(data, path.dirname(path.resolve(sourcePath))),
    tags: list(data.tags), categories: list(data.categories),
    titleSource: frontTitle ? 'frontmatter.title' : headingTitle ? 'heading' : 'basename',
    summarySource,
  };
}

module.exports = { deriveMetadata };
