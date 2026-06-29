'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const https = require('https');

const { renderMarkdown, buildFullHtml, buildWechatCopyHtml, buildZhihuCopyHtml, buildXhsCopyHtml, convertMarkdownToWeChat, buildXhsRenderHtml } = require('./lib/converter');
const { THEMES, DEFAULT_THEME_ID, getTheme } = require('./lib/themes');
const zhihu = require('./lib/zhihu');

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
  outputChannel = vscode.window.createOutputChannel('Markdown2Anything');
  log('Markdown2Anything 插件已激活');

  context.subscriptions.push(
    vscode.commands.registerCommand('markdown2anything.preview', handlePreview),
    vscode.commands.registerCommand('markdown2anything.convert', handleConvert),

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
    'markdown2anythingPreview',
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
    const cfg = vscode.workspace.getConfiguration('markdown2anything');
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
      const cfg = vscode.workspace.getConfiguration('markdown2anything');
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
      const { width = 1080, height = 1440, padding = 40, bg = '#ffffff', autoExport = false } = msg;

      // 生成独立渲染 HTML
      const { bodyHtml } = renderMarkdown(mdPath);
      const theme = getTheme(currentThemeId);
      const htmlContent = buildXhsRenderHtml(bodyHtml, path.dirname(mdPath), theme);
      const tmpHtml = path.join(os.tmpdir(), `markdown2anything_xhs_${Date.now()}.html`);
      const base = path.basename(mdPath, path.extname(mdPath));
      // 生成预览时保存到系统临时目录，一键导出时才保存到项目目录
      const outDir = autoExport
        ? path.join(path.dirname(mdPath), `${base}_xhs`)
        : path.join(os.tmpdir(), `markdown2anything_xhs_preview_${Date.now()}`);
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

          panel.webview.postMessage({ type: 'xhsPythonDone', dataUrls, outDir, autoExport });
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
        // 目录：同 MD 文件名去后缀 + '_xhs'
        const base = path.basename(mdPath, path.extname(mdPath));
        const dir = path.join(path.dirname(mdPath), `${base}_xhs`);
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
        const cfg = vscode.workspace.getConfiguration('markdown2anything');
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
        const cfg = vscode.workspace.getConfiguration('markdown2anything');
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

    case 'zhihuCheckLogin': {
      const cookieStr = extContext.globalState.get(zhihu.STORAGE_KEY, '');
      if (zhihu.isLoggedIn(cookieStr)) {
        const info = await zhihu.verifyLogin(cookieStr);
        panel.webview.postMessage({ type: 'zhihuLoginStatus', loggedIn: info.valid, name: info.name });
      } else {
        panel.webview.postMessage({ type: 'zhihuLoginStatus', loggedIn: false });
      }
      break;
    }

    case 'zhihuStartQr': {
      // 用 Playwright 打开真实浏览器让用户登录，绕过知乎的反爬限制
      const { spawn } = require('child_process');
      const scriptPath = path.join(extContext.extensionUri.fsPath, 'scripts', 'zhihu_login.js');
      panel.webview.postMessage({ type: 'zhihuQrProgress', message: '正在启动浏览器，请在弹出的窗口中登录...' });
      log('启动知乎登录浏览器');

      const proc = spawn(process.execPath, [scriptPath]);
      let stdout = '';

      proc.stdout.on('data', async (d) => {
        stdout += d.toString();
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line === 'READY') {
            panel.webview.postMessage({ type: 'zhihuQrReady' });
          } else if (line.startsWith('COOKIE:')) {
            try {
              const cookies = JSON.parse(line.slice(7));
              // 把 playwright cookie 数组转为 "name=value; ..." 字符串
              const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
              const info = await zhihu.verifyLogin(cookieStr);
              if (info.valid) {
                await extContext.globalState.update(zhihu.STORAGE_KEY, cookieStr);
                panel.webview.postMessage({ type: 'zhihuPollResult', status: 'confirmed', name: info.name });
                log(`知乎登录成功: ${info.name}`);
              } else {
                panel.webview.postMessage({ type: 'zhihuQrError', message: '登录成功但 Cookie 验证失败，请重试' });
              }
            } catch (e) {
              panel.webview.postMessage({ type: 'zhihuQrError', message: '解析登录结果失败：' + e.message });
            }
          } else if (line === 'NEED_INSTALL') {
            panel.webview.postMessage({ type: 'zhihuQrError', message: '未找到 Chromium，请先使用小红书截图功能触发自动安装' });
          } else if (line.startsWith('ERROR:')) {
            panel.webview.postMessage({ type: 'zhihuQrError', message: line.slice(6) });
          }
        }
      });

      proc.on('error', (err) => {
        panel.webview.postMessage({ type: 'zhihuQrError', message: '启动失败：' + err.message });
      });

      break;
    }

    case 'zhihuPollQr':
      // 已不再使用，Playwright 方案由子进程自行轮询
      break;

    case 'zhihuLogout': {
      await extContext.globalState.update(zhihu.STORAGE_KEY, undefined);
      extContext.globalState.update('zhihu._qrToken', undefined);
      extContext.globalState.update('zhihu._qrCookie', undefined);
      panel.webview.postMessage({ type: 'zhihuLoginStatus', loggedIn: false });
      break;
    }

    case 'zhihuSaveCookie': {
      try {
        // 用户粘贴的是 z_c0 的值，包装成完整 cookie 字符串
        const raw = (msg.z_c0 || '').trim();
        if (!raw) {
          panel.webview.postMessage({ type: 'zhihuSaveCookieResult', success: false, error: 'z_c0 值不能为空' });
          break;
        }
        // 支持两种格式：纯值，或已带 "z_c0=..." 前缀
        const cookieStr = raw.startsWith('z_c0=') ? raw : `z_c0=${raw}`;
        const info = await zhihu.verifyLogin(cookieStr);
        if (!info.valid) {
          panel.webview.postMessage({ type: 'zhihuSaveCookieResult', success: false, error: 'Cookie 无效或已过期，请重新获取' });
          break;
        }
        await extContext.globalState.update(zhihu.STORAGE_KEY, cookieStr);
        panel.webview.postMessage({ type: 'zhihuSaveCookieResult', success: true, name: info.name });
        panel.webview.postMessage({ type: 'zhihuLoginStatus', loggedIn: true, name: info.name });
      } catch (err) {
        log(`知乎 Cookie 验证失败: ${err.message}`);
        panel.webview.postMessage({ type: 'zhihuSaveCookieResult', success: false, error: err.message });
      }
      break;
    }

    case 'zhihuGetArticleId': {
      const mapKey = 'zhihu.articleIdMap';
      const map = extContext.globalState.get(mapKey, {});
      const savedId = map[mdPath] || null;
      panel.webview.postMessage({ type: 'zhihuArticleId', articleId: savedId });
      break;
    }

    case 'zhihuPublish': {
      try {
        const cookieStr = extContext.globalState.get(zhihu.STORAGE_KEY, '');
        if (!zhihu.isLoggedIn(cookieStr)) {
          panel.webview.postMessage({ type: 'zhihuPublishResult', success: false, error: '未登录，请先扫码登录' });
          break;
        }
        const { title, articleId: existingId } = msg;
        if (!title || !title.trim()) {
          panel.webview.postMessage({ type: 'zhihuPublishResult', success: false, error: '文章标题不能为空' });
          break;
        }

        panel.webview.postMessage({ type: 'zhihuPublishStart' });
        log(`开始发布到知乎: ${title}${existingId ? ` (更新 ${existingId})` : ''}`);

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mdPath));
        const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(mdPath);
        const cfg = vscode.workspace.getConfiguration('markdown2anything');
        const templateName = cfg.get('template', 'wechat');
        const templatePath = getTemplatePath(workspacePath, templateName);
        const { bodyHtml } = renderMarkdown(mdPath);
        const theme = getTheme(currentThemeId);
        let htmlContent = buildZhihuCopyHtml(bodyHtml, templatePath, theme);

        // 处理代码块（去掉 hljs span，保留纯文本 + 内联样式）
        htmlContent = zhihu.normalizeCodeBlocks(htmlContent);
        // 规范化图片标签（去掉 figure 包裹和内联样式，知乎不支持这些）
        htmlContent = zhihu.normalizeImagesForZhihu(htmlContent);

        // 上传本地图片到知乎图床
        panel.webview.postMessage({ type: 'zhihuPublishProgress', message: '正在上传图片...' });
        const uploadResult = await zhihu.uploadImagesInHtml(htmlContent, cookieStr, (done, total, failed) => {
          log(`图片上传进度: ${done}/${total}${failed ? `，失败 ${failed} 张` : ''}`);
          panel.webview.postMessage({ type: 'zhihuPublishProgress', message: `正在上传图片 ${done}/${total}...` });
        });
        htmlContent = uploadResult.html;
        if (uploadResult.failed > 0) {
          log(`图片上传部分失败: ${uploadResult.failed}/${uploadResult.total}，错误：${uploadResult.errors.join('; ')}`);
          panel.webview.postMessage({ type: 'zhihuPublishProgress', message: `⚠️ ${uploadResult.failed} 张图片上传失败，继续发布...` });
        }

        panel.webview.postMessage({ type: 'zhihuPublishProgress', message: existingId ? '正在更新文章...' : '正在发布文章...' });

        let result;
        if (existingId) {
          result = await zhihu.updateAndPublishArticle({ articleId: existingId, title: title.trim(), htmlContent, cookieStr });
        } else {
          result = await zhihu.createAndPublishArticle({ title: title.trim(), htmlContent, cookieStr });
        }

        // 保存文件路径 → 文章 ID 映射
        const mapKey = 'zhihu.articleIdMap';
        const map = extContext.globalState.get(mapKey, {});
        map[mdPath] = result.articleId;
        await extContext.globalState.update(mapKey, map);

        log(`知乎发布成功: ${result.url}`);
        panel.webview.postMessage({ type: 'zhihuPublishResult', success: true, articleId: result.articleId, url: result.url });
        vscode.window.showInformationMessage(`✅ 知乎${existingId ? '更新' : '发布'}成功！`, '打开文章').then(a => {
          if (a === '打开文章') vscode.env.openExternal(vscode.Uri.parse(result.url));
        });
      } catch (err) {
        log(`知乎发布失败: ${err.message}`);
        panel.webview.postMessage({ type: 'zhihuPublishResult', success: false, error: err.message });
      }
      break;
    }

    case 'zhihuSaveDraft': {
      try {
        const cookieStr = extContext.globalState.get(zhihu.STORAGE_KEY, '');
        if (!zhihu.isLoggedIn(cookieStr)) {
          panel.webview.postMessage({ type: 'zhihuDraftResult', success: false, error: '未登录，请先扫码登录' });
          break;
        }
        const { title, articleId: existingId } = msg;
        if (!title || !title.trim()) {
          panel.webview.postMessage({ type: 'zhihuDraftResult', success: false, error: '文章标题不能为空' });
          break;
        }

        panel.webview.postMessage({ type: 'zhihuPublishStart' });
        log(`保存知乎草稿: ${title}${existingId ? ` (articleId=${existingId})` : ''}`);

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mdPath));
        const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(mdPath);
        const cfg = vscode.workspace.getConfiguration('markdown2anything');
        const templateName = cfg.get('template', 'wechat');
        const templatePath = getTemplatePath(workspacePath, templateName);
        const { bodyHtml } = renderMarkdown(mdPath);
        const theme = getTheme(currentThemeId);
        let htmlContent = buildZhihuCopyHtml(bodyHtml, templatePath, theme);

        htmlContent = zhihu.normalizeCodeBlocks(htmlContent);
        htmlContent = zhihu.normalizeImagesForZhihu(htmlContent);

        panel.webview.postMessage({ type: 'zhihuPublishProgress', message: '正在上传图片...' });
        const uploadResult = await zhihu.uploadImagesInHtml(htmlContent, cookieStr, (done, total) => {
          panel.webview.postMessage({ type: 'zhihuPublishProgress', message: `正在上传图片 ${done}/${total}...` });
        });
        htmlContent = uploadResult.html;

        panel.webview.postMessage({ type: 'zhihuPublishProgress', message: '正在保存草稿...' });
        const result = await zhihu.saveAsDraft({ articleId: existingId || null, title: title.trim(), htmlContent, cookieStr });

        const mapKey = 'zhihu.articleIdMap';
        const map = extContext.globalState.get(mapKey, {});
        map[mdPath] = result.articleId;
        await extContext.globalState.update(mapKey, map);

        log(`知乎草稿保存成功: ${result.editUrl}`);
        panel.webview.postMessage({ type: 'zhihuDraftResult', success: true, articleId: result.articleId, editUrl: result.editUrl });
        vscode.window.showInformationMessage('✅ 草稿已保存！可在知乎编辑器预览效果。', '打开编辑器').then(a => {
          if (a === '打开编辑器') vscode.env.openExternal(vscode.Uri.parse(result.editUrl));
        });
      } catch (err) {
        log(`知乎草稿保存失败: ${err.message}`);
        panel.webview.postMessage({ type: 'zhihuDraftResult', success: false, error: err.message });
      }
      break;
    }

    default:
      break;
  }
}

function sendConfig(panel) {
  const cfg = vscode.workspace.getConfiguration('markdown2anything');
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
        'User-Agent': 'markdown2anything-vscode/1.0',
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
    .btn-zhihu-publish  { background: #1772f6; color: #fff; }
    .btn-zhihu-publish:hover { background: #0e5cd1; }
    .zhihu-tab {
      flex: 1; padding: 7px 0; background: none; border: none;
      border-bottom: 2px solid transparent; color: #888; font-size: 13px;
      cursor: pointer; transition: all 0.15s;
    }
    .zhihu-tab:hover { color: #ccc; }
    .zhihu-tab-active { color: #4fc3f7; border-bottom-color: #4fc3f7; }
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
    .xhs-panel.open  { width: 480px; min-width: 340px; max-width: calc(100% - 220px); position: relative; }
    .xhs-panel .resize-handle {
      position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
      cursor: col-resize; background: rgba(255,255,255,0.06); z-index: 10;
      display: none;
    }
    .xhs-panel.open .resize-handle { display: block; }
    .xhs-panel .resize-handle:hover { background: #0078d4; }
    .xhs-panel .resize-handle::after {
      content: ''; position: absolute; left: 2px; top: 50%; transform: translateY(-50%);
      width: 2px; height: 40px; background: #555; border-radius: 2px;
    }
    .xhs-panel .resize-handle:hover::after { background: #0078d4; }
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

    /* ── 目录（TOC）面板 ── */
    .toc-panel {
      width: 0;
      overflow: hidden;
      transition: width 0.25s ease;
      background: #1e1e1e;
      border-right: 1px solid #444;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .toc-panel.open { width: 240px; }
    .toc-panel .side-panel-header {
      border-bottom: 1px solid #333;
      border-right: none;
    }
    .toc-nav {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }
    .toc-item {
      display: block;
      padding: 5px 16px;
      font-size: 12px;
      color: #ccc;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-left: 2px solid transparent;
      transition: all 0.15s;
      line-height: 1.5;
    }
    .toc-item:hover { background: #2a2a2a; color: #fff; }
    .toc-item.active { border-left-color: #07c160; color: #07c160; background: #1a2a1a; }
    .toc-item[data-level="1"] { padding-left: 16px; font-weight: 600; }
    .toc-item[data-level="2"] { padding-left: 28px; }
    .toc-item[data-level="3"] { padding-left: 40px; font-size: 11px; color: #aaa; }
    .toc-item[data-level="4"],
    .toc-item[data-level="5"],
    .toc-item[data-level="6"] { padding-left: 52px; font-size: 11px; color: #999; }
    .toc-empty {
      padding: 12px 16px;
      font-size: 12px;
      color: #666;
    }
    .btn-toc { background: #444; color: #eee; }
    .btn-toc:hover { background: #555; }
  </style>
</head>
<body>

  <!-- 工具栏 -->
  <div class="toolbar">
    <span class="toolbar-title" id="doc-title">Markdown2Anything 预览</span>
    <select id="theme-select" title="切换主题" style="
      padding:5px 8px; border:none; border-radius:4px; cursor:pointer;
      font-size:13px; background:#3a3a3a; color:#eee; outline:none;
    ">
      <option value="">主题...</option>
    </select>
    <button class="btn btn-toc" id="btn-toc" title="显示/隐藏文章目录（仅预览用，不影响导出）">
      📑 目录
    </button>
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
    <button class="btn btn-zhihu-publish" id="btn-zhihu-publish" title="直接发布到知乎专栏（需扫码登录）">
      🚀 发布知乎
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
    <!-- 目录面板（仅预览用，不影响导出） -->
    <div class="toc-panel" id="toc-panel">
      <div class="side-panel-header">📑 目录<button class="panel-close-btn" data-close-panel="toc-panel" data-close-state="tocPanelOpen">×</button></div>
      <nav class="toc-nav" id="toc-nav">
        <p class="toc-empty">暂无标题</p>
      </nav>
    </div>

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

    <!-- 知乎发布面板 -->
    <div class="side-panel" id="zhihu-publish-panel">
      <div class="side-panel-header">🚀 发布到知乎<button class="panel-close-btn" data-close-panel="zhihu-publish-panel" data-close-state="zhihuPublishPanelOpen">×</button></div>
      <div class="side-panel-body">

        <!-- 已登录视图 -->
        <div id="zhihu-logged-in" style="display:none;">
          <p class="hint" style="color:#4caf50;">✅ 已登录：<strong id="zhihu-user-name"></strong></p>
          <div class="panel-actions">
            <button class="btn btn-secondary" id="btn-zhihu-logout">退出登录</button>
          </div>
          <div class="divider"></div>
          <label>文章标题 <span style="color:#f06529">*</span></label>
          <input type="text" id="zhihu-input-title" placeholder="文章标题">
          <label>已有文章 ID（留空 = 新建，填写 = 更新）</label>
          <input type="text" id="zhihu-input-article-id" placeholder="留空新建，填写则更新已有文章">
          <p class="hint" style="margin-top:4px;">文章 ID 是知乎链接 <code style="color:#4fc3f7;">/p/</code> 后的数字，发布成功后自动填入。</p>
          <div class="hint" style="margin-top:10px;color:#e6a817;border:1px solid #555;padding:8px;border-radius:4px;">
            ⚠️ 发布后文章将直接公开到你的知乎专栏，请确认内容无误后再发布。
          </div>
          <div class="panel-actions" style="margin-top:14px;">
            <button class="btn btn-zhihu-publish" id="btn-zhihu-do-publish">发布文章</button>
            <button class="btn btn-secondary" id="btn-zhihu-save-draft" title="保存为草稿，可在知乎官网预览效果后再发布">保存草稿</button>
          </div>
          <p class="hint" id="zhihu-publish-progress" style="margin-top:8px;display:none;"></p>
          <div class="upload-result" id="zhihu-publish-result"></div>
        </div>

        <!-- 未登录视图：标签页切换 -->
        <div id="zhihu-logged-out">
          <!-- 标签页 -->
          <div style="display:flex;gap:0;margin-bottom:14px;border-bottom:1px solid #444;">
            <button id="zhihu-tab-qr"     class="zhihu-tab zhihu-tab-active">📱 扫码登录</button>
            <button id="zhihu-tab-cookie" class="zhihu-tab">🍪 手动 Cookie</button>
          </div>

          <!-- 浏览器登录 -->
          <div id="zhihu-pane-qr">
            <p class="hint">点击下方按钮，将弹出真实浏览器窗口。<br>在浏览器中用手机扫码（或账号密码）登录知乎，登录后插件将自动获取凭证。<br><br>登录凭证仅保存在本地 VS Code 存储中，不写入文件，不会被 git 追踪。</p>
            <div class="panel-actions">
              <button class="btn btn-zhihu-publish" id="btn-zhihu-qr">打开浏览器登录</button>
            </div>
            <p class="hint" id="zhihu-qr-hint" style="margin-top:10px;display:none;"></p>
          </div>

          <!-- 手动 Cookie -->
          <div id="zhihu-pane-cookie" style="display:none;">
            <p class="hint">
              在浏览器打开 <strong style="color:#ccc;">zhihu.com</strong>，登录后按 F12 → Application → Cookies，
              复制 <code style="color:#4fc3f7;">z_c0</code> 的值粘贴到下方。<br>
              Cookie 仅保存在本地 VS Code 存储中，不写入文件，不会被 git 追踪。
            </p>
            <label>z_c0 Cookie 值 <span style="color:#f06529">*</span></label>
            <textarea id="zhihu-input-cookie" placeholder="粘贴 z_c0 的值..." style="min-height:80px;font-size:11px;word-break:break-all;"></textarea>
            <div class="panel-actions" style="margin-top:10px;">
              <button class="btn btn-zhihu-publish" id="btn-zhihu-save-cookie">验证并保存</button>
            </div>
            <div class="upload-result" id="zhihu-cookie-result"></div>
          </div>
        </div>

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
          <button class="btn btn-xhs" id="btn-xhs-python" title="仅生成预览图，不保存到项目目录">📸 生成预览</button>
          <button class="btn btn-secondary" id="btn-xhs-reset">恢复默认</button>
        </div>
        <div class="panel-actions" style="margin-top:8px;">
          <button class="btn btn-xhs" id="btn-xhs-export-all" title="生成图片并保存到 MD 同名 _xhs 目录（若已生成预览则直接保存）">💾 一键导出全部</button>
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
    const panelState = { stylePanelOpen: false, uploadPanelOpen: false, xhsPanelOpen: false, tocPanelOpen: false, zhihuPublishPanelOpen: false };

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

    // XHS 面板拖拽调宽（限制最大宽度，确保预览区始终可见）
    (function initResize() {
      const handle = document.getElementById('xhs-resize-handle');
      const panel  = document.getElementById('xhs-panel');
      if (!handle || !panel) return;
      const XHS_DEFAULT_W = 480;
      const XHS_MIN_W = 340;
      let startX, startW;
      function getMaxW() {
        // 预览区至少保留 220px
        return Math.max(XHS_MIN_W, (panel.parentElement ? panel.parentElement.offsetWidth : window.innerWidth) - 220);
      }
      handle.addEventListener('mousedown', function(e) {
        startX = e.clientX; startW = panel.offsetWidth;
        e.preventDefault();
        function onMove(ev) {
          const w = Math.min(getMaxW(), Math.max(XHS_MIN_W, startW - (ev.clientX - startX)));
          panel.style.width = w + 'px';
        }
        function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      // 双击 handle 重置为默认宽度
      handle.addEventListener('dblclick', function() {
        panel.style.width = XHS_DEFAULT_W + 'px';
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
      document.getElementById('btn-toc').className =
        'btn ' + (panelState.tocPanelOpen ? 'btn-active' : 'btn-toc');
      document.getElementById('btn-zhihu-publish').className =
        'btn ' + (panelState.zhihuPublishPanelOpen ? 'btn-active' : 'btn-zhihu-publish');
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

    // ─── TOC 目录 ───

    function buildToc() {
      const nav = document.getElementById('toc-nav');
      if (!nav) return;
      const content = document.getElementById('preview-content');
      if (!content) return;
      const headings = content.querySelectorAll('h1, h2, h3, h4, h5, h6');
      if (!headings.length) {
        nav.innerHTML = '<p class="toc-empty">暂无标题</p>';
        return;
      }
      // 给没有 id 的标题赋予 id，供锚点跳转
      headings.forEach((h, i) => {
        if (!h.id) h.id = 'toc-heading-' + i;
      });
      nav.innerHTML = Array.from(headings).map(h => {
        const level = parseInt(h.tagName[1]);
        const text = h.innerText || h.textContent || '';
        return \`<a class="toc-item" data-level="\${level}" data-id="\${h.id}" title="\${text}">\${text}</a>\`;
      }).join('');

      // 点击跳转
      nav.querySelectorAll('.toc-item').forEach(item => {
        item.addEventListener('click', () => {
          const targetId = item.dataset.id;
          const target = document.getElementById(targetId);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // 高亮当前项
            nav.querySelectorAll('.toc-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
          }
        });
      });
    }

    // 滚动时更新 TOC 高亮
    document.querySelector('.preview-scroll').addEventListener('scroll', () => {
      if (!panelState.tocPanelOpen) return;
      const nav = document.getElementById('toc-nav');
      if (!nav) return;
      const items = nav.querySelectorAll('.toc-item');
      if (!items.length) return;
      const scrollTop = document.querySelector('.preview-scroll').scrollTop;
      let activeItem = null;
      items.forEach(item => {
        const target = document.getElementById(item.dataset.id);
        if (target && target.offsetTop - 80 <= scrollTop) activeItem = item;
      });
      items.forEach(i => i.classList.remove('active'));
      if (activeItem) activeItem.classList.add('active');
    });

    // 目录按钮
    document.getElementById('btn-toc').addEventListener('click', () => {
      togglePanel('toc-panel', 'tocPanelOpen', []);
      if (panelState.tocPanelOpen) buildToc();
    });

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
        [{panelId:'upload-panel',stateKey:'uploadPanelOpen'},{panelId:'xhs-panel',stateKey:'xhsPanelOpen'},{panelId:'zhihu-publish-panel',stateKey:'zhihuPublishPanelOpen'}]);
    });

    document.getElementById('btn-upload').addEventListener('click', () => {
      togglePanel('upload-panel', 'uploadPanelOpen',
        [{panelId:'style-panel',stateKey:'stylePanelOpen'},{panelId:'xhs-panel',stateKey:'xhsPanelOpen'},{panelId:'zhihu-publish-panel',stateKey:'zhihuPublishPanelOpen'}]);
      if (panelState.uploadPanelOpen) {
        const titleInput = document.getElementById('input-title');
        if (!titleInput.value && currentTitle) titleInput.value = currentTitle;
        vscode.postMessage({ type: 'getConfig' });
      }
    });

    document.getElementById('btn-zhihu-publish').addEventListener('click', () => {
      togglePanel('zhihu-publish-panel', 'zhihuPublishPanelOpen',
        [{panelId:'style-panel',stateKey:'stylePanelOpen'},{panelId:'upload-panel',stateKey:'uploadPanelOpen'},{panelId:'xhs-panel',stateKey:'xhsPanelOpen'}]);
      if (panelState.zhihuPublishPanelOpen) {
        const titleInput = document.getElementById('zhihu-input-title');
        if (!titleInput.value && currentTitle) titleInput.value = currentTitle;
        vscode.postMessage({ type: 'zhihuCheckLogin' });
        vscode.postMessage({ type: 'zhihuGetArticleId' });
      }
    });

    // 知乎面板内部事件

    // 标签页切换
    function switchZhihuTab(tab) {
      const isQr = tab === 'qr';
      document.getElementById('zhihu-pane-qr').style.display     = isQr ? '' : 'none';
      document.getElementById('zhihu-pane-cookie').style.display  = isQr ? 'none' : '';
      document.getElementById('zhihu-tab-qr').className     = 'zhihu-tab' + (isQr ? ' zhihu-tab-active' : '');
      document.getElementById('zhihu-tab-cookie').className  = 'zhihu-tab' + (!isQr ? ' zhihu-tab-active' : '');
      if (!isQr) stopZhihuQrPoll();
    }
    document.getElementById('zhihu-tab-qr').addEventListener('click',     () => switchZhihuTab('qr'));
    document.getElementById('zhihu-tab-cookie').addEventListener('click',  () => switchZhihuTab('cookie'));

    document.getElementById('btn-zhihu-qr').addEventListener('click', () => {
      vscode.postMessage({ type: 'zhihuStartQr' });
    });

    document.getElementById('btn-zhihu-save-cookie').addEventListener('click', () => {
      const raw = document.getElementById('zhihu-input-cookie').value.trim();
      if (!raw) { showToast('请输入 z_c0 值', 'error'); return; }
      const btn = document.getElementById('btn-zhihu-save-cookie');
      btn.disabled = true; btn.textContent = '⏳ 验证中...';
      vscode.postMessage({ type: 'zhihuSaveCookie', z_c0: raw });
    });

    document.getElementById('btn-zhihu-logout').addEventListener('click', () => {
      if (!confirm('确认退出知乎登录？')) return;
      vscode.postMessage({ type: 'zhihuLogout' });
    });

    document.getElementById('btn-zhihu-do-publish').addEventListener('click', () => {
      const title     = document.getElementById('zhihu-input-title').value.trim();
      const articleId = document.getElementById('zhihu-input-article-id').value.trim();
      if (!title) { showToast('请填写文章标题', 'error'); return; }
      vscode.postMessage({ type: 'zhihuPublish', title, articleId: articleId || null });
    });

    document.getElementById('btn-zhihu-save-draft').addEventListener('click', () => {
      const title     = document.getElementById('zhihu-input-title').value.trim();
      const articleId = document.getElementById('zhihu-input-article-id').value.trim();
      if (!title) { showToast('请填写文章标题', 'error'); return; }
      vscode.postMessage({ type: 'zhihuSaveDraft', title, articleId: articleId || null });
    });

    // 扫码轮询定时器
    let _zhihuQrTimer = null;
    function startZhihuQrPoll() {
      stopZhihuQrPoll();
      _zhihuQrTimer = setInterval(() => {
        vscode.postMessage({ type: 'zhihuPollQr' });
      }, 2000);
    }
    function stopZhihuQrPoll() {
      if (_zhihuQrTimer) { clearInterval(_zhihuQrTimer); _zhihuQrTimer = null; }
    }

    document.getElementById('btn-xhs').addEventListener('click', () => {
      togglePanel('xhs-panel', 'xhsPanelOpen',
        [{panelId:'style-panel',stateKey:'stylePanelOpen'},{panelId:'upload-panel',stateKey:'uploadPanelOpen'},{panelId:'zhihu-publish-panel',stateKey:'zhihuPublishPanelOpen'}]);
    });

    document.getElementById('btn-xhs-python').addEventListener('click', () => {
      const imgW   = parseInt(document.getElementById('xhs-width').value)     || XHS_DEFAULTS.width;
      const imgH   = parseInt(document.getElementById('xhs-height').value)    || XHS_DEFAULTS.height;
      const pad    = parseInt(document.getElementById('xhs-padding').value);
      const bgColor = currentThemeBg || '#ffffff';
      const btn = document.getElementById('btn-xhs-python');
      btn.disabled = true; btn.textContent = '⏳ 渲染中...';
      document.getElementById('xhs-output').innerHTML = '<p class="hint">⏳ 正在生成，请稍候...</p>';
      // autoExport: false → 仅生成预览，保存到临时目录
      vscode.postMessage({ type: 'generateXhsViaPython', width: imgW, height: imgH, padding: pad, bg: bgColor, autoExport: false });
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
      const btn = document.getElementById('btn-xhs-export-all');
      if (slices && slices.length) {
        // 已有预览，直接保存
        btn.disabled = true; btn.textContent = '💾 导出中...';
        vscode.postMessage({ type: 'saveXhsImages', dataUrls: slices });
      } else {
        // 未生成预览，先生成再自动保存（autoExport: true）
        const imgW   = parseInt(document.getElementById('xhs-width').value)     || XHS_DEFAULTS.width;
        const imgH   = parseInt(document.getElementById('xhs-height').value)    || XHS_DEFAULTS.height;
        const pad    = parseInt(document.getElementById('xhs-padding').value);
        const bgColor = currentThemeBg || '#ffffff';
        btn.disabled = true; btn.textContent = '⏳ 生成并导出中...';
        document.getElementById('btn-xhs-python').disabled = true;
        document.getElementById('btn-xhs-python').textContent = '⏳ 渲染中...';
        document.getElementById('xhs-output').innerHTML = '<p class="hint">⏳ 正在生成，请稍候...</p>';
        vscode.postMessage({ type: 'generateXhsViaPython', width: imgW, height: imgH, padding: pad, bg: bgColor, autoExport: true });
      }
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
            : 'Markdown2Anything 预览';
          // 应用主题
          if (msg.theme) {
            applyTheme(msg.theme);
          }
          // 填充标题输入框（如果为空）
          const titleInput = document.getElementById('input-title');
          if (!titleInput.value && currentTitle) titleInput.value = currentTitle;
          // 内容更新后同步重建目录
          if (panelState.tocPanelOpen) buildToc();
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
          btn.disabled = false; btn.textContent = '📸 生成预览';
          window._xhsLastSlices = msg.dataUrls;
          showXhsOutput(msg.dataUrls);
          document.getElementById('btn-xhs-export-all').disabled = false;
          if (msg.autoExport) {
            // 一键导出全部触发的生成：自动保存
            document.getElementById('btn-xhs-export-all').disabled = true;
            document.getElementById('btn-xhs-export-all').textContent = '💾 导出中...';
            vscode.postMessage({ type: 'saveXhsImages', dataUrls: msg.dataUrls });
          } else {
            showToast(\`✅ 生成 \${msg.dataUrls.length} 张预览图，点击「一键导出全部」保存到本地\`, 'success', 5000);
          }
          break;
        }
        case 'xhsPythonError': {
          const btn = document.getElementById('btn-xhs-python');
          btn.disabled = false; btn.textContent = '📸 生成预览';
          document.getElementById('btn-xhs-export-all').disabled = false;
          document.getElementById('btn-xhs-export-all').textContent = '💾 一键导出全部';
          const errMsg = msg.message || '未知错误';
          document.getElementById('xhs-output').innerHTML =
            \`<p class="hint" style="color:#f88">❌ \${errMsg}</p>\`;
          showToast('生成失败: ' + errMsg, 'error');
          break;
        }
        case 'saveXhsImagesDone': {
          const btn = document.getElementById('btn-xhs-export-all');
          btn.disabled = false; btn.textContent = '💾 一键导出全部';
          document.getElementById('btn-xhs-python').disabled = false;
          showToast(\`✅ 已导出 \${msg.count} 张到 \${msg.dir}\`, 'success', 4000);
          break;
        }
        case 'saveXhsImagesError': {
          const btn = document.getElementById('btn-xhs-export-all');
          btn.disabled = false; btn.textContent = '💾 一键导出全部';
          document.getElementById('btn-xhs-python').disabled = false;
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

        // ── 知乎发布 ──
        case 'zhihuLoginStatus': {
          const loggedOut = document.getElementById('zhihu-logged-out');
          const loggedIn  = document.getElementById('zhihu-logged-in');
          if (msg.loggedIn) {
            loggedOut.style.display = 'none';
            loggedIn.style.display  = 'block';
            document.getElementById('zhihu-user-name').textContent = msg.name || '（已登录）';
            stopZhihuQrPoll();
          } else {
            loggedOut.style.display = 'block';
            loggedIn.style.display  = 'none';
            document.getElementById('zhihu-input-cookie').value = '';
            document.getElementById('zhihu-cookie-result').style.display = 'none';
            switchZhihuTab('qr');
          }
          break;
        }
        case 'zhihuSaveCookieResult': {
          const btn = document.getElementById('btn-zhihu-save-cookie');
          btn.disabled = false; btn.textContent = '验证并保存';
          const res = document.getElementById('zhihu-cookie-result');
          if (msg.success) {
            res.className = 'upload-result success';
            res.textContent = \`✅ 验证成功，已登录为：\${msg.name || '（未知用户）'}\`;
            showToast('知乎 Cookie 已保存！', 'success');
          } else {
            res.className = 'upload-result error';
            res.textContent = \`❌ \${msg.error || '验证失败'}\`;
            showToast(msg.error || '验证失败', 'error');
          }
          res.style.display = 'block';
          break;
        }
        case 'zhihuQrProgress': {
          const btn = document.getElementById('btn-zhihu-qr');
          btn.disabled = true; btn.textContent = '⏳ 启动中...';
          const hint = document.getElementById('zhihu-qr-hint');
          hint.textContent = msg.message || '正在启动浏览器...';
          hint.style.display = '';
          break;
        }
        case 'zhihuQrReady': {
          const hint = document.getElementById('zhihu-qr-hint');
          hint.textContent = '浏览器已打开，请在浏览器窗口中完成登录...';
          hint.style.display = '';
          document.getElementById('btn-zhihu-qr').disabled = true;
          document.getElementById('btn-zhihu-qr').textContent = '⏳ 等待登录...';
          break;
        }
        case 'zhihuQrError': {
          const btn = document.getElementById('btn-zhihu-qr');
          btn.disabled = false; btn.textContent = '重新打开浏览器';
          const hint = document.getElementById('zhihu-qr-hint');
          hint.textContent = '❌ ' + (msg.message || '未知错误');
          hint.style.display = '';
          break;
        }
        case 'zhihuPollResult': {
          if (msg.status === 'confirmed') {
            document.getElementById('btn-zhihu-qr').disabled = false;
            document.getElementById('btn-zhihu-qr').textContent = '重新登录';
            document.getElementById('zhihu-logged-out').style.display = 'none';
            document.getElementById('zhihu-logged-in').style.display  = 'block';
            document.getElementById('zhihu-user-name').textContent    = msg.name || '（已登录）';
            showToast('✅ 知乎登录成功！', 'success');
          } else if (msg.status === 'error') {
            const btn = document.getElementById('btn-zhihu-qr');
            btn.disabled = false; btn.textContent = '重新打开浏览器';
            showToast('登录出错：' + (msg.message || '未知错误'), 'error');
          }
          break;
        }
        case 'zhihuPublishStart': {
          const btn = document.getElementById('btn-zhihu-do-publish');
          btn.disabled = true; btn.textContent = '⏳ 发布中...';
          document.getElementById('btn-zhihu-save-draft').disabled = true;
          document.getElementById('zhihu-publish-result').style.display = 'none';
          const prog = document.getElementById('zhihu-publish-progress');
          prog.textContent = '准备中...';
          prog.style.display = '';
          break;
        }
        case 'zhihuPublishProgress': {
          const prog = document.getElementById('zhihu-publish-progress');
          prog.textContent = msg.message || '';
          prog.style.display = '';
          break;
        }
        case 'zhihuArticleId': {
          if (msg.articleId) {
            document.getElementById('zhihu-input-article-id').value = msg.articleId;
          }
          break;
        }
        case 'zhihuPublishResult': {
          const btn = document.getElementById('btn-zhihu-do-publish');
          btn.disabled = false; btn.textContent = '发布文章';
          document.getElementById('btn-zhihu-save-draft').disabled = false;
          document.getElementById('zhihu-publish-progress').style.display = 'none';
          const res = document.getElementById('zhihu-publish-result');
          if (msg.success) {
            res.className = 'upload-result success';
            res.innerHTML = \`✅ 发布成功！<br><a href="\${msg.url}" style="color:#4fc3f7;word-break:break-all;" title="\${msg.url}">\${msg.url}</a>\`;
            showToast('知乎发布成功！', 'success');
            if (msg.articleId) {
              document.getElementById('zhihu-input-article-id').value = msg.articleId;
            }
          } else {
            res.className = 'upload-result error';
            res.textContent = \`❌ 发布失败：\${msg.error || '未知错误'}\`;
            showToast('发布失败', 'error');
          }
          res.style.display = 'block';
          break;
        }
        case 'zhihuDraftResult': {
          const btn = document.getElementById('btn-zhihu-do-publish');
          btn.disabled = false; btn.textContent = '发布文章';
          document.getElementById('btn-zhihu-save-draft').disabled = false;
          document.getElementById('zhihu-publish-progress').style.display = 'none';
          const res = document.getElementById('zhihu-publish-result');
          if (msg.success) {
            res.className = 'upload-result success';
            res.innerHTML = \`📝 草稿已保存！<br><a href="\${msg.editUrl}" style="color:#4fc3f7;">打开知乎草稿箱查看效果</a>\`;
            showToast('草稿保存成功！', 'success');
            if (msg.articleId) {
              document.getElementById('zhihu-input-article-id').value = msg.articleId;
            }
          } else {
            res.className = 'upload-result error';
            res.textContent = \`❌ 保存草稿失败：\${msg.error || '未知错误'}\`;
            showToast('保存草稿失败', 'error');
          }
          res.style.display = 'block';
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
