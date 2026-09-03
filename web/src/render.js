/**
 * Web 版渲染核心（纯浏览器）：
 * 输入 Markdown 文本 → 输出渲染后的 bodyHtml（KaTeX 公式 + 代码高亮 + 图片 + 表格）
 * 用 esbuild 打包 marked / katex / highlight.js，不依赖 Node 内置模块。
 */
import { Marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import { THEMES, getTheme, DEFAULT_THEME_ID } from '../../lib/themes';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

const markedInstance = new Marked();
markedInstance.use({
  gfm: true,
  breaks: false,
  extensions: [blockMathExt, inlineMathExt],
  renderer: {
    listitem(text, task, checked) {
      if (task) {
        const cleanText = text.replace(/<input\b[^>]*>/i, '').trim();
        return `<li class="task-list-item"><input type="checkbox" class="task-checkbox"${checked ? ' checked' : ''}> ${cleanText}</li>\n`;
      }
      return `<li>${text}</li>\n`;
    },
    image(href, title, text) {
      const alt = text || '';
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const imgStyle = 'max-width:100%;display:block;margin:0 auto;';
      const img = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"${titleAttr} style="${imgStyle}">`;
      const captionStyle = 'display:block;text-align:center;color:#999;font-size:14px;margin-top:8px;line-height:1.5;font-style:normal;';
      const figStyle = 'margin:1.5em auto;text-align:center;';
      if (alt) {
        return `<figure style="${figStyle}">${img}<figcaption style="${captionStyle}">${alt}</figcaption></figure>\n`;
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
    const code = pre.querySelector('code');
    if (!code || pre.classList.contains('mac-code')) return;
    const rawCode = code.textContent;
    let language = 'plaintext';
    const classes = (pre.className || '') + ' ' + (code.className || '');
    const langMatch = classes.match(/language-([\w-]+)/);
    if (langMatch && hljs.getLanguage(langMatch[1])) language = langMatch[1];
    let highlighted;
    try { highlighted = hljs.highlight(rawCode, { language }).value; }
    catch (_) { highlighted = hljs.highlightAuto(rawCode).value; }
    const newPre = document.createElement('pre');
    newPre.className = 'mac-code';
    newPre.style.cssText = 'font-size:90%;overflow-x:auto;border-radius:8px;padding:0;line-height:1.5;margin:10px 8px;background-color:#f6f8fa;border:1px solid #eaedf0;';
    newPre.innerHTML =
      `<span class="mac-dots" style="display:block;margin:12px 16px 0;">${svgDots}</span>` +
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
  const parsedHtml = markedInstance.parse(content);
  const bodyHtml = enhanceCodeHtml(parsedHtml);
  // 标题
  let title = fmTitle;
  if (!title) {
    const m = raw.match(/^#\s+(.+)$/m);
    if (m) title = m[1].trim();
  }
  return { bodyHtml, title: title || '未命名文档', rawMarkdown: raw };
}

export { THEMES, getTheme, DEFAULT_THEME_ID, katex };
