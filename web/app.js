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
  function bodyToCopyHtml(bodyHtml, opts = {}) {
    // 微信/知乎复制：公式转 mdnice 兼容结构 + 主题内联
    const div = document.createElement('div');
    div.innerHTML = bodyHtml;
    // 公式处理：KaTeX HTML 输出 + mdnice data-formula 结构
    div.querySelectorAll('.math-block, .math-inline').forEach((el) => {
      const latex = el.getAttribute('data-math') || '';
      const isDisplay = el.classList.contains('math-block') || el.getAttribute('data-display') === 'true';
      try {
        const html = M2A.katex.renderToString(latex, { displayMode: isDisplay, throwOnError: false, output: 'html', strict: false });
        if (isDisplay) {
          const sec = document.createElement('section');
          sec.setAttribute('data-tools', 'mdnice编辑器');
          sec.setAttribute('data-id', '88');
          sec.style.cssText = 'text-align:center;margin:1.2em 0;';
          sec.innerHTML = `<span class="block-equation" data-formula="${escapeHtml(latex)}" style="display:block;text-align:center;">${html}</span>`;
          el.replaceWith(sec);
        } else {
          const span = document.createElement('span');
          span.className = 'inline-equation';
          span.setAttribute('data-formula', latex);
          span.style.cssText = 'display:inline-block;';
          span.innerHTML = html;
          el.replaceWith(span);
        }
      } catch (_) {
        // 降级 zhihu equation
        const imgUrl = 'https://www.zhihu.com/equation?tex=' + encodeURIComponent(latex);
        if (isDisplay) el.outerHTML = `<div style="text-align:center;margin:1.2em 0;"><img src="${imgUrl}"></div>`;
        else el.outerHTML = `<img src="${imgUrl}" style="display:inline-block;vertical-align:-0.1em;">`;
      }
    });
    return div.innerHTML;
  }

  async function copyHtml(platform) {
    const theme = M2A.getTheme(currentThemeId);
    let html = bodyToCopyHtml(currentBodyHtml);
    // 包一层 article-wrapper + 主题 CSS 内联到 style
    const full = `<style>${theme.css}</style><div class="article-wrapper" style="padding:16px;background:${theme.wrapperBg};font-family:system-ui,-apple-system,'PingFang SC',sans-serif;">${html}</div>`;
    try {
      // 关键：必须写 text/html MIME，粘贴时目标编辑器才识别为富文本而非源码
      const plain = document.createElement('div');
      plain.innerHTML = full;
      const textBlob = new Blob([plain.textContent], { type: 'text/plain' });
      const htmlBlob = new Blob([full], { type: 'text/html' });
      const item = new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob });
      await navigator.clipboard.write([item]);
      showToast(`✅ 已复制${platform === 'wechat' ? '微信' : '知乎'}格式，去编辑器 Ctrl+V / ⌘V 粘贴`, 'success');
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

  // ── 小红书长图导出（多张子图，适配移动端 1080×1440）──
  const XHS_W = 1080, XHS_H = 1440;
  async function exportXhs() {
    const theme = M2A.getTheme(currentThemeId);
    const scale = 2;
    showToast('⏳ 正在生成长图…');
    try {
      // 临时把预览区固定为 1080 宽，确保截图比例正确（截完恢复）
      const zoomCanvas = document.querySelector('.zoom-canvas');
      const prevMaxW = zoomCanvas.style.maxWidth;
      const articleWrapper = previewContent.parentElement;
      const prevWrapPad = articleWrapper.style.padding;
      zoomCanvas.style.maxWidth = XHS_W + 'px';
      articleWrapper.style.padding = '40px 48px';   // 小红书舒适留白
      await new Promise((r) => setTimeout(r, 50));
      // 1. 截完整预览为一张大 canvas（逻辑 1080 宽 → 物理 2160）
      const fullCanvas = await html2canvas(previewContent, {
        scale, backgroundColor: theme.wrapperBg || '#ffffff', useCORS: true, logging: false,
        width: XHS_W,
        windowWidth: XHS_W,
      });
      // 恢复预览宽度
      zoomCanvas.style.maxWidth = prevMaxW;
      articleWrapper.style.padding = prevWrapPad;
      const fullW = fullCanvas.width;          // 物理宽
      const fullH = fullCanvas.height;         // 物理高
      const physW = XHS_W * scale;             // 2160
      const physH = XHS_H * scale;             // 2880

      // 2. 计算切片点：收集块级元素物理 Y 坐标作为候选边界
      const cutPoints = computeCutPoints(physW, physH, scale, fullH);

      // 3. 逐段 drawImage 切片导出
      const title = (currentTitle || 'markdown').replace(/[\\/:*?"<>|]/g, '');
      const downloads = [];
      for (let i = 0; i < cutPoints.length; i++) {
        const [y0, y1] = cutPoints[i];
        const h = y1 - y0;
        const slice = document.createElement('canvas');
        slice.width = physW;
        slice.height = physH;                  // 每张固定 1440 逻辑高
        const ctx = slice.getContext('2d');
        ctx.fillStyle = theme.wrapperBg || '#ffffff';
        ctx.fillRect(0, 0, physW, physH);
        // 底部填充背景，避免最后一张矮
        ctx.drawImage(fullCanvas, 0, y0, physW, h, 0, 0, physW, h);
        // 直接下载
        await downloadCanvas(slice, `${title}-${String(i + 1).padStart(2, '0')}.png`);
        downloads.push(`${title}-${String(i + 1).padStart(2, '0')}.png`);
      }
      showToast(`✅ 已导出 ${downloads.length} 张子图（1080×1440）`, 'success');
    } catch (e) {
      console.error(e);
      showToast('导出失败：' + e.message, 'error');
    }
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
