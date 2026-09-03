/* Markdown2Anything 网页版主逻辑 */
(function () {
  'use strict';

  // ── DOM 引用 ──
  const $ = (id) => document.getElementById(id);
  const editorHost = $('editor-host');
  const previewContent = $('preview-content');
  const previewScroll = $('preview-scroll');
  const themeSelect = $('theme-select');
  const docTitle = $('doc-title');
  const wordCount = $('word-count');
  const toastEl = $('toast');

  const LS_KEY = 'm2a:web:doc';
  const LS_THEME = 'm2a:web:theme';
  const LS_WIDTH = 'm2a:web:width';

  let currentTitle = '';
  let currentBodyHtml = '';
  let currentThemeId = M2A.DEFAULT_THEME_ID;

  // ── CodeMirror 编辑器 ──
  let editor = null;
  function initEditor() {
    const { EditorView, basicSetup } = CodeMirror;
    const markdownLang = CodeMirror.markdown;
    const { EditorState } = CodeMirror.state;
    // basicSetup 由 codemirror.bundle.js 提供
    const startDoc = localStorage.getItem(LS_KEY) || `# 标题

在这里写 Markdown，右侧实时预览。

## 公式

行内公式 $E=mc^2$：

$$
L(\\theta) = -\\frac{1}{N}\\sum_{i=1}^{N}\\left[ y_i\\log\\hat{y}_i + (1-y_i)\\log(1-\\hat{y}_i) \\right]
$$

## 代码

\`\`\`python
def summarize(md):
    return render(md)
\`\`\`

## 表格

| 平台 | 公式 | 图片 |
| :--- | :--: | :--: |
| 微信 | ✅ | ✅ |
| 知乎 | ✅ | ✅ |

## 图片

![示例图片](https://picsum.photos/seed/m2a/600/300)
`;
    const state = EditorState.create({
      doc: startDoc,
      extensions: [
        basicSetup,
        markdownLang(),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            onDocChanged(u.state.doc.toString());
          }
        }),
      ],
    });
    editor = new EditorView({ state, parent: editorHost });
    onDocChanged(startDoc, true);
  }

  // ── 渲染预览 ──
  let renderTimer = null;
  function onDocChanged(text, immediate) {
    const words = text.replace(/\s+/g, '').length;
    wordCount.textContent = words + ' 字';
    localStorage.setItem(LS_KEY, text);
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderPreview(text), immediate ? 0 : 250);
  }

  function renderPreview(text) {
    const r = M2A.renderMarkdown(text);
    currentTitle = r.title;
    currentBodyHtml = r.bodyHtml;
    previewContent.innerHTML = r.bodyHtml;
    docTitle.textContent = '预览：' + (currentTitle || '未命名');
    // 表格模式按钮（web 简化：自动包裹）
  }

  // ── 主题 ──
  function applyTheme(theme) {
    currentThemeId = theme.id;
    // 注入主题 CSS 到 article-wrapper
    let styleEl = document.getElementById('m2a-theme-css');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'm2a-theme-css';
      document.head.appendChild(styleEl);
    }
    // 主题 CSS 是 .article-wrapper 后代选择器，需要作用于预览容器
    styleEl.textContent = theme.css + `
      .article-wrapper { background: ${theme.wrapperBg}; }
    `;
    previewScroll.style.background = theme.wrapperBg;
  }

  function initThemeSelect() {
    M2A.THEMES.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      themeSelect.appendChild(opt);
    });
    const saved = localStorage.getItem(LS_THEME);
    const start = saved && M2A.THEMES.some(t => t.id === saved) ? saved : 'claude';
    themeSelect.value = start;
    applyTheme(M2A.getTheme(start));
    themeSelect.addEventListener('change', () => {
      const t = M2A.getTheme(themeSelect.value);
      applyTheme(t);
      localStorage.setItem(LS_THEME, t.id);
    });
  }

  // ── 复制（微信/知乎）──
  // hljs 颜色映射（与插件 lib/converter.js 一致，内联到 span 供粘贴）
  const HLJS_COLOR_MAP = {
    'hljs-doctag': '#d73a49', 'hljs-keyword': '#d73a49', 'hljs-meta': '#d73a49',
    'hljs-template-tag': '#d73a49', 'hljs-template-variable': '#d73a49',
    'hljs-type': '#d73a49', 'hljs-variable.language_': '#d73a49',
    'hljs-title': '#6f42c1', 'hljs-title.class_': '#6f42c1', 'hljs-title.function_': '#6f42c1',
    'hljs-attr': '#005cc5', 'hljs-attribute': '#005cc5', 'hljs-literal': '#005cc5',
    'hljs-number': '#005cc5', 'hljs-operator': '#005cc5', 'hljs-variable': '#005cc5',
    'hljs-selector-attr': '#005cc5', 'hljs-selector-class': '#005cc5', 'hljs-selector-id': '#005cc5',
    'hljs-regexp': '#032f62', 'hljs-string': '#032f62',
    'hljs-built_in': '#e36209', 'hljs-symbol': '#e36209',
    'hljs-comment': '#6a737d', 'hljs-code': '#6a737d', 'hljs-formula': '#6a737d',
    'hljs-name': '#22863a', 'hljs-quote': '#22863a',
    'hljs-selector-tag': '#22863a', 'hljs-selector-pseudo': '#22863a',
    'hljs-subst': '#24292e',
    'hljs-section': '#005cc5', 'hljs-bullet': '#735c0f',
    'hljs-addition': '#22863a', 'hljs-deletion': '#b31d28',
    'hljs-emphasis': '#24292e', 'hljs-strong': '#24292e',
  };

  // 内联 hljs 颜色到 span（插件 inlineHljsColors 同款）
  function inlineHljsColors(highlighted) {
    return highlighted.replace(
      /<span class="([^"]+)">/g,
      (m, classes) => {
        const classList = classes.trim().split(/\s+/);
        let color = HLJS_COLOR_MAP[classList.join('.')];
        if (!color) {
          for (const c of classList) {
            if (HLJS_COLOR_MAP[c]) { color = HLJS_COLOR_MAP[c]; break; }
          }
        }
        return color ? `<span style="color:${color};">` : `<span>`;
      }
    );
  }

  // 代码块处理（插件 applyCodeBlocksForWechat 同款）：
  // 反转 hljs 转义拿纯文本 → 重新高亮 → 内联颜色 → 空格转 &nbsp;、换行转 <br>
  const SVG_DOTS =
    `<svg width="52" height="12" viewBox="0 0 52 12" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="6" cy="6" r="6" fill="#FF5F56"/><circle cx="26" cy="6" r="6" fill="#FFBD2E"/><circle cx="46" cy="6" r="6" fill="#27C93F"/></svg>`;

  function prepareCodeBlocksForCopy(html) {
    return html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (fullMatch, preContent) => {
      const codeMatch = preContent.match(/<code([^>]*)>([\s\S]*?)<\/code>/);
      if (!codeMatch) return fullMatch;
      const [, codeAttrs, codeContent] = codeMatch;
      const langMatch = codeAttrs.match(/class="[^"]*(?:hljs\s+|language-)([\w-]+)/);
      const language = langMatch ? langMatch[1] : 'plaintext';
      // 反转 hljs 转义拿纯文本
      const rawCode = codeContent
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n');
      let highlighted;
      try { highlighted = M2A.hljs.highlight(rawCode, { language }).value; }
      catch (_) { highlighted = M2A.hljs.highlightAuto(rawCode).value; }
      highlighted = inlineHljsColors(highlighted);
      // 换行→<br>，空格→&nbsp;（只操作文本节点，标签间不动）
      highlighted = highlighted.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, txt) => {
        if (tag) return tag;
        return txt.replace(/\r\n|\r|\n/g, '<br>').replace(/ /g, '&nbsp;');
      });
      return (
        `<pre class="mac-code" style="font-size:90%;overflow-x:auto;border-radius:8px;padding:0;line-height:1.5;margin:10px 8px;background-color:#f6f8fa;border:1px solid #eaedf0;">` +
        `<span class="mac-dots" style="display:block;margin:12px 16px 0;">${SVG_DOTS}</span>` +
        `<code class="hljs ${language}" style="display:block;padding:0.5em 1em 1em;overflow-x:auto;text-indent:0;color:inherit;background:none;white-space:pre-wrap;word-break:break-all;margin:0;">${highlighted}</code>` +
        `</pre>`
      );
    });
  }

  let katexCssCache = '';
  async function getKatexCss() {
    if (katexCssCache) return katexCssCache;
    // 从已加载的 <link> 读取 cssRules（线上同源可用）；file:// 下降级 fetch
    let css = '';
    try {
      const link = document.querySelector('link[href*="katex"]');
      if (link && link.sheet) {
        css = Array.from(link.sheet.cssRules || []).map((r) => r.cssText).join('\n');
      }
    } catch (_) {}
    if (!css) {
      try {
        const res = await fetch('vendor/katex/katex.min.css');
        css = await res.text();
      } catch (_) {}
    }
    // 字体 URL 转绝对路径（相对路径在内联 <style> 后失效）
    if (css) {
      const base = new URL('vendor/katex/', window.location.href);
      css = css.replace(/url\(([^)]+)\)/g, (m, u) => {
        u = u.trim().replace(/^["']|["']$/g, '');
        if (/^(data:|https?:|\/)/.test(u)) return m;
        return `url(${new URL(u, base).href})`;
      });
      katexCssCache = css;
    }
    return katexCssCache;
  }

  // ── MathJax 浏览器版：生成 mdnice SVG（与插件一致，公式不依赖 CSS 字体）──
  let mjxPromise = null;
  function loadMathJax() {
    if (!mjxPromise) {
      mjxPromise = new Promise((resolve, reject) => {
        if (window.MathJax && typeof window.MathJax.tex2svgPromise === 'function') { resolve(); return; }
        const s = document.createElement('script');
        s.src = 'vendor/mathjax/tex-svg.js';
        s.onload = () => {
          // 等待 MathJax 初始化
          const M = window.MathJax;
          const check = () => {
            if (M && typeof M.tex2svgPromise === 'function') resolve();
            else setTimeout(check, 100);
          };
          check();
        };
        s.onerror = () => reject(new Error('MathJax 加载失败'));
        document.head.appendChild(s);
      });
    }
    return mjxPromise;
  }

  async function mathToSvg(latex, isDisplay) {
    await loadMathJax();
    const node = await window.MathJax.tex2svgPromise(latex, { display: isDisplay, em: 16, ex: 8, containerWidth: 600 });
    const outer = node.outerHTML || new XMLSerializer().serializeToString(node);
    const svgMatch = outer.match(/<svg[\s\S]*<\/svg>/);
    if (!svgMatch) throw new Error('MathJax 未能生成 SVG');
    return svgMatch[0];
  }

  /**
   * 生成可粘贴 HTML
   * platform: 'wechat' | 'zhihu'
   *  - 微信：公式 KaTeX HTML + 内联 KaTeX CSS；代码内联颜色
   *  - 知乎：公式用 zhihu.com/equation 图片 + eeimg 标记（不依赖 CSS）
   */
  async function buildCopyHtml(bodyHtml, platform, theme) {
    const div = document.createElement('div');
    div.innerHTML = bodyHtml;
    const isWechat = platform === 'wechat';
    // ── 公式处理 ──
    for (const el of div.querySelectorAll('.math-block, .math-inline')) {
      const latex = el.getAttribute('data-math') || '';
      const isDisplay = el.classList.contains('math-block') || el.getAttribute('data-display') === 'true';
      const imgUrl = 'https://www.zhihu.com/equation?tex=' + encodeURIComponent(latex);
      if (isWechat) {
        // 微信：mdnice SVG（MathJax 生成，不依赖 CSS 字体，任何环境显示）
        try {
          const svgStr = await mathToSvg(latex, isDisplay);
          if (isDisplay) {
            const sec = document.createElement('section');
            sec.setAttribute('data-tools', 'mdnice编辑器');
            sec.setAttribute('data-id', '88');
            sec.style.cssText = 'text-align:center;margin:1.2em 0;';
            sec.innerHTML = `<span class="block-equation" data-formula="${escapeHtml(latex)}" style="display:block;text-align:center;">${svgStr}</span>`;
            el.replaceWith(sec);
          } else {
            // 提取 SVG vertical-align 保持行内对齐
            const vaMatch = svgStr.match(/style="[^"]*vertical-align:\s*(-?[\d.]+)/);
            const va = vaMatch ? vaMatch[1] : '-0.1em';
            const span = document.createElement('span');
            span.className = 'inline-equation';
            span.setAttribute('data-formula', latex);
            span.style.cssText = `display:inline-block;vertical-align:${va}em;`;
            span.innerHTML = svgStr;
            el.replaceWith(span);
          }
        } catch (_) {
          // 降级：知乎公式图片
          if (isDisplay) el.outerHTML = `<div style="text-align:center;margin:1.2em 0;"><img src="${imgUrl}"></div>`;
          else el.outerHTML = `<img src="${imgUrl}" style="display:inline-block;vertical-align:-0.1em;">`;
        }
      } else {
        // 知乎：zhihu.com/equation 图片 + eeimg 标记
        if (isDisplay) {
          el.outerHTML = `<p><img eeimg="1" src="${imgUrl}" alt="\\\\${escapeHtml(latex)}"></p>`;
        } else {
          el.outerHTML = `<img eeimg="1" src="${imgUrl}" alt="${escapeHtml(latex)}">`;
        }
      }
    }
    let html = div.innerHTML;
    // ── 代码块：内联颜色 + 空格/换行保留 ──
    html = prepareCodeBlocksForCopy(html);
    // ── 图片检测：data URI 图片（知乎/微信不支持，需要外链）──
    const dataUriImgs = (html.match(/<img[^>]+src="data:image[^"]*"/g) || []).length;
    return { html, dataUriImgs };
  }

  async function copyHtml(platform) {
    const theme = M2A.getTheme(currentThemeId);
    const { html, dataUriImgs } = await buildCopyHtml(currentBodyHtml, platform, theme);
    // 组装完整可粘贴 HTML（公式已是 SVG 自包含，仅需主题 CSS 内联）
    const full = `<style>${theme.css}</style><div class="article-wrapper" style="padding:16px;background:${theme.wrapperBg};font-family:system-ui,-apple-system,'PingFang SC',sans-serif;">${html}</div>`;
    try {
      // 关键：必须写 text/html MIME，粘贴时目标编辑器才识别为富文本而非源码
      const plain = document.createElement('div');
      plain.innerHTML = full;
      const textBlob = new Blob([plain.textContent], { type: 'text/plain' });
      const htmlBlob = new Blob([full], { type: 'text/html' });
      const item = new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob });
      await navigator.clipboard.write([item]);
      const name = platform === 'wechat' ? '微信' : '知乎';
      if (dataUriImgs > 0) {
        showToast(`⚠️ 已复制，但 ${name} 不支持 base64 内嵌图片（${dataUriImgs} 张），请改用外链图片 URL`, 'error');
      } else {
        showToast(`✅ 已复制${name}格式，去编辑器 Ctrl+V / ⌘V 粘贴`, 'success');
      }
    } catch (e) {
      // 降级：老浏览器不支持 ClipboardItem 时退回纯文本
      try {
        await navigator.clipboard.writeText(full);
        showToast(`✅ 已复制（纯文本模式），去编辑器粘贴`, 'success');
      } catch (e2) {
        showToast('复制失败：' + e.message, 'error');
      }
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── 小红书长图导出（分块渲染 + 拼接，质量可靠；支持单张长图 / 多张子图）──
  const XHS_W = 1080, XHS_H = 1440;
  const XHS_SCALE = 2;
  const CHUNK_H = 1300;   // 每块逻辑高（html2canvas 分块渲染可靠，避免大 canvas 丢失）
  const CHUNK_OVERLAP = 120;

  /**
   * 分块渲染预览为完整大 canvas。
   * html2canvas 整页大高度会丢失内容，分块（每块 ~1300 逻辑高，重叠拼接）保证质量。
   */
  async function renderFullCanvas(theme, scale, logicalWidth) {
    const zoomCanvas = document.querySelector('.zoom-canvas');
    const prevMaxW = zoomCanvas.style.maxWidth;
    const articleWrapper = previewContent.parentElement;
    const prevWrapPad = articleWrapper.style.padding;
    const prevMinH = articleWrapper.style.minHeight;
    // 固定宽度 + 小红书舒适留白 + 去掉 min-height 干扰（避免偏移错位）
    zoomCanvas.style.maxWidth = logicalWidth + 'px';
    articleWrapper.style.padding = '40px 48px';
    articleWrapper.style.minHeight = '0';
    previewScroll.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 120));

    // 精确总高：内容自身高度（含 padding）
    const totalH = Math.max(1, Math.ceil(previewContent.getBoundingClientRect().height));
    const physW = logicalWidth * scale;
    const out = document.createElement('canvas');
    out.width = physW;
    out.height = Math.max(1, totalH * scale);
    const octx = out.getContext('2d');
    octx.fillStyle = theme.wrapperBg || '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);

    try {
      let y = 0;
      let guard = 0;
      while (y < totalH && guard < 400) {
        guard++;
        const chunkLogicalH = Math.min(CHUNK_H, totalH - y);
        const chunkCanvas = await html2canvas(previewContent, {
          scale,
          backgroundColor: theme.wrapperBg || '#ffffff',
          useCORS: true,
          logging: false,
          width: logicalWidth,
          windowWidth: logicalWidth,
          height: Math.min(chunkLogicalH + CHUNK_OVERLAP, totalH - y),
          y,
          x: 0,
        });
        const pasteH = Math.min(chunkLogicalH * scale, chunkCanvas.height);
        octx.drawImage(chunkCanvas, 0, 0, chunkCanvas.width, pasteH, 0, y * scale, physW, pasteH);
        y += chunkLogicalH;
        await new Promise((r) => setTimeout(r, 30));
      }
    } finally {
      zoomCanvas.style.maxWidth = prevMaxW;
      articleWrapper.style.padding = prevWrapPad;
      articleWrapper.style.minHeight = prevMinH;
    }
    // 裁剪到实际高度
    const finalH = Math.min(totalH * scale, out.height);
    const cropped = document.createElement('canvas');
    cropped.width = physW;
    cropped.height = finalH;
    cropped.getContext('2d').drawImage(out, 0, 0, physW, finalH, 0, 0, physW, finalH);
    return cropped;
  }

  /** 导出完整单张长图 */
  async function exportXhsSingle() {
    const theme = M2A.getTheme(currentThemeId);
    showToast('⏳ 正在生成完整长图…');
    try {
      const canvas = await renderFullCanvas(theme, XHS_SCALE, XHS_W);
      const title = (currentTitle || 'markdown').replace(/[\\/:*?"<>|]/g, '');
      await downloadCanvas(canvas, `${title}-长图.png`);
      showToast('✅ 完整长图已导出', 'success');
    } catch (e) {
      console.error(e);
      showToast('导出失败：' + e.message, 'error');
    }
  }

  /** 导出多张 1080×1440 子图（移动端适配） */
  async function exportXhsMulti() {
    const theme = M2A.getTheme(currentThemeId);
    showToast('⏳ 正在生成多张子图…');
    try {
      const canvas = await renderFullCanvas(theme, XHS_SCALE, XHS_W);
      const fullW = canvas.width;       // 物理宽 2160
      const fullH = canvas.height;
      const physW = XHS_W * XHS_SCALE;  // 2160
      const physH = XHS_H * XHS_SCALE;  // 2880
      const cutPoints = computeCutPoints(physW, physH, XHS_SCALE, fullH);
      const title = (currentTitle || 'markdown').replace(/[\\/:*?"<>|]/g, '');
      for (let i = 0; i < cutPoints.length; i++) {
        const [y0, y1] = cutPoints[i];
        const h = y1 - y0;
        const slice = document.createElement('canvas');
        slice.width = physW;
        slice.height = physH;
        const ctx = slice.getContext('2d');
        ctx.fillStyle = theme.wrapperBg || '#ffffff';
        ctx.fillRect(0, 0, physW, physH);
        ctx.drawImage(canvas, 0, y0, physW, h, 0, 0, physW, h);
        await downloadCanvas(slice, `${title}-${String(i + 1).padStart(2, '0')}.png`);
      }
      showToast(`✅ 已导出 ${cutPoints.length} 张子图（1080×1440）`, 'success');
    } catch (e) {
      console.error(e);
      showToast('导出失败：' + e.message, 'error');
    }
  }

  async function exportXhs() {
    // 保持兼容旧调用，默认导出完整单张长图（用户更满意）
    return exportXhsSingle();
  }

  // 计算切片点：每张目标 physH，向上找最近块级元素边界
  function computeCutPoints(physW, physH, scale, fullH) {
    const logicalH = physH / scale;            // 1440 逻辑高
    const blocks = [];
    // 收集块级元素（段落/标题/列表/代码块/表格/图片/公式等）的逻辑 Y 范围
    previewContent.querySelectorAll('h1,h2,h3,h4,p,ul,ol,pre,table,figure,.math-block,blockquote,hr').forEach((el) => {
      const top = el.offsetTop;
      const h = el.offsetHeight;
      if (top >= 0 && h > 0) blocks.push({ top, bottom: top + h });
    });
    blocks.sort((a, b) => a.top - b.top);

    const cuts = [];
    let start = 0;
    const totalLogical = fullH / scale;
    while (start < totalLogical - 1) {
      const target = start + logicalH;
      if (target >= totalLogical - 1) {
        cuts.push([start, totalLogical]);
        break;
      }
      // 在 [target - logicalH*0.35, target] 范围内找最接近 target 的块边界
      const searchStart = target - logicalH * 0.35;
      let best = null;
      let bestScore = Infinity;
      for (const b of blocks) {
        if (b.bottom < searchStart || b.bottom > target) continue;
        const score = target - b.bottom;       // 越接近 target 分越低
        if (score < bestScore) { bestScore = score; best = b.bottom; }
        // 也考虑块顶
        if (b.top >= searchStart && b.top <= target) {
          const s2 = target - b.top;
          if (s2 < bestScore) { bestScore = s2; best = b.top; }
        }
      }
      const cut = best !== null ? best : target;
      cuts.push([start, cut]);
      start = cut;
    }
    return cuts;
  }

  function downloadCanvas(canvas, name) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) { resolve(); return; }
        const a = document.createElement('a');
        a.download = name;
        a.href = URL.createObjectURL(blob);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); resolve(); }, 100);
      }, 'image/png');
    });
  }

  // ── 图片插入 ──
  function insertMarkdownImage(src, alt) {
    const pos = editor.state.selection.main.head;
    const ins = `![${alt || '图片'}](${src})`;
    editor.dispatch({
      changes: { from: pos, insert: ins },
      selection: { anchor: pos + ins.length },
    });
    editor.focus();
  }

  function showInsertMenu(x, y) {
    const menu = $('insert-menu');
    menu.style.display = 'block';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function hideInsertMenu() {
    $('insert-menu').style.display = 'none';
  }

  function initImageInsert() {
    $('btn-insert-img').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showInsertMenu(r.left, r.bottom + 4);
    });
    $('insert-menu').addEventListener('click', (e) => {
      const act = e.target.getAttribute('data-act');
      hideInsertMenu();
      if (act === 'file') $('img-file').click();
      else if (act === 'url') promptInsertUrl();
      else if (act === 'clipboard') pasteFromClipboard();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#insert-menu') && !e.target.closest('#btn-insert-img')) hideInsertMenu();
    });
    $('img-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        insertMarkdownImage(reader.result, f.name.replace(/\.[^.]+$/, ''));
        showToast('✅ 已插入本地图片（base64 内嵌）', 'success');
      };
      reader.readAsDataURL(f);
      e.target.value = '';
    });
  }

  function promptInsertUrl() {
    const url = prompt('粘贴图片 URL：');
    if (url) { insertMarkdownImage(url, '图片'); showToast('✅ 已插入图片链接', 'success'); }
  }

  async function pasteFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        for (const type of it.types) {
          if (type.startsWith('image/')) {
            const blob = await it.getType(type);
            const reader = new FileReader();
            reader.onload = () => {
              insertMarkdownImage(reader.result, '剪贴板图片');
              showToast('✅ 已插入剪贴板图片', 'success');
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
      }
      showToast('剪贴板里没有图片', 'error');
    } catch (e) {
      showToast('读取剪贴板失败：' + e.message + '（需要浏览器授权）', 'error');
    }
  }

  // ── 文件打开 / 下载 / 清空 ──
  const isElectron = typeof window.electronAPI !== 'undefined';
  function initFiles() {
    $('btn-new').addEventListener('click', () => {
      if (!confirm('清空当前内容？')) return;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '' } });
      localStorage.removeItem(LS_KEY);
      showToast('已清空', 'success');
    });
    $('btn-open').addEventListener('click', async () => {
      if (isElectron) {
        // Electron：本地文件对话框
        try {
          const res = await window.electronAPI.invoke('dialog:openFile');
          if (res && res.content !== undefined) {
            editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: String(res.content) } });
            showToast(`✅ 已打开 ${res.fileName}`, 'success');
          }
        } catch (e) { showToast('打开失败：' + e.message, 'error'); }
        return;
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.txt';
      input.onchange = () => {
        const f = input.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: String(reader.result) } });
          showToast(`✅ 已打开 ${f.name}`, 'success');
        };
        reader.readAsText(f);
      };
      input.click();
    });
    $('btn-download').addEventListener('click', () => {
      const text = editor.state.doc.toString();
      if (isElectron) {
        window.electronAPI.invoke('dialog:saveFileAs', text)
          .then((res) => { if (res) showToast(`✅ 已保存 ${res.fileName}`, 'success'); })
          .catch((e) => showToast('保存失败：' + e.message, 'error'));
        return;
      }
      const a = document.createElement('a');
      a.download = (currentTitle || 'markdown') + '.md';
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  // ── toast ──
  let toastTimer = null;
  function showToast(msg, type) {
    toastEl.textContent = msg;
    toastEl.style.background = type === 'error' ? '#b42318' : '#2e6b47';
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  // ── 初始化 ──
  function init() {
    initEditor();
    initThemeSelect();
    initImageInsert();
    initFiles();
    $('btn-copy-wechat').addEventListener('click', () => copyHtml('wechat'));
    $('btn-copy-zhihu').addEventListener('click', () => copyHtml('zhihu'));
    $('btn-export-xhs').addEventListener('click', exportXhs);
    $('btn-export-xhs-multi').addEventListener('click', exportXhsMulti);
    // 粘贴事件：编辑器内粘贴图片直接插入
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          e.preventDefault();
          const blob = it.getAsFile();
          if (blob) {
            const reader = new FileReader();
            reader.onload = () => insertMarkdownImage(reader.result, '粘贴图片');
            reader.readAsDataURL(blob);
          }
          return;
        }
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
