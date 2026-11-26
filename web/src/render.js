/**
 * Web 版渲染核心（纯浏览器）：
 * 输入 Markdown 文本 → 输出渲染后的 bodyHtml（KaTeX 公式 + 代码高亮 + 图片 + 表格）
 * 用 esbuild 打包 marked / katex / highlight.js，不依赖 Node 内置模块。
 */
import { Marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import mermaid from 'mermaid';
import { THEMES, getTheme, DEFAULT_THEME_ID } from '../../lib/themes';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseImageAttributes(title) {
  const text = String(title || '');
  return {
    width: text.match(/(?:^|\s)width\s*=\s*([0-9.]+%?|[0-9.]+px)(?:\s|$)/i)?.[1] || '',
    align: text.match(/(?:^|\s)align\s*=\s*(left|center|right)(?:\s|$)/i)?.[1]?.toLowerCase() || 'center',
  };
}

function prepareFootnotes(markdown) {
  const definitions = new Map();
  const kept = [];
  let inFence = false;
  for (const line of String(markdown).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && line.match(/^\[\^([\w-]+)\]:\s*(.*)$/);
    if (match) definitions.set(match[1], match[2]);
    else kept.push(line);
  }
  return {
    markdown: kept.join('\n').replace(/\[\^([\w-]+)\]/g, '@@M2A_FOOTNOTE_REF_$1@@'),
    definitions,
  };
}

function prepareImageAttributes(markdown) {
  return String(markdown).replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\{([^}]+)\}/g,
    (_, alt, href, title, attrs) => `![${alt}](${href} "${[title, attrs].filter(Boolean).join(' ')}")`
  );
}

// ── marked 扩展：块级公式 $$...$$ ──
const blockMathExt = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    let idx = src.indexOf('\n$$');
    if (idx === -1) idx = src.indexOf('$$');
    if (idx === -1) return undefined;
    // 确保是行首
    while (idx > 0 && src[idx - 1] !== '\n') {
      idx = src.indexOf('$$', idx + 1);
      if (idx === -1) return undefined;
    }
    return idx;
  },
  tokenizer(src) {
    const match = src.match(/^\$\$([\s\S]+?)\$\$/);
    if (match) {
      return { type: 'blockMath', raw: match[0], math: match[1].trim() };
    }
  },
  renderer(token) {
    try {
      const html = katex.renderToString(token.math, {
        displayMode: true, throwOnError: false, output: 'html', strict: false,
      });
      return `<div class="math-block" data-math="${escapeHtml(token.math)}" data-display="true" style="text-align:center;overflow-x:auto;margin:1.2em 0;padding:0.5em 0;">${html}</div>\n`;
    } catch (e) {
      return `<pre><code class="math">${escapeHtml(token.math)}</code></pre>\n`;
    }
  },
};

// ── marked 扩展：行内公式 $...$ ──
const inlineMathExt = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    let i = src.indexOf('$');
    while (i !== -1 && src[i + 1] === '$') i = src.indexOf('$', i + 2);
    return i >= 0 ? i : undefined;
  },
  tokenizer(src) {
    if (src.startsWith('$$')) return undefined;
    const match = src.match(/^\$([^\$\n]+?)\$/);
    if (match) return { type: 'inlineMath', raw: match[0], math: match[1] };
  },
  renderer(token) {
    try {
      const html = katex.renderToString(token.math, {
        displayMode: false, throwOnError: false, output: 'html', strict: false,
      });
      return `<span class="math-inline" data-math="${escapeHtml(token.math)}">${html}</span>`;
    } catch (e) {
      return `<code class="math">${escapeHtml(token.math)}</code>`;
    }
  },
};

const footnoteRefExt = {
  name: 'footnoteRef',
  level: 'inline',
  start(src) {
    const match = src.match(/@@M2A_FOOTNOTE_REF_[\w-]+@@/);
    return match ? match.index : undefined;
  },
  tokenizer(src) {
    const match = src.match(/^@@M2A_FOOTNOTE_REF_([\w-]+)@@/);
    if (!match) return;
    return { type: 'footnoteRef', raw: match[0], label: match[1] };
  },
  renderer(token) {
    return `<sup class="footnote-ref" id="fnref-${escapeHtml(token.label)}"><a href="#fn-${escapeHtml(token.label)}">[${escapeHtml(token.label)}]</a></sup>`;
  },
};

const calloutExt = {
  name: 'callout',
  level: 'block',
  start(src) {
    const match = src.match(/^:::\s*(?:note|tip|info|warning|danger|success|important)\b/im);
    return match ? match.index : undefined;
  },
  tokenizer(src) {
    const match = src.match(/^:::\s*(note|tip|info|warning|danger|success|important)\s*\n([\s\S]*?)\n:::[ \t]*(?:\n|$)/i);
    if (!match) return;
    return { type: 'callout', raw: match[0], kind: match[1].toLowerCase(), text: match[2] };
  },
  renderer(token) {
    const labels = { note: '注意', tip: '提示', info: '信息', warning: '警告', danger: '危险', success: '成功', important: '重要' };
    return `<aside class="callout callout-${token.kind}" data-callout="${token.kind}"><strong>${labels[token.kind] || token.kind}</strong><div>${markedInstance.parse(token.text)}</div></aside>\n`;
  },
};

const mermaidExt = {
  name: 'mermaid',
  level: 'block',
  start(src) {
    const match = src.match(/^```mermaid[ \t]*$/im);
    return match ? match.index : undefined;
  },
  tokenizer(src) {
    const match = src.match(/^```mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n|$)/i);
    if (!match) return;
    return { type: 'mermaid', raw: match[0], source: match[1].trim() };
  },
  renderer(token) {
    return `<div class="mermaid-diagram"><pre class="mermaid-source"><code>${escapeHtml(token.source)}</code></pre></div>\n`;
  },
};

const markedInstance = new Marked();
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
markedInstance.use({
  gfm: true,
  breaks: false,
  extensions: [blockMathExt, inlineMathExt, footnoteRefExt, calloutExt, mermaidExt],
  renderer: {
    code(code, infostring) {
      const info = String(infostring || '');
      const language = info.trim().split(/\s+/)[0] || '';
      return `<pre><code class="language-${escapeHtml(language)}" data-code-info="${escapeHtml(info)}">${escapeHtml(code)}</code></pre>\n`;
    },
    listitem(text, task, checked) {
      if (task) {
        const cleanText = text.replace(/<input\b[^>]*>/i, '').trim();
        return `<li class="task-list-item"><input type="checkbox" class="task-checkbox"${checked ? ' checked' : ''}> ${cleanText}</li>\n`;
      }
      return `<li>${text}</li>\n`;
    },
    image(href, title, text) {
      const alt = text || '';
      const attrs = parseImageAttributes(title);
      const titleText = String(title || '').replace(/\b(?:width|align)\s*=\s*(?:[0-9.]+%?|[0-9.]+px|left|center|right)\b/gi, '').trim();
      const titleAttr = titleText ? ` title="${escapeHtml(titleText)}"` : '';
      const margin = attrs.align === 'left' ? '0 auto 0 0' : attrs.align === 'right' ? '0 0 0 auto' : '0 auto';
      const imgStyle = `max-width:100%;display:block;margin:${margin};${attrs.width ? `width:${attrs.width};` : ''}`;
      const img = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"${titleAttr} style="${imgStyle}">`;
      const captionStyle = 'display:block;text-align:center;color:#999;font-size:14px;margin-top:8px;line-height:1.5;font-style:normal;';
      const figStyle = 'margin:1.5em auto;text-align:center;';
      if (alt) {
        return `<figure style="${figStyle}">${img}<figcaption style="${captionStyle}">${escapeHtml(alt)}</figcaption></figure>\n`;
      }
      return `<figure style="${figStyle}">${img}</figure>\n`;
    },
  },
});

// 代码高亮（mac 风格窗口圆点 + hljs）
function enhanceCodeHtml(parsedHtml) {
  const div = document.createElement('div');
  div.innerHTML = parsedHtml;
  const svgDots =
    `<svg width="52" height="12" viewBox="0 0 52 12" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="6" cy="6" r="6" fill="#FF5F56"/><circle cx="26" cy="6" r="6" fill="#FFBD2E"/><circle cx="46" cy="6" r="6" fill="#27C93F"/></svg>`;
  div.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.mermaid-diagram')) return;
    const code = pre.querySelector('code');
    if (!code || pre.classList.contains('mac-code')) return;
    const rawCode = code.textContent;
    const info = code.getAttribute('data-code-info') || '';
    const filename = info.match(/filename\s*=\s*["']([^"']+)["']/i)?.[1] ||
      info.match(/(?:^|\s)filename=([^\s]+)/i)?.[1] || '';
    let language = 'plaintext';
    const classes = (pre.className || '') + ' ' + (code.className || '');
    const langMatch = classes.match(/language-([\w-]+)/);
    if (langMatch && hljs.getLanguage(langMatch[1])) language = langMatch[1];
    let highlighted;
    try { highlighted = hljs.highlight(rawCode, { language }).value; }
    catch (_) { highlighted = hljs.highlightAuto(rawCode).value; }
    if (/\b(?:line-numbers|linenos|numbers)\b/i.test(info)) {
      highlighted = highlighted.split(/\r?\n/).map((line, index) =>
        `<span class="code-line"><span class="code-line-number">${index + 1}</span>${line || ' '}</span>`
      ).join('\n');
    }
    const newPre = document.createElement('pre');
    newPre.className = 'mac-code';
    newPre.style.cssText = 'font-size:90%;overflow-x:auto;border-radius:8px;padding:0;line-height:1.5;margin:10px 8px;background-color:#f6f8fa;border:1px solid #eaedf0;';
    newPre.innerHTML =
      `<span class="mac-dots" style="display:block;margin:12px 16px 0;">${svgDots}</span>` +
      (filename ? `<span class="code-filename" style="display:block;padding:8px 16px 0;font-size:12px;color:#666;">${escapeHtml(filename)}</span>` : '') +
      `<code class="hljs ${language}" style="display:block;padding:0.5em 1em 1em;overflow-x:auto;text-indent:0;color:inherit;background:none;white-space:pre-wrap;word-break:break-all;margin:0;">${highlighted}</code>`;
    pre.replaceWith(newPre);
  });
  // 表格包裹
  div.querySelectorAll('table').forEach((t) => {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrapper';
    wrap.style.cssText = 'overflow-x:auto;-webkit-overflow-scrolling:touch;';
    t.parentNode.insertBefore(wrap, t);
    wrap.appendChild(t);
  });
  return div.innerHTML;
}

/**
 * 渲染 Markdown → { bodyHtml, title }
 * @param {string} mdText
 * @param {object} opts { baseDir? } 图片路径解析
 */
export function renderMarkdown(mdText, opts = {}) {
  const raw = String(mdText || '');
  // 提取 frontmatter
  let content = raw;
  let fmTitle = '';
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (fmMatch) {
    content = raw.slice(fmMatch[0].length);
    const tMatch = fmMatch[1].match(/^title:\s*(.+)$/m);
    if (tMatch) fmTitle = tMatch[1].trim().replace(/^["']|["']$/g, '');
  }
  const prepared = prepareFootnotes(prepareImageAttributes(content));
  const parsedHtml = markedInstance.parse(prepared.markdown);
  const bodyHtml = enhanceCodeHtml(parsedHtml);
  if (prepared.definitions.size) {
    const items = [...prepared.definitions.entries()].map(([label, text]) =>
      `<li id="fn-${escapeHtml(label)}"><p>${markedInstance.parse(text).trim()} <a class="footnote-backref" href="#fnref-${escapeHtml(label)}">↩</a></p></li>`
    ).join('');
    const holder = document.createElement('div');
    holder.innerHTML = bodyHtml;
    holder.insertAdjacentHTML('beforeend', `<section class="footnotes"><hr><ol>${items}</ol></section>`);
    return { bodyHtml: holder.innerHTML, title: title || '未命名文档', rawMarkdown: raw };
  }
  // 标题
  let title = fmTitle;
  if (!title) {
    const m = raw.match(/^#\s+(.+)$/m);
    if (m) title = m[1].trim();
  }
  return { bodyHtml, title: title || '未命名文档', rawMarkdown: raw };
}

export async function renderMermaidDiagrams(root) {
  const nodes = [...root.querySelectorAll('.mermaid-diagram')];
  for (const node of nodes) {
    const source = node.querySelector('.mermaid-source')?.textContent?.trim();
    if (!source || node.querySelector('svg')) continue;
    try {
      const result = await mermaid.render(`m2a-mermaid-${Math.random().toString(36).slice(2)}`, source);
      node.innerHTML = result.svg;
    } catch (_) {
      node.classList.add('mermaid-error');
    }
  }
}

export { THEMES, getTheme, DEFAULT_THEME_ID, katex, hljs };
