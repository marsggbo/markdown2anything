'use strict';

const cheerio = require('cheerio');
const { safeUrl, failure } = require('./http');
const { mapImages } = require('./media');
const { ORIGIN, credentials, api } = require('./zhihu-client');
const { uploadImage } = require('./zhihu-media');

const COMMENTS = new Set(['all', 'nobody', 'followee', 'censor', 'follower']);
const STATEMENTS = new Set(['spoiler', 'medical_advice', 'fictional_creation', 'contain_finance', 'ai_creation']);
const LANGUAGES = new Set((
  'abap abnf as as3 ada adl agda alloy at antlr apacheconf apl applescript arduino aspectj aspx-cs aspx-vb asy ' +
  'ahk autoit awk basemake bash console bat bbcode bc befunge blitzbasic blitzmax bnf boo boogie brainfuck bro bugs ' +
  'c c-objdump csharp cpp ca65 cadl camkes cbmbas ceylon cfengine3 cfs chai chapel cheetah cirru clay clojure ' +
  'clojurescript cmake cobol cobolfree coffee-script cfc cfm common-lisp componentpascal coq cpp-objdump cpsa crmsh ' +
  'croc cryptol csound-document csound-score css cuda cypher cython d d-objdump dpatch dart control sourceslist ' +
  'delphi dg diff django docker dtd duel dylan dylan-console dylan-lid earl-grey easytrieve ebnf ec ecl eiffel ' +
  'elixir iex elm emacs ragel-em erb erlang erl evoque ezhil factor fancy fan felix fish fortran fortranfixed ' +
  'foxpro fsharp gap gas genshi genshitext pot cucumber glsl gnuplot go golo gooddata-cl gosu gst groff groovy ' +
  'haml handlebars haskell hx hexdump html html+django html+handlebars http haxeml hylang hybris idl idris igor ' +
  'inform6 i6t inform7 ini io ioke irc isabelle j jade jags jasmin java jsp js jcl json jsonld julia jlcon kal ' +
  'kconfig koka kotlin lasso lean less lighty limbo liquid lagda lcry lhs lidr live-script llvm logos logtalk ' +
  'lsl lua make mako maql mask mason mathematica matlab matlabsession minid modelica modula2 trac-wiki monkey ' +
  'moocode moon mozhashpreproc mozpercentpreproc mql mscgen doscon mupad mxml myghty mysql nasm nemerle nesc ' +
  'newlisp newspeak nginx nimrod nit nixos nsis numpy objdump objdump-nasm objective-c objective-c++ objective-j ' +
  'ocaml octave odin ooc opa openedge pacmanconf pan parasail pawn perl perl6 php pig pike pkgconfig plpgsql ' +
  'psql postgresql postscript pov powershell ps1con praat prolog properties protobuf puppet pypylog python ' +
  'python3 py3tb pycon pytb qbasic qml qvto racket ragel rconsole rd rebol red redcode registry resource rst ' +
  'rexx rhtml roboconf-graph roboconf-instances robotframework spec rql rsl rb rbcon rust splus sass scala ssp ' +
  'scaml scheme scilab scss shen slim smali smalltalk smarty snobol sp sparql sql sqlite3 squidconf stan sml ' +
  'sc swift swig systemverilog tads3 tap tcl tcsh tcshcon tea termcap terminfo terraform tex text thrift todotxt ' +
  'rts treetop turtle twig ts urbiscript vala vb.net vctreestatus velocity verilog vgl vhdl vim x10 xml xquery ' +
  'xslt xtend xul+mozpreproc yaml yaml+jinja zephir'
).split(/\s+/));
const IMAGE_ATTRS = [
  'data-caption', 'data-size', 'data-rawwidth', 'data-rawheight', 'data-watermark',
  'data-original-src', 'data-watermark-src', 'data-private-watermark-src',
];
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const length = value => Array.from(value).length;
const escape = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const tag = (name, attrs, body = '') => `<${name}${Object.entries(attrs)
  .map(([key, value]) => ` ${key}="${escape(value)}"`).join('')}>${body}${['img', 'hr', 'br'].includes(name) ? '' : `</${name}>`}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function webUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch (_) { return false; }
}

function topicList(value) {
  if (value === undefined || value === null) return [];
  const links = typeof value === 'string' ? value.split(/[,，\s]+/).filter(Boolean) : value;
  const hint = '话题为选填，可留空；请填写知乎话题链接，例如 https://www.zhihu.com/topic/19555547，多个链接用逗号、中文逗号或空白分隔';
  if (!Array.isArray(links)) throw failure(`知乎话题必须为话题链接列表；${hint}`);
  const topics = [];
  for (const link of links) {
    if (typeof link !== 'string' || !webUrl(link)) throw failure(`知乎话题只接受 /topic/{token} 链接；${hint}`);
    const url = new URL(link);
    const match = url.pathname.match(/^\/topic\/([A-Za-z0-9_-]+)(?:\/(?:hot|newest|top-answers))?\/?$/);
    if (!['www.zhihu.com', 'zhihu.com'].includes(url.hostname) || url.port || !match) {
      throw failure(`知乎话题只接受知乎 /topic/{token} 链接；${hint}`);
    }
    if (!topics.some(item => item.topic_token === match[1])) {
      topics.push({ topic_id: '', topic_token: match[1], topic_name: '' });
    }
  }
  if (topics.length > 3) throw failure('知乎文章最多关联 3 个话题');
  return topics;
}

function option(options, camel, snake, fallback) {
  if (own(options, camel) && own(options, snake) && options[camel] !== options[snake]) {
    throw failure('知乎发布选项重复且不一致');
  }
  return options[camel] !== undefined ? options[camel] : options[snake] !== undefined ? options[snake] : fallback;
}

function configuration(ctx) {
  const article = ctx.article || {};
  const options = ctx.options || {};
  if ((options.type !== undefined && options.type !== 'article') ||
      (article.type !== undefined && article.type !== 'article')) throw failure('知乎官方发布仅支持文章');
  if ([article, options].some(value => ['coverPath', 'cover_path', 'cover', 'coverUrl', 'cover_url']
    .some(key => value[key]))) {
    throw failure('知乎官方文章接口不支持独立封面，请移除独立封面选项');
  }
  const updateKeys = ['id', 'articleId', 'article_id', 'articleUrl', 'updateId', 'updateUrl',
    'updateArticleId', 'targetArticleId', 'targetId', 'targetUrl', 'content_token'];
  if (updateKeys.some(key => article[key] != null || options[key] != null) ||
      options.update || ['update', 'edit'].includes(options.mode)) {
    throw failure('知乎官方接口不支持更新旧文章');
  }
  if (typeof article.title !== 'string' || !article.title.trim() ||
      /[\r\n\u2028\u2029]/.test(article.title) || length(article.title) > 100) {
    throw failure('知乎文章标题必须非空、无换行且不超过 100 字');
  }
  if (typeof article.html !== 'string') throw failure('知乎文章正文必须为 HTML 字符串');
  const comment = option(options, 'commentPermission', 'comment_permission', 'all');
  const toc = option(options, 'tableOfContentsEnabled', 'table_of_contents_enabled', false);
  const statement = option(options, 'creationStatement', 'creation_statement', '');
  if (!COMMENTS.has(comment)) throw failure('知乎评论权限不在支持的枚举中');
  if (typeof toc !== 'boolean') throw failure('知乎目录选项必须为 boolean');
  if (statement !== '' && statement !== null && !STATEMENTS.has(statement)) {
    throw failure('知乎创作声明不在支持的枚举中');
  }
  const content = { title: article.title, comment_permission: comment, table_of_contents_enabled: toc };
  const topics = topicList(options.topics);
  if (topics.length) content.topics = topics;
  if (statement) content.creation_statement = statement;
  return content;
}

// Render a new tree from an explicit whitelist; never return raw input markup.
// Benign presentation is downgraded with warnings. Active content is rejected.
function convert(html, { mapped = false, normalized = false } = {}) {
  const $ = cheerio.load(html, null, false);
  const warnings = new Set();
  const warn = () => warnings.add('部分标签或样式已降级为知乎支持的格式，文字保持原样');
  const forbidden = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'link', 'meta',
    'base', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'canvas', 'template']);
  $('*').each((_, node) => {
    // KaTeX's display tree is replaced using its exact data-math source.
    const inFormula = $(node).parents('[data-math]').length > 0;
    if (forbidden.has(node.name) && !(inFormula && ['svg', 'math'].includes(node.name))) {
      throw failure('知乎正文包含不支持的可执行或嵌入标签');
    }
    for (const [key, value] of Object.entries(node.attribs || {})) {
      if (/^on/i.test(key) || key === 'srcdoc' ||
          ((key === 'style' || /^(?:src|srcset|href|xlink:href|action|formaction|data-url|data-.*-src)$/.test(key)) &&
           /(?:javascript|vbscript)\s*:|expression\s*\(/i.test(value))) {
        throw failure('知乎正文包含不安全的属性或地址');
      }
    }
  });
  const children = node => (node.children || []).map(render).join('');
  function plainChildren(node) {
    return (node.children || []).map((child, index, siblings) => {
      const result = plain(child);
      const block = ['p', 'div', 'section', 'li'].includes(child.name);
      return result + (block && siblings.slice(index + 1).some(next =>
        next.type !== 'text' || next.data.trim()) ? '<br>' : '');
    }).join('');
  }
  function plain(node) {
    if (node.type === 'text') return escape(node.data);
    if (node.name === 'br') return '<br>';
    const attrs = node.attribs || {};
    if (own(attrs, 'data-math') ||
        (node.name === 'img' && ['1', '2'].includes(attrs.eeimg) && own(attrs, 'alt'))) {
      warnings.add('知乎表格内公式已保留为 LaTeX 文本，表格外公式保持原样');
      return escape(own(attrs, 'data-math') ? attrs['data-math'] : attrs.alt);
    }
    if (node.name === 'img') {
      throw failure('知乎表格单元格仅支持纯文本和换行，请将图片移出表格');
    }
    return plainChildren(node);
  }
  function formula(latex, display) {
    return tag('img', { eeimg: display, src: `//www.zhihu.com/equation?tex=${encodeURIComponent(latex)}`, alt: latex });
  }
  function render(node) {
    if (node.type === 'text') return escape(node.data);
    if (!node.name) return '';
    const name = node.name;
    const a = node.attribs || {};
    if (a.style || a.class || a.id) warn();
    if (own(a, 'data-math')) {
      return formula(a['data-math'], a['data-display'] === 'true' || /(?:^|\s)math-block(?:\s|$)/.test(a.class || '') ? '2' : '1');
    }
    if (name === 'img') {
      if (own(a, 'eeimg')) {
        if (!['1', '2'].includes(a.eeimg) || !own(a, 'alt')) throw failure('知乎公式需要 eeimg=1/2 和 LaTeX alt');
        return formula(a.alt, a.eeimg);
      }
      const src = (a.src || '').trim();
      // Local paths and data images are resolved exclusively by mapImages.
      if (!src || (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^(?:https?:|file:|data:image\/)/i.test(src))) {
        throw failure('知乎正文图片地址无效');
      }
      const caption = a['data-caption'] !== undefined ? a['data-caption'] : a.alt || '';
      if (length(caption) > 140) throw failure('知乎图片注释不得超过 140 字');
      const attrs = { src, 'data-caption': caption };
      if (mapped) {
        if (!safeUrl(src)) throw failure('知乎图片尚未上传完成');
        for (const key of IMAGE_ATTRS) {
          if (own(a, key)) attrs[key] = a[key];
        }
        for (const key of ['data-original-src', 'data-watermark-src', 'data-private-watermark-src']) {
          if (attrs[key] && !safeUrl(attrs[key])) throw failure('知乎图片媒体属性地址无效');
        }
      }
      return tag('img', attrs);
    }
    if (name === 'a') {
      const href = (a.href || '').trim();
      if (!webUrl(href)) throw failure('知乎文字链接只支持有效的 HTTP(S) 地址');
      // Link cards degrade to ordinary links; no cover or card metadata is invented.
      if (a['data-draft-type']) warn();
      return tag('a', { href }, children(node));
    }
    if (name === 'pre') {
      const code = $(node).children('code').first();
      let lang = a.lang || code.attr('lang') || (code.attr('class') || a.class || '').match(/(?:language-|lang-)([^\s]+)/)?.[1] || '';
      lang = lang.toLowerCase();
      lang = ({ javascript: 'js', typescript: 'ts', py: 'python', 'c++': 'cpp', 'c#': 'csharp', ruby: 'rb' })[lang] || lang;
      if (lang && !LANGUAGES.has(lang)) { lang = ''; warn(); }
      return tag('pre', { lang }, escape($(node).text()));
    }
    if (name === 'table') {
      if ($(node).find('table').length) throw failure('知乎不支持嵌套表格');
      // Captions are visible content, so keep them as text above the table.
      const caption = $(node).children('caption').toArray()
        .map(cell => tag('p', {}, plainChildren(cell))).join('');
      const rows = $(node).find('tr').toArray().map(row => tag('tr', {},
        $(row).children('th,td').toArray().map(cell => {
          if (['colspan', 'rowspan'].some(key => cell.attribs[key] && cell.attribs[key] !== '1')) {
            throw failure('知乎表格不支持合并单元格');
          }
          return tag(cell.name, {}, plainChildren(cell));
        }).join(''))).join('');
      return caption + tag('table', { 'data-draft-node': 'block', 'data-draft-type': 'table',
        'data-size': 'normal', 'data-row-style': 'normal' }, tag('tbody', {}, rows));
    }
    if (name === 'sup' && a['data-draft-type'] === 'reference') {
      const text = a['data-text'] || '';
      const url = (a['data-url'] || '').trim();
      if ((!text && !url) || (url && !webUrl(url)) || !/^[1-9]\d*$/.test(a['data-numero'] || '') ||
          $(node).text() !== `[${a['data-numero']}]`) throw failure('知乎引用标注格式无效');
      return tag('sup', { 'data-text': text, 'data-url': url, 'data-draft-node': 'inline',
        'data-draft-type': 'reference', 'data-numero': a['data-numero'] }, escape($(node).text()));
    }
    if (/^h[1-6]$/.test(name)) {
      const heading = name === 'h1' ? 'h2' : normalized && name === 'h2' ? 'h2' : 'h3';
      return tag(heading, {}, children(node));
    }
    const alias = { strong: 'b', em: 'i' };
    if (alias[name]) return tag(alias[name], {}, children(node));
    if (['p', 'b', 'i', 'ul', 'ol', 'li', 'blockquote', 'code', 'br', 'hr'].includes(name)) {
      let body = children(node);
      if (name === 'p' && !body.trim()) body = '<br>';
      if (name === 'blockquote') {
        body = (node.children || []).map((child, index, siblings) => {
          if (child.name !== 'p') return render(child);
          const more = siblings.slice(index + 1).some(next => next.type !== 'text' || next.data.trim());
          return children(child) + (more ? '<br>' : '');
        }).join('');
      }
      return tag(name, {}, body);
    }
    warn();
    const body = children(node);
    if (['div', 'section', 'article', 'main', 'figure', 'figcaption', 'header', 'footer', 'aside'].includes(name) &&
        !$(node).children('p,div,section,article,h1,h2,h3,h4,h5,h6,ul,ol,pre,table,blockquote,figure').length) {
      return tag('p', {}, body.trim() ? body : '<br>');
    }
    return body;
  }
  const result = $.root()[0].children.map(render).join('');
  const count = length(cheerio.load(result, null, false).root().text().trim());
  if (count < 9 || count > 100000) throw failure(`知乎文章正文纯文本须为 9～100000 字（当前 ${count} 字）`);
  return { html: result, warnings: [...warnings], textLength: count };
}

function validate(ctx) {
  configuration(ctx);
  credentials(ctx);
  const result = convert(ctx.article.html);
  return { warnings: result.warnings };
}

async function check(ctx) {
  credentials(ctx);
  return {
    verified: false,
    message: '知乎未提供只读的官方鉴权 probe；仅确认已配置凭证，未验证密钥有效性或发布权限',
  };
}

async function prepare(ctx) {
  const content = configuration(ctx);
  credentials(ctx);
  const converted = convert(ctx.article.html);
  const warnings = new Set(converted.warnings);
  const images = await mapImages(converted.html, {
    baseDir: ctx.article.baseDir, cache: ctx.mediaCache || {},
    upload: asset => uploadImage(ctx, asset, { warnings }), onProgress: ctx.onProgress, saveCache: ctx.saveCache,
  });
  const final = convert(images.html, { mapped: true, normalized: true });
  final.warnings.forEach(value => warnings.add(value));
  content.html = final.html;
  const payload = { type: 'article', confirmed: true, confirm_note: 'confirmed by user before publishing', content };
  return {
    html: final.html, payload,
    summary: { title: content.title, imageCount: images.count, textLength: final.textLength,
      commentPermission: content.comment_permission, tableOfContentsEnabled: content.table_of_contents_enabled,
      topics: content.topics || [], creationStatement: content.creation_statement || '' },
    warnings: [...warnings],
  };
}

async function execute(ctx) {
  credentials(ctx);
  const prepared = ctx.prepared;
  const payload = prepared && prepared.payload;
  // Only consume the prepared snapshot: changed source/options must not silently
  // change what was previewed. The host owns the single preview confirmation.
  if (!object(payload) || payload.type !== 'article' || payload.confirmed !== true ||
      !object(payload.content) || payload.content.html !== prepared.html) {
    throw failure('知乎发布缺少完整的已准备预览，请先 prepare');
  }
  const content = payload.content;
  const allowed = new Set(['title', 'html', 'comment_permission', 'table_of_contents_enabled', 'topics', 'creation_statement']);
  if (Object.keys(payload).some(key => !['type', 'confirmed', 'confirm_note', 'content'].includes(key)) ||
      Object.keys(content).some(key => !allowed.has(key))) throw failure('知乎预览包含不支持的发布字段');
  if (!COMMENTS.has(content.comment_permission) || typeof content.table_of_contents_enabled !== 'boolean' ||
      (own(content, 'creation_statement') && !STATEMENTS.has(content.creation_statement))) {
    throw failure('知乎预览发布选项不完整或无效，请重新 prepare');
  }
  // Validate the snapshot locally, without downloading, uploading, or rebuilding it.
  configuration({ article: { title: content.title, html: content.html }, options: {
    commentPermission: content.comment_permission, tableOfContentsEnabled: content.table_of_contents_enabled,
    creationStatement: content.creation_statement,
  } });
  if (content.topics !== undefined && (!Array.isArray(content.topics) || content.topics.length > 3 ||
      content.topics.some(item => !object(item) || item.topic_id !== '' || item.topic_name !== '' ||
        !/^[A-Za-z0-9_-]+$/.test(item.topic_token || '') ||
        Object.keys(item).some(key => !['topic_id', 'topic_token', 'topic_name'].includes(key))))) {
    throw failure('知乎预览话题格式无效');
  }
  const normalized = convert(content.html, { mapped: true, normalized: true });
  if (normalized.html !== content.html) throw failure('知乎预览 HTML 尚未规范化，请重新 prepare');
  const data = await api(ctx, `${ORIGIN}/openapi/publish`, 'POST', payload);
  if (data.status !== 0 || !object(data.data)) throw failure('知乎发布响应不完整，提交结果可能未知', false);
  const result = data.data;
  const id = typeof result.content_token === 'string' ? result.content_token :
    Number.isSafeInteger(result.content_token) ? String(result.content_token) : '';
  let url;
  try { url = new URL(result.url); } catch (_) { /* handled below */ }
  if (!/^[1-9]\d*$/.test(id) || !safeUrl(result.url) || !url || url.hostname !== 'zhuanlan.zhihu.com' ||
      url.port || url.hash || url.pathname !== `/p/${id}` || (result.type !== undefined && result.type !== 'article')) {
    throw failure('知乎未返回匹配文章 ID 的真实文章 HTTPS URL，提交结果可能未知', false);
  }
  return { state: 'published', id, url: result.url };
}

module.exports = { id: 'zhihu', validate, check, prepare, execute };
