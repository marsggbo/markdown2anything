'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const { renderMarkdown, buildFullHtml, buildWechatCopyHtml, buildZhihuCopyHtml, buildXhsCopyHtml, convertMarkdownToWeChat, buildXhsRenderHtmlByMode, inlineRemoteImages } = require('./lib/converter');
const { THEMES, DEFAULT_THEME_ID, getTheme } = require('./lib/themes');
const zhihu = require('./lib/zhihu');
const llm = require('./lib/llm');
const social = require('./lib/social');
const cover = require('./lib/cover');
const coverLlm = require('./lib/cover-llm');
const extract = require('./lib/extract');
const matter = require('gray-matter');
const pandocManager = require('./lib/pandoc-manager');
const slidevManager = require('./lib/slidev-manager');

// 在扩展宿主里 process.execPath 是 VS Code 的 Electron 二进制，用它跑 Node 脚本
// 必须带 ELECTRON_RUN_AS_NODE=1，否则二进制会把脚本参数当命令行选项、不执行脚本。
// 修复：封面脚本合成、小红书截图、知乎登录浏览器等 spawn 全走这个 env。
const NODE_EXEC_ENV = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });

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
  // 收掉常驻的发布 worker（连带关掉它开的浏览器），不留残窗
  try { killWorker('xiaohongshu'); killWorker('twitter'); killWorker('zhihu'); } catch (_) {}
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

async function handleConvert(uri, customOutputPath) {
  const mdPath = await resolveMdFilePath(uri);
  if (!mdPath) return;

  try {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mdPath));
    const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(mdPath);
    const cfg = vscode.workspace.getConfiguration('markdown2anything');
    const templateName = cfg.get('template', 'wechat');
    const templatePath = getTemplatePath(workspacePath, templateName);

    if (!templatePath) {
      vscode.window.showErrorMessage(`找不到模板: ${templateName}`);
      return;
    }

    // 输出路径优先级：webview 传入的自定义路径 > 配置项 > 默认同目录
    let outputPath;
    if (customOutputPath && path.isAbsolute(customOutputPath)) {
      outputPath = customOutputPath;
    } else if (customOutputPath) {
      outputPath = path.join(path.dirname(mdPath), customOutputPath);
    } else {
      const savedDir = cfg.get('outputPath', '');
      const base = path.basename(mdPath, path.extname(mdPath));
      if (savedDir) {
        const dir = path.isAbsolute(savedDir) ? savedDir : path.join(path.dirname(mdPath), savedDir);
        outputPath = path.join(dir, `${base}.html`);
      } else {
        // 默认：与 md 文件同目录，同名
        outputPath = path.join(path.dirname(mdPath), `${base}.html`);
      }
    }

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

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
    const proc = spawn(process.execPath, [cliPath, 'install', 'chromium'], { env: NODE_EXEC_ENV });
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
      await handleConvert(vscode.Uri.file(mdPath), msg.outputPath || '');
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
      const { width = 1080, height = 1440, padding = 40, bg = '#ffffff', autoExport = false, mode = 'classic', density = null } = msg;
      // density 语义：adaptive 模式 → 正文字号(px)；classic 模式 → 字体缩放(%)
      const cfgAdaptive = vscode.workspace.getConfiguration('markdown2anything');
      const useThemeAccent = cfgAdaptive.get('xhs.adaptiveUseTheme', true);
      const renderOpts = mode === 'adaptive'
        ? { fontSize:  density != null ? density : 36, useThemeAccent }
        : { fontScale: density != null ? density : 100 };

      // 生成独立渲染 HTML
      const { bodyHtml } = renderMarkdown(mdPath);
      const theme = getTheme(currentThemeId);
      const htmlContent = buildXhsRenderHtmlByMode(bodyHtml, path.dirname(mdPath), theme, mode, renderOpts);
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
        ], { env: NODE_EXEC_ENV });

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
            const htmlContent2 = buildXhsRenderHtmlByMode(bodyHtml, path.dirname(mdPath), theme, mode);
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
        // 远程图片下载转 base64 内联：微信编辑器拒绝外链图片，粘贴后图片才能显示
        const inlined = await inlineRemoteImages(bodyHtml);
        const theme = getTheme(currentThemeId);
        const html = buildWechatCopyHtml(inlined, templatePath, theme);
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
        // 远程图片下载转 base64 内联（保证本地/远程图片统一为 data URI）
        const inlined = await inlineRemoteImages(bodyHtml);
        const theme = getTheme(currentThemeId);
        let html = buildZhihuCopyHtml(inlined, templatePath, theme);

        // 知乎编辑器只认自己图床（zhimg.com）的图片，base64 粘贴会被拒绝。
        // 若用户已登录知乎，自动上传图片到知乎图床替换为 CDN URL，粘贴即可显示。
        const imgCount = (html.match(/data:image\//g) || []).length;
        const cookieStr = extContext.globalState.get(zhihu.STORAGE_KEY, '');
        let imgUploaded = 0;
        if (imgCount > 0 && zhihu.isLoggedIn(cookieStr)) {
          panel.webview.postMessage({ type: 'zhihuHtmlProgress', message: `正在上传 ${imgCount} 张图片到知乎图床...` });
          try {
            const up = await zhihu.uploadImagesInHtml(html, cookieStr);
            html = up.html;
            imgUploaded = up.total - up.failed;
            log(`知乎复制：图片上传 ${imgUploaded}/${up.total} 成功`);
            if (up.failed > 0) log(`知乎复制：${up.failed} 张图片上传失败，已保留原图`);
          } catch (err) {
            log(`知乎复制：图片上传异常 ${err.message}`);
          }
        }
        panel.webview.postMessage({ type: 'zhihuHtml', html, imgCount, imgUploaded, loggedIn: zhihu.isLoggedIn(cookieStr) });
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

    case 'setXhsExportMode': {
      const mode = msg.mode === 'adaptive' ? 'adaptive' : 'classic';
      const cfg = vscode.workspace.getConfiguration('markdown2anything');
      await cfg.update('xhs.exportMode', mode, vscode.ConfigurationTarget.Global);
      break;
    }

    case 'setXhsAdaptiveUseTheme': {
      const cfg = vscode.workspace.getConfiguration('markdown2anything');
      await cfg.update('xhs.adaptiveUseTheme', !!msg.enabled, vscode.ConfigurationTarget.Global);
      break;
    }

    // ─── 封面生成 ───────────────────────────────────────────────
    case 'coverGeneratePrompt': {
      try {
        const cfg = await getLlmConfig();
        const meta = readArticleMeta(mdPath);
        const title = (msg.title || meta.title || '').trim();
        const rawAbstract = msg.abstract || '';
        const result = await coverLlm.generateCoverPrompt({
          title, abstract: rawAbstract, vibe: msg.vibe || '', instruction: msg.instruction || '', config: cfg,
        });
        panel.webview.postMessage({ type: 'coverPromptResult', ok: true, ...result });
      } catch (e) {
        panel.webview.postMessage({ type: 'coverPromptResult', ok: false, message: e.message });
      }
      break;
    }

    case 'coverGenerateImage': {
      try {
        const cfg = await getLlmConfig();
        // 若配置了 cover.imageModel 则覆盖 model
        const ccfg = vscode.workspace.getConfiguration('markdown2anything');
        const imgModel = ccfg.get('cover.imageModel','').trim();
        const imgSize = ccfg.get('cover.imageSize','1024x1536').trim() || '1024x1536';
        const imgCfg = imgModel ? { ...cfg, model: imgModel } : cfg;
        const { b64 } = await coverLlm.generateCoverImage({
          prompt: msg.prompt, negativePrompt: msg.negativePrompt||'', config: imgCfg, size: imgSize,
        });
        // 保存到 md 同目录 _cover + 同步入全局历史（自动设为默认）
        const base = path.basename(mdPath, path.extname(mdPath));
        const dir = path.join(path.dirname(mdPath), `${base}_cover`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
        const outPath = path.join(dir, `cover_bg_${Date.now()}.png`);
        coverLlm.saveB64ToFile(b64, outPath);
        const dataUrl = `data:image/png;base64,${b64}`;
        try { coverSaveBgFromDataUrl(dataUrl, 'LLM_'+Date.now()); } catch(_){}
        panel.webview.postMessage({ type: 'coverImageResult', ok: true, dataUrl, outPath });
        // 推送最新历史
        try {
          const cfg2 = loadCoverConfig();
          const list2 = cfg2.bgs.map(function(it){ return { id:it.id, name:it.name, createdAt:it.createdAt, dataUrl: coverGetBgDataUrl(it) }; }).filter(function(x){return x.dataUrl;});
          panel.webview.postMessage({ type:'coverHistory', bgs: list2, defaultBgId: cfg2.defaultBgId, titleState: cfg2.titleState||{x:50,y:50,fontSize:78,width:70} });
        } catch(_){}
      } catch (e) {
        // 404 等表示不支持生图，降级为只给 prompt
        panel.webview.postMessage({ type: 'coverImageResult', ok: false, message: e.message, needCopy: /404|not found|不支持/i.test(e.message) });
      }
      break;
    }

    case 'coverGenerate': {
      // 脚本合成封面：标题 + 背景图 -> 1080x1440 PNG，位置/大小持久化
      try {
        const { spawn } = require('child_process');
        const title = (msg.title || '').trim() || readArticleMeta(mdPath).title || '未命名封面';
        const bgDataUrl = msg.bgDataUrl || msg.bg || '';
        const tagline = msg.tagline || '';
        let bgPath = '';
        if (bgDataUrl && bgDataUrl.startsWith('data:')) {
          const m = bgDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
          if (m) {
            bgPath = path.join(os.tmpdir(), `m2a_cover_bg_${Date.now()}.png`);
            fs.writeFileSync(bgPath, Buffer.from(m[1],'base64'));
          }
        } else if (bgDataUrl && !bgDataUrl.startsWith('http')) {
          // 可能是 globalStorage 里的真实路径
          if (bgDataUrl && fs.existsSync(bgDataUrl)) bgPath = bgDataUrl;
          else bgPath = bgDataUrl;
        }
        const base = path.basename(mdPath, path.extname(mdPath));
        const outDir = path.join(path.dirname(mdPath), `${base}_cover`);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir,{recursive:true});
        const outPath = path.join(outDir, `cover_${Date.now()}.png`);
        const scriptPath = path.join(extContext.extensionUri.fsPath, 'scripts', 'cover.js');
        const args=[scriptPath, '--title', title, '--out', outPath, '--width','1080','--height','1440'];
        if (bgPath) args.push('--bg', bgPath);
        if (tagline) args.push('--tagline', tagline);
        if (msg.titleState) args.push('--titleState', JSON.stringify(msg.titleState));
        if (bgDataUrl && bgDataUrl.startsWith('http')) args.push('--bg', bgDataUrl);

        const proc = spawn(process.execPath, args, { env: NODE_EXEC_ENV });
        let stdout='';
        proc.stdout.on('data', d=>{ stdout+=d.toString(); const l=d.toString().trim(); if(l.startsWith('INFO:')) panel.webview.postMessage({type:'coverProgress', message:l.slice(5)}); });
        proc.stderr.on('data', d=>{ stdout+=d.toString(); });
        proc.on('close', async (code)=>{
          try{ if(bgPath && bgPath.includes(os.tmpdir()) && fs.existsSync(bgPath)) fs.unlinkSync(bgPath);}catch(_){}
          if (code===2) {
            panel.webview.postMessage({type:'coverProgress', message:'📥 首次使用，正在下载 Chromium...'});
            await installChromium(panel);
            const proc2=spawn(process.execPath, args, { env: NODE_EXEC_ENV });
            let out2='';
            proc2.stdout.on('data', d=>{ out2+=d.toString(); });
            proc2.on('close', c2=>{
              if(c2!==0){ panel.webview.postMessage({type:'coverResult', ok:false, message: out2.split('\n').find(l=>l.startsWith('ERROR:'))||'封面生成失败'}); return; }
              const buf=fs.readFileSync(outPath);
              panel.webview.postMessage({type:'coverResult', ok:true, dataUrl:`data:image/png;base64,${buf.toString('base64')}`, outPath});
            });
            return;
          }
          if(code!==0){ panel.webview.postMessage({type:'coverResult', ok:false, message: stdout.split('\n').find(l=>l.startsWith('ERROR:'))||'封面生成失败'}); return; }
          const buf=fs.readFileSync(outPath);
          panel.webview.postMessage({type:'coverResult', ok:true, dataUrl:`data:image/png;base64,${buf.toString('base64')}`, outPath});
        });
        proc.on('error', e=> panel.webview.postMessage({type:'coverResult', ok:false, message:e.message}));
        panel.webview.postMessage({type:'coverProgress', message:'⏳ 正在合成封面...'});
      } catch(e){ panel.webview.postMessage({type:'coverResult', ok:false, message:e.message}); }
      break;
    }

    case 'coverGetHistory': {
      try {
        const cfg = loadCoverConfig();
        const list = cfg.bgs.map(item=> ({ id:item.id, name:item.name, createdAt:item.createdAt, dataUrl: coverGetBgDataUrl(item) })).filter(x=>x.dataUrl);
        panel.webview.postMessage({ type:'coverHistory', bgs: list, defaultBgId: cfg.defaultBgId, titleState: cfg.titleState || { x:50, y:50, fontSize:78, width:70 } });
      } catch(e){ panel.webview.postMessage({ type:'coverHistory', bgs:[], defaultBgId:null, titleState:{x:50,y:50,fontSize:78,width:70} }); }
      break;
    }
    case 'coverSaveBg': {
      try {
        const dataUrl = msg.dataUrl;
        if (!dataUrl || !dataUrl.startsWith('data:')) throw new Error('请先选择图片');
        const { item, cfg } = coverSaveBgFromDataUrl(dataUrl, msg.name||'');
        const list = cfg.bgs.map(it=> ({ id:it.id, name:it.name, createdAt:it.createdAt, dataUrl: coverGetBgDataUrl(it) })).filter(x=>x.dataUrl);
        panel.webview.postMessage({ type:'coverHistory', bgs: list, defaultBgId: cfg.defaultBgId, titleState: cfg.titleState||{x:50,y:50,fontSize:78,width:70} });
        panel.webview.postMessage({ type:'coverSaveBgDone', id:item.id, dataUrl: coverGetBgDataUrl(item) });
      } catch(e){ panel.webview.postMessage({ type:'coverSaveBgDone', ok:false, message:e.message }); }
      break;
    }
    case 'coverSetDefaultBg': {
      try {
        const cfg = loadCoverConfig();
        if (cfg.bgs.some(b=>b.id===msg.id)) { cfg.defaultBgId = msg.id; saveCoverConfig(cfg); }
        const list = cfg.bgs.map(it=> ({ id:it.id, name:it.name, createdAt:it.createdAt, dataUrl: coverGetBgDataUrl(it) })).filter(x=>x.dataUrl);
        panel.webview.postMessage({ type:'coverHistory', bgs: list, defaultBgId: cfg.defaultBgId, titleState: cfg.titleState||{x:50,y:50,fontSize:78,width:70} });
      } catch(e){ panel.webview.postMessage({ type:'coverHistory', bgs:[], defaultBgId:null }); }
      break;
    }
    case 'coverDeleteBg': {
      try {
        const cfg = loadCoverConfig();
        const idx = cfg.bgs.findIndex(b=>b.id===msg.id);
        if (idx>=0) {
          try{ fs.unlinkSync(cfg.bgs[idx].path); }catch(_){}
          cfg.bgs.splice(idx,1);
          if (cfg.defaultBgId===msg.id) cfg.defaultBgId = cfg.bgs[0]?.id||null;
          saveCoverConfig(cfg);
        }
        const list = cfg.bgs.map(it=> ({ id:it.id, name:it.name, createdAt:it.createdAt, dataUrl: coverGetBgDataUrl(it) })).filter(x=>x.dataUrl);
        panel.webview.postMessage({ type:'coverHistory', bgs: list, defaultBgId: cfg.defaultBgId, titleState: cfg.titleState||{x:50,y:50,fontSize:78,width:70} });
      } catch(e){ panel.webview.postMessage({ type:'coverHistory', bgs:[], defaultBgId:null }); }
      break;
    }
    case 'coverSaveTitleState': {
      try {
        const cfg = loadCoverConfig();
        cfg.titleState = { x: Number(msg.x)||50, y: Number(msg.y)||50, fontSize: Number(msg.fontSize)||78, width: Number(msg.width)||70 };
        saveCoverConfig(cfg);
        panel.webview.postMessage({ type:'coverTitleStateSaved', titleState: cfg.titleState });
      } catch(e){ panel.webview.postMessage({ type:'coverTitleStateSaved', ok:false, message:e.message }); }
      break;
    }

    // 「→ 预览」按钮：webview 请求当前编辑器光标行，extension 立即推送 syncToLine
    case 'requestCursorLine': {
      const editors = vscode.window.visibleTextEditors.filter(
        (e) => e.document.uri.fsPath === mdPath,
      );
      if (editors.length > 0) {
        const line = editors[0].selection.active.line;
        panel.webview.postMessage({ type: 'syncToLine', line });
      }
      break;
    }

    // 预览滚动 → 跳转到编辑器对应行（预览 → 编辑器方向，仅滚动不移光标）
    case 'scrollToEditorLine': {
      const targetLine = typeof msg.line === 'number' ? msg.line : 0;
      const editors = vscode.window.visibleTextEditors.filter(
        (e) => e.document.uri.fsPath === mdPath,
      );
      for (const editor of editors) {
        const pos = new vscode.Position(targetLine, 0);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
        // 不修改 selection，避免触发 onDidChangeTextEditorSelection 形成循环
      }
      break;
    }

    // ─── 社交发布（小红书 / Twitter）：文案生成 + cookie 登录 + Playwright 发布 ───
    case 'socialGetInit': {
      const platform = msg.platform;
      const cookies = social.getCookies(platform, socialStorage());
      const status = social.cookieStatus(platform, cookies);
      const meta = readArticleMeta(mdPath);
      const images = listExportedXhsImages(mdPath);
      // 优先用已保存的当前版本；没有才用本地算法预填
      const store = loadSocialStore(mdPath);
      const saved = currentContent(store, platform);
      panel.webview.postMessage({
        type: 'socialInit', platform, status, meta,
        images, imageCount: images.length,
        defaultInstruction: llm.getDefaultInstruction(platform === 'twitter' ? 'twitter' : 'xiaohongshu'),
        prefill: saved || localPrefill(mdPath, platform),
        fromSaved: !!saved,
        savedLink: store.link || '',
        versions: versionMeta(store, platform),
        llm: await getLlmConfigForView(),
      });
      break;
    }

    // 覆盖保存当前版本
    case 'socialSaveCopy': {
      const store = updateCurrentVersion(mdPath, msg.platform, msg.content, msg.link);
      panel.webview.postMessage({
        type: 'socialSaveCopyResult', platform: msg.platform, ok: true,
        path: path.basename(socialCopyPath(mdPath)),
        versions: versionMeta(store, msg.platform),
      });
      break;
    }

    // 切换版本（左右箭头）
    case 'socialSwitchVersion': {
      const store = loadSocialStore(mdPath);
      const p = store[msg.platform];
      if (p.versions.length) {
        p.current = Math.max(0, Math.min(msg.index, p.versions.length - 1));
        saveSocialStore(mdPath, store);
        panel.webview.postMessage({
          type: 'socialCopyResult', platform: msg.platform,
          copy: p.versions[p.current].content,
          source: p.versions[p.current].source,
          versions: versionMeta(store, msg.platform),
        });
      }
      break;
    }

    // 删除某个版本
    case 'socialDeleteVersion': {
      const store = loadSocialStore(mdPath);
      const p = store[msg.platform];
      if (p.versions.length) {
        const i = Math.max(0, Math.min(msg.index, p.versions.length - 1));
        p.versions.splice(i, 1);
        p.current = p.versions.length ? Math.min(i, p.versions.length - 1) : -1;
        saveSocialStore(mdPath, store);
        panel.webview.postMessage({
          type: 'socialCopyResult', platform: msg.platform,
          copy: currentContent(store, msg.platform) || localPrefill(mdPath, msg.platform),
          source: 'switch',
          versions: versionMeta(store, msg.platform),
          deleted: true,
        });
      }
      break;
    }

    // 本地提取（不调模型），用于「↺ 本地提取」按钮
    case 'socialLocalExtract': {
      panel.webview.postMessage({
        type: 'socialCopyResult', platform: msg.platform,
        copy: localPrefill(mdPath, msg.platform), source: 'local',
      });
      break;
    }

    // ─── LLM 配置（API Key 存 SecretStorage / 系统钥匙串，绝不明文落盘） ───
    case 'llmGetConfig': {
      panel.webview.postMessage({ type: 'llmConfig', llm: await getLlmConfigForView() });
      break;
    }

    case 'llmSaveConfig': {
      try {
        const cfg = vscode.workspace.getConfiguration('markdown2anything');
        // 未传 profileId（新建）→ 生成唯一 ID，保证所有历史配置都能保存、不被覆盖
        let profileId = (msg.profileId || '').trim();
        if (!profileId) profileId = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        // 多 Profile 存储
        const profiles = getLlmProfilesData();
        const existing = profiles.find(p => p.id === profileId);
        const baseUrl  = typeof msg.baseUrl === 'string' ? msg.baseUrl.trim() : (existing?.baseUrl || '');
        const profileData = {
          id: profileId,
          name: (msg.profileName || '').trim() || profileId,
          baseUrl,
          model:   typeof msg.model   === 'string' ? msg.model.trim()   : (existing?.model   || ''),
          savedAt: Date.now(),
        };
        if (existing) Object.assign(existing, profileData);
        else profiles.push(profileData);
        await cfg.update('llm.profiles', JSON.stringify(profiles), vscode.ConfigurationTarget.Global);
        await cfg.update('llm.activeProfile', profileId, vscode.ConfigurationTarget.Global);
        const sk = LLM_PROFILE_SECRET_PREFIX + profileId;
        if (typeof msg.apiKey === 'string') {
          // 用户显式填了 key：非空则存，空串则清除
          const k = msg.apiKey.trim();
          if (k) await extContext.secrets.store(sk, k);
          else   await extContext.secrets.delete(sk);
        } else if (!(await extContext.secrets.get(sk))) {
          // 未填 key 且本配置还没有 key：自动复用同平台（同端点优先，其次同 host）已有配置的 key，
          // 这样同平台换模型/新建配置无需重复填 key；不同平台的 key 不互相复用
          const host = llmHostOf(baseUrl);
          const src = profiles.find(p => p.id !== profileId && p.baseUrl === baseUrl && p.id)
                   || profiles.find(p => p.id !== profileId && host && host === llmHostOf(p.baseUrl) && p.id);
          if (src) {
            const inherit = await getLlmProfileApiKey(src.id);
            if (inherit) await extContext.secrets.store(sk, inherit);
          }
        }
        panel.webview.postMessage({ type: 'llmConfigSaved', llm: await getLlmConfigForView() });
      } catch (e) {
        panel.webview.postMessage({ type: 'llmConfigError', message: e.message });
      }
      break;
    }

    case 'llmSwitchProfile': {
      try {
        const cfg = vscode.workspace.getConfiguration('markdown2anything');
        await cfg.update('llm.activeProfile', msg.profileId || '', vscode.ConfigurationTarget.Global);
        panel.webview.postMessage({ type: 'llmConfigSaved', llm: await getLlmConfigForView() });
      } catch (e) {
        panel.webview.postMessage({ type: 'llmConfigError', message: e.message });
      }
      break;
    }

    case 'llmDeleteProfile': {
      try {
        const cfg = vscode.workspace.getConfiguration('markdown2anything');
        if (msg.profileId === '__legacy__') {
          // 删除历史遗留扁平配置：清空旧版键 + 旧版 key
          await cfg.update('llm.baseUrl', '', vscode.ConfigurationTarget.Global);
          await cfg.update('llm.model', '', vscode.ConfigurationTarget.Global);
          await extContext.secrets.delete(LLM_SECRET_KEY);
          await cfg.update('llm.activeProfile', '', vscode.ConfigurationTarget.Global);
          panel.webview.postMessage({ type: 'llmConfigSaved', llm: await getLlmConfigForView() });
          break;
        }
        const profiles = getLlmProfilesData().filter(p => p.id !== msg.profileId);
        await cfg.update('llm.profiles', JSON.stringify(profiles), vscode.ConfigurationTarget.Global);
        await extContext.secrets.delete(LLM_PROFILE_SECRET_PREFIX + msg.profileId);
        const activeId = cfg.get('llm.activeProfile', '');
        if (activeId === msg.profileId) {
          const nextId = profiles.length ? profiles[profiles.length - 1].id : '';
          await cfg.update('llm.activeProfile', nextId, vscode.ConfigurationTarget.Global);
        }
        panel.webview.postMessage({ type: 'llmConfigSaved', llm: await getLlmConfigForView() });
      } catch (e) {
        panel.webview.postMessage({ type: 'llmConfigError', message: e.message });
      }
      break;
    }

    case 'llmTestConnection': {
      try {
        panel.webview.postMessage({ type: 'llmTestProgress', message: '正在测试连接…' });
        // 优先测试表单里当前填的内容（未保存也能测）；未传则回退到激活配置
        let config;
        if (typeof msg.baseUrl === 'string' && typeof msg.model === 'string') {
          const baseUrl = msg.baseUrl.trim();
          const model   = msg.model.trim();
          let apiKey = typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '';
          // key 留空时自动复用同平台已有配置的 key（同端点优先，其次同 host），与保存逻辑一致
          if (!apiKey) {
            const profiles = getLlmProfilesData();
            const host = llmHostOf(baseUrl);
            const src = profiles.find(p => p.baseUrl === baseUrl && p.id)
                     || profiles.find(p => host && host === llmHostOf(p.baseUrl) && p.id);
            if (src) apiKey = await getLlmProfileApiKey(src.id);
          }
          // 还没有的话再回退历史遗留扁平配置的 key（旧版 llm.apiKey）
          if (!apiKey) apiKey = (await extContext.secrets.get(LLM_SECRET_KEY)) || '';
          config = { baseUrl, model, apiKey };
        } else {
          config = await getLlmConfig();
        }
        const res = await llm.testConnection({ config });
        panel.webview.postMessage({ type: 'llmTestResult', ok: true, reply: res.reply });
      } catch (e) {
        panel.webview.postMessage({ type: 'llmTestResult', ok: false, message: e.message });
      }
      break;
    }

    // 测试某个已保存 profile 的连接（用于「配置按钮」显示连接状态）
    case 'llmTestProfile': {
      try {
        const profiles = getLlmProfilesData();
        const p = profiles.find(x => x.id === msg.profileId);
        if (!p) {
          panel.webview.postMessage({ type: 'llmTestProfileResult', profileId: msg.profileId, ok: false, message: '配置不存在' });
          break;
        }
        const apiKey = await getLlmProfileApiKey(p.id);
        const res = await llm.testConnection({ config: { baseUrl: p.baseUrl, model: p.model, apiKey } });
        panel.webview.postMessage({ type: 'llmTestProfileResult', profileId: msg.profileId, ok: true, reply: res.reply });
      } catch (e) {
        panel.webview.postMessage({ type: 'llmTestProfileResult', profileId: msg.profileId, ok: false, message: e.message });
      }
      break;
    }

    // 导出全部配置（不含 API Key 明文，只含元数据 + key 指纹），用于备份/迁移
    case 'llmExportConfig': {
      try {
        const profiles = getLlmProfilesData().map(p => ({
          id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model,
          hasKey: p.hasKey === true, keyHint: p.keyHint || '',
        }));
        panel.webview.postMessage({ type: 'llmExportResult', json: JSON.stringify(profiles, null, 2), ok: true });
      } catch (e) {
        panel.webview.postMessage({ type: 'llmExportResult', ok: false, message: e.message });
      }
      break;
    }

    // 导入配置（JSON 数组，不含 key 明文；导入时 key 留空走同平台继承）
    case 'llmImportConfig': {
      try {
        const cfg = vscode.workspace.getConfiguration('markdown2anything');
        const list = JSON.parse(msg.json || '[]');
        if (!Array.isArray(list)) throw new Error('格式错误：应为配置数组');
        const profiles = getLlmProfilesData();
        let imported = 0;
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          const baseUrl = String(item.baseUrl || '').trim();
          const model   = String(item.model || '').trim();
          if (!baseUrl || !model) continue;
          const id = (String(item.id || '').trim()) || ('p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7));
          const existing = profiles.find(p => p.id === id);
          const profileData = {
            id,
            name: (item.name || '').toString().trim() || id,
            baseUrl, model, savedAt: Date.now(),
          };
          if (existing) Object.assign(existing, profileData);
          else profiles.push(profileData);
          // key 未提供/为空时尝试同平台继承
          const sk = LLM_PROFILE_SECRET_PREFIX + id;
          const hasKeyNow = await extContext.secrets.get(sk);
          if (!hasKeyNow) {
            const host = llmHostOf(baseUrl);
            const src = profiles.find(p => p.id !== id && p.baseUrl === baseUrl && p.id)
                     || profiles.find(p => p.id !== id && host && host === llmHostOf(p.baseUrl) && p.id);
            if (src) {
              const inherit = await getLlmProfileApiKey(src.id);
              if (inherit) await extContext.secrets.store(sk, inherit);
            }
          }
          imported++;
        }
        await cfg.update('llm.profiles', JSON.stringify(profiles), vscode.ConfigurationTarget.Global);
        panel.webview.postMessage({ type: 'llmImportResult', ok: true, imported, llm: await getLlmConfigForView() });
      } catch (e) {
        panel.webview.postMessage({ type: 'llmImportResult', ok: false, message: e.message });
      }
      break;
    }

    // 获取某个配置的完整 API Key（供「显示 Key」开关查看；仅本机 SecretStorage）
    case 'llmGetProfileKey': {
      try {
        const k = await getLlmProfileApiKey(msg.profileId);
        panel.webview.postMessage({ type: 'llmProfileKey', profileId: msg.profileId, key: k || '' });
      } catch (e) {
        panel.webview.postMessage({ type: 'llmProfileKey', profileId: msg.profileId, key: '', error: e.message });
      }
      break;
    }

    // 批量测试所有配置的连接
    case 'llmTestAll': {
      try {
        const profiles = getLlmProfilesData();
        if (!profiles.length) {
          panel.webview.postMessage({ type: 'llmTestAllProgress', total: 0, done: 0 });
          break;
        }
        panel.webview.postMessage({ type: 'llmTestAllProgress', total: profiles.length, done: 0 });
        let done = 0;
        for (const p of profiles) {
          try {
            const apiKey = await getLlmProfileApiKey(p.id);
            const res = await llm.testConnection({ config: { baseUrl: p.baseUrl, model: p.model, apiKey } });
            panel.webview.postMessage({ type: 'llmTestProfileResult', profileId: p.id, ok: true, reply: res.reply });
          } catch (e) {
            panel.webview.postMessage({ type: 'llmTestProfileResult', profileId: p.id, ok: false, message: e.message });
          }
          done++;
          panel.webview.postMessage({ type: 'llmTestAllProgress', total: profiles.length, done });
        }
      } catch (e) {
        panel.webview.postMessage({ type: 'llmTestAllProgress', total: 0, done: 0, error: e.message });
      }
      break;
    }

    // 拉取 OpenRouter 当前可用的免费模型（带 :free 后缀），用于「免费模型」快捷选择
    case 'llmFetchFreeModels': {
      try {
        const models = await fetchOpenRouterFreeModels(msg.force === true);
        panel.webview.postMessage({ type: 'llmFreeModels', models, fetchedAt: llmFreeModelsFetchedAt(), forced: msg.force === true });
      } catch (e) {
        panel.webview.postMessage({ type: 'llmFreeModels', models: [], error: e.message });
      }
      break;
    }

    case 'socialGenerateCopy': {
      const platform = msg.platform;
      try {
        const meta = readArticleMeta(mdPath);
        // Twitter 的条数/配图对应要靠真实的长图张数来算，所以先确保长图已导出
        let genImages = listExportedXhsImages(mdPath);
        if (platform === 'twitter' && !genImages.length) {
          panel.webview.postMessage({ type: 'socialCopyProgress', platform, message: '先导出长图以确定推文条数…' });
          genImages = await exportXhsImages(mdPath, panel, platform).catch(() => []);
        }
        panel.webview.postMessage({ type: 'socialCopyProgress', platform, message: '正在生成文案…' });
        const { rawMarkdown } = renderMarkdown(mdPath);
        const context = llm.buildContext({
          title: meta.title, link: msg.link || meta.link,
          images: genImages, rawMarkdown,
        });
        const copy = await llm.generateCopy({
          platform: platform === 'twitter' ? 'twitter' : 'xiaohongshu',
          instruction: msg.instruction || llm.getDefaultInstruction(platform),
          context,
          config: await getLlmConfig(),
        });
        // 每次生成都存成【新版本】，旧版本保留，可用左右箭头回切对比
        const store = addSocialVersion(mdPath, platform, copy, 'llm', msg.link || meta.link);
        panel.webview.postMessage({
          type: 'socialCopyResult', platform, copy, source: 'llm', saved: true,
          versions: versionMeta(store, platform),
        });
      } catch (e) {
        panel.webview.postMessage({ type: 'socialCopyError', platform, message: e.message });
      }
      break;
    }

    case 'socialLogin': {
      const platform = msg.platform;
      try {
        panel.webview.postMessage({ type: 'socialLoginProgress', platform, message: '正在启动浏览器，请在窗口中登录…' });
        killWorker(platform);   // 复用/收掉旧窗口，避免开出一堆
        await social.login(platform, {
          extensionPath: extContext.extensionUri.fsPath,
          storage: socialStorage(),
          onChild: (c) => { lastChild[platform] = c; },
          onProgress: (m) => panel.webview.postMessage({ type: 'socialLoginProgress', platform, message: m }),
        });
        const status = social.cookieStatus(platform, social.getCookies(platform, socialStorage()));
        panel.webview.postMessage({ type: 'socialLoginResult', platform, status });
      } catch (e) {
        if (e.needInstall) {
          panel.webview.postMessage({ type: 'socialLoginError', platform, message: '未找到 Chromium，正在下载…' });
          await installChromium(panel);
          panel.webview.postMessage({ type: 'socialLoginError', platform, message: 'Chromium 已就绪，请重新点击登录' });
        } else {
          panel.webview.postMessage({ type: 'socialLoginError', platform, message: e.message });
        }
      }
      break;
    }

    case 'socialLogout': {
      social.clearCookies(msg.platform, socialStorage());
      panel.webview.postMessage({ type: 'socialLoginResult', platform: msg.platform, status: { loggedIn: false, state: 'none' } });
      break;
    }

    case 'socialPublish': {
      const platform = msg.platform;
      try {
        const cookies = social.getCookies(platform, socialStorage());
        const status = social.cookieStatus(platform, cookies);
        if (!status.loggedIn) {
          panel.webview.postMessage({ type: 'socialPublishError', platform, message: '未登录或登录已失效，请先登录' });
          break;
        }
        const content = msg.content || {};
        const hasText = platform === 'twitter'
          ? (content.tweets || []).some(t => (t.body || '').trim())
          : (content.body || '').trim();
        if (!hasText) {
          panel.webview.postMessage({ type: 'socialPublishError', platform, message: '正文不能为空' });
          break;
        }

        // 配图：有就用，没有就自动导出（两个平台都带图）
        let images = await ensureXhsImages(mdPath, panel, platform);
        const exported = images.length;
        const notify = (m) => panel.webview.postMessage({ type: 'socialPublishProgress', platform, message: m });

        // 配图数量自检：确认数量与导出的截图张数一致
        if (platform === 'twitter') {
          const n = (content.tweets || []).length || 1;
          const cap = n * 4;                       // X 每条最多 4 张
          const willSend = Math.min(exported, cap);
          notify(`配图检查：已导出 ${exported} 张，将分配到 ${n} 条推文共上传 ${willSend} 张`
                 + (exported > cap ? `（超出 ${n}×4 容量，有 ${exported - cap} 张发不出去，建议增加推文条数）` : ''));
        } else {
          const XHS_MAX = 18;                      // 小红书单篇上限
          if (exported > XHS_MAX) images = images.slice(0, XHS_MAX);
          notify(`配图检查：已导出 ${exported} 张，将上传 ${images.length} 张`
                 + (exported > XHS_MAX ? `（超过小红书 ${XHS_MAX} 张上限，已截断）` : ''));
        }

        // 发布前把当前文案落盘备份
        updateCurrentVersion(mdPath, platform, content, msg.link);   // 发布前备份当前版本

        const pcfg = vscode.workspace.getConfiguration('markdown2anything');
        panel.webview.postMessage({ type: 'socialPublishProgress', platform, message: '正在打开浏览器…' });
        killWorker(platform);   // 先收掉上一次的 worker/浏览器，避免窗口越开越多
        const result = await social.publish(platform, {
          extensionPath: extContext.extensionUri.fsPath,
          cookies, content, images,
          link: msg.link || readArticleMeta(mdPath).link,
          mode: pcfg.get('publish.mode', 'prepare'),
          headless: pcfg.get('publish.headless', false),
          onChild: (c) => { lastChild[platform] = c; },
          onProgress: (m) => panel.webview.postMessage({ type: 'socialPublishProgress', platform, message: m }),
          onStep: (s) => panel.webview.postMessage({ type: 'socialPublishStep', platform, step: s }),
          onNeedInstall: () => panel.webview.postMessage({ type: 'socialPublishProgress', platform, message: '正在下载 Chromium…' }),
        });
        lastJobFile[platform] = result.jobFile;   // 供断点续传
        panel.webview.postMessage({ type: 'socialPublishResult', platform, status: result.status });
      } catch (e) {
        if (e.jobFile) lastJobFile[platform] = e.jobFile;
        panel.webview.postMessage({
          type: 'socialPublishError', platform, message: e.message,
          canResume: !!(e.canResume && lastJobFile[platform]),
        });
      }
      break;
    }

    case 'socialResume': {
      const platform = msg.platform;
      try {
        killWorker(platform);   // 收掉卡住的那个 worker，但浏览器窗口仍开着，resume 会连回去
        const result = await social.resume(platform, {
          extensionPath: extContext.extensionUri.fsPath,
          jobFile: lastJobFile[platform],
          onChild: (c) => { lastChild[platform] = c; },
          onProgress: (m) => panel.webview.postMessage({ type: 'socialPublishProgress', platform, message: m }),
          onStep: (s) => panel.webview.postMessage({ type: 'socialPublishStep', platform, step: s }),
        });
        panel.webview.postMessage({ type: 'socialPublishResult', platform, status: result.status });
      } catch (e) {
        panel.webview.postMessage({
          type: 'socialPublishError', platform, message: e.message,
          canResume: !!lastJobFile[platform],
        });
      }
      break;
    }

    // 手动关掉该平台的浏览器窗口（连带收掉常驻的 worker）
    case 'socialCloseBrowser': {
      killWorker(msg.platform);
      panel.webview.postMessage({ type: 'socialPublishProgress', platform: msg.platform, message: '已关闭浏览器窗口' });
      break;
    }

    case 'socialOpenLoginPage': {
      const meta = social.META[msg.platform];
      if (meta) vscode.env.openExternal(vscode.Uri.parse(meta.loginUrl));
      break;
    }

    case 'socialSaveCookie': {
      const platform = msg.platform;
      try {
        const cookies = social.parsePastedCookies(platform, msg.raw);
        social.setCookies(platform, socialStorage(), cookies);
        const status = social.cookieStatus(platform, cookies);
        panel.webview.postMessage({ type: 'socialLoginResult', platform, status });
        panel.webview.postMessage({ type: 'socialLoginProgress', platform, message: 'Cookie 已保存' });
      } catch (e) {
        panel.webview.postMessage({ type: 'socialLoginError', platform, message: e.message });
      }
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

      const proc = spawn(process.execPath, [scriptPath], { env: NODE_EXEC_ENV });
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
        // 走【真实浏览器】发布：知乎没有公开 API 且会主动改内部接口搞挂第三方工具，
        // 之前直接调 api.zhihu.com 传图已经失效；而且当时把「剪贴板版」的带样式 HTML
        // （258KB，每个标签都挂 inline style）直接丢给接口，被知乎的过滤器洗坏 —— 表现就是
        // 代码折叠成一行、公式丢失、图片没传上去。
        //
        // 现在改成：干净的语义化 HTML + 用知乎编辑器自己的通道传图。
        const { bodyHtml } = renderMarkdown(mdPath);
        const cleanHtml = zhihu.buildPublishHtml(bodyHtml);       // <pre lang="python"> + eeimg 公式 + 无 style
        const localImages = listMarkdownLocalImages(mdPath);      // 按出现顺序的本地图
        const cookies = zhihuBrowserCookies();

        if (!cookies.length) {
          panel.webview.postMessage({ type: 'zhihuPublishResult', success: false, error: '未登录，请先扫码登录' });
          break;
        }

        log(`知乎发布：正文 ${cleanHtml.length} 字节，本地图 ${localImages.length} 张`);
        killWorker('zhihu');
        const pcfg2 = vscode.workspace.getConfiguration('markdown2anything');
        const result = await social.publish('zhihu', {
          extensionPath: extContext.extensionUri.fsPath,
          cookies,
          content: { title: title.trim(), html: cleanHtml },
          images: localImages,
          mode: pcfg2.get('publish.mode', 'prepare'),
          headless: false,
          onChild: (c) => { lastChild.zhihu = c; },
          onProgress: (m) => panel.webview.postMessage({ type: 'zhihuPublishProgress', message: m }),
          onStep: (s) => panel.webview.postMessage({ type: 'zhihuPublishProgress', message: `[${s.done}/${s.total}] ${s.label}` }),
        });

        panel.webview.postMessage({
          type: 'zhihuPublishResult', success: true, browser: true,
          message: result.status === 'ready'
            ? '✅ 标题、正文、图片都已填好，请在浏览器里核对后自己点「发布」'
            : '✅ 已提交发布，请在浏览器确认',
        });
        break;
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

    case 'exportPpt': {
      await handleExportPpt(msg, panel, mdPath);
      break;
    }

    case 'cancelPpt': {
      if (currentPptProc && !currentPptProc.killed) {
        currentPptProc.kill('SIGTERM'); currentPptProc = null;
      }
      if (currentPptAbort) { currentPptAbort.abort(); currentPptAbort = null; }
      panel.webview.postMessage({ type: 'pptResult', success: false, error: '已取消' });
      break;
    }

    case 'getPptLlmInstruction': {
      // backend 决定使用哪套默认 prompt
      panel.webview.postMessage({
        type: 'pptLlmInstruction',
        instruction: llm.getDefaultPptInstruction(msg.backend || 'slidev'),
      });
      break;
    }

    case 'pptLlmGenerate': {
      try {
        panel.webview.postMessage({ type: 'pptLlmProgress', label: '正在调用 LLM 改写...' });
        const { rawMarkdown } = renderMarkdown(mdPath);
        const cfg = await getLlmConfig();
        const abortCtrl = new AbortController();
        currentPptAbort = abortCtrl;
        const backend = msg.backend || 'slidev';
        const pptMd = await llm.generatePptMarkdown({
          rawMarkdown,
          backend,
          instruction: msg.instruction || '',
          config: cfg,
          signal: abortCtrl.signal,
        });
        currentPptAbort = null;
        // 自动存版本
        const store = addPptVersion(mdPath, backend, pptMd, msg.instruction || '');
        panel.webview.postMessage({
          type: 'pptLlmResult',
          slidevMd: pptMd,
          backend,
          versions: pptVersionMeta(store, backend),
        });
      } catch (err) {
        panel.webview.postMessage({ type: 'pptLlmError', message: err.message });
      }
      break;
    }

    case 'pptGetVersions': {
      // webview 初始化时或切换 backend 时请求版本列表，同时加载当前版本内容
      const backend = msg.backend || 'slidev';
      const store   = loadPptStore(mdPath);
      const meta    = pptVersionMeta(store, backend);
      const b       = store[backend];
      const current = (b.current >= 0 && b.versions[b.current]) ? b.versions[b.current].markdown : null;
      panel.webview.postMessage({ type: 'pptVersionsLoaded', backend, versions: meta, current });
      break;
    }

    case 'pptSaveVersion': {
      // 用户手动编辑了 textarea 后点「保存当前版本」
      const backend = msg.backend || 'slidev';
      const store   = loadPptStore(mdPath);
      const b       = store[backend];
      if (b.current >= 0 && b.versions.length) {
        b.versions[b.current].markdown = msg.markdown || '';
        b.versions[b.current].at = new Date().toISOString();
        savePptStore(mdPath, store);
        panel.webview.postMessage({ type: 'pptVersionSaved', backend, versions: pptVersionMeta(store, backend) });
      } else {
        // 没有版本就新建
        const s2 = addPptVersion(mdPath, backend, msg.markdown || '', '手动');
        panel.webview.postMessage({ type: 'pptVersionSaved', backend, versions: pptVersionMeta(s2, backend) });
      }
      break;
    }

    case 'pptSwitchVersion': {
      const backend = msg.backend || 'slidev';
      const store   = loadPptStore(mdPath);
      const b       = store[backend];
      const idx     = Math.max(0, Math.min(msg.index, b.versions.length - 1));
      b.current = idx;
      savePptStore(mdPath, store);
      panel.webview.postMessage({
        type: 'pptVersionSwitched',
        backend,
        markdown: b.versions[idx].markdown,
        versions: pptVersionMeta(store, backend),
      });
      break;
    }

    case 'pptDeleteVersion': {
      const backend = msg.backend || 'slidev';
      const store   = loadPptStore(mdPath);
      const b       = store[backend];
      if (!b.versions.length) break;
      const idx = Math.max(0, Math.min(msg.index, b.versions.length - 1));
      b.versions.splice(idx, 1);
      b.current = b.versions.length ? Math.min(idx, b.versions.length - 1) : -1;
      savePptStore(mdPath, store);
      const current = (b.current >= 0 && b.versions[b.current]) ? b.versions[b.current].markdown : '';
      panel.webview.postMessage({
        type: 'pptVersionDeleted',
        backend,
        markdown: current,
        versions: pptVersionMeta(store, backend),
      });
      break;
    }

    case 'exportWord': {
      await handleExportWord(msg, panel, mdPath);
      break;
    }

    default:
      break;
  }
}

// ─── LLM 配置（Key 走 SecretStorage / 系统钥匙串） ───────────────
const LLM_SECRET_KEY = 'markdown2anything.llm.apiKey';
const LLM_PROFILE_SECRET_PREFIX = 'markdown2anything.llm.apiKey.';
const LLM_FREE_MODELS_CACHE_KEY = 'llm.freeModelsCache';
const LLM_FREE_MODELS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 免费模型列表缓存 7 天

function getLlmProfilesData() {
  const cfg = vscode.workspace.getConfiguration('markdown2anything');
  try { return JSON.parse(cfg.get('llm.profiles', '[]')); } catch (_) { return []; }
}

async function getLlmProfileApiKey(profileId) {
  return (await extContext.secrets.get(LLM_PROFILE_SECRET_PREFIX + profileId)) || '';
}

/** key 指纹（仅显示用，不泄露明文）：sk-or…aB3f */
function keyFingerprint(k) {
  if (!k) return '';
  if (k.length <= 8) return '••••' + k.slice(-2);
  return k.slice(0, 4) + '…' + k.slice(-4);
}

/** 从 baseUrl 提取主机名（平台），如 https://openrouter.ai/api/v1 → openrouter.ai */
function llmHostOf(url) {
  const s = String(url || '').replace(/^[a-z]+:\/\//i, '').split('/')[0];
  return s || '';
}

/** 每个平台最近一次的发布 job 文件，用于「从断点继续发布」 */
const lastJobFile = { xiaohongshu: null, twitter: null, zhihu: null };

/** 每个平台当前活着的 worker 子进程（worker 会常驻以保持浏览器打开） */
const lastChild = { xiaohongshu: null, twitter: null, zhihu: null };

/** 杀掉上一个 worker（连带关掉它开的浏览器），避免开出一堆窗口 */
function killWorker(platform) {
  const c = lastChild[platform];
  if (c && !c.killed) { try { c.kill('SIGTERM'); } catch (_) {} }
  lastChild[platform] = null;
}

/** 完整配置（含明文 key）——仅供 host 侧发请求用，绝不发给 webview */
async function getLlmConfig() {
  const cfg = vscode.workspace.getConfiguration('markdown2anything');
  const activeId = cfg.get('llm.activeProfile', '');
  if (activeId) {
    const profile = getLlmProfilesData().find(p => p.id === activeId);
    if (profile) {
      return { baseUrl: profile.baseUrl, model: profile.model, apiKey: await getLlmProfileApiKey(activeId) };
    }
  }
  return {
    baseUrl: cfg.get('llm.baseUrl', ''),
    model:   cfg.get('llm.model', ''),
    apiKey:  (await extContext.secrets.get(LLM_SECRET_KEY)) || '',
  };
}

/** 给 webview 看的版本：包含配置列表（不含 key 本身） */
async function getLlmConfigForView() {
  const cfg = vscode.workspace.getConfiguration('markdown2anything');
  const activeId = cfg.get('llm.activeProfile', '');
  const rawProfiles = getLlmProfilesData();
  const profiles = [];
  for (const p of rawProfiles) {
    const apiKey = await getLlmProfileApiKey(p.id);
    profiles.push({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model,
                    hasKey: !!apiKey, keyHint: keyFingerprint(apiKey), keyOptional: llm.isLocalEndpoint(p.baseUrl) });
  }
  // 历史遗留扁平配置（旧版 llm.baseUrl/llm.model/apiKey）：也显示成一张可删除的卡片，
  // 避免它「隐身」却在无激活 profile 时被默认读取
  const legacyBase = cfg.get('llm.baseUrl', '');
  const legacyKey  = await extContext.secrets.get(LLM_SECRET_KEY);
  const legacyOverlaps = rawProfiles.some(p => p.baseUrl === legacyBase && p.model === cfg.get('llm.model', ''));
  if (legacyBase && !legacyOverlaps) {
    profiles.push({ id: '__legacy__', name: '历史遗留配置', baseUrl: legacyBase, model: cfg.get('llm.model', ''),
                    hasKey: !!legacyKey, keyHint: keyFingerprint(legacyKey), keyOptional: llm.isLocalEndpoint(legacyBase), legacy: true });
  }
  const active = profiles.find(p => p.id === activeId);
  let baseUrl, model, hasKey;
  if (active) {
    ({ baseUrl, model, hasKey } = active);
  } else {
    baseUrl = legacyBase;
    model   = cfg.get('llm.model', '');
    hasKey  = !!legacyKey;
  }
  return { baseUrl, model, hasKey, keyOptional: llm.isLocalEndpoint(baseUrl), profiles, activeProfile: activeId };
}

/**
 * 拉取 OpenRouter 当前可用的免费模型列表（官方 /api/v1/models，无需鉴权）。
 * 只返回带 :free 后缀、且免费定价（prompt/completion 均为 0）的模型。
 * 结果缓存到 globalState，7 天内不重复拉取；force=true 时强制刷新。
 * @param {boolean} [force]
 * @returns {Promise<Array<{id:string, name:string, context_length:number}>>}
 */
function fetchOpenRouterFreeModels(force) {
  // 缓存命中（且非强制刷新）→ 直接返回
  let cached;
  try { cached = extContext.globalState.get(LLM_FREE_MODELS_CACHE_KEY); } catch (_) { cached = undefined; }
  if (!force && cached && cached.fetchedAt &&
      (Date.now() - cached.fetchedAt) < LLM_FREE_MODELS_TTL_MS &&
      Array.isArray(cached.models) && cached.models.length) {
    return Promise.resolve(cached.models);
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/models',
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'markdown2anything-vscode' },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(text).data || [];
          const free = data
            .filter(m => /:free$/.test(m.id) || (m.pricing && m.pricing.prompt === '0'))
            .map(m => ({
              id: m.id,
              name: m.name || m.id,
              context_length: m.context_length || 0,
            }));
          // 拉取成功 → 写缓存
          try { extContext.globalState.update(LLM_FREE_MODELS_CACHE_KEY, { fetchedAt: Date.now(), models: free }); } catch (_) {}
          resolve(free);
        } catch (e) { reject(new Error('解析 OpenRouter 模型列表失败')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('拉取免费模型列表超时（请检查网络）')); });
    req.end();
  });
}

/** 上次成功拉取免费模型的时间戳（用于 UI 显示「缓存于 X 分钟前」） */
function llmFreeModelsFetchedAt() {
  try {
    const c = extContext.globalState.get(LLM_FREE_MODELS_CACHE_KEY);
    return c && c.fetchedAt ? c.fetchedAt : 0;
  } catch (_) { return 0; }
}

// ─── 文案持久化：存到文章同目录，切换/重开不用重新生成，也便于随文章一起备份 ───
/** <mdDir>/<base>_social.json */
function socialCopyPath(mdPath) {
  const base = path.basename(mdPath, path.extname(mdPath));
  return path.join(path.dirname(mdPath), `${base}_social.json`);
}

const PLATFORMS_LIST = ['xiaohongshu', 'twitter'];

/**
 * 读取并规范化文案库。结构：
 * {
 *   link, updatedAt,
 *   xiaohongshu: { current: 0, versions: [ { id, at, source, content } ] },
 *   twitter:     { current: 0, versions: [...] }
 * }
 * 兼容旧格式（platform 直接是 content 对象）——自动迁移成 versions[0]。
 */
function loadSocialStore(mdPath) {
  let raw = {};
  try {
    const p = socialCopyPath(mdPath);
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) { raw = {}; }

  const store = { link: raw.link || '', updatedAt: raw.updatedAt || '' };
  for (const pf of PLATFORMS_LIST) {
    const v = raw[pf];
    if (v && Array.isArray(v.versions)) {
      store[pf] = { current: Math.min(v.current || 0, v.versions.length - 1), versions: v.versions };
    } else if (v && (v.body || v.tweets || v.title)) {
      // 旧格式迁移
      store[pf] = { current: 0, versions: [{ id: 1, at: raw.updatedAt || '', source: 'legacy', content: v }] };
    } else {
      store[pf] = { current: -1, versions: [] };
    }
  }
  return store;
}

function saveSocialStore(mdPath, store) {
  try {
    const p = socialCopyPath(mdPath);
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(store, null, 2) + '\n', 'utf8');
    return p;
  } catch (e) {
    log(`保存文案失败: ${e.message}`);
    return null;
  }
}

// ─── 封面底图历史 & 标题状态（存在 globalStorage） ───────────────
function getCoverStoreDir() {
  try { return path.join(extContext.globalStorageUri.fsPath, 'cover'); } catch(_) { return path.join(os.tmpdir(), 'm2a_cover_store'); }
}
function ensureCoverStoreDir() {
  const d = getCoverStoreDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  const bgDir = path.join(d, 'bgs');
  if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });
  return d;
}
function getCoverConfigPath() { return path.join(getCoverStoreDir(), 'config.json'); }
function loadCoverConfig() {
  try {
    const p = getCoverConfigPath();
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { defaultBgId: j.defaultBgId || null, titleState: j.titleState || null, bgs: Array.isArray(j.bgs) ? j.bgs : [] };
    }
  } catch(_) {}
  return { defaultBgId: null, titleState: null, bgs: [] };
}
function saveCoverConfig(cfg) {
  try {
    ensureCoverStoreDir();
    fs.writeFileSync(getCoverConfigPath(), JSON.stringify({ defaultBgId: cfg.defaultBgId||null, titleState: cfg.titleState||null, bgs: cfg.bgs||[] }, null, 2)+'\n','utf8');
  } catch(e){ log('保存封面配置失败: '+e.message); }
}
function coverBgFilePath(id, ext='png') { return path.join(getCoverStoreDir(), 'bgs', `${id}.${ext}`); }
function coverSaveBgFromDataUrl(dataUrl, nameHint) {
  ensureCoverStoreDir();
  const m = String(dataUrl).match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) throw new Error('无效的图片 dataUrl');
  const ext = (m[1]==='jpeg'?'jpg':m[1]);
  const b64 = m[2];
  const id = Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6);
  const fp = coverBgFilePath(id, ext);
  fs.writeFileSync(fp, Buffer.from(b64,'base64'));
  const cfg = loadCoverConfig();
  const item = { id, ext, name: (nameHint||'').slice(0,40) || `bg_${id}`, createdAt: new Date().toISOString(), path: fp };
  cfg.bgs.unshift(item);
  // 超过 20 张自动只保留最新 20
  if (cfg.bgs.length>20) {
    const old = cfg.bgs.splice(20);
    for(const o of old) try{ fs.unlinkSync(o.path);}catch(_){}
  }
  cfg.defaultBgId = id;
  saveCoverConfig(cfg);
  return { item, cfg };
}
function coverGetBgDataUrl(item) {
  try {
    if (!item || !fs.existsSync(item.path)) return null;
    const ext = item.ext||'png';
    const mime = ext==='jpg'?'image/jpeg':`image/${ext}`;
    const b64 = fs.readFileSync(item.path).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch(_){ return null; }
}

/** 新增一个版本（旧版本保留，可回切），返回新版本下标 */
function addSocialVersion(mdPath, platform, content, source, link) {
  const store = loadSocialStore(mdPath);
  const list = store[platform].versions;
  const nextId = list.length ? Math.max(...list.map(v => v.id || 0)) + 1 : 1;
  list.push({ id: nextId, at: new Date().toISOString(), source: source || 'llm', content });
  store[platform].current = list.length - 1;
  if (link !== undefined && link) store.link = link;
  saveSocialStore(mdPath, store);
  return store;
}

/** 覆盖当前版本（手动编辑后保存） */
function updateCurrentVersion(mdPath, platform, content, link) {
  const store = loadSocialStore(mdPath);
  const p = store[platform];
  if (p.current < 0 || !p.versions.length) return addSocialVersion(mdPath, platform, content, 'manual', link);
  p.versions[p.current].content = content;
  p.versions[p.current].at = new Date().toISOString();
  if (link !== undefined && link) store.link = link;
  saveSocialStore(mdPath, store);
  return store;
}

/** 面板需要的版本元信息（不含正文，只给导航用） */
function versionMeta(store, platform) {
  const p = store[platform];
  return {
    current: p.current,
    total: p.versions.length,
    list: p.versions.map(v => ({ id: v.id, at: v.at, source: v.source })),
  };
}

function currentContent(store, platform) {
  const p = store[platform];
  return (p.current >= 0 && p.versions[p.current]) ? p.versions[p.current].content : null;
}

// ─── PPT 改写版本管理 ─────────────────────────────────────────
// 结构与 socialStore 完全一致，key 是 backend 名（slidev/marp/pandoc）
// 存储文件：<base>_ppt.json

function pptStorePath(mdPath) {
  const base = path.basename(mdPath, path.extname(mdPath));
  return path.join(path.dirname(mdPath), `${base}_ppt.json`);
}

const PPT_BACKENDS = ['slidev', 'marp', 'pandoc'];

function loadPptStore(mdPath) {
  let raw = {};
  try {
    const p = pptStorePath(mdPath);
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) { raw = {}; }

  const store = { updatedAt: raw.updatedAt || '' };
  for (const be of PPT_BACKENDS) {
    const v = raw[be];
    if (v && Array.isArray(v.versions)) {
      store[be] = { current: Math.min(v.current || 0, v.versions.length - 1), versions: v.versions };
    } else {
      store[be] = { current: -1, versions: [] };
    }
  }
  return store;
}

function savePptStore(mdPath, store) {
  try {
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(pptStorePath(mdPath), JSON.stringify(store, null, 2) + '\n', 'utf8');
  } catch (e) { log(`保存 PPT 改写版本失败: ${e.message}`); }
}

function addPptVersion(mdPath, backend, markdown, instruction) {
  const store = loadPptStore(mdPath);
  const list = store[backend].versions;
  const nextId = list.length ? Math.max(...list.map(v => v.id || 0)) + 1 : 1;
  list.push({ id: nextId, at: new Date().toISOString(), instruction: (instruction || '').slice(0, 80), markdown });
  store[backend].current = list.length - 1;
  savePptStore(mdPath, store);
  return store;
}

function pptVersionMeta(store, backend) {
  const b = store[backend];
  return {
    current: b.current,
    total: b.versions.length,
    list: b.versions.map(v => ({ id: v.id, at: v.at, instruction: v.instruction })),
  };
}

/** 本地算法预填（不调用任何模型） */
function localPrefill(mdPath, platform) {
  try {
    const { rawMarkdown } = renderMarkdown(mdPath);
    return extract.extractCopy({ rawMarkdown, platform: platform === 'twitter' ? 'twitter' : 'xiaohongshu' });
  } catch (_) {
    return { title: '', body: '', tags: [], source: 'local' };
  }
}

// ─── 社交发布辅助 ───────────────────────────────
/** cookie 存储适配器：委托 VS Code globalState，不落磁盘 */
function socialStorage() {
  return {
    get: (k) => extContext.globalState.get(k, ''),
    set: (k, v) => extContext.globalState.update(k, v),
  };
}

/** 读文章元信息：标题 + 全文链接（从 front matter permalink/url/link） */
function readArticleMeta(mdPath) {
  try {
    const raw = fs.readFileSync(mdPath, 'utf8');
    const parsed = matter(raw);
    const fm = parsed.data || {};
    const title = fm.title || (parsed.content.match(/^#\s+(.+)$/m) || [])[1] || path.basename(mdPath, path.extname(mdPath));
    const link = fm.permalink || fm.url || fm.link || '';
    return { title: String(title).trim(), link: String(link).trim() };
  } catch (_) {
    return { title: path.basename(mdPath, path.extname(mdPath)), link: '' };
  }
}

/**
 * 确保长图已存在：有就直接用，没有就先自动导出再用。
 * 发布小红书/Twitter 时调用，用户无需先手动点「一键导出全部」。
 */
async function ensureXhsImages(mdPath, panel, platform) {
  const existing = listExportedXhsImages(mdPath);
  if (existing.length) return existing;

  const notify = (m) => panel.webview.postMessage({ type: 'socialPublishProgress', platform, message: m });
  notify('未检测到长图，正在自动导出…');

  const images = await exportXhsImages(mdPath, panel, platform);
  if (!images.length) throw new Error('长图自动导出失败');
  notify(`已自动导出 ${images.length} 张长图`);
  return images;
}

/** 跑截图脚本，把文章渲染成长图存到 <base>_xhs/，返回图片路径 */
function exportXhsImages(mdPath, panel, platform, retried = false, exportMode) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const os = require('os');

    const cfg = vscode.workspace.getConfiguration('markdown2anything');
    const mode = exportMode || cfg.get('xhs.exportMode', 'classic');
    const useThemeAccent = cfg.get('xhs.adaptiveUseTheme', true);
    const { bodyHtml } = renderMarkdown(mdPath);
    const theme = getTheme(currentThemeId);
    const htmlContent = buildXhsRenderHtmlByMode(bodyHtml, path.dirname(mdPath), theme, mode, mode==='adaptive'?{useThemeAccent}:{ });
    const tmpHtml = path.join(os.tmpdir(), `markdown2anything_xhs_${Date.now()}.html`);
    const base = path.basename(mdPath, path.extname(mdPath));
    const outDir = path.join(path.dirname(mdPath), `${base}_xhs`);
    fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

    const scriptPath = path.join(extContext.extensionUri.fsPath, 'scripts', 'xhs_screenshot.js');
    const proc = spawn(process.execPath, [
      scriptPath, tmpHtml, outDir,
      '--width', '1080', '--height', '1440', '--padding', '40', '--bg', '#ffffff',
    ], { env: NODE_EXEC_ENV });

    let stdout = '';
    proc.stdout.on('data', d => {
      stdout += d.toString();
      for (const line of d.toString().split('\n')) {
        if (line.startsWith('INFO:')) {
          panel.webview.postMessage({ type: 'socialPublishProgress', platform, message: '导出长图：' + line.slice(5) });
        }
      }
    });

    proc.on('close', async (code) => {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}
      if (code === 2 && !retried) {
        panel.webview.postMessage({ type: 'socialPublishProgress', platform, message: '首次使用，正在下载 Chromium…' });
        await installChromium(panel);
        resolve(await exportXhsImages(mdPath, panel, platform, true));
        return;
      }
      if (code !== 0) {
        const err = stdout.split('\n').find(l => l.startsWith('ERROR:')) || '截图失败';
        reject(new Error(err.replace('ERROR:', '').trim()));
        return;
      }
      resolve(listExportedXhsImages(mdPath));
    });
    proc.on('error', reject);
  });
}

/** 把已有的知乎 cookie 字符串转成 Playwright cookie 数组（复用现有扫码登录，不用重登） */
function zhihuBrowserCookies() {
  const str = extContext.globalState.get(zhihu.STORAGE_KEY, '') || '';
  return str.split(/;\s*/).map(p => {
    const i = p.indexOf('=');
    if (i <= 0) return null;
    return {
      name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(),
      domain: '.zhihu.com', path: '/', expires: -1,
      httpOnly: false, secure: true, sameSite: 'Lax',
    };
  }).filter(c => c && c.name && c.value);
}

/** 按 markdown 里出现的顺序列出所有【本地】图片的绝对路径（知乎发布要拿文件去喂上传控件） */
function listMarkdownLocalImages(mdPath) {
  try {
    const raw = fs.readFileSync(mdPath, 'utf8');
    const dir = path.dirname(mdPath);
    const out = [];
    const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const src = m[1];
      if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:')) continue;  // 远程图跳过
      const abs = path.isAbsolute(src) ? src : path.resolve(dir, src);
      if (fs.existsSync(abs)) out.push(abs);
    }
    return out;
  } catch (_) { return []; }
}

/**
 * 列出已导出的长图（<base>_xhs/ 下的 png/jpg），发布时作为配图。
 *
 * 两个坑（都踩过）：
 *  1. 目录里可能同时存在两套命名（脚本写的 xhs_01.png 和面板导出的 xiaohongshu-01.png），
 *     直接全取会把同一篇文章的图【重复上传两套】，看起来就是"顺序乱了"。→ 只取其中一套（最新的那套）。
 *  2. 字典序排序在两位数以上会错（10 排到 2 前面）。→ 按数字自然排序。
 */
function listExportedXhsImages(mdPath) {
  try {
    const base = path.basename(mdPath, path.extname(mdPath));
    const dir = path.join(path.dirname(mdPath), `${base}_xhs`);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g)$/i.test(f));
    if (!files.length) return [];

    // 按「前缀」分组（去掉结尾数字），例如 xhs_ / xiaohongshu-
    const families = new Map();
    for (const f of files) {
      const key = f.replace(/\d+(\.\w+)$/, '$1').replace(/\.\w+$/, '');
      if (!families.has(key)) families.set(key, []);
      families.get(key).push(f);
    }

    // 多套并存时只取【最新那套】（按该组最新的 mtime）
    let chosen = null, chosenTime = -1;
    for (const [, group] of families) {
      const t = Math.max(...group.map(f => {
        try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) { return 0; }
      }));
      if (t > chosenTime) { chosenTime = t; chosen = group; }
    }
    if (!chosen) return [];

    // 按文件名里的数字自然排序（xhs_2 < xhs_10）
    const numOf = (f) => { const m = f.match(/(\d+)(?=\.\w+$)/); return m ? parseInt(m[1], 10) : 0; };
    return chosen
      .sort((a, b) => numOf(a) - numOf(b) || a.localeCompare(b))
      .map(f => path.join(dir, f));
  } catch (_) { return []; }
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

// ─────────────────────────────────────────────
//  PPT 导出（双 backend：Slidev 美观截图 / Pandoc 可编辑）
// ─────────────────────────────────────────────

// 当前 PPT 子进程引用，用于取消
let currentPptProc = null;
let currentPptAbort = null; // AbortController for LLM

async function handleExportPpt(msg, panel, mdPath) {
  const { execFile } = require('child_process');
  const os   = require('os');
  const notify = (step, total, label) =>
    panel.webview.postMessage({ type: 'pptProgress', step, total, label });

  // 杀掉上一次残留
  if (currentPptProc && !currentPptProc.killed) {
    currentPptProc.kill('SIGTERM'); currentPptProc = null;
  }
  if (currentPptAbort) { currentPptAbort.abort(); currentPptAbort = null; }

  const backend  = msg.backend || 'slidev';  // 'slidev' | 'pandoc'
  const mdDir    = path.dirname(mdPath);
  const base     = path.basename(mdPath, path.extname(mdPath));
  const outFile  = path.join(mdDir, `${base}.pptx`);

  try {
    // ── 步骤 1：LLM 改写（可选）──────────────────────────────
    let sourceMdPath = mdPath; // 默认直接用原文件
    if (msg.llmEnabled && msg.llmMd) {
      // webview 已经生成了 Slidev MD 并回传给我们
      const tmpMd = path.join(os.tmpdir(), `m2a_ppt_llm_${Date.now()}.md`);
      fs.writeFileSync(tmpMd, msg.llmMd, 'utf8');
      sourceMdPath = tmpMd;
    }

    if (backend === 'slidev') {
      // ── Slidev backend ─────────────────────────────────────
      const totalSteps = msg.llmEnabled ? 7 : 5;
      notify(msg.llmEnabled ? 3 : 1, totalSteps, '检查 Slidev 安装...');

      const globalStorage = extContext.globalStorageUri.fsPath;
      const slidevDir = slidevManager.getSlidevDir(globalStorage);
      const slidevBin = await slidevManager.getSlidevBin(
        globalStorage,
        (s, t, l) => notify(s, t, l),
      );

      notify(msg.llmEnabled ? 5 : 3, totalSteps, '正在渲染幻灯片...');

      // 构造带 frontmatter 的临时 Slidev 文件
      // 放在 Slidev 安装目录里，这样相对路径图片也能找到
      // （图片路径会在 slidev 里解析，需要保持相对关系）
      const theme      = msg.theme || 'default';
      const rawContent = fs.readFileSync(sourceMdPath, 'utf8');
      // 如果 LLM 已经生成了带 frontmatter 的内容，替换 theme；否则插入
      let slidevContent;
      if (/^---\s*\n/.test(rawContent)) {
        // 有 frontmatter：确保 theme 字段存在
        if (/\ntheme\s*:/.test(rawContent)) {
          slidevContent = rawContent.replace(/(\ntheme\s*:\s*)([^\n]*)/, `$1${theme}`);
        } else {
          slidevContent = rawContent.replace(/^(---\s*\n)/, `$1theme: ${theme}\n`);
        }
      } else {
        slidevContent = `---\ntheme: ${theme}\n---\n\n${rawContent}`;
      }

      // 临时文件放在 md 文件同目录，保持图片相对路径正确
      const tmpSlidev = path.join(mdDir, `.m2a_slidev_tmp_${Date.now()}.md`);
      fs.writeFileSync(tmpSlidev, slidevContent, 'utf8');

      // 用 AbortController 支持取消
      const abortCtrl = new AbortController();
      currentPptAbort = abortCtrl;

      await slidevManager.exportSlides({
        slidevBin,
        slidesPath: tmpSlidev,
        outFile,
        format: 'pptx',
        signal: abortCtrl.signal,
        slidevDir,
        onProgress: (s, t, l) => notify(msg.llmEnabled ? 5 + s : 3 + s, totalSteps, l),
      });

      try { fs.unlinkSync(tmpSlidev); } catch (_) {}

    } else if (backend === 'marp') {
      // ── Marp backend ───────────────────────────────────────
      const { spawn } = require('child_process');
      const marpTheme = msg.marpTheme || 'default';
      const rawContent = fs.readFileSync(sourceMdPath, 'utf8');
      // 注入 Marp frontmatter
      let marpContent;
      if (/^---\n/.test(rawContent)) {
        marpContent = rawContent.replace(/^---\n/, `---\nmarp: true\ntheme: ${marpTheme}\npaginate: true\n`);
      } else {
        marpContent = `---\nmarp: true\ntheme: ${marpTheme}\npaginate: true\n---\n\n${rawContent}`;
      }
      const tmpMarp = path.join(os.tmpdir(), `m2a_marp_${Date.now()}.md`);
      fs.writeFileSync(tmpMarp, marpContent, 'utf8');

      notify(2, 4, '正在渲染（Marp npx）...');
      await new Promise((resolve, reject) => {
        const proc = spawn('npx', [
          '--yes', '@marp-team/marp-cli',
          tmpMarp, '--pptx', '--no-stdin', '--allow-local-files',
          '-o', outFile,
        ], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        currentPptProc = proc;
        let buf = '';
        const onData = (d) => {
          buf += d.toString();
          const lines = buf.split('\n'); buf = lines.pop();
          for (const l of lines) {
            const t = l.trim().replace(/^\[\s*INFO\s*\]\s*/i, '');
            if (t && !/stdin stream/i.test(t)) notify(3, 4, t.slice(0, 80));
          }
        };
        proc.stdout.on('data', onData); proc.stderr.on('data', onData);
        proc.on('close', (code) => {
          currentPptProc = null;
          try { fs.unlinkSync(tmpMarp); } catch (_) {}
          if (code !== 0 && code !== null) reject(new Error(`Marp 退出码 ${code}`));
          else resolve();
        });
        proc.on('error', reject);
      });

    } else {
      // ── Pandoc backend ─────────────────────────────────────
      notify(1, 5, '检查 pandoc...');
      const pandocPath = await pandocManager.getPandocPath(
        extContext.globalStorageUri.fsPath,
        notify,
      );

      notify(3, 5, '正在生成可编辑 PPTX...');
      const themesDir = path.join(extContext.extensionUri.fsPath, 'ppt-themes');
      const themeFile = msg.pandocTheme ? path.join(themesDir, `${msg.pandocTheme}.pptx`) : null;
      const slideLevel = msg.split === 'h2' ? '2' : '1';

      const args = [
        sourceMdPath, '-o', outFile,
        '--slide-level', slideLevel,
        `--resource-path=${mdDir}`,
        '--embed-resources',
      ];
      if (themeFile && fs.existsSync(themeFile)) args.push(`--reference-doc=${themeFile}`);

      await new Promise((resolve, reject) => {
        const proc = execFile(pandocPath, args, { cwd: mdDir }, (err, _out, stderr) => {
          currentPptProc = null;
          if (err && err.code !== 0) reject(new Error((stderr || err.message).slice(0, 400)));
          else resolve();
        });
        currentPptProc = proc;
      });
    }

    // 清理 LLM 临时文件
    if (msg.llmEnabled && msg.llmMd && sourceMdPath !== mdPath) {
      try { fs.unlinkSync(sourceMdPath); } catch (_) {}
    }

    notify(99, 100, '生成完成！');
    log(`PPT 导出成功: ${outFile}`);
    panel.webview.postMessage({ type: 'pptResult', success: true, filename: path.basename(outFile) });
    const action = await vscode.window.showInformationMessage(
      `✅ PPTX 已生成：${outFile}`, '打开文件', '打开目录',
    );
    if (action === '打开文件') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outFile));
    else if (action === '打开目录') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outFile));
  } catch (err) {
    log(`PPT 导出失败: ${err.message}`);
    panel.webview.postMessage({ type: 'pptResult', success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────
//  Word 导出（pandoc）
// ─────────────────────────────────────────────

async function handleExportWord(msg, panel, mdPath) {
  const { execFile } = require('child_process');
  const notify = (m) => panel.webview.postMessage({ type: 'wordProgress', message: m });

  try {
    // 用 pandoc-manager 统一查找/下载 pandoc
    notify('⏳ 检测 pandoc...');
    const pandocPath = await pandocManager.getPandocPath(
      extContext.globalStorageUri.fsPath,
      (step, total, label) => notify(`⏳ [${step}/${total}] ${label}`),
    );

    const base    = path.basename(mdPath, path.extname(mdPath));
    const outFile = path.join(path.dirname(mdPath), `${base}.docx`);

    notify('⏳ 正在生成 Word...');

    // 构建 pandoc 参数
    const mathFlag = msg.mathFmt === 'mathml' ? '--mathml'
      : msg.mathFmt === 'latex' ? '--lua-filter=/dev/null'
      : ''; // docx 默认走 OMML
    const hlFlag = msg.hlStyle && msg.hlStyle !== 'none'
      ? `--highlight-style=${msg.hlStyle}`
      : '--no-highlight';

    const mdDir = path.dirname(mdPath);
    const args = [
      mdPath,
      '-o', outFile,
      '--wrap=none',
      `--resource-path=${mdDir}`,
      '--embed-resources',
      hlFlag,
    ];
    if (mathFlag) args.push(mathFlag);

    await new Promise((resolve, reject) => {
      execFile(pandocPath, args, { cwd: mdDir }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });

    log(`Word 导出成功: ${outFile}`);
    panel.webview.postMessage({ type: 'wordResult', success: true, filename: path.basename(outFile) });
    const action = await vscode.window.showInformationMessage(
      `✅ Word 已生成：${outFile}`, '打开文件', '打开目录',
    );
    if (action === '打开文件') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outFile));
    else if (action === '打开目录') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outFile));
  } catch (err) {
    log(`Word 导出失败: ${err.message}`);
    panel.webview.postMessage({ type: 'wordResult', success: false, error: err.message });
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

/**
 * 生成「文案 + 一键发布」区块 HTML（小红书 / Twitter 共用）
 * @param {string} platform  'xiaohongshu' | 'twitter'
 * @param {string} prefix    元素 id 前缀，如 'xhs-social'
 * @param {string} name      平台显示名
 * @param {number} titleLimit 标题字数上限（0 = 不限制/不显示计数）
 * @param {string} extraHint  区块底部提示
 */
function socialBlockHtml(platform, prefix, name, titleLimit, extraHint) {
  const isThread = platform === 'twitter';
  const publishBtnClass = isThread ? 'btn btn-twitter' : 'btn btn-xhs';

  // 内容区：Twitter 用串推卡片列表；小红书用单条 标题/正文/标签
  const contentRows = isThread
    ? '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">'
      + '<label style="margin:0;">推文串（每条 ≤280 字）</label>'
      + '<label style="font-weight:normal;cursor:pointer;font-size:12px;">'
      + '<input type="checkbox" id="' + prefix + '-autonum" checked> 自动编号 1/N'
      + '</label></div>'
      + '<label style="margin-top:10px;">标签（整串共用，分号 <code>;</code> 分隔）</label>'
      + '<input type="text" id="' + prefix + '-tags" placeholder="例：Gemma4; 端侧AI" style="width:100%;box-sizing:border-box;">'
      + '<label style="margin-top:10px;">全文链接位置</label>'
      + '<select id="' + prefix + '-linkpos" style="width:100%;box-sizing:border-box;padding:6px 8px;background:#2d2d2d;color:#eee;border:1px solid #444;border-radius:4px;">'
      + '<option value="all" selected>每条都放（推荐，谁都看得到）</option>'
      + '<option value="first">只放第 1 条（曝光最高）</option>'
      + '<option value="last">只放最后一条</option>'
      + '</select>'
      + '<div id="' + prefix + '-thread"></div>'
      + '<button class="btn btn-secondary" id="' + prefix + '-addtweet" style="margin-top:8px;padding:4px 10px;">＋ 添加一条</button>'
      + '<p class="hint" style="margin-top:6px;">📎 一条一图：第 N 条自动配第 N 张长图，最后的总结条不配图。所有帖子都会自动带上 <b>#marsggbo</b>。</p>'
    : '<label style="margin-top:10px;">标题 * <span id="' + prefix + '-titlecount" style="color:#888;font-weight:normal;">0/' + titleLimit + '</span></label>'
      + '<input type="text" id="' + prefix + '-title" maxlength="' + (titleLimit * 2) + '" style="width:100%;box-sizing:border-box;">'
      + '<label style="margin-top:10px;">正文 *</label>'
      + '<textarea id="' + prefix + '-body" rows="6" style="width:100%;box-sizing:border-box;font-family:inherit;"></textarea>'
      + '<label style="margin-top:10px;">标签</label>'
      + '<input type="text" id="' + prefix + '-tags" placeholder="例：LLM; 多模态; 端侧推理（分号分隔，不用带 #）" style="width:100%;box-sizing:border-box;">';

  return `
        <div class="social-block" data-platform="${platform}" data-prefix="${prefix}" data-title-limit="${titleLimit}">

          <!-- ✍ 文案区块 -->
          <div class="section-block">
            <div class="section-block-title">✍ 文案</div>

            <!-- AI / 手动 + LLM 状态 -->
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <div style="display:flex;gap:14px;">
                <label style="cursor:pointer;margin:0;"><input type="radio" name="${prefix}-mode" value="ai" checked> ✨ AI</label>
                <label style="cursor:pointer;margin:0;"><input type="radio" name="${prefix}-mode" value="manual"> ✍️ 手动</label>
              </div>
              <span id="${prefix}-llmstate" style="font-size:11px;color:#ffb020;">⚠️ 未配置</span>
            </div>

            <!-- AI 生成区 -->
            <div id="${prefix}-ai">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <button class="btn btn-secondary" id="${prefix}-gen" style="flex:1;">✨ AI 生成</button>
                <button class="btn-ghost" id="${prefix}-prompttoggle">指令 ▾</button>
                <button class="btn btn-secondary" id="${prefix}-reprompt" title="恢复默认指令" style="padding:4px 8px;">↺</button>
              </div>
              <textarea id="${prefix}-prompt" rows="3" style="display:none;width:100%;box-sizing:border-box;font-family:inherit;margin-bottom:6px;"></textarea>
            </div>

            <!-- 版本管理 -->
            <div id="${prefix}-verbar" style="display:none;align-items:center;gap:6px;margin-bottom:8px;
                 border:1px solid #333;border-radius:4px;padding:5px 8px;">
              <button class="btn btn-secondary" id="${prefix}-verprev" style="padding:2px 8px;" title="上一版">◀</button>
              <span id="${prefix}-verlabel" style="flex:1;text-align:center;font-size:12px;color:#aaa;"></span>
              <button class="btn btn-secondary" id="${prefix}-vernext" style="padding:2px 8px;" title="下一版">▶</button>
              <button class="btn btn-secondary" id="${prefix}-verdel" style="padding:2px 8px;color:#ff6b6b;" title="删除当前这一版">🗑</button>
            </div>

            <!-- 内容字段 -->
            ${contentRows}
            <label style="margin-top:10px;">全文链接</label>
            <input type="text" id="${prefix}-link" placeholder="留空则用 front matter 里的 permalink/url" style="width:100%;box-sizing:border-box;">

            <!-- 文案操作（折叠） -->
            <details class="section-details">
              <summary>⋯ 更多操作 <span class="toggle-arrow">▶</span></summary>
              <div class="section-details-body">
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button class="btn btn-secondary" id="${prefix}-local" title="用本地算法重新提取，不调用模型">↺ 本地提取</button>
                  <button class="btn btn-secondary" id="${prefix}-savecopy" title="保存到 _social.json">💾 保存</button>
                  <button class="btn btn-secondary" id="${prefix}-copytext">📋 复制</button>
                </div>
              </div>
            </details>

            <!-- AI/发布进度（统一放在文案区，贴近操作） -->
            <div class="social-progress" id="${prefix}-progress" style="margin-top:8px;color:#4ea1ff;font-size:12px;white-space:pre-wrap;overflow-y:auto;max-height:160px;"></div>
          </div>

          <!-- 🚀 账号 & 发布区块 -->
          <div class="section-block">
            <div class="section-block-title">🚀 账号 &amp; 发布</div>

            <!-- 登录状态 + 按钮 -->
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
              <span class="social-status" id="${prefix}-status" title="Cookie 登录状态与有效期">● 未登录</span>
              <button class="btn btn-secondary" id="${prefix}-login" style="padding:4px 10px;">登录${name}</button>
              <button class="btn btn-secondary" id="${prefix}-logout" style="padding:4px 8px;display:none;">退出</button>
            </div>
            <p class="hint" id="${prefix}-cookiehint" style="display:none;margin-bottom:10px;"></p>

            <!-- 发布按钮 -->
            <button class="${publishBtnClass}" id="${prefix}-publish" style="width:100%;margin-top:8px;padding:10px;font-size:14px;" title="注入 Cookie 打开真实浏览器，自动传图+填文">🚀 发布${name}</button>
            <p class="hint" style="margin-top:6px;">${extraHint}</p>

            <!-- 发布进度条 -->
            <div id="${prefix}-steps" style="display:none;margin-top:8px;">
              <div style="display:flex;justify-content:space-between;font-size:12px;color:#aaa;">
                <span id="${prefix}-steplabel">准备中</span><span id="${prefix}-stepnum"></span>
              </div>
              <div style="background:#3a3a3a;border-radius:3px;height:6px;margin-top:3px;overflow:hidden;">
                <div id="${prefix}-stepbar" style="background:#4ea1ff;height:100%;width:0%;transition:width .3s;"></div>
              </div>
            </div>
            <div style="margin-top:6px;">
              <button class="btn btn-secondary" id="${prefix}-resume" style="display:none;width:100%;">▶️ 从断点继续</button>
            </div>

            <!-- Cookie 粘贴（折叠） -->
            <details class="section-details">
              <summary>🔑 手动 Cookie <span class="toggle-arrow">▶</span></summary>
              <div class="section-details-body">
                <button class="btn-ghost btn-ghost-blue" id="${prefix}-openlogin" style="display:block;margin-bottom:8px;">🔗 打开${name}登录页</button>
                <label style="margin-top:0;">粘贴 Cookie</label>
                <textarea id="${prefix}-pasteinput" rows="3" placeholder="name=value; name2=value2（或 JSON 数组）" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:11px;"></textarea>
                <button class="btn btn-secondary" id="${prefix}-pastesave" style="margin-top:6px;padding:4px 10px;">保存 Cookie</button>
              </div>
            </details>
            <div style="margin-top:8px;">
              <button class="btn btn-secondary" id="${prefix}-closebrowser" title="关掉此平台的浏览器窗口" style="font-size:11px;padding:3px 8px;">🗙 关闭浏览器</button>
            </div>
          </div>
        </div>`;
}

function getWebviewHtml(webview, _bodyHtml, mdPath) {
  const nonce = getNonce();
  const csp = webview.cspSource;
  const xhsExportMode = vscode.workspace.getConfiguration('markdown2anything').get('xhs.exportMode', 'classic');
  const xhsAdaptiveUseTheme = vscode.workspace.getConfiguration('markdown2anything').get('xhs.adaptiveUseTheme', true);
  // 当前运行中的扩展版本（显示在工具栏，便于排查旧版本/缓存问题）
  const extVersion = (() => {
    try { return require('./package.json').version; } catch (_) { return ''; }
  })();

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

    // 读取静态面板模板（webview/panel.html），替换运行时占位符
  // 模板由 scripts/gen-panel.js 生成，与旧内联模板逐字节等价（见 test/compare_html.test.js）
  let html = fs.readFileSync(path.join(extContext.extensionUri.fsPath, 'webview', 'panel.html'), 'utf8');
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

module.exports = { activate, deactivate };
