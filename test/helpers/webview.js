/**
 * 测试用 webview HTML 加载器。
 * 与生产代码（extension.js getWebviewHtml）使用完全相同的占位符替换逻辑，
 * 只是把运行时注入值换成测试值。
 */
const fs = require('fs');
const path = require('path');

const PANEL_PATH = path.join(__dirname, '..', '..', 'webview', 'panel.html');

/**
 * 返回替换好占位符的完整 webview HTML（未注入 vscode stub）。
 * @param {object} [opts] 可覆盖测试值
 */
function loadPanelHtml(opts = {}) {
  let html = fs.readFileSync(PANEL_PATH, 'utf8');
  const o = {
    nonce: 'testnonce123',
    csp: 'vscode-webview://mock',
    katexDistUri: 'vscode-webview-resource://mock/katex',
    hlStyleUri: 'vscode-webview-resource://mock/hl.css',
    html2canvasUri: 'vscode-webview-resource://mock/h2c.js',
    extVersion: '3.4.7',
    xhsExportMode: 'classic',
    xhsAdaptiveUseTheme: false,
    ...opts,
  };
  const { nonce, csp, katexDistUri, hlStyleUri, html2canvasUri, extVersion, xhsExportMode, xhsAdaptiveUseTheme } = o;
  html = html
    .split('__M2A_NONCE__').join(nonce)
    .split('__M2A_CSP__').join(csp)
    .split('__M2A_KATEX_URI__').join(katexDistUri)
    .split('__M2A_HL_URI__').join(hlStyleUri)
    .split('__M2A_HTML2CANVAS_URI__').join(html2canvasUri)
    .split('__M2A_VERSION__').join(extVersion)
    .split('__M2A_XHS_MODE_CLASSIC__').join(xhsExportMode === 'classic' ? ' selected' : '')
    .split('__M2A_XHS_MODE_ADAPTIVE__').join(xhsExportMode === 'adaptive' ? ' selected' : '')
    .split('__M2A_XHS_MODE_FLEX__').join(xhsExportMode === 'adaptive' ? 'flex' : 'none')
    .split('__M2A_XHS_THEME_CHECKED__').join(xhsAdaptiveUseTheme ? 'checked' : '')
    .split('__M2A_XHS_MODE_DENSITY__').join(xhsExportMode === 'adaptive' ? '36' : '100')
    .split('__M2A_XHS_MODE_MIN__').join(xhsExportMode === 'adaptive' ? '20' : '60')
    .split('__M2A_XHS_MODE_MAX__').join(xhsExportMode === 'adaptive' ? '60' : '200')
    .split('__M2A_XHS_MODE_STEP__').join(xhsExportMode === 'adaptive' ? '1' : '5');
  return html;
}

/** 注入 acquireVsCodeApi stub，返回可直接 setContent 的 HTML */
function buildTestHtml(opts) {
  const html = loadPanelHtml(opts);
  const stub = `<script nonce="${opts && opts.nonce ? opts.nonce : 'testnonce123'}">
    window.__posted = [];
    window.acquireVsCodeApi = function () { return { postMessage: (m) => window.__posted.push(m), getState: () => null, setState: () => {} }; };
  </script>`;
  return html.replace('</head>', stub + '</head>');
}

module.exports = { loadPanelHtml, buildTestHtml, PANEL_PATH };
