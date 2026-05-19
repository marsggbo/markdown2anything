'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const https = require('https');

const { renderMarkdown, buildFullHtml, buildWechatCopyHtml, buildZhihuCopyHtml, buildXhsCopyHtml, convertMarkdownToWeChat, buildXhsRenderHtml } = require('./lib/converter');
const { THEMES, DEFAULT_THEME_ID, getTheme } = require('./lib/themes');

// ─────────────────────────────────────────────
//  全局状态
// ─────────────────────────────────────────────

/** @type {vscode.ExtensionContext} */
let extContext;

/** @type {vscode.OutputChannel} */
let outputChannel;

/** Map<mdFilePath, vscode.WebviewPanel> */
const previewPanels = new Map();

/** Map<mdFilePath, NodeJS.Timeout> */
const debounceTimers = new Map();

/** 当前选中的主题 ID（全局，所有预览共享） */
let currentThemeId = DEFAULT_THEME_ID;

// ─────────────────────────────────────────────
//  激活 / 停用
// ─────────────────────────────────────────────

function activate(context) {
  extContext = context;
  outputChannel = vscode.window.createOutputChannel('MD2WeChat');
  log('MD2WeChat 插件已激活');

  context.subscriptions.push(
    vscode.commands.registerCommand('md2wechat.preview', handlePreview),
    vscode.commands.registerCommand('md2wechat.convert', handleConvert),

    // 文档变更时更新预览（500ms 防抖）
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== 'markdown') return;
      const mdPath = e.document.uri.fsPath;
      if (!previewPanels.has(mdPath)) return;
      scheduleUpdate(mdPath);
    }),

    // 活跃编辑器切换时如有已开启的预览则刷新
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || editor.document.languageId !== 'markdown') return;
      const mdPath = editor.document.uri.fsPath;
      if (previewPanels.has(mdPath)) {
        scheduleUpdate(mdPath);
      }
    }),
  );
}

function deactivate() {
  if (outputChannel) outputChannel.dispose();
}

// ─────────────────────────────────────────────
//  日志
// ─────────────────────────────────────────────

function log(msg) {
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ─────────────────────────────────────────────
//  获取 Markdown 文件路径
// ─────────────────────────────────────────────

/**
 * @param {vscode.Uri|undefined} uri
 * @returns {string|null}
 */
async function resolveMdFilePath(uri) {
  if (uri && uri.fsPath) {
    if (!uri.fsPath.endsWith('.md')) {
      vscode.window.showErrorMessage('请选择 Markdown (.md) 文件');
      return null;
    }
    return uri.fsPath;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('请先打开一个 Markdown 文件');
    return null;
  }
  if (editor.document.languageId !== 'markdown') {
    vscode.window.showErrorMessage('当前文件不是 Markdown 格式');
    return null;
  }
  if (editor.document.isDirty) {
    await editor.document.save();
  }
  return editor.document.uri.fsPath;
}

// ─────────────────────────────────────────────
//  获取模板路径
// ─────────────────────────────────────────────

function getTemplatePath(workspacePath, templateName) {
  // 1. 工作区自定义模板
  if (workspacePath) {
    const custom = path.join(workspacePath, 'templates', `${templateName}.html`);
    if (fs.existsSync(custom)) return custom;
  }
  // 2. 扩展内置
  const builtin = path.join(extContext.extensionUri.fsPath, 'templates', `${templateName}.html`);
  if (fs.existsSync(builtin)) return builtin;
  // 3. 默认 wechat
  const fallback = path.join(extContext.extensionUri.fsPath, 'templates', 'wechat.html');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

// ─────────────────────────────────────────────
//  命令：预览
// ─────────────────────────────────────────────

async function handlePreview(uri) {
  const mdPath = await resolveMdFilePath(uri);
  if (!mdPath) return;

  // 已有面板则直接显示
  if (previewPanels.has(mdPath)) {
    previewPanels.get(mdPath).reveal(vscode.ViewColumn.Beside, true);
    scheduleUpdate(mdPath);
    return;
  }

  // 创建新面板
  const panel = vscode.window.createWebviewPanel(
    'md2wechatPreview',
    `预览: ${path.basename(mdPath)}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        extContext.extensionUri,
        vscode.Uri.file(path.join(extContext.extensionUri.fsPath, 'node_modules')),
      ],
    },
  );

  previewPanels.set(mdPath, panel);

  // 面板关闭时清理
  panel.onDidDispose(() => {
    previewPanels.delete(mdPath);
    const t = debounceTimers.get(mdPath);
    if (t) { clearTimeout(t); debounceTimers.delete(mdPath); }
  }, null, extContext.subscriptions);

  // 接收 webview 消息
  panel.webview.onDidReceiveMessage(
    (msg) => handleWebviewMessage(msg, panel, mdPath),
    null,
    extContext.subscriptions,
  );

  // 初始化内容
  panel.webview.html = getWebviewHtml(panel.webview, '', mdPath);
  updatePreview(panel, mdPath);
}

// ─────────────────────────────────────────────
//  命令：导出 HTML
// ─────────────────────────────────────────────

async function handleConvert(uri) {
  const mdPath = await resolveMdFilePath(uri);
  if (!mdPath) return;

  try {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mdPath));
    const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(mdPath);
    const cfg = vscode.workspace.getConfiguration('md2wechat');
    const templateName = cfg.get('template', 'wechat');
    const outputDir = cfg.get('outputPath', 'build');
    const templatePath = getTemplatePath(workspacePath, templateName);

    if (!templatePath) {
      vscode.window.showErrorMessage(`找不到模板: ${templateName}`);
      return;
    }

    const outputPath = path.join(workspacePath, outputDir, 'wechat.html');
    log(`开始导出: ${mdPath}`);
    convertMarkdownToWeChat(mdPath, templatePath, outputPath);
    log(`导出完成: ${outputPath}`);

    const action = await vscode.window.showInformationMessage(
      `✅ 导出完成: ${outputPath}`,
      '打开文件',
      '打开文件夹',
    );
    if (action === '打开文件') {
      vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputPath));
    } else if (action === '打开文件夹') {
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputPath));
    }
  } catch (err) {
    log(`导出失败: ${err.message}`);
    vscode.window.showErrorMessage(`导出失败: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
//  防抖更新预览
// ─────────────────────────────────────────────

function scheduleUpdate(mdPath) {
  const existing = debounceTimers.get(mdPath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(mdPath);
    const panel = previewPanels.get(mdPath);
    if (panel) updatePreview(panel, mdPath);
  }, 500);
  debounceTimers.set(mdPath, timer);
}

function updatePreview(panel, mdPath) {
  try {
    const { bodyHtml, title } = renderMarkdown(mdPath);
    const theme = getTheme(currentThemeId);
    panel.webview.postMessage({ type: 'update', bodyHtml, title, theme: { id: theme.id, css: theme.css, wrapperBg: theme.wrapperBg } });
  } catch (err) {
    panel.webview.postMessage({ type: 'error', message: err.message });
  }
}

// ─────────────────────────────────────────────
//  处理 webview → extension 消息
// ─────────────────────────────────────────────

/**
 * 用 playwright-core CLI 自动安装 Chromium，实时转发进度到 webview
 */
function installChromium(panel) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const cliPath = path.join(
      extContext.extensionUri.fsPath, 'node_modules', 'playwright-core', 'lib', 'cli', 'program.js'
    );
    const proc = spawn(process.execPath, [cliPath, 'install', 'chromium']);
    proc.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) panel.webview.postMessage({ type: 'xhsPythonProgress', message: '📥 ' + line });
    });
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) panel.webview.postMessage({ type: 'xhsPythonProgress', message: '📥 ' + line });
    });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve()); // 即使失败也继续尝试
  });
}

async function handleWebviewMessage(msg, panel, mdPath) {
  switch (msg.type) {
    case 'ready': {
      // webview 加载完毕，发送最新内容
      updatePreview(panel, mdPath);
      // 发送当前配置
      sendConfig(panel);
      // 发送主题列表
      panel.webview.postMessage({
        type: 'themeList',
        themes: THEMES.map((t) => ({ id: t.id, name: t.name })),
        currentId: currentThemeId,
      });
      break;
    }

    case 'getConfig': {
      sendConfig(panel);
      break;
    }

    case 'saveConfig': {
      const cfg = vscode.workspace.getConfiguration('md2wechat');
      await cfg.update('appid', msg.appid, vscode.ConfigurationTarget.Global);
      await cfg.update('appSecret', msg.appSecret, vscode.ConfigurationTarget.Global);
      if (msg.author !== undefined)
        await cfg.update('author', msg.author, vscode.ConfigurationTarget.Global);
      if (msg.digest !== undefined)
        await cfg.update('digest', msg.digest, vscode.ConfigurationTarget.Global);
      panel.webview.postMessage({ type: 'configSaved' });
      vscode.window.showInformationMessage('配置已保存');
      break;
    }

    case 'upload': {
      await handleUpload(msg, panel, mdPath);
      break;
    }

    case 'todoToggle': {
      // 用户在预览中切换 Todo 复选框，同步更新 MD 文件
      try {
        const content = fs.readFileSync(mdPath, 'utf8');
        let count = 0;
        const updated = content.replace(/^(\s*[-*+]\s)\[( |x|X)\]/gm, (match, prefix) => {
          if (count++ === msg.index) {
            return prefix + (msg.checked ? '[x]' : '[ ]');
          }
          return match;
        });
        if (updated !== content) {
          fs.writeFileSync(mdPath, updated, 'utf8');
        }
      } catch (e) {
        log(`todoToggle 失败: ${e.message}`);
      }
      break;
    }

    case 'exportHtml': {
      await handleConvert(vscode.Uri.file(mdPath));
      break;
    }

    case 'fetchImageBase64': {
      // 用 Node 端下载图片并转 base64，绕过 webview CSP 限制
      try {
        const imgUrl = msg.url;
        const https = require('https');
        const http  = require('http');
        const urlMod = require('url');
        const parsed = new urlMod.URL(imgUrl);
        const client = parsed.protocol === 'https:' ? https : http;
        const data = await new Promise((resolve, reject) => {
          const chunks = [];
          const req = client.get(imgUrl, { timeout: 10000 }, (res) => {
            if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        const ext = (parsed.pathname.split('.').pop() || 'png').toLowerCase();
        const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
        const mime = mimeMap[ext] || 'image/png';
        const dataUrl = `data:${mime};base64,${data.toString('base64')}`;
        panel.webview.postMessage({ type: 'imageBase64Result', reqId: msg.reqId, url: imgUrl, dataUrl });
      } catch(e) {
        panel.webview.postMessage({ type: 'imageBase64Result', reqId: msg.reqId, url: msg.url, dataUrl: null, error: e.message });
      }
      break;
    }

    case 'generateXhsViaPython': {
      // 用 Node.js + Playwright 截图（无需 Python，自动检测/安装 Chromium）
      const { spawn } = require('child_process');
      const os = require('os');
      const { width = 1080, height = 1440, padding = 40, bg = '#ffffff' } = msg;

      // 生成独立渲染 HTML
      const { bodyHtml } = renderMarkdown(mdPath);
      const theme = getTheme(currentThemeId);
      const htmlContent = buildXhsRenderHtml(bodyHtml, path.dirname(mdPath), theme);
      const tmpHtml = path.join(os.tmpdir(), `md2wechat_xhs_${Date.now()}.html`);
      const base = path.basename(mdPath, path.extname(mdPath));
      const outDir = path.join(path.dirname(mdPath), `${base}_xhs`);
      fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

      const scriptPath = path.join(extContext.extensionUri.fsPath, 'scripts', 'xhs_screenshot.js');

      async function runScreenshot(retryAfterInstall) {
        panel.webview.postMessage({ type: 'xhsPythonProgress', message: '⏳ 渲染中，请稍候...' });

        const proc = spawn(process.execPath, [
          scriptPath, tmpHtml, outDir,
          '--width', String(width), '--height', String(height),
          '--padding', String(padding), '--bg', bg,
        ]);

        let stdout = '';
        proc.stdout.on('data', d => {
          stdout += d.toString();
          // 实时转发 INFO 进度
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (line.startsWith('INFO:')) {
              panel.webview.postMessage({ type: 'xhsPythonProgress', message: '⏳ ' + line.slice(5) });
            }
          }
        });

        proc.on('close', async (code) => {
          try { fs.unlinkSync(tmpHtml); } catch(_) {}

          if (code === 2 && !retryAfterInstall) {
            // 未找到 Chromium → 自动安装后重试
            panel.webview.postMessage({ type: 'xhsPythonProgress', message: '📥 首次使用，正在下载 Chromium（约 150MB）...' });
            await installChromium(panel);
            // 重新生成 HTML（tmpHtml 已被删除）
            const htmlContent2 = buildXhsRenderHtml(bodyHtml, path.dirname(mdPath), theme);
            fs.writeFileSync(tmpHtml, htmlContent2, 'utf8');
            runScreenshot(true);
            return;
          }

          if (code !== 0) {
            const errLine = stdout.split('\n').find(l => l.startsWith('ERROR:')) || '截图失败';
            panel.webview.postMessage({ type: 'xhsPythonError', message: errLine.replace('ERROR:', '').trim() });
            return;
          }

          const savedPaths = stdout.split('\n')
            .filter(l => l.startsWith('SAVED:'))
            .map(l => l.slice(6).trim())
            .filter(Boolean);

          const dataUrls = savedPaths.map(p => {
            const buf = fs.readFileSync(p);
            return `data:image/png;base64,${buf.toString('base64')}`;
          });

          panel.webview.postMessage({ type: 'xhsPythonDone', dataUrls, outDir });
        });

        proc.on('error', (err) => {
          panel.webview.postMessage({ type: 'xhsPythonError', message: err.message });
        });
      }

      runScreenshot(false);
      break;
    }

    case 'saveXhsImages': {
      try {
        const dataUrls = msg.dataUrls || [];
        // 目录：同 MD 文件名去后缀 + '_img'
        const base = path.basename(mdPath, path.extname(mdPath));
        const dir = path.join(path.dirname(mdPath), `${base}_img`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        dataUrls.forEach((dataUrl, i) => {
          const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
          const buf = Buffer.from(b64, 'base64');
          const fname = `xiaohongshu-${String(i + 1).padStart(2, '0')}.png`;
          fs.writeFileSync(path.join(dir, fname), buf);
        });
        log(`小红书图片已导出到: ${dir}`);
        panel.webview.postMessage({ type: 'saveXhsImagesDone', count: dataUrls.length, dir });
        vscode.window.showInformationMessage(`✅ 已导出 ${dataUrls.length} 张图片到 ${dir}`, '打开目录').then(a => {
          if (a === '打开目录') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        });
      } catch (err) {
        log(`保存小红书图片失败: ${err.message}`);
        panel.webview.postMessage({ type: 'saveXhsImagesError', message: err.message });
      }
      break;
    }

    case 'getWechatHtml': {
      try {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mdPath));
        const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(mdPath);
        const cfg = vscode.workspace.getConfiguration('md2wechat');
        const templateName = cfg.get('template', 'wechat');
        const templatePath = getTemplatePath(workspacePath, templateName);
        const { bodyHtml } = renderMarkdown(mdPath);
        const theme = getTheme(currentThemeId);
        const html = buildWechatCopyHtml(bodyHtml, templatePath, theme);
        panel.webview.postMessage({ type: 'wechatHtml', html });
      } catch (err) {
        log(`buildWechatCopyHtml 失败: ${err.message}`);
        panel.webview.postMessage({ type: 'wechatHtmlError', message: err.message });
      }
      break;
    }

    case 'getZhihuHtml': {
      try {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mdPath));
        const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(mdPath);
        const cfg = vscode.workspace.getConfiguration('md2wechat');
        const templateName = cfg.get('template', 'wechat');
        const templatePath = getTemplatePath(workspacePath, templateName);
        const { bodyHtml } = renderMarkdown(mdPath);
        const theme = getTheme(currentThemeId);
        const html = buildZhihuCopyHtml(bodyHtml, templatePath, theme);
        panel.webview.postMessage({ type: 'zhihuHtml', html });
      } catch (err) {
        log(`buildZhihuCopyHtml 失败: ${err.message}`);
        panel.webview.postMessage({ type: 'zhihuHtmlError', message: err.message });
      }
      break;
    }

    case 'getXhsCopyHtml': {
      try {
        const { bodyHtml } = renderMarkdown(mdPath);
        const theme = getTheme(currentThemeId);
        const html = buildXhsCopyHtml(bodyHtml, theme);
        panel.webview.postMessage({ type: 'xhsCopyHtml', html });
      } catch (err) {
        log(`buildXhsCopyHtml 失败: ${err.message}`);
        panel.webview.postMessage({ type: 'xhsCopyHtmlError', message: err.message });
      }
      break;
    }

    case 'setTheme': {
      currentThemeId = msg.themeId || DEFAULT_THEME_ID;
      // 重新渲染预览
      updatePreview(panel, mdPath);
      break;
    }

    default:
      break;
  }
}

function sendConfig(panel) {
  const cfg = vscode.workspace.getConfiguration('md2wechat');
  panel.webview.postMessage({
    type: 'config',
    appid: cfg.get('appid', ''),
    appSecret: cfg.get('appSecret', ''),
    author: cfg.get('author', ''),
    digest: cfg.get('digest', ''),
  });
}

// ─────────────────────────────────────────────
//  上传到微信草稿箱（通过 FastPen API）
// ─────────────────────────────────────────────

async function handleUpload(msg, panel, mdPath) {
  const { rawMarkdown } = renderMarkdown(mdPath);

  const { appid, appSecret, title, author, digest } = msg;

  if (!appid || !appSecret) {
    panel.webview.postMessage({
      type: 'uploadResult',
      success: false,
      error: '请先配置 AppID 和 AppSecret',
    });
    return;
  }

  panel.webview.postMessage({ type: 'uploadStart' });
  log(`开始上传: ${title}`);

  try {
    const result = await postToFastPen({ markdown: rawMarkdown, title, appid, appSecret, author, digest });
    log(`上传结果: ${JSON.stringify(result)}`);
    if (result.success) {
      panel.webview.postMessage({
        type: 'uploadResult',
        success: true,
        mediaId: result.data && result.data.media_id,
      });
      vscode.window.showInformationMessage(`✅ 上传成功！media_id: ${result.data && result.data.media_id}`);
    } else {
      panel.webview.postMessage({
        type: 'uploadResult',
        success: false,
        error: result.message || '上传失败，请检查配置',
      });
    }
  } catch (err) {
    log(`上传异常: ${err.message}`);
    panel.webview.postMessage({
      type: 'uploadResult',
      success: false,
      error: err.message,
    });
  }
}

/**
 * POST to FastPen API to upload article to WeChat draft box.
 * @param {{ markdown, title, appid, appSecret, author, digest }} params
 */
function postToFastPen({ markdown, title, appid, appSecret, author, digest }) {
  return new Promise((resolve, reject) => {
    const bodyData = JSON.stringify({
      markdown,
      title,
      appid,
      app_secret: appSecret,
      author: author || '',
      digest: digest || '',
    });

    const options = {
      hostname: 'www.fastpen.online',
      path: '/api/draft/multi/import-markdown',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyData, 'utf8'),
        'User-Agent': 'md2wechat-vscode/1.0',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          reject(new Error(`服务器响应解析失败: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('请求超时（30s），请检查网络'));
    });
    req.write(bodyData, 'utf8');
    req.end();
  });
}

// ─────────────────────────────────────────────
//  生成 Webview HTML
// ─────────────────────────────────────────────

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function getWebviewHtml(webview, _bodyHtml, mdPath) {
  const nonce = getNonce();
  const csp = webview.cspSource;

  // KaTeX 资源 URI（从扩展的 node_modules 加载）
  const katexDistPath = path.join(extContext.extensionUri.fsPath, 'node_modules', 'katex', 'dist');
  const katexDistUri = webview.asWebviewUri(vscode.Uri.file(katexDistPath));

  // highlight.js 样式 URI
  const hlStylePath = path.join(
    extContext.extensionUri.fsPath,
    'node_modules',
    'highlight.js',
    'styles',
    'github.min.css',
  );
  const hlStyleUri = webview.asWebviewUri(vscode.Uri.file(hlStylePath));

  // html2canvas URI
  const html2canvasPath = path.join(
    extContext.extensionUri.fsPath,
    'node_modules',
    'html2canvas',
    'dist',
    'html2canvas.min.js',
  );
  const html2canvasUri = webview.asWebviewUri(vscode.Uri.file(html2canvasPath));

  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${csp} 'unsafe-inline';
    font-src ${csp};
    script-src 'nonce-${nonce}';
    img-src ${csp} data: https: http:;
    connect-src https: http:;
  ">
  <title>MD2WeChat 预览</title>

  <!-- KaTeX CSS（从扩展本地加载，支持字体） -->
  <link rel="stylesheet" href="${katexDistUri}/katex.min.css">
  <!-- highlight.js GitHub 主题 -->
  <link rel="stylesheet" href="${hlStyleUri}">
  <!-- html2canvas -->
  <script nonce="${nonce}" src="${html2canvasUri}"></script>

  <style>
    /* ── 基础重置 ── */
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #e8e8e8;
      color: #333;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── 工具栏 ── */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: #2c2c2c;
      border-bottom: 1px solid #444;
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .toolbar-title {
      flex: 1;
      font-size: 13px;
      color: #ccc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn {
      padding: 5px 14px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .btn-primary   { background: #07c160; color: #fff; }
    .btn-primary:hover   { background: #06ad56; }
    .btn-secondary { background: #555; color: #eee; }
    .btn-secondary:hover { background: #666; }
    .btn-active    { background: #0078d4; color: #fff; }
    .btn-upload    { background: #f06529; color: #fff; }
    .btn-upload:hover    { background: #d4551f; }
    .btn-zhihu     { background: #0066ff; color: #fff; }
    .btn-zhihu:hover     { background: #0052cc; }
    .btn-xhs       { background: #ff2442; color: #fff; }
    .btn-xhs:hover       { background: #d91c38; }
    .btn-xhs-copy  { background: #ff6080; color: #fff; }
    .btn-xhs-copy:hover  { background: #e04060; }
    .btn:disabled  { opacity: 0.5; cursor: not-allowed; }

    /* ── 主区域 ── */
    .main {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ── 预览区域 ── */
    .preview-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 0;
      display: flex;
      justify-content: center;
      background: #fff;
    }
    .article-wrapper {
      width: 100%;
      max-width: 680px;
      background: transparent;
      padding: 32px 28px;
      min-height: 200px;
    }

    /* ── 侧面板通用 ── */
    .side-panel {
      width: 0;
      overflow: hidden;
      transition: width 0.25s ease;
      background: #1e1e1e;
      border-left: 1px solid #444;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .side-panel.open { width: 340px; }
    .xhs-panel.open  { width: 480px; min-width: 340px; max-width: 80vw; position: relative; }
    .xhs-panel .resize-handle {
      position: absolute; left: 0; top: 0; bottom: 0; width: 5px;
      cursor: col-resize; background: transparent; z-index: 10;
    }
    .xhs-panel .resize-handle:hover { background: #0078d4; }
    .side-panel-header {
      padding: 12px 16px;
      font-size: 13px;
      font-weight: 600;
      color: #ccc;
      border-bottom: 1px solid #333;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .panel-close-btn {
      background: none;
      border: none;
      color: #888;
      font-size: 16px;
      cursor: pointer;
      padding: 0 2px;
      line-height: 1;
      flex-shrink: 0;
    }
    .panel-close-btn:hover { color: #fff; }
    .side-panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    label {
      display: block;
      font-size: 12px;
      color: #aaa;
      margin-bottom: 4px;
      margin-top: 12px;
    }
    label:first-child { margin-top: 0; }
    input[type=text], input[type=password], textarea {
      width: 100%;
      padding: 7px 10px;
      background: #2d2d2d;
      border: 1px solid #444;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus, textarea:focus { border-color: #0078d4; }
    textarea {
      resize: vertical;
      min-height: 80px;
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 12px;
    }
    #css-textarea { min-height: 300px; }
    .panel-actions {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }
    .panel-actions .btn { flex: 1; }
    .hint {
      font-size: 11px;
      color: #777;
      margin-top: 8px;
      line-height: 1.5;
    }
    .hint a { color: #4fc3f7; }
    .divider {
      height: 1px;
      background: #333;
      margin: 14px 0;
    }

    /* ── 状态消息 ── */
    .toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(80px);
      background: #333;
      color: #fff;
      padding: 10px 20px;
      border-radius: 20px;
      font-size: 13px;
      opacity: 0;
      transition: all 0.3s;
      z-index: 9999;
      white-space: nowrap;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .toast.success { background: #07c160; }
    .toast.error   { background: #c0392b; }

    /* ── 上传结果区域 ── */
    .upload-result {
      margin-top: 12px;
      padding: 10px;
      border-radius: 4px;
      font-size: 13px;
      display: none;
    }
    .upload-result.success { background: #1a3a1a; color: #aff; border: 1px solid #2a6a2a; }
    .upload-result.error   { background: #3a1a1a; color: #faa; border: 1px solid #6a2a2a; }

    /* ── 文章内容样式（镜像 template.html 以便预览一致） ── */
    .article-wrapper p,
    .article-wrapper li,
    .article-wrapper td,
    .article-wrapper th {
      text-align: left;
      color: #3f3f3f;
      line-height: 1.75em;
      font-family: system-ui, -apple-system, BlinkMacSystemFont,
        'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB',
        'Microsoft YaHei UI', 'Microsoft YaHei', Arial, sans-serif;
      font-size: 16px;
    }
    .article-wrapper strong { font-weight: 600; color: rgb(0, 122, 170); }
    .article-wrapper img { outline: none; text-decoration: none; max-width: 100%; display: block; margin: 0 auto; }
    .article-wrapper p { margin: 1.3em 0; }
    .article-wrapper h1 { font-size: 140%; color: #de7456; text-align: center; }
    .article-wrapper h2 {
      font-size: 120%; font-weight: bold; color: #de7456;
      text-align: center; line-height: 2;
      border-bottom: 1px solid #de7456;
      margin: 1em auto; padding-bottom: 4px;
    }
    .article-wrapper h3 {
      font-size: 110%; color: rgb(0, 122, 170);
      border-left: 3px solid rgb(0, 122, 170);
      padding-left: 10px; margin: 24px 0;
    }
    .article-wrapper h4, .article-wrapper h5, .article-wrapper h6 {
      font-size: 100%; color: rgb(0, 122, 170); margin: 16px 0;
    }
    .article-wrapper a { color: orange; }
    .article-wrapper blockquote {
      border-left: 4px solid #ddd;
      margin: 1em 0;
      padding: 0.5em 1em;
      color: #666;
      background: #fafafa;
    }
    .article-wrapper table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }
    .article-wrapper table td,
    .article-wrapper table th {
      border: 1px solid #999;
      padding: 8px;
    }
    .article-wrapper table th { background: #f2f2f2; font-weight: bold; text-align: center; }
    .article-wrapper ul, .article-wrapper ol { padding-left: 1.5em; }
    .article-wrapper figcaption {
      display: block;
      text-align: center;
      color: #999;
      font-size: 14px;
      margin-top: 8px;
      line-height: 1.5;
    }
    /* KaTeX 公式样式 */
    .article-wrapper .math-block {
      text-align: center;
      overflow-x: auto;
      margin: 1.2em 0;
    }
    .article-wrapper .math-inline { display: inline; }
    /* 代码块 mac 风格 */
    .article-wrapper pre.mac-code {
      border-radius: 8px;
      background: #f6f8fa;
      border: 1px solid #eaedf0;
      overflow-x: auto;
      margin: 10px 0;
    }
    .article-wrapper pre.mac-code code.hljs { padding: 10px 16px; }
    .article-wrapper code:not([class]) {
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
      font-size: 14px;
    }

    /* ── Todo 任务列表 ── */
    .article-wrapper .task-list-item {
      list-style: none;
      margin-left: -1.2em;
      padding-left: 0.2em;
      display: flex;
      align-items: flex-start;
      gap: 6px;
    }
    .article-wrapper .task-checkbox {
      cursor: pointer;
      margin-top: 0.35em;
      flex-shrink: 0;
      width: 15px;
      height: 15px;
      accent-color: #07c160;
    }

    /* ── 缩放容器 ── */
    .zoom-controls {
      display: flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
    }
    .zoom-controls .btn {
      padding: 4px 9px;
      font-size: 14px;
    }
    #zoom-value {
      font-size: 12px;
      color: #ccc;
      min-width: 40px;
      text-align: center;
      user-select: none;
    }

    /* ── 小红书图片输出 ── */
    .xhs-img-item {
      margin-bottom: 12px;
      border: 1px solid #333;
      border-radius: 4px;
      overflow: hidden;
    }
    .xhs-img-item img {
      width: 100%;
      display: block;
      cursor: zoom-in;
    }
    .xhs-img-item .xhs-img-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: #111;
      font-size: 12px;
      color: #888;
      gap: 6px;
    }
    .xhs-img-item .xhs-img-meta button {
      padding: 3px 10px;
      font-size: 12px;
      background: #ff2442;
      color: #fff;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      white-space: nowrap;
    }
    /* 全屏预览遮罩 */
    #xhs-lightbox {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.85);
      z-index: 99999;
      align-items: center;
      justify-content: center;
      cursor: zoom-out;
    }
    #xhs-lightbox.show { display: flex; }
    #xhs-lightbox img {
      max-width: 90vw;
      max-height: 92vh;
      border-radius: 4px;
      box-shadow: 0 8px 32px rgba(0,0,0,.6);
    }
  </style>
</head>
<body>

  <!-- 工具栏 -->
  <div class="toolbar">
    <span class="toolbar-title" id="doc-title">MD2WeChat 预览</span>
    <select id="theme-select" title="切换主题" style="
      padding:5px 8px; border:none; border-radius:4px; cursor:pointer;
      font-size:13px; background:#3a3a3a; color:#eee; outline:none;
    ">
      <option value="">主题...</option>
    </select>
    <div class="zoom-controls">
      <button class="btn btn-secondary" id="btn-zoom-out" title="缩小预览">－</button>
      <span id="zoom-value">100%</span>
      <button class="btn btn-secondary" id="btn-zoom-in" title="放大预览">＋</button>
      <button class="btn btn-secondary" id="btn-zoom-reset" title="重置缩放" style="padding:4px 7px;">↺</button>
    </div>
    <button class="btn btn-primary" id="btn-copy" title="选中并复制预览区域内容，可直接粘贴到微信公众号编辑器">
      📋 复制微信
    </button>
    <button class="btn btn-zhihu" id="btn-zhihu" title="复制适合粘贴到知乎编辑器的内容（公式保留 KaTeX HTML）">
      📝 复制知乎
    </button>
    <button class="btn btn-xhs" id="btn-xhs" title="将文章渲染为多张图片导出，适合发布小红书">
      📸 导出小红书
    </button>
    <button class="btn btn-xhs-copy" id="btn-xhs-copy" title="复制适合粘贴到小红书长文编辑器的内容（文字格式保留；图片需在小红书编辑器内手动上传）">
      📱 复制小红书
    </button>
    <button class="btn btn-secondary" id="btn-style" title="打开 CSS 样式编辑器">
      🎨 修改样式
    </button>
    <button class="btn btn-upload" id="btn-upload" title="上传到微信公众号草稿箱">
      ☁️ 上传公众号
    </button>
    <button class="btn btn-secondary" id="btn-export" title="导出 HTML 文件到 build/ 目录">
      💾 导出 HTML
    </button>
  </div>

  <!-- 主内容区 -->
  <div class="main">
    <!-- 预览区 -->
    <div class="preview-scroll">
      <div class="article-wrapper" id="preview-content">
        <p style="color:#999;text-align:center;">正在加载预览...</p>
      </div>
    </div>

    <!-- 样式编辑面板 -->
    <div class="side-panel" id="style-panel">
      <div class="side-panel-header">🎨 自定义样式<button class="panel-close-btn" data-close-panel="style-panel" data-close-state="stylePanelOpen">×</button></div>
      <div class="side-panel-body">
        <p class="hint">在此输入 CSS，将作用于预览区域内的文章内容。<br>样式在当前会话内保持，不会影响导出文件。</p>
        <label>自定义 CSS</label>
        <textarea id="css-textarea" placeholder="/* 在这里输入自定义 CSS */
.article-wrapper h1 { color: red; }
.article-wrapper p { font-size: 18px; }
"></textarea>
        <div class="panel-actions">
          <button class="btn btn-primary" id="btn-apply-css">应用</button>
          <button class="btn btn-secondary" id="btn-reset-css">重置</button>
        </div>
      </div>
    </div>

    <!-- 上传面板 -->
    <div class="side-panel" id="upload-panel">
      <div class="side-panel-header">☁️ 上传到微信公众号<button class="panel-close-btn" data-close-panel="upload-panel" data-close-state="uploadPanelOpen">×</button></div>
      <div class="side-panel-body">
        <!-- 配置区 -->
        <div id="config-section">
          <p class="hint">
            需要配置微信公众号开发者信息。<br>
            前往
            <a href="https://mp.weixin.qq.com/" title="微信公众平台">微信公众平台</a>
            → 设置与开发 → 基本配置 中获取。
          </p>
          <label>AppID <span style="color:#f06529">*</span></label>
          <input type="text" id="input-appid" placeholder="wx开头的AppID">
          <label>AppSecret <span style="color:#f06529">*</span></label>
          <input type="password" id="input-appsecret" placeholder="AppSecret">
          <div class="panel-actions">
            <button class="btn btn-primary" id="btn-save-config">保存配置</button>
          </div>
          <div class="divider"></div>
        </div>

        <!-- 文章信息 -->
        <label>文章标题 <span style="color:#f06529">*</span></label>
        <input type="text" id="input-title" placeholder="文章标题">
        <label>作者（可选）</label>
        <input type="text" id="input-author" placeholder="作者名称">
        <label>文章摘要（可选）</label>
        <textarea id="input-digest" placeholder="文章摘要，留空则自动截取" style="min-height:60px;"></textarea>

        <div class="hint" style="margin-top:12px;color:#e6a817;border:1px solid #555;padding:8px;border-radius:4px;">
          ⚠️ 上传功能通过 <a href="https://www.fastpen.online" title="FastPen">FastPen</a> 第三方服务实现，您的 AppSecret 将被发送至该服务。请确认您信任该服务后再使用。
        </div>

        <div class="panel-actions" style="margin-top:14px;">
          <button class="btn btn-upload" id="btn-do-upload">上传草稿箱</button>
        </div>

        <!-- 上传结果 -->
        <div class="upload-result" id="upload-result"></div>
      </div>
    </div>

    <!-- 小红书面板 -->
    <div class="side-panel xhs-panel" id="xhs-panel">
      <div class="resize-handle" id="xhs-resize-handle"></div>
      <div class="side-panel-header">📸 导出小红书<button class="panel-close-btn" data-close-panel="xhs-panel" data-close-state="xhsPanelOpen">×</button></div>
      <div class="side-panel-body">
        <p class="hint">将文章渲染为多张适合小红书发布的图片。首次使用会自动下载 Chromium（约 150MB），之后无需等待。</p>

        <label>图片宽度（px）</label>
        <input type="number" id="xhs-width" value="1080" min="600" max="2000">

        <label>每张最大高度（px）</label>
        <input type="number" id="xhs-height" value="1440" min="400" max="4000">

        <label>四周内边距（px）</label>
        <input type="number" id="xhs-padding" value="40" min="0" max="200">

        <label>背景色判断容差（0-100）</label>
        <input type="number" id="xhs-tolerance" value="15" min="0" max="100">

        <div class="panel-actions" style="margin-top:14px;">
          <button class="btn btn-xhs" id="btn-xhs-python">📸 生成图片</button>
          <button class="btn btn-secondary" id="btn-xhs-reset">恢复默认</button>
        </div>
        <div class="panel-actions" style="margin-top:8px;">
          <button class="btn btn-secondary" id="btn-xhs-export-all" disabled title="先生成图片，再一键导出到 MD 同名目录">💾 一键导出全部</button>
        </div>

        <div id="xhs-output" style="margin-top:14px;"></div>
      </div>
    </div>
  </div>

  <!-- Toast 提示 -->
  <div class="toast" id="toast"></div>

  <!-- 全屏预览 -->
  <div id="xhs-lightbox">
    <img id="xhs-lightbox-img" src="" alt="">
  </div>

  <!-- 自定义样式注入点 -->
  <style id="custom-style"></style>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ─── 状态 ───
    let currentTitle = '';
    let currentBodyHtml = '';
    let currentThemeBg = '#ffffff';
    let currentZoom = 100;
    // 用对象统一管理面板开关状态，避免 let 变量与 window 属性不同步的 bug
    const panelState = { stylePanelOpen: false, uploadPanelOpen: false, xhsPanelOpen: false };

    const XHS_DEFAULTS = { width: 1080, height: 1440, padding: 40, tolerance: 15 };

    // ─── 工具函数 ───
    function showToast(msg, type = '', duration = 2500) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast show' + (type ? ' ' + type : '');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => { el.className = 'toast'; }, duration);
    }

    function applyTheme(theme) {
      currentThemeBg = theme.wrapperBg || '#ffffff';
      // 替换主题样式
      let styleEl = document.getElementById('theme-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'theme-style';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = '.article-wrapper { background: ' + theme.wrapperBg + '; } .article-wrapper ' +
        theme.css.replace(/([^}]+{)/g, (m) => '.article-wrapper ' + m);
      // 背景色应用到整个预览区域
      document.querySelector('.preview-scroll').style.background = theme.wrapperBg;
    }

    // ─── 小红书辅助函数 ───

    function cssColorToRgb(color) {
      color = (color || '#ffffff').trim();
      if (color.startsWith('#')) {
        const c = color.replace('#', '');
        const full = c.length === 3 ? c.split('').map(x => x+x).join('') : c;
        return { r: parseInt(full.slice(0,2),16), g: parseInt(full.slice(2,4),16), b: parseInt(full.slice(4,6),16) };
      }
      const m = color.match(/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)/);
      if (m) return { r: +m[1], g: +m[2], b: +m[3] };
      return { r: 255, g: 255, b: 255 };
    }

    function isCleanRow(imageData, relY, width, bgRgb, tol) {
      const offset = relY * width * 4;
      for (let x = 0; x < width; x++) {
        const i = offset + x * 4;
        if (imageData.data[i+3] < 10) continue; // transparent → skip
        if (Math.abs(imageData.data[i]   - bgRgb.r) > tol ||
            Math.abs(imageData.data[i+1] - bgRgb.g) > tol ||
            Math.abs(imageData.data[i+2] - bgRgb.b) > tol) return false;
      }
      return true;
    }

    function smartSlice(canvas, maxSliceH, bgRgb, tol) {
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      const slices = [];
      let startY = 0;
      while (startY < H) {
        let endY = Math.min(startY + maxSliceH, H);
        if (endY < H) {
          const minEndY = startY + Math.floor(maxSliceH * 0.5);
          const chunk = ctx.getImageData(0, startY, W, endY - startY);
          let cutY = endY;
          while (cutY > minEndY) {
            if (isCleanRow(chunk, cutY - startY - 1, W, bgRgb, tol)) { endY = cutY; break; }
            cutY--;
          }
        }
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = W; sliceCanvas.height = endY - startY;
        sliceCanvas.getContext('2d').drawImage(canvas, 0, startY, W, endY - startY, 0, 0, W, endY - startY);
        slices.push(sliceCanvas.toDataURL('image/png'));
        startY = endY;
      }
      return slices;
    }

    function showXhsOutput(slices) {
      const out = document.getElementById('xhs-output');
      const exportBtn = document.getElementById('btn-xhs-export-all');
      if (!slices.length) {
        out.innerHTML = '<p class="hint">未生成任何图片</p>';
        exportBtn.disabled = true;
        return;
      }
      exportBtn.disabled = false;
      out.innerHTML = slices.map((url, i) =>
        \`<div class="xhs-img-item">
          <img src="\${url}" alt="第\${i+1}张" data-action="zoom" data-url="\${url}">
          <div class="xhs-img-meta">
            <span>第 \${i+1} / \${slices.length} 张</span>
            <button data-action="download" data-url="\${url}" data-index="\${i+1}">⬇ 下载</button>
          </div>
        </div>\`
      ).join('');
    }

    // 事件委托：处理 XHS 输出区域的点击（避免 inline onclick 被 CSP 拦截）
    document.getElementById('xhs-output').addEventListener('click', function(e) {
      const target = e.target;
      if (target.dataset.action === 'zoom') {
        zoomImg(target.dataset.url);
      } else if (target.dataset.action === 'download') {
        downloadImg(target.dataset.url, parseInt(target.dataset.index));
      }
    });

    // lightbox 关闭
    document.getElementById('xhs-lightbox').addEventListener('click', function() {
      this.classList.remove('show');
    });

    function zoomImg(url) {
      document.getElementById('xhs-lightbox-img').src = url;
      document.getElementById('xhs-lightbox').classList.add('show');
    }

    function downloadImg(dataUrl, index) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = \`xiaohongshu-\${String(index).padStart(2,'0')}.png\`;
      a.click();
    }

    async function generateXhsImages() {
      const imgW   = parseInt(document.getElementById('xhs-width').value)     || XHS_DEFAULTS.width;
      const imgH   = parseInt(document.getElementById('xhs-height').value)    || XHS_DEFAULTS.height;
      const pad    = parseInt(document.getElementById('xhs-padding').value);
      const tol    = parseInt(document.getElementById('xhs-tolerance').value) || XHS_DEFAULTS.tolerance;
      const bgColor = currentThemeBg || '#ffffff';
      const SCALE = 2;

      const btn = document.getElementById('btn-xhs-generate');
      btn.disabled = true; btn.textContent = '⏳ 渲染中...';
      document.getElementById('btn-xhs-export-all').disabled = true;
      document.getElementById('xhs-output').innerHTML = '<p class="hint">正在渲染，请稍候...</p>';

      try {
        const wrapper = document.querySelector('.article-wrapper');
        if (!wrapper) throw new Error('找不到预览内容');

        // 1) 创建离屏容器，强制 = 小红书图片宽度
        const offscreen = document.createElement('div');
        offscreen.style.cssText = [
          'position:fixed',
          'left:-99999px',
          'top:0',
          'z-index:-1',
          'width:' + imgW + 'px',
          'box-sizing:border-box',
          'padding:' + pad + 'px',
          'background:' + bgColor,
          'overflow:visible',
        ].join(';');

        // 2) 用 cloneNode(true) 克隆 wrapper 内容（保留所有样式与图片 src）
        const clone = wrapper.cloneNode(true);
        // 强制覆盖克隆体的宽度限制
        clone.style.width = 'auto';
        clone.style.maxWidth = 'none';
        clone.style.padding = '0';
        clone.style.background = 'transparent';
        offscreen.appendChild(clone);

        // 3) 同步当前主题 <style>（确保字体、颜色、代码块都对）
        const themeStyle = document.getElementById('theme-style');
        if (themeStyle) {
          const s = document.createElement('style');
          s.textContent = themeStyle.textContent;
          offscreen.insertBefore(s, clone);
        }

        document.body.appendChild(offscreen);

        // 4) 把所有远程图片通过 Node 端转为 base64（html2canvas 无法渲染跨域图片）
        const imgsAll = offscreen.querySelectorAll('img');
        await Promise.all(Array.from(imgsAll).map(async img => {
          const src = img.getAttribute('src') || '';
          if (!src || src.startsWith('data:')) return; // 已是 data URI，跳过
          // 通过 VS Code 消息通道让 Node 端下载
          const reqId = Math.random().toString(36).slice(2);
          const dataUrl = await new Promise(resolve => {
            const handler = e => {
              const m = e.data;
              if (m.type === 'imageBase64Result' && m.reqId === reqId) {
                window.removeEventListener('message', handler);
                resolve(m.dataUrl); // null 表示失败
              }
            };
            window.addEventListener('message', handler);
            vscode.postMessage({ type: 'fetchImageBase64', url: src, reqId });
            // 10s 超时兜底
            setTimeout(() => { window.removeEventListener('message', handler); resolve(null); }, 10000);
          });
          if (dataUrl) {
            img.src = dataUrl;
            await img.decode().catch(() => {});
          }
        }));
        await document.fonts.ready;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // 5) 截图：固定宽度 imgW，自适应高度
        let rawCanvas;
        try {
          rawCanvas = await html2canvas(offscreen, {
            scale: SCALE,
            backgroundColor: bgColor,
            useCORS: true,
            allowTaint: true,
            logging: false,
            width: imgW,
            height: offscreen.offsetHeight,
            windowWidth: imgW,
          });
        } finally {
          document.body.removeChild(offscreen);
        }

        // 6) 智能切片（不做缩放，截图本身已是 imgW * SCALE 宽）
        const sliceHeightPx = imgH * SCALE;
        const bgRgb = cssColorToRgb(bgColor);
        const slices = smartSlice(rawCanvas, sliceHeightPx, bgRgb, tol);
        window._xhsLastSlices = slices;
        showXhsOutput(slices);
        showToast(\`✅ 生成 \${slices.length} 张图片，点击可全屏预览\`, 'success', 3000);
      } catch(e) {
        console.error('XHS error:', e);
        document.getElementById('xhs-output').innerHTML = \`<p class="hint" style="color:#f88">❌ 生成失败：\${e.message}</p>\`;
        showToast('生成失败: ' + e.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = '🖼 生成图片';
      }
    }

    // XHS 面板拖拽调宽
    (function initResize() {
      const handle = document.getElementById('xhs-resize-handle');
      const panel  = document.getElementById('xhs-panel');
      if (!handle || !panel) return;
      let startX, startW;
      handle.addEventListener('mousedown', function(e) {
        startX = e.clientX; startW = panel.offsetWidth;
        e.preventDefault();
        function onMove(ev) { panel.style.width = Math.max(340, startW - (ev.clientX - startX)) + 'px'; }
        function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    })();

    function closePanel(panelId, stateKey) {
      panelState[stateKey] = false;
      const el = document.getElementById(panelId);
      if (el) {
        el.classList.remove('open');
        el.style.width = ''; // 清除 resize handle 设置的内联 width，避免覆盖 CSS width:0
      }
      updateBtnActive();
    }

    function togglePanel(panelId, stateKey, closeOtherIds) {
      const panel  = document.getElementById(panelId);
      const newVal = !panelState[stateKey];
      panelState[stateKey] = newVal;
      panel.classList.toggle('open', newVal);
      if (!newVal) panel.style.width = ''; // 关闭时清除内联 width
      // 关闭其他面板
      (closeOtherIds || []).forEach(id => {
        const other = document.getElementById(id.panelId);
        panelState[id.stateKey] = false;
        if (other) { other.classList.remove('open'); other.style.width = ''; }
      });
      updateBtnActive();
    }

    function updateBtnActive() {
      document.getElementById('btn-style').className =
        'btn ' + (panelState.stylePanelOpen ? 'btn-active' : 'btn-secondary');
      document.getElementById('btn-upload').className =
        'btn ' + (panelState.uploadPanelOpen ? 'btn-active' : 'btn-upload');
      document.getElementById('btn-xhs').className =
        'btn ' + (panelState.xhsPanelOpen ? 'btn-active' : 'btn-xhs');
    }

    // 面板关闭按钮（事件委托）
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.panel-close-btn');
      if (!btn) return;
      const panelId  = btn.dataset.closePanel;
      const stateKey = btn.dataset.closeState;
      if (panelId && stateKey) closePanel(panelId, stateKey);
    });

    // ─── 按钮事件 ───

    // 主题切换
    document.getElementById('theme-select').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'setTheme', themeId: e.target.value });
    });

    // 复制内容（向 extension 请求带内联 CSS 的 HTML，再写入剪贴板）
    document.getElementById('btn-copy').addEventListener('click', () => {
      const btn = document.getElementById('btn-copy');
      btn.disabled = true;
      btn.textContent = '⏳ 处理中...';
      vscode.postMessage({ type: 'getWechatHtml' });
    });

    document.getElementById('btn-style').addEventListener('click', () => {
      togglePanel('style-panel', 'stylePanelOpen',
        [{panelId:'upload-panel',stateKey:'uploadPanelOpen'},{panelId:'xhs-panel',stateKey:'xhsPanelOpen'}]);
    });

    document.getElementById('btn-upload').addEventListener('click', () => {
      togglePanel('upload-panel', 'uploadPanelOpen',
        [{panelId:'style-panel',stateKey:'stylePanelOpen'},{panelId:'xhs-panel',stateKey:'xhsPanelOpen'}]);
      if (panelState.uploadPanelOpen) {
        const titleInput = document.getElementById('input-title');
        if (!titleInput.value && currentTitle) titleInput.value = currentTitle;
        vscode.postMessage({ type: 'getConfig' });
      }
    });

    document.getElementById('btn-xhs').addEventListener('click', () => {
      togglePanel('xhs-panel', 'xhsPanelOpen',
        [{panelId:'style-panel',stateKey:'stylePanelOpen'},{panelId:'upload-panel',stateKey:'uploadPanelOpen'}]);
    });

    document.getElementById('btn-xhs-python').addEventListener('click', () => {
      const imgW   = parseInt(document.getElementById('xhs-width').value)     || XHS_DEFAULTS.width;
      const imgH   = parseInt(document.getElementById('xhs-height').value)    || XHS_DEFAULTS.height;
      const pad    = parseInt(document.getElementById('xhs-padding').value);
      const bgColor = currentThemeBg || '#ffffff';
      const btn = document.getElementById('btn-xhs-python');
      btn.disabled = true; btn.textContent = '⏳ 渲染中...';
      document.getElementById('btn-xhs-export-all').disabled = true;
      document.getElementById('xhs-output').innerHTML = '<p class="hint">⏳ 正在生成，请稍候...</p>';
      vscode.postMessage({ type: 'generateXhsViaPython', width: imgW, height: imgH, padding: pad, bg: bgColor });
    });

    document.getElementById('btn-xhs-reset').addEventListener('click', () => {
      document.getElementById('xhs-width').value     = XHS_DEFAULTS.width;
      document.getElementById('xhs-height').value    = XHS_DEFAULTS.height;
      document.getElementById('xhs-padding').value   = XHS_DEFAULTS.padding;
      document.getElementById('xhs-tolerance').value = XHS_DEFAULTS.tolerance;
      showToast('已恢复默认参数');
    });

    document.getElementById('btn-xhs-export-all').addEventListener('click', () => {
      const slices = window._xhsLastSlices;
      if (!slices || !slices.length) { showToast('请先生成图片', 'error'); return; }
      const btn = document.getElementById('btn-xhs-export-all');
      btn.disabled = true; btn.textContent = '💾 导出中...';
      vscode.postMessage({ type: 'saveXhsImages', dataUrls: slices });
    });

    // 知乎复制
    document.getElementById('btn-zhihu').addEventListener('click', () => {
      const btn = document.getElementById('btn-zhihu');
      btn.disabled = true; btn.textContent = '⏳ 处理中...';
      vscode.postMessage({ type: 'getZhihuHtml' });
    });

    // 小红书长文复制
    document.getElementById('btn-xhs-copy').addEventListener('click', () => {
      const btn = document.getElementById('btn-xhs-copy');
      btn.disabled = true; btn.textContent = '⏳ 处理中...';
      vscode.postMessage({ type: 'getXhsCopyHtml' });
    });

    document.getElementById('btn-export').addEventListener('click', () => {
      vscode.postMessage({ type: 'exportHtml' });
    });

    // 应用自定义 CSS
    document.getElementById('btn-apply-css').addEventListener('click', () => {
      const css = document.getElementById('css-textarea').value;
      document.getElementById('custom-style').textContent = css;
      showToast('样式已应用', 'success');
    });

    // 重置 CSS
    document.getElementById('btn-reset-css').addEventListener('click', () => {
      document.getElementById('css-textarea').value = '';
      document.getElementById('custom-style').textContent = '';
      showToast('样式已重置');
    });

    // 保存配置
    document.getElementById('btn-save-config').addEventListener('click', () => {
      const appid     = document.getElementById('input-appid').value.trim();
      const appSecret = document.getElementById('input-appsecret').value.trim();
      const author    = document.getElementById('input-author').value.trim();
      const digest    = document.getElementById('input-digest').value.trim();
      if (!appid || !appSecret) {
        showToast('AppID 和 AppSecret 不能为空', 'error');
        return;
      }
      vscode.postMessage({ type: 'saveConfig', appid, appSecret, author, digest });
    });

    // 上传
    document.getElementById('btn-do-upload').addEventListener('click', () => {
      const appid     = document.getElementById('input-appid').value.trim();
      const appSecret = document.getElementById('input-appsecret').value.trim();
      const title     = document.getElementById('input-title').value.trim();
      const author    = document.getElementById('input-author').value.trim();
      const digest    = document.getElementById('input-digest').value.trim();

      if (!appid || !appSecret) {
        showToast('请先填写并保存 AppID / AppSecret', 'error');
        return;
      }
      if (!title) {
        showToast('请填写文章标题', 'error');
        return;
      }

      vscode.postMessage({ type: 'upload', appid, appSecret, title, author, digest });
    });

    // ─── 接收 extension 消息 ───
    window.addEventListener('message', ({ data: msg }) => {
      switch (msg.type) {
        case 'update': {
          currentBodyHtml = msg.bodyHtml || '';
          currentTitle    = msg.title || '';
          document.getElementById('preview-content').innerHTML = currentBodyHtml;
          document.getElementById('doc-title').textContent = currentTitle
            ? \`预览: \${currentTitle}\`
            : 'MD2WeChat 预览';
          // 应用主题
          if (msg.theme) {
            applyTheme(msg.theme);
          }
          // 填充标题输入框（如果为空）
          const titleInput = document.getElementById('input-title');
          if (!titleInput.value && currentTitle) titleInput.value = currentTitle;
          break;
        }
        case 'themeList': {
          const sel = document.getElementById('theme-select');
          sel.innerHTML = '';
          (msg.themes || []).forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            if (t.id === msg.currentId) opt.selected = true;
            sel.appendChild(opt);
          });
          break;
        }
        case 'error': {
          document.getElementById('preview-content').innerHTML =
            \`<p style="color:red;font-family:monospace;">⚠️ 渲染错误：\${msg.message}</p>\`;
          break;
        }
        case 'wechatHtml': {
          const btn = document.getElementById('btn-copy');
          btn.disabled = false;
          btn.textContent = '📋 复制微信';
          const html = msg.html || '';
          // 优先用 ClipboardItem API，保留富文本格式
          if (navigator.clipboard && window.ClipboardItem) {
            navigator.clipboard.write([
              new ClipboardItem({
                'text/html':  new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([
                  document.getElementById('preview-content').innerText || ''
                ], { type: 'text/plain' }),
              }),
            ]).then(() => {
              showToast('✅ 已复制！直接粘贴到微信公众号编辑器即可', 'success');
            }).catch(() => {
              // 降级：execCommand
              fallbackCopy();
            });
          } else {
            fallbackCopy();
          }
          function fallbackCopy() {
            const tmp = document.createElement('div');
            tmp.style.cssText = 'position:fixed;left:-9999px;top:0;';
            tmp.innerHTML = html;
            document.body.appendChild(tmp);
            const range = document.createRange();
            range.selectNodeContents(tmp);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            try { document.execCommand('copy'); showToast('✅ 已复制！直接粘贴到微信公众号编辑器即可', 'success'); }
            catch (_) { showToast('复制失败，请手动 Ctrl+A 后复制', 'error'); }
            sel.removeAllRanges();
            document.body.removeChild(tmp);
          }
          break;
        }
        case 'wechatHtmlError': {
          const btn = document.getElementById('btn-copy');
          btn.disabled = false;
          btn.textContent = '📋 复制微信';
          showToast('复制失败：' + (msg.message || '未知错误'), 'error');
          break;
        }
        case 'zhihuHtml': {
          const btn = document.getElementById('btn-zhihu');
          btn.disabled = false; btn.textContent = '📝 复制知乎';
          const html = msg.html || '';
          const doCopy = () => {
            if (navigator.clipboard && window.ClipboardItem) {
              navigator.clipboard.write([new ClipboardItem({
                'text/html':  new Blob([html], {type:'text/html'}),
                'text/plain': new Blob([document.getElementById('preview-content').innerText||''], {type:'text/plain'}),
              })]).then(()=>showToast('✅ 已复制！粘贴到知乎编辑器即可','success'))
                 .catch(fallback);
            } else { fallback(); }
            function fallback() {
              const tmp = document.createElement('div');
              tmp.style.cssText = 'position:fixed;left:-9999px;top:0;';
              tmp.innerHTML = html;
              document.body.appendChild(tmp);
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(tmp);
              sel.removeAllRanges(); sel.addRange(range);
              try { document.execCommand('copy'); showToast('✅ 已复制！粘贴到知乎编辑器即可','success'); }
              catch(_) { showToast('复制失败，请手动选择复制','error'); }
              sel.removeAllRanges(); document.body.removeChild(tmp);
            }
          };
          doCopy();
          break;
        }
        case 'zhihuHtmlError': {
          const btn = document.getElementById('btn-zhihu');
          btn.disabled = false; btn.textContent = '📝 复制知乎';
          showToast('复制失败：' + (msg.message || '未知错误'), 'error');
          break;
        }
        case 'xhsCopyHtml': {
          const btn = document.getElementById('btn-xhs-copy');
          btn.disabled = false; btn.textContent = '📱 复制小红书';
          const html = msg.html || '';
          const doCopy = () => {
            if (navigator.clipboard && window.ClipboardItem) {
              navigator.clipboard.write([new ClipboardItem({
                'text/html':  new Blob([html], {type:'text/html'}),
                'text/plain': new Blob([document.getElementById('preview-content').innerText||''], {type:'text/plain'}),
              })]).then(() => showToast('✅ 已复制！粘贴到小红书长文编辑器即可（图片需手动上传）', 'success', 4000))
                 .catch(fallback);
            } else { fallback(); }
            function fallback() {
              const tmp = document.createElement('div');
              tmp.style.cssText = 'position:fixed;left:-9999px;top:0;';
              tmp.innerHTML = html;
              document.body.appendChild(tmp);
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(tmp);
              sel.removeAllRanges(); sel.addRange(range);
              try { document.execCommand('copy'); showToast('✅ 已复制！粘贴到小红书长文编辑器即可（图片需手动上传）', 'success', 4000); }
              catch(_) { showToast('复制失败，请手动选择复制', 'error'); }
              sel.removeAllRanges(); document.body.removeChild(tmp);
            }
          };
          doCopy();
          break;
        }
        case 'xhsCopyHtmlError': {
          const btn = document.getElementById('btn-xhs-copy');
          btn.disabled = false; btn.textContent = '📱 复制小红书';
          showToast('复制失败：' + (msg.message || '未知错误'), 'error');
          break;
        }
        case 'xhsPythonProgress': {
          document.getElementById('xhs-output').innerHTML = \`<p class="hint">\${msg.message}</p>\`;
          break;
        }
        case 'xhsPythonDone': {
          const btn = document.getElementById('btn-xhs-python');
          btn.disabled = false; btn.textContent = '� 生成图片';
          window._xhsLastSlices = msg.dataUrls;
          showXhsOutput(msg.dataUrls);
          document.getElementById('btn-xhs-export-all').disabled = false;
          showToast(\`✅ 生成 \${msg.dataUrls.length} 张，已保存到 \${msg.outDir}\`, 'success', 5000);
          break;
        }
        case 'xhsPythonError': {
          const btn = document.getElementById('btn-xhs-python');
          btn.disabled = false; btn.textContent = '📸 生成图片';
          const errMsg = msg.message || '未知错误';
          document.getElementById('xhs-output').innerHTML =
            \`<p class="hint" style="color:#f88">❌ \${errMsg}</p>\`;
          showToast('生成失败: ' + errMsg, 'error');
          break;
        }
        case 'saveXhsImagesDone': {
          const btn = document.getElementById('btn-xhs-export-all');
          btn.disabled = false; btn.textContent = '💾 一键导出全部';
          showToast(\`✅ 已导出 \${msg.count} 张到 \${msg.dir}\`, 'success', 4000);
          break;
        }
        case 'saveXhsImagesError': {
          const btn = document.getElementById('btn-xhs-export-all');
          btn.disabled = false; btn.textContent = '💾 一键导出全部';
          showToast('导出失败：' + (msg.message || '未知错误'), 'error');
          break;
        }
        case 'config': {
          if (msg.appid)     document.getElementById('input-appid').value     = msg.appid;
          if (msg.appSecret) document.getElementById('input-appsecret').value = msg.appSecret;
          if (msg.author)    document.getElementById('input-author').value    = msg.author;
          if (msg.digest)    document.getElementById('input-digest').value    = msg.digest;
          break;
        }
        case 'configSaved': {
          showToast('✅ 配置已保存', 'success');
          break;
        }
        case 'uploadStart': {
          const btn = document.getElementById('btn-do-upload');
          btn.textContent = '上传中...';
          btn.disabled = true;
          const res = document.getElementById('upload-result');
          res.style.display = 'none';
          break;
        }
        case 'uploadResult': {
          const btn = document.getElementById('btn-do-upload');
          btn.textContent = '上传草稿箱';
          btn.disabled = false;
          const res = document.getElementById('upload-result');
          if (msg.success) {
            res.className = 'upload-result success';
            res.textContent = \`✅ 上传成功！media_id: \${msg.mediaId || '—'}\`;
            showToast('上传成功！', 'success');
          } else {
            res.className = 'upload-result error';
            res.textContent = \`❌ 上传失败：\${msg.error || '未知错误'}\`;
            showToast('上传失败，请查看详情', 'error');
          }
          res.style.display = 'block';
          break;
        }
      }
    });

    // ─── 缩放控制 ───
    function setZoom(zoom) {
      currentZoom = Math.max(30, Math.min(200, zoom));
      const el = document.getElementById('preview-content');
      if (el) el.style.zoom = currentZoom + '%';
      const zv = document.getElementById('zoom-value');
      if (zv) zv.textContent = currentZoom + '%';
    }
    document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(currentZoom - 10));
    document.getElementById('btn-zoom-in').addEventListener('click',  () => setZoom(currentZoom + 10));
    document.getElementById('btn-zoom-reset').addEventListener('click', () => setZoom(100));

    // 鼠标滚轮 + Ctrl 快捷缩放
    document.getElementById('preview-content').addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(currentZoom + (e.deltaY < 0 ? 10 : -10));
    }, { passive: false });

    // ─── Todo 任务列表交互 ───
    document.getElementById('preview-content').addEventListener('change', (e) => {
      if (!e.target.classList.contains('task-checkbox')) return;
      const all = Array.from(document.querySelectorAll('#preview-content .task-checkbox'));
      const index = all.indexOf(e.target);
      if (index >= 0) {
        vscode.postMessage({ type: 'todoToggle', index, checked: e.target.checked });
      }
    });

    // ─── 初始化 ───
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

module.exports = { activate, deactivate };
