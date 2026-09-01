'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const { renderMarkdown, buildFullHtml, buildWechatCopyHtml, buildZhihuCopyHtml, buildXhsCopyHtml, convertMarkdownToWeChat, buildXhsRenderHtmlByMode } = require('./lib/converter');
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

        const proc = spawn(process.execPath, args);
        let stdout='';
        proc.stdout.on('data', d=>{ stdout+=d.toString(); const l=d.toString().trim(); if(l.startsWith('INFO:')) panel.webview.postMessage({type:'coverProgress', message:l.slice(5)}); });
        proc.stderr.on('data', d=>{ stdout+=d.toString(); });
        proc.on('close', async (code)=>{
          try{ if(bgPath && bgPath.includes(os.tmpdir()) && fs.existsSync(bgPath)) fs.unlinkSync(bgPath);}catch(_){}
          if (code===2) {
            panel.webview.postMessage({type:'coverProgress', message:'📥 首次使用，正在下载 Chromium...'});
            await installChromium(panel);
            const proc2=spawn(process.execPath, args);
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
        const profileId = (msg.profileId || '').trim();
        if (profileId) {
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
            // 未填 key 且本配置还没有 key：自动复用同 baseUrl（同端点）已有配置的 key，
            // 这样换 model / 新建同端点配置无需重复填 key
            const src = profiles.find(p => p.id !== profileId && p.baseUrl === baseUrl && p.id);
            if (src) {
              const inherit = await getLlmProfileApiKey(src.id);
              if (inherit) await extContext.secrets.store(sk, inherit);
            }
          }
        } else {
          // 兼容旧版（无 profileId）
          if (typeof msg.baseUrl === 'string') await cfg.update('llm.baseUrl', msg.baseUrl.trim(), vscode.ConfigurationTarget.Global);
          if (typeof msg.model   === 'string') await cfg.update('llm.model',   msg.model.trim(),   vscode.ConfigurationTarget.Global);
          if (typeof msg.apiKey  === 'string') {
            const k = msg.apiKey.trim();
            if (k) await extContext.secrets.store(LLM_SECRET_KEY, k);
            else   await extContext.secrets.delete(LLM_SECRET_KEY);
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
        const res = await llm.testConnection({ config: await getLlmConfig() });
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

    // 拉取 OpenRouter 当前可用的免费模型（带 :free 后缀），用于「免费模型」快捷选择
    case 'llmFetchFreeModels': {
      try {
        const models = await fetchOpenRouterFreeModels();
        panel.webview.postMessage({ type: 'llmFreeModels', models });
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
  const active = profiles.find(p => p.id === activeId);
  let baseUrl, model, hasKey;
  if (active) {
    ({ baseUrl, model, hasKey } = active);
  } else {
    baseUrl = cfg.get('llm.baseUrl', '');
    model   = cfg.get('llm.model', '');
    hasKey  = !!(await extContext.secrets.get(LLM_SECRET_KEY));
  }
  return { baseUrl, model, hasKey, keyOptional: llm.isLocalEndpoint(baseUrl), profiles, activeProfile: activeId };
}

/**
 * 拉取 OpenRouter 当前可用的免费模型列表（官方 /api/v1/models，无需鉴权）。
 * 只返回带 :free 后缀、且免费定价（prompt/completion 均为 0）的模型。
 * @returns {Promise<Array<{id:string, name:string, context_length:number}>>}
 */
function fetchOpenRouterFreeModels() {
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
          resolve(free);
        } catch (e) { reject(new Error('解析 OpenRouter 模型列表失败')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('拉取免费模型列表超时（请检查网络）')); });
    req.end();
  });
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
    ]);

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
      flex-direction: column;
      background: #2c2c2c;
      border-bottom: 1px solid #444;
      flex-shrink: 0;
      /* overflow 必须 visible，否则 position:absolute 的下拉菜单会被裁掉 */
      overflow: visible;
    }
    /* 第一行：标题 */
    .toolbar-title-row {
      padding: 6px 14px 0;
    }
    .toolbar-title {
      font-size: 12px;
      color: #888;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }
    /* 第二行：所有操作按钮，窄窗口自动换行；overflow:visible 确保下拉可显示 */
    .toolbar-btn-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px 7px;
      flex-wrap: wrap;
      overflow: visible;
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
    .btn-primary   { background: #0a9d58; color: #fff; }
    .btn-primary:hover   { background: #098a4d; }
    .btn-secondary { background: #4c4c4c; color: #ddd; }
    .btn-secondary:hover { background: #5a5a5a; }
    .btn-active    { background: #0078d4; color: #fff; }
    .btn-panel-open { filter: brightness(1.15) saturate(1.05); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.32); }
    /* ── 工具栏三区布局：预览控制 / 发布主操作 / 工具 ── */
    .toolbar-zone {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
      background: rgba(255,255,255,0.035);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      padding: 3px 6px;
    }
    .btn-icon { padding: 4px 8px; font-size: 13px; }
    /* 图标按钮悬浮提示（1 秒延迟，JS 控制显隐） */
    .m2a-tip {
      position: fixed;
      z-index: 99999;
      background: #333;
      color: #f0f0f0;
      font-size: 11.5px;
      line-height: 1.4;
      padding: 5px 9px;
      border-radius: 6px;
      border: 1px solid #555;
      box-shadow: 0 3px 10px rgba(0,0,0,.4);
      pointer-events: none;
      max-width: 280px;
      white-space: normal;
      display: none;
    }
    /* 发布主操作区：平台按钮放大加粗，作为主要 CTA */
    .toolbar-zone-publish > .dropdown > .btn,
    .toolbar-zone-publish > .btn {
      font-size: 13.5px;
      padding: 6px 16px;
      font-weight: 600;
    }
    /* 平台按钮统一暗色调（muted brand），图标/文字用品牌色，不再高饱和实底刺眼 */
    .toolbar-zone-publish > .dropdown > .btn,
    .toolbar-zone-publish > .btn {
      background: #1c2026;
      border: 1px solid #3a4048;
      box-shadow: none;
    }
    .toolbar-zone-publish .brand-glyph { font-weight: 800; margin-right: 5px; }
    .toolbar-zone-publish .btn svg,
    .toolbar-zone-publish .btn svg { width: 14px; height: 14px; vertical-align: -2px; margin-right: 5px; }
    .toolbar-zone-publish > .dropdown > #btn-dd-wechat { color: #6fdc9c; border-color: #2e6b47; }
    .toolbar-zone-publish > .dropdown > #btn-dd-wechat:hover { background: #24322c; border-color: #3a8a5c; }
    .toolbar-zone-publish > .dropdown > #btn-dd-zhihu { color: #83b2f6; border-color: #2f5f8f; }
    .toolbar-zone-publish > .dropdown > #btn-dd-zhihu:hover { background: #232c3a; border-color: #3d7bb8; }
    .toolbar-zone-publish > .dropdown > #btn-dd-xhs { color: #ff8fa0; border-color: #8a3040; }
    .toolbar-zone-publish > .dropdown > #btn-dd-xhs:hover { background: #3a2428; border-color: #b84855; }
    .toolbar-zone-publish > #btn-twitter { color: #83c5ee; border-color: #2f5f7a; }
    .toolbar-zone-publish > #btn-twitter:hover { background: #22303c; border-color: #3d7fa8; }
    /* 工具区：次级按钮缩小（图标为主） */
    .toolbar-zone-tools > .dropdown > .btn,
    .toolbar-zone-tools > .btn {
      font-size: 12.5px;
      padding: 4px 10px;
    }
    /* ── LLM 配置卡片 ── */
    .llm-profile-row {
      background: #252525;
      border: 1px solid #363636;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 12px;
      margin-bottom: 6px;
      cursor: pointer;
      transition: border-color .15s, background .15s;
    }
    .llm-profile-row:hover { border-color: #555; }
    .llm-profile-row.llm-profile-active { background: #192819; border-color: #3a6a3a; }
    .llm-profile-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
    .llm-profile-name { font-weight:700; font-size:13px; color:#ddd; }
    .llm-profile-active .llm-profile-name { color:#3ddc84; }
    .llm-profile-badge { font-size:10px; padding:1px 6px; border-radius:10px; background:#2a4a2a; color:#3ddc84; }
    .llm-profile-meta { color:#777; font-size:11px; margin-bottom:6px; line-height:1.5; }
    /* 连接状态徽标 */
    .llm-status { font-size:10px; padding:1px 7px; border-radius:10px; font-weight:600; flex-shrink:0; }
    .llm-status-ok       { background:#1e3a2a; color:#3ddc84; }
    .llm-status-fail     { background:#3a1e24; color:#ff7a7a; }
    .llm-status-testing  { background:#1e2f3a; color:#4ea1ff; }
    .llm-status-untested { background:#333; color:#999; }
    .llm-profile-actions { display:flex; gap:5px; align-items:center; flex-wrap:wrap; }
    .llm-profile-use { font-size:11px; padding:2px 10px; background:#0078d4; color:#fff; border:none; border-radius:4px; cursor:pointer; }
    .llm-profile-use:hover { background:#005fa3; }
    .llm-profile-test { font-size:11px; padding:2px 8px; background:#2d4a2d; color:#7fd97f; border:1px solid #3a6a3a; border-radius:4px; cursor:pointer; }
    .llm-profile-test:hover { background:#3a5c3a; }
    .llm-profile-edit { font-size:11px; padding:2px 8px; background:#3a3a3a; color:#ccc; border:none; border-radius:4px; cursor:pointer; }
    .llm-profile-edit:hover { background:#4a4a4a; }
    .llm-profile-del { font-size:12px; padding:2px 6px; background:none; color:#666; border:none; cursor:pointer; }
    .llm-profile-del:hover { color:#ff6b6b; }
    #global-llm-free-list [data-slug] { transition: background .12s; }
    #global-llm-free-list [data-slug]:hover { background: #333; }
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
    .btn-twitter   { background: #1d9bf0; color: #fff; }
    .btn-twitter:hover   { background: #1a8cd8; }
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
      overflow: auto;
      padding: 0;
      background: #fff;
      /* 不用 flex 布局，zoom-canvas 用 margin:0 auto 居中，
         这样 CSS zoom 放大后 scrollHeight 真实增长，scrollTop 补偿才有效 */
    }
    /* zoom-canvas：直接撑开 scroll 容器，margin auto 水平居中 */
    .zoom-canvas {
      /* 宽度自适应容器，zoom 放大后 scrollWidth 自然增长 */
      width: 100%;
      max-width: 680px;
      margin: 0 auto;
      /* zoom 由 JS 动态设置，默认 1 */
      box-sizing: border-box;
    }
    .article-wrapper {
      width: 100%;
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
    /* ── XHS 参数网格 ── */
    .xhs-param-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .xhs-param-grid > div > label { font-size: 11px !important; color: #999 !important; margin: 0 0 3px !important; }
    .xhs-param-grid > div > input { width: 100%; }
    /* ── 三大功能区块 ── */
    .section-block {
      background: #272727;
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 12px;
    }
    .section-block input[type=text],
    .section-block input[type=number],
    .section-block input[type=password],
    .section-block textarea,
    .section-block select {
      background: #313131;
      border-color: #484848;
    }
    .section-block-title {
      font-size: 10px;
      font-weight: 700;
      color: #666;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      margin: 0 0 12px;
    }
    /* ── 区块内折叠条 ── */
    details.section-details > summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 5px 0;
      font-size: 12px;
      color: #666;
      user-select: none;
    }
    details.section-details > summary::-webkit-details-marker { display: none; }
    details.section-details > summary:hover { color: #999; }
    .section-details-body {
      margin-top: 8px;
      padding-top: 10px;
      border-top: 1px solid #2e2e2e;
    }
    .toggle-arrow {
      font-size: 9px;
      display: inline-block;
      transition: transform .15s;
      flex-shrink: 0;
    }
    details.section-details[open] > summary .toggle-arrow { transform: rotate(90deg); }
    /* ── 小红书面板/封面：跟随主题强调色（--m2a-accent 由 applyTheme 注入） ── */
    .xhs-panel .section-block {
      background: #1e1e1e;
      border: 1px solid #333;
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 12px;
    }
    .xhs-panel .section-block-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 700;
      color: #eee;
      margin: 0 0 12px;
      letter-spacing: 0;
      text-transform: none;
    }
    .xhs-panel .section-block-title::before {
      content: '';
      width: 4px;
      height: 14px;
      border-radius: 2px;
      background: var(--m2a-accent, #ff2442);
      flex-shrink: 0;
    }
    /* 主 CTA「一键导出」：主题色暗化实底（不刺眼） */
    .xhs-panel #btn-xhs-export-all {
      background: var(--m2a-accent-dim, var(--m2a-accent, #ff2442));
      border: 1px solid var(--m2a-accent, #ff2442);
      color: #fff;
      font-weight: 600;
    }
    .xhs-panel #btn-xhs-export-all:hover { filter: brightness(1.15); }
    /* 次级 CTA「生成预览」：主题色描边 */
    .xhs-panel #btn-xhs-python {
      background: transparent;
      border: 1px solid var(--m2a-accent, #ff2442);
      color: var(--m2a-accent, #ff2442);
    }
    .xhs-panel #btn-xhs-python:hover { background: var(--m2a-accent-soft, rgba(255,36,66,.15)); }
    /* 折叠块升级为卡片式 accordion */
    .xhs-panel details.section-details > summary {
      font-size: 12.5px;
      color: #ccc;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 8px 10px;
      background: #242424;
    }
    .xhs-panel details.section-details > summary:hover {
      border-color: var(--m2a-accent, #ff2442);
      color: #fff;
    }
    .xhs-panel details.section-details[open] > summary {
      border-color: var(--m2a-accent, #ff2442);
      color: #fff;
    }
    /* 表单 focus 描边跟随主题色 */
    .xhs-panel input:focus,
    .xhs-panel select:focus,
    .xhs-panel textarea:focus {
      border-color: var(--m2a-accent, #ff2442) !important;
      outline: none;
      box-shadow: 0 0 0 1px var(--m2a-accent, #ff2442);
    }
    .xhs-panel label { color: #bbb; }
    /* 预览图缩略图：圆角卡片感 */
    .xhs-panel #xhs-output img {
      border-radius: 8px;
      border: 1px solid #333;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      margin-bottom: 8px;
    }
    /* ── Ghost 按钮 ── */
    .btn-ghost {
      background: none;
      border: none;
      color: #666;
      font-size: 12px;
      cursor: pointer;
      padding: 0;
      line-height: 1.4;
    }
    .btn-ghost:hover { color: #aaa; }
    .btn-ghost.btn-ghost-blue { color: #4ea1ff; }
    .btn-ghost.btn-ghost-blue:hover { color: #7db8ff; }
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
      background: #161616;
    }
    label {
      display: block;
      font-size: 12px;
      color: #aaa;
      margin-bottom: 4px;
      margin-top: 12px;
    }
    label:first-child { margin-top: 0; }
    input[type=text], input[type=number], input[type=password], textarea {
      width: 100%;
      padding: 7px 10px;
      background: #2d2d2d;
      border: 1px solid #444;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
      box-sizing: border-box;
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
    /* 预览区可自由选中（含图片）：
       <img> 默认可拖拽，鼠标拖过图片会触发「拖动图片」而不是「扩展选区」，
       导致框选一碰到图片就断掉、复制也带不上图。禁用拖拽即可正常框选。 */
    .preview-scroll, .article-wrapper {
      user-select: text;
      -webkit-user-select: text;
      cursor: auto;
    }
    .article-wrapper img {
      outline: none; text-decoration: none; max-width: 100%; display: block; margin: 0 auto;
      -webkit-user-drag: none;      /* 关键：别让拖拽抢走框选 */
      user-select: auto;
      -webkit-user-select: auto;
    }

    /* ── 图片悬浮工具条：复制图片 / 拖出去 ──
       解决"知乎图片上传失败还得手动一张张传"的问题：
       「复制图片」拷的是真正的 PNG 位图（不是 data URL），粘进知乎/公众号会被平台自动上传。 */
    #img-hover-bar {
      position: fixed; display: none; z-index: 9999;
      gap: 6px; align-items: center;
      background: rgba(30,30,30,.94); border: 1px solid #555; border-radius: 6px;
      padding: 4px 6px; box-shadow: 0 2px 10px rgba(0,0,0,.4);
      font-size: 12px; color: #eee;
    }
    #img-hover-bar button, #img-hover-bar .drag-handle {
      background: #3a3a3a; color: #eee; border: none; border-radius: 4px;
      padding: 4px 8px; font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    #img-hover-bar button:hover, #img-hover-bar .drag-handle:hover { background: #4a4a4a; }
    #img-hover-bar .drag-handle { cursor: grab; -webkit-user-drag: element; }
    #img-hover-bar .ok { background: #2d7a3e; }
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
    /* 宽表格滚动容器：内部横向滚动，避免宽表格把整个预览页撑宽
       （renderMarkdown 会把每个 <table> 包进 .table-wrapper）
       默认「横向滚动」模式；工具栏按钮可切换到「完整显示」（body.tables-expanded） */
    .article-wrapper .table-wrapper {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    /* 完整显示模式：宽表格自然展开，预览区出现横向滚动条以看全表（仅影响预览，不改变导出的 HTML） */
    body.tables-expanded .article-wrapper .table-wrapper {
      overflow-x: visible !important;
      overflow-y: visible !important;
      -webkit-overflow-scrolling: auto !important;
    }
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
    .btn-toc { background: #444; color: #eee; padding: 4px 8px; font-size: 13px; }
    .btn-toc:hover { background: #555; }
    .btn-ppt  { background: #7c3aed; color: #fff; }
    .btn-ppt:hover  { background: #6d28d9; }
    .btn-word { background: #1d4ed8; color: #fff; }
    .btn-word:hover { background: #1e40af; }

    /* ── 下拉菜单（平台聚合按钮） ── */
    .dropdown { position: relative; display: inline-flex; flex-shrink: 0; }
    .dropdown-menu {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      background: #2a2a2a;
      border: 1px solid #555;
      border-radius: 6px;
      min-width: 200px;
      z-index: 9000;
      box-shadow: 0 6px 20px rgba(0,0,0,.5);
      overflow: hidden;
    }
    .dropdown-menu.open { display: block; }
    /* 右对齐版（靠右侧按钮） */
    .dropdown-menu.align-right { left: auto; right: 0; }
    .dropdown-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 14px;
      font-size: 13px;
      color: #ddd;
      cursor: pointer;
      white-space: nowrap;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      transition: background 0.12s;
    }
    .dropdown-item:hover { background: #3a3a3a; color: #fff; }
    .dropdown-item .item-icon { font-size: 15px; flex-shrink: 0; }
    .dropdown-item .item-label { font-weight: 500; }
    .dropdown-item .item-desc {
      font-size: 11px; color: #888; margin-top: 2px;
      white-space: normal; line-height: 1.3;
    }
    .dropdown-item-content { display: flex; flex-direction: column; }
    .dropdown-divider { height: 1px; background: #3a3a3a; margin: 4px 0; }
    .dropdown-section-label {
      padding: 6px 14px 3px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #666;
      pointer-events: none;
    }
    /* 触发按钮带小三角 */
    .dropdown-trigger::after {
      content: '▾';
      margin-left: 4px;
      font-size: 10px;
      opacity: 0.7;
    }
    /* 工具栏分隔线 */
    .toolbar-sep {
      width: 1px;
      height: 20px;
      background: #444;
      flex-shrink: 0;
      margin: 0 2px;
    }
  </style>
</head>
<body>

  <!-- 工具栏 -->
  <div class="toolbar">
    <!-- 第一行：文档标题 -->
    <div class="toolbar-title-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <span class="toolbar-title" id="doc-title">Markdown2Anything 预览</span>
      <span id="ext-version" title="当前运行的扩展版本" style="font-size:10px;color:#888;flex-shrink:0;">v${extVersion}</span>
    </div>

    <!-- 第二行：三区布局（预览控制 / 发布主操作 / 工具） -->
    <div class="toolbar-btn-row">

      <!-- 区① 预览控制（紧凑图标按钮） -->
      <div class="toolbar-zone toolbar-zone-preview">
        <select id="theme-select" title="切换主题" style="
          padding:4px 6px; border:none; border-radius:4px; cursor:pointer;
          font-size:12.5px; background:#3a3a3a; color:#eee; outline:none; flex-shrink:0;
        ">
          <option value="">主题</option>
        </select>
        <button class="btn btn-toc" id="btn-toc" data-tip="显示/隐藏文章目录">📑</button>
        <div class="zoom-controls">
          <button class="btn btn-icon" id="btn-zoom-out" data-tip="缩小预览（按住 Ctrl/Cmd 滚轮）">－</button>
          <span id="zoom-value">100%</span>
          <button class="btn btn-icon" id="btn-zoom-in" data-tip="放大预览（按住 Ctrl/Cmd 滚轮）">＋</button>
          <button class="btn btn-icon" id="btn-zoom-reset" data-tip="重置缩放">↺</button>
        </div>
        <button class="btn btn-icon" id="btn-sync-to-preview" data-tip="跳到编辑器光标对应的预览位置">→</button>
        <button class="btn btn-icon" id="btn-sync-to-editor" data-tip="跳到当前预览位置对应的编辑器行">←</button>
        <button class="btn btn-icon" id="btn-table-mode" data-tip="切换宽表格显示：横向滚动或完整显示" style="display:none;">▦ 滚动</button>
      </div>

      <!-- 区② 发布主操作 -->
      <div class="toolbar-zone toolbar-zone-publish">

    <!-- 🟢 微信 ▼ -->
    <div class="dropdown" id="dd-wechat">
      <button class="btn btn-primary dropdown-trigger" id="btn-dd-wechat"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M9.04 4.29C5.18 4.29 2 7.13 2 10.71c0 1.83.92 3.48 2.4 4.6L3.7 18l3.36-1.64c.63.17 1.3.27 1.98.27h.3c-.16-.54-.25-1.11-.25-1.7 0-3.15 2.63-5.71 5.88-5.71.28 0 .56.02.83.06-.62-3.53-3.65-5.99-6.76-5.99z"/><path d="M14.77 10.57c-3.17 0-5.75 2.41-5.75 5.38s2.58 5.38 5.75 5.38c.68 0 1.34-.11 1.95-.31L19.97 23l-.76-2.38A5.37 5.37 0 0 0 20.52 15.95c0-2.97-2.58-5.38-5.75-5.38z"/></svg>微信</button>
      <div class="dropdown-menu" id="menu-wechat">
        <div class="dropdown-section-label">操作方式</div>
        <button class="dropdown-item" id="btn-copy">
          <span class="item-icon">📋</span>
          <span class="dropdown-item-content">
            <span class="item-label">复制到剪贴板</span>
            <span class="item-desc">带样式 HTML，直接粘贴到公众号编辑器</span>
          </span>
        </button>
        <button class="dropdown-item" id="btn-upload">
          <span class="item-icon">☁️</span>
          <span class="dropdown-item-content">
            <span class="item-label">上传到草稿箱</span>
            <span class="item-desc">通过 API 直接推送到公众号草稿（需配置 AppID）</span>
          </span>
        </button>
      </div>
    </div>

    <!-- 🔵 知乎 ▼ -->
    <div class="dropdown" id="dd-zhihu">
      <button class="btn btn-zhihu dropdown-trigger" id="btn-dd-zhihu"><span class="brand-glyph">知</span>知乎</button>
      <div class="dropdown-menu" id="menu-zhihu">
        <div class="dropdown-section-label">操作方式</div>
        <button class="dropdown-item" id="btn-zhihu">
          <span class="item-icon">📋</span>
          <span class="dropdown-item-content">
            <span class="item-label">复制到剪贴板</span>
            <span class="item-desc">带样式 HTML，手动粘贴到知乎编辑器</span>
          </span>
        </button>
        <button class="dropdown-item" id="btn-zhihu-publish">
          <span class="item-icon">🚀</span>
          <span class="dropdown-item-content">
            <span class="item-label">自动发布</span>
            <span class="item-desc">打开浏览器，自动填充标题和正文（需登录）</span>
          </span>
        </button>
      </div>
    </div>

    <!-- 📱 小红书 ▼ -->
    <div class="dropdown" id="dd-xhs">
      <button class="btn btn-xhs dropdown-trigger" id="btn-dd-xhs"><span class="brand-glyph" style="font-size:11px;letter-spacing:.02em;">RED</span>小红书</button>
      <div class="dropdown-menu" id="menu-xhs">
        <div class="dropdown-section-label">图文笔记（推荐）</div>
        <button class="dropdown-item" id="btn-xhs">
          <span class="item-icon">📸</span>
          <span class="dropdown-item-content">
            <span class="item-label">截图为长图</span>
            <span class="item-desc">渲染为多张图片，适合图文笔记发布</span>
          </span>
        </button>
        <div class="dropdown-divider"></div>
        <div class="dropdown-section-label">长文笔记</div>
        <button class="dropdown-item" id="btn-xhs-copy">
          <span class="item-icon">📋</span>
          <span class="dropdown-item-content">
            <span class="item-label">复制到剪贴板</span>
            <span class="item-desc">纯文字格式，粘贴到小红书长文编辑器</span>
          </span>
        </button>
      </div>
    </div>

    <!-- 🐦 Twitter -->
    <button class="btn btn-twitter" id="btn-twitter" title="生成中文推文，用真实浏览器自动发布到 Twitter/X"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 4l16 16M20 4L4 20"/></svg>Twitter</button>
      </div><!-- /区② 发布主操作 -->

      <!-- 区③ 工具 -->
      <div class="toolbar-zone toolbar-zone-tools">

    <!-- 💾 导出 ▼ -->
    <div class="dropdown" id="dd-export">
      <button class="btn btn-secondary dropdown-trigger" id="btn-dd-export">💾 导出</button>
      <div class="dropdown-menu align-right" id="menu-export">
        <div class="dropdown-section-label">导出格式</div>
        <button class="dropdown-item" id="btn-export">
          <span class="item-icon">🌐</span>
          <span class="dropdown-item-content">
            <span class="item-label">HTML</span>
            <span class="item-desc">默认保存到 MD 同目录同名 .html</span>
          </span>
        </button>
        <div style="padding:4px 14px 8px;display:flex;gap:6px;align-items:center;">
          <input type="text" id="html-output-path" placeholder="自定义路径（留空=同目录）"
            style="flex:1;padding:4px 8px;background:#222;border:1px solid #444;border-radius:3px;color:#ccc;font-size:11px;outline:none;"
            title="绝对路径或相对于 md 文件的路径，如 ../out/article.html">
        </div>
        <div class="dropdown-divider"></div>
        <button class="dropdown-item" id="btn-ppt">
          <span class="item-icon">📊</span>
          <span class="dropdown-item-content">
            <span class="item-label">PPT（PPTX）</span>
            <span class="item-desc">pandoc 生成，文字可编辑，图片/公式完整</span>
          </span>
        </button>
        <button class="dropdown-item" id="btn-word">
          <span class="item-icon">📄</span>
          <span class="dropdown-item-content">
            <span class="item-label">Word（DOCX）</span>
            <span class="item-desc">保留公式/代码/图片，需安装 pandoc</span>
          </span>
        </button>
      </div>
    </div>

    <!-- ⋮ 更多工具 ▼ -->
    <div class="dropdown" id="dd-more">
      <button class="btn btn-secondary dropdown-trigger" id="btn-dd-more" title="更多工具：LLM 配置 / 样式 / 封面">⋮ 更多</button>
      <div class="dropdown-menu align-right" id="menu-more">
        <div class="dropdown-section-label">更多工具</div>
        <button class="dropdown-item" id="btn-llm-config">
          <span class="item-icon">⚙️</span>
          <span class="dropdown-item-content">
            <span class="item-label">LLM 配置</span>
            <span class="item-desc">AI 生成文案 / PPT 改写共用接口</span>
          </span>
        </button>
        <button class="dropdown-item" id="btn-style">
          <span class="item-icon">🎨</span>
          <span class="dropdown-item-content">
            <span class="item-label">自定义样式</span>
            <span class="item-desc">覆盖预览 / 导出的 CSS</span>
          </span>
        </button>
        <button class="dropdown-item" id="btn-cover">
          <span class="item-icon">🖼️</span>
          <span class="dropdown-item-content">
            <span class="item-label">封面生成</span>
            <span class="item-desc">小红书 1080×1440 高清封面</span>
          </span>
        </button>
      </div>
    </div>
      </div><!-- /区③ 工具 -->

    </div><!-- /toolbar-btn-row -->
  </div><!-- /toolbar -->

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
    <div class="preview-scroll" id="preview-scroll">
      <div class="zoom-canvas" id="zoom-canvas">
        <div class="article-wrapper" id="preview-content">
          <p style="color:#999;text-align:center;">正在加载预览...</p>
        </div>
      </div>
    </div>

    <!-- 样式编辑面板 -->
    <div class="side-panel" id="style-panel">
      <div class="side-panel-header">🎨 自定义样式<button class="panel-close-btn" data-close-panel="style-panel" data-close-state="stylePanelOpen">×</button></div>
      <div class="side-panel-body">

        <p class="hint" style="color:#aaa;line-height:1.6;">
          在此输入 CSS，覆盖当前主题的样式。<br>
          所有规则需以 <code style="color:#4fc3f7;">.article-wrapper</code> 开头才能生效。
        </p>

        <!-- 接口速查表 -->
        <div style="background:#111;border:1px solid #333;border-radius:6px;padding:10px 12px;margin:10px 0;font-size:11px;line-height:1.9;color:#aaa;">
          <div style="color:#ccc;font-weight:600;margin-bottom:6px;font-size:12px;">📐 可用选择器</div>
          <div><code style="color:#4fc3f7;">.article-wrapper</code> — 文章容器（背景/内边距）</div>
          <div><code style="color:#4fc3f7;">.article-wrapper h1/h2/h3/h4</code> — 各级标题</div>
          <div><code style="color:#4fc3f7;">.article-wrapper p</code> — 正文段落</div>
          <div><code style="color:#4fc3f7;">.article-wrapper strong</code> — 加粗文字</div>
          <div><code style="color:#4fc3f7;">.article-wrapper a</code> — 链接</div>
          <div><code style="color:#4fc3f7;">.article-wrapper blockquote</code> — 引用块</div>
          <div><code style="color:#4fc3f7;">.article-wrapper pre.mac-code</code> — 代码块容器</div>
          <div><code style="color:#4fc3f7;">.article-wrapper code:not([class])</code> — 行内代码</div>
          <div><code style="color:#4fc3f7;">.article-wrapper table</code> — 表格</div>
          <div><code style="color:#4fc3f7;">.article-wrapper table th</code> — 表头</div>
          <div><code style="color:#4fc3f7;">.article-wrapper table td</code> — 表格单元格</div>
          <div><code style="color:#4fc3f7;">.article-wrapper .table-wrapper</code> — 宽表格滚动容器（溢出时内部横向滚动）</div>
          <div><code style="color:#4fc3f7;">.article-wrapper ul / ol</code> — 列表</div>
          <div><code style="color:#4fc3f7;">.article-wrapper img</code> — 图片</div>
          <div><code style="color:#4fc3f7;">.article-wrapper figure</code> — 图片容器</div>
          <div><code style="color:#4fc3f7;">.article-wrapper figcaption</code> — 图片说明</div>
          <div><code style="color:#4fc3f7;">.article-wrapper hr</code> — 分割线</div>
          <div><code style="color:#4fc3f7;">.math-block / .math-inline</code> — KaTeX 公式</div>
        </div>

        <!-- 常用属性提示 -->
        <div style="background:#111;border:1px solid #333;border-radius:6px;padding:10px 12px;margin:8px 0;font-size:11px;line-height:1.9;color:#aaa;">
          <div style="color:#ccc;font-weight:600;margin-bottom:6px;font-size:12px;">⚡ 常用属性</div>
          <div><code style="color:#a6e3a1;">color</code> — 文字颜色，如 <code>#333</code> / <code>rgb(50,50,50)</code></div>
          <div><code style="color:#a6e3a1;">font-size</code> — 字号，如 <code>16px</code> / <code>1.1em</code></div>
          <div><code style="color:#a6e3a1;">font-family</code> — 字体，如 <code>'PingFang SC', serif</code></div>
          <div><code style="color:#a6e3a1;">line-height</code> — 行高，如 <code>1.8em</code></div>
          <div><code style="color:#a6e3a1;">background</code> — 背景色/渐变</div>
          <div><code style="color:#a6e3a1;">border-left</code> — 左边框，如 <code>4px solid #07c160</code></div>
          <div><code style="color:#a6e3a1;">border-radius</code> — 圆角，如 <code>8px</code></div>
          <div><code style="color:#a6e3a1;">padding / margin</code> — 内/外边距</div>
          <div><code style="color:#a6e3a1;">text-align</code> — 对齐：<code>left/center/right</code></div>
          <div><code style="color:#a6e3a1;">letter-spacing</code> — 字间距，如 <code>0.05em</code></div>
        </div>

        <!-- LLM 提示 -->
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:10px 12px;margin:8px 0;font-size:11px;color:#aaa;line-height:1.6;">
          <div style="color:#9b8afb;font-weight:600;margin-bottom:4px;font-size:12px;">🤖 用 AI 生成样式</div>
          <div>把下面的提示发给 Claude / ChatGPT，它会直接给你可用的 CSS：</div>
          <div style="background:#0d0d1a;border:1px solid #2d2d5e;border-radius:4px;padding:8px;margin-top:6px;color:#c4c4ff;font-size:10.5px;line-height:1.7;user-select:text;">
            帮我写一段适用于 markdown2anything 插件的自定义样式 CSS。<br>
            选择器格式固定为 <strong>.article-wrapper 元素名</strong>，例如 .article-wrapper h2。<br>
            需求：[在这里描述你的需求，例如：「标题用蓝色，h2 左边加绿色竖线，正文字体 17px 宋体，引用块浅黄色背景」]
          </div>
        </div>

        <label style="margin-top:12px;">CSS 编辑区</label>
        <textarea id="css-textarea" placeholder="/* 示例 */
.article-wrapper h1 {
  color: #07c160;
  border-bottom: 2px solid #07c160;
}
.article-wrapper p {
  font-size: 17px;
  line-height: 1.9em;
}
.article-wrapper blockquote {
  background: #f0fff4;
  border-left: 4px solid #07c160;
}
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

        <!-- ① 导出区块 -->
        <div class="section-block">
          <div class="section-block-title">🎨 导出</div>
           <select id="xhs-export-mode" style="width:100%;padding:6px 8px;background:#2d2d2d;color:#eee;border:1px solid #444;border-radius:4px;font-size:13px;outline:none;">
            <option value="classic"${xhsExportMode === 'classic' ? ' selected' : ''}>默认 HTML 页面截图</option>
            <option value="adaptive"${xhsExportMode === 'adaptive' ? ' selected' : ''}>手机自适应截图</option>
          </select>
          <label style="display:${xhsExportMode === 'adaptive' ? 'flex' : 'none'};align-items:center;gap:6px;margin:8px 0 0;font-size:12px;color:#aaa;cursor:pointer;" id="xhs-theme-row">
            <input type="checkbox" id="xhs-adaptive-theme" ${xhsAdaptiveUseTheme ? 'checked' : ''} style="accent-color:var(--m2a-accent,#ff2442);"> 跟随预览主题色
            <span style="font-size:11px;color:#666;">(关闭则固定小红书红)</span>
          </label>
          <p class="hint" id="xhs-mode-hint" style="margin:6px 0 10px;line-height:1.4;"></p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <button class="btn btn-secondary" id="btn-xhs-python" title="生成预览图，不保存到项目目录">📸 生成预览</button>
            <button class="btn btn-secondary" id="btn-xhs-export-all" title="生成并保存到 MD 同名 _xhs 目录">💾 一键导出</button>
          </div>

          <!-- 参数设置（折叠） -->
          <details class="section-details" id="xhs-settings-details">
            <summary>
              ⚙ 参数设置
              <span style="margin-left:auto;display:flex;gap:4px;align-items:center;">
                <button class="btn btn-secondary" id="btn-xhs-save-defaults" onclick="event.stopPropagation()" style="padding:2px 8px;font-size:11px;" title="将当前参数保存为该模式的默认值">★ 设为默认</button>
                <button class="btn btn-secondary" id="btn-xhs-reset" onclick="event.stopPropagation()" style="padding:2px 8px;font-size:11px;" title="恢复为系统出厂参数">↺ 出厂值</button>
                <span class="toggle-arrow">▶</span>
              </span>
            </summary>
            <div class="section-details-body">
              <div class="xhs-param-grid" style="margin-bottom:10px;">
                <div><label>宽度（px）</label><input type="number" id="xhs-width" value="1080" min="600" max="2000"></div>
                <div><label>最大高度（px）</label><input type="number" id="xhs-height" value="1440" min="400" max="4000"></div>
              </div>
              <label id="xhs-density-label">字体缩放（%）</label>
              <input type="number" id="xhs-density" value="${xhsExportMode === 'adaptive' ? '36' : '100'}" min="${xhsExportMode === 'adaptive' ? '20' : '60'}" max="${xhsExportMode === 'adaptive' ? '60' : '200'}" step="${xhsExportMode === 'adaptive' ? '1' : '5'}">
              <p class="hint" id="xhs-density-hint" style="margin:4px 0 10px;line-height:1.4;"></p>
              <div class="xhs-param-grid">
                <div><label>内边距（px）</label><input type="number" id="xhs-padding" value="40" min="0" max="200"></div>
                <div><label>背景容差（0-100）</label><input type="number" id="xhs-tolerance" value="15" min="0" max="100"></div>
              </div>
            </div>
          </details>

          <!-- 预览图（折叠，固定高度） -->
          <details class="section-details" id="xhs-preview-details">
            <summary>
              🖼 预览图 <span id="xhs-preview-count" style="color:#888;font-weight:normal;font-size:11px;margin-left:2px;"></span>
              <span class="toggle-arrow" style="margin-left:auto;">▶</span>
            </summary>
            <div id="xhs-output" style="max-height:300px;overflow-y:auto;margin-top:8px;padding-top:10px;border-top:1px solid #2e2e2e;"></div>
          </details>
        </div>

        <!-- ② 文案 & 账号发布 -->
        ${socialBlockHtml('xiaohongshu', 'xhs-social', '小红书', 20,
          '发布用「一键导出」生成的长图作配图。默认停在发布前，核对无误后你点页面里的「发布」即可。')}
      </div>
    </div>

    <!-- 封面面板 -->
    <div class="side-panel xhs-panel" id="cover-panel">
      <div class="resize-handle" id="cover-resize-handle"></div>
      <div class="side-panel-header">🖼️ 生成封面<button class="panel-close-btn" data-close-panel="cover-panel" data-close-state="coverPanelOpen">×</button></div>
      <div class="side-panel-body">

        <!-- 标题 + 可视化拖拽 -->
        <div class="section-block">
          <div class="section-block-title">✏️ 标题（可拖拽/缩放）</div>
          <label style="margin-top:0;">封面标题 *</label>
          <input type="text" id="cover-title" placeholder="自动取文章标题，可手动改" style="width:100%;box-sizing:border-box;">
          <label>小字标语（可选）</label>
          <input type="text" id="cover-tagline" placeholder="例：新书签售会 / AI · 技术分享" style="width:100%;box-sizing:border-box;">
          <!-- 实时预览：1080x1440 等比缩放 0.25，所见即所得 -->
          <div id="cover-preview-wrap" style="width:270px;height:360px;margin:10px auto;position:relative;overflow:hidden;border:1px solid #333;border-radius:8px;background:#FFF8E7;cursor:grab;user-select:none;">
            <div id="cover-preview-inner" style="width:1080px;height:1440px;transform:scale(0.25);transform-origin:top left;position:absolute;left:0;top:0;background:#FFF8E7;">
              <img id="cover-preview-bg" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;">
              <div id="cover-draggable-title" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:70%;text-align:center;cursor:move;touch-action:none;">
                <div id="cover-preview-title" style="font-family:'PingFang SC','Hiragino Sans GB','Alibaba PuHuiTi Heavy',system-ui,sans-serif;font-weight:900;line-height:1.28;color:#1A1A1A;word-break:break-word;-webkit-text-stroke:7px #fff;paint-order:stroke fill;text-shadow:0 2px 0 rgba(255,255,255,0.95), 0 10px 28px rgba(0,0,0,0.12);font-size:78px;">标题预览</div>
                <div id="cover-preview-tagline" style="margin-top:16px;font-size:30px;font-weight:600;color:#3a3a3a;letter-spacing:0.12em;-webkit-text-stroke:4px #fff;paint-order:stroke fill;word-break:break-word;"></div>
              </div>
            </div>
            <div id="cover-preview-hint" style="position:absolute;bottom:4px;left:50%;transform:translateX(-50%);font-size:9px;color:#fff;background:rgba(0,0,0,0.45);padding:2px 6px;border-radius:999px;pointer-events:none;">拖动标题 · 按住 Ctrl 滚轮缩放</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:6px;">
            <label style="flex:1;margin:0;font-size:11px;color:#999;">字号 <span id="cover-fontsize-val" style="color:#ccc;">78</span> <input type="range" id="cover-fontsize" min="28" max="120" value="78" style="width:100%;"></label>
            <label style="flex:1;margin:0;font-size:11px;color:#999;">宽度 <span id="cover-width-val" style="color:#ccc;">70%</span> <input type="range" id="cover-width" min="50" max="92" value="70" style="width:100%;"></label>
            <button class="btn btn-secondary" id="btn-cover-reset-pos" style="padding:4px 8px;font-size:11px;">↺ 居中</button>
          </div>
          <p class="hint" style="margin:4px 0 0;">拖动标题、滚轮/滑条调大小 → 点「确认排版」设为默认值 → 导出即为所见（1080×1440 高清）。</p>

          <label style="margin-top:10px;">背景图（自动设为默认）</label>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="cover-bg" placeholder="粘贴图片 URL 或选本地文件" style="flex:1;box-sizing:border-box;">
            <label class="btn btn-secondary" style="padding:5px 10px;cursor:pointer;margin:0;">选择<input type="file" id="cover-bg-file" accept="image/*" style="display:none;"></label>
          </div>
          <div id="cover-bg-history" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;max-height:120px;overflow-y:auto;"></div>
          <p class="hint" style="margin:4px 0 0;">上传后自动设为默认，历史保留可切换，点 ✕ 删除。</p>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;">
            <button class="btn btn-secondary" id="btn-cover-confirm" title="将当前拖拽位置/大小设为以后默认值">✓ 确认排版</button>
            <button class="btn btn-primary" id="btn-cover-generate" title="用当前预览排版直出 1080×1440 高清图">⬇ 导出高清封面</button>
          </div>
          <div id="cover-progress" style="margin-top:8px;color:#4ea1ff;font-size:12px;white-space:pre-wrap;"></div>
          <div id="cover-result" style="margin-top:10px;display:none;">
            <img id="cover-result-img" style="width:100%;border-radius:8px;border:1px solid #333;cursor:zoom-in;">
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button class="btn btn-secondary" id="btn-cover-save" style="flex:1;">💾 已自动保存</button>
              <button class="btn btn-secondary" id="btn-cover-copy">📋 复制</button>
            </div>
            <p class="hint" id="cover-result-path" style="word-break:break-all;"></p>
          </div>
        </div>

        <!-- LLM 生图 -->
        <div class="section-block">
          <div class="section-block-title">🤖 LLM 生背景（去标题）</div>
          <p class="hint" style="margin-top:0;">有新策划时快速换背景：LLM 生成蜡笔小新+猪猪侠背景 prompt → 调生图 API 生成无字背景 → 再用上面按钮贴标题。</p>
          <label>期望气质（可选）</label>
          <input type="text" id="cover-vibe" placeholder="例：科技感 / 可爱 / 极简 / 暖粉" style="width:100%;box-sizing:border-box;">
          <details class="section-details" id="cover-prompt-details">
            <summary>指令 <span class="toggle-arrow">▶</span></summary>
            <div class="section-details-body">
              <textarea id="cover-instruction" rows="4" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:11px;" placeholder="留空用默认：蜡笔小新+猪猪侠，中央留白..."></textarea>
            </div>
          </details>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <button class="btn btn-secondary" id="btn-cover-prompt" style="flex:1;">✨ 生成 Prompt</button>
            <button class="btn btn-secondary" id="btn-cover-image" style="flex:1;">🎨 生成背景图</button>
          </div>
          <div id="cover-prompt-out" style="margin-top:8px;display:none;background:#111;border:1px solid #333;border-radius:6px;padding:8px;font-size:11px;color:#ccc;white-space:pre-wrap;word-break:break-word;"></div>
          <div id="cover-bg-gen-preview" style="margin-top:8px;display:none;"><img id="cover-bg-gen-img" style="width:100%;border-radius:6px;border:1px solid #333;max-height:240px;object-fit:contain;background:#111;"></div>
          <p class="hint" id="cover-llm-progress" style="margin-top:6px;color:#4ea1ff;white-space:pre-wrap;"></p>
          <p class="hint">复用工具栏 ⚙️ LLM 配置的 baseUrl/model/key；生图模型可在设置里单独配 <code>cover.imageModel</code>。</p>
        </div>

      </div>
    </div>

    <!-- Twitter 面板 -->
    <div class="side-panel xhs-panel" id="twitter-panel">
      <div class="resize-handle" id="twitter-resize-handle"></div>
      <div class="side-panel-header">🐦 发布 Twitter<button class="panel-close-btn" data-close-panel="twitter-panel" data-close-state="twitterPanelOpen">×</button></div>
      <div class="side-panel-body">
        ${socialBlockHtml('twitter', 'tw-social', 'Twitter', 0,
          '推文正文会自动拼上标签和全文链接，并压到 280 字以内。默认停在发帖前，核对无误后你点页面里的「发帖」。配图复用「导出小红书」生成的长图（最多 4 张）。')}
      </div>
    </div>

    <!-- PPT 导出面板 -->
    <div class="side-panel xhs-panel" id="ppt-panel">
      <div class="resize-handle" id="ppt-resize-handle"></div>
      <div class="side-panel-header">📊 导出 PPT<button class="panel-close-btn" data-close-panel="ppt-panel" data-close-state="pptPanelOpen">×</button></div>
      <div class="side-panel-body">

        <!-- ── Backend 选择 ── -->
        <label>渲染引擎</label>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
          <label style="margin:0;display:flex;align-items:center;gap:6px;cursor:pointer;color:#ccc;font-size:13px;">
            <input type="radio" name="ppt-backend" value="slidev" id="ppt-backend-slidev" checked
              style="accent-color:#7c3aed;"> Slidev <span style="color:#888;font-size:11px;">（美观截图 PPTX，首次安装约 200MB）</span>
          </label>
          <label style="margin:0;display:flex;align-items:center;gap:6px;cursor:pointer;color:#ccc;font-size:13px;">
            <input type="radio" name="ppt-backend" value="marp" id="ppt-backend-marp"
              style="accent-color:#7c3aed;"> Marp <span style="color:#888;font-size:11px;">（截图 PPTX，轻量，npx 即用）</span>
          </label>
          <label style="margin:0;display:flex;align-items:center;gap:6px;cursor:pointer;color:#ccc;font-size:13px;">
            <input type="radio" name="ppt-backend" value="pandoc" id="ppt-backend-pandoc"
              style="accent-color:#7c3aed;"> Pandoc <span style="color:#888;font-size:11px;">（可编辑 PPTX，约 30MB）</span>
          </label>
        </div>

        <!-- Marp 选项 -->
        <div id="ppt-marp-opts" style="display:none;">
          <label>Marp 主题</label>
          <select id="ppt-marp-theme" style="width:100%;padding:7px 10px;background:#2d2d2d;border:1px solid #444;border-radius:4px;color:#e0e0e0;font-size:13px;outline:none;margin-bottom:8px;">
            <option value="default">Default（白底简洁）</option>
            <option value="gaia">Gaia（深色优雅）</option>
            <option value="uncover">Uncover（左对齐极简）</option>
          </select>
          <p class="hint" style="margin:0 0 8px;">Marp 通过 npx 即用，无需安装，首次需下载缓存（约 30MB）。<br>导出为截图 PPTX，视觉效果好，但文字不可编辑。</p>
        </div>

        <!-- Slidev 选项 -->
        <div id="ppt-slidev-opts">
          <label>Slidev 主题</label>
          <select id="ppt-slidev-theme" style="width:100%;padding:7px 10px;background:#2d2d2d;border:1px solid #444;border-radius:4px;color:#e0e0e0;font-size:13px;outline:none;margin-bottom:8px;">
            <option value="default">Default（简洁）</option>
            <option value="seriph">Seriph（深色优雅）</option>
            <option value="bricks">Bricks（网格活力）</option>
            <option value="apple-basic">Apple Basic（苹果风）</option>
            <option value="shibainu">Shibainu（柔和可爱）</option>
          </select>
          <p class="hint" style="margin:0 0 8px;">首次使用 Slidev 会在后台安装环境（约 200MB），之后秒启动。<br>导出格式为截图 PPTX，文字不可编辑但视觉效果最佳。</p>
        </div>

        <!-- Pandoc 选项 -->
        <div id="ppt-pandoc-opts" style="display:none;">
          <label>Pandoc 主题</label>
          <select id="ppt-pandoc-theme" style="width:100%;padding:7px 10px;background:#2d2d2d;border:1px solid #444;border-radius:4px;color:#e0e0e0;font-size:13px;outline:none;margin-bottom:8px;">
            <option value="">默认（白底简洁）</option>
            <option value="clean-light">Clean Light（浅色商务）</option>
            <option value="tech-dark">Tech Dark（深色科技）</option>
            <option value="warm-claude">Warm Claude（暖色知识）</option>
          </select>
          <label>分页级别</label>
          <select id="ppt-split" style="width:100%;padding:7px 10px;background:#2d2d2d;border:1px solid #444;border-radius:4px;color:#e0e0e0;font-size:13px;outline:none;margin-bottom:8px;">
            <option value="h1">按一级标题（# 开头）分页</option>
            <option value="h2">按二级标题（## 开头）分页</option>
          </select>
          <p class="hint" style="margin:0 0 8px;">生成真正可编辑的 PPTX，文字/代码/图片可在 PowerPoint 中修改。系统无 pandoc 时自动下载（约 30MB）。</p>
        </div>

        <div class="divider" style="margin:12px 0;"></div>

        <!-- ── LLM 改写（所有 backend 通用） ── -->
        <div id="ppt-llm-section">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:13px;color:#ccc;font-weight:600;">✨ AI 改写</span>
            <label style="margin:0;display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:#888;">
              <input type="checkbox" id="ppt-llm-enable" style="accent-color:#7c3aed;"> 启用
            </label>
          </div>
          <p class="hint" style="margin:0 0 8px;">用 LLM 把文章重写为 PPT 格式：提取要点、控制每页字数、保留代码/图片引用。需先点工具栏 ⚙️ LLM 配置。</p>
          <div id="ppt-llm-opts" style="display:none;">
            <label style="margin-top:8px;">改写指令（可编辑）</label>
            <textarea id="ppt-llm-instruction" style="width:100%;min-height:120px;padding:8px;background:#1a1a1a;border:1px solid #444;border-radius:4px;color:#ccc;font-size:11px;font-family:monospace;resize:vertical;outline:none;line-height:1.5;"></textarea>
            <div style="display:flex;gap:8px;margin-top:8px;">
              <button class="btn btn-secondary" id="btn-ppt-llm-preview" style="flex:1;font-size:12px;">👁 预览改写结果</button>
              <button class="btn btn-secondary" id="btn-ppt-llm-reset" style="font-size:12px;padding:4px 10px;">↺ 重置</button>
            </div>
            <!-- 改写预览区 + 版本管理 -->
            <div id="ppt-llm-preview-wrap" style="display:none;margin-top:10px;">
              <!-- 版本导航栏 -->
              <div id="ppt-ver-bar" style="display:none;align-items:center;gap:6px;margin-bottom:6px;
                   border:1px solid #3a3a3a;border-radius:4px;padding:5px 8px;background:#1a1a1a;">
                <button class="btn btn-secondary" id="btn-ppt-ver-prev" style="padding:2px 8px;" title="上一版">◀</button>
                <span id="ppt-ver-label" style="flex:1;text-align:center;font-size:11px;color:#aaa;"></span>
                <button class="btn btn-secondary" id="btn-ppt-ver-next" style="padding:2px 8px;" title="下一版">▶</button>
                <button class="btn btn-secondary" id="btn-ppt-ver-del" style="padding:2px 6px;color:#ff6b6b;" title="删除当前版本">🗑</button>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                <span id="ppt-llm-preview-label" style="font-size:11px;color:#888;">改写后的 Markdown（可直接编辑）</span>
                <div style="display:flex;gap:4px;">
                  <button class="btn btn-secondary" id="btn-ppt-ver-save" style="font-size:11px;padding:2px 7px;" title="保存对当前版本的编辑">💾 保存</button>
                  <button class="btn btn-secondary" id="btn-ppt-llm-preview-close" style="font-size:11px;padding:2px 7px;">收起</button>
                </div>
              </div>
              <textarea id="ppt-llm-preview-text" style="width:100%;min-height:200px;padding:8px;background:#111;border:1px solid #333;border-radius:4px;color:#ccc;font-size:11px;font-family:monospace;resize:vertical;outline:none;line-height:1.5;"></textarea>
            </div>
          </div>
        </div>

        <div class="divider" style="margin:12px 0;"></div>

        <!-- ── 生成按钮 ── -->
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ppt" id="btn-ppt-export" style="flex:1;">📊 生成 PPTX</button>
          <button class="btn btn-secondary" id="btn-ppt-cancel" style="display:none;padding:5px 10px;">✕</button>
        </div>
        <!-- 进度条 -->
        <div id="ppt-progress-wrap" style="display:none;margin-top:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span id="ppt-progress-label" style="font-size:12px;color:#ccc;flex:1;"></span>
            <span id="ppt-progress-step" style="font-size:11px;color:#666;flex-shrink:0;margin-left:8px;"></span>
          </div>
          <div style="background:#333;border-radius:3px;height:4px;overflow:hidden;">
            <div id="ppt-progress-bar" style="height:100%;background:#7c3aed;border-radius:3px;width:0%;transition:width 0.3s ease;"></div>
          </div>
        </div>
        <div class="upload-result" id="ppt-result"></div>
      </div>
    </div>

    <!-- Word 导出面板 -->
    <div class="side-panel" id="word-panel">
      <div class="side-panel-header">📄 导出 Word<button class="panel-close-btn" data-close-panel="word-panel" data-close-state="wordPanelOpen">×</button></div>
      <div class="side-panel-body">
        <p class="hint">将 Markdown 导出为 Word（.docx）格式，保留数学公式、代码高亮、图片。</p>
        <p class="hint" style="color:#e6a817;border:1px solid #555;padding:8px;border-radius:4px;margin-top:8px;">
          ⚠️ 需要系统安装 <strong style="color:#ccc;">pandoc</strong>。<br>
          macOS: <code style="color:#4fc3f7;">brew install pandoc</code><br>
          Windows: <a href="https://pandoc.org/installing.html" style="color:#4fc3f7;" title="pandoc 安装页">pandoc.org/installing</a>
        </p>

        <label style="margin-top:14px;">数学公式格式</label>
        <select id="word-math" style="width:100%;padding:7px 10px;background:#2d2d2d;border:1px solid #444;border-radius:4px;color:#e0e0e0;font-size:13px;outline:none;">
          <option value="mathml">MathML（Word 2013+ 原生支持，推荐）</option>
          <option value="docx">OMML（Word 原生公式格式）</option>
          <option value="latex">LaTeX 原文（可用于 LuaLaTeX 流）</option>
        </select>

        <label style="margin-top:12px;">代码高亮</label>
        <select id="word-highlight" style="width:100%;padding:7px 10px;background:#2d2d2d;border:1px solid #444;border-radius:4px;color:#e0e0e0;font-size:13px;outline:none;">
          <option value="pygments">Pygments（推荐）</option>
          <option value="tango">Tango</option>
          <option value="espresso">Espresso</option>
          <option value="zenburn">Zenburn（暗色）</option>
          <option value="none">不高亮</option>
        </select>

        <div style="margin-top:16px;display:flex;gap:8px;">
          <button class="btn btn-word" id="btn-word-export" style="flex:1;">📄 生成 Word</button>
        </div>
        <p class="hint" id="word-progress" style="margin-top:10px;display:none;"></p>
        <div class="upload-result" id="word-result"></div>
      </div>
    </div>

    <!-- LLM 全局配置面板 -->
    <div class="side-panel" id="llm-config-panel">
      <div class="side-panel-header">⚙️ LLM 配置<button class="panel-close-btn" data-close-panel="llm-config-panel" data-close-state="llmConfigPanelOpen">×</button></div>
      <div class="side-panel-body">

        <!-- 已保存的配置列表 -->
        <div id="llm-profiles-section" style="display:none;margin-bottom:16px;">
          <div style="font-size:10px;font-weight:700;color:#666;letter-spacing:.8px;text-transform:uppercase;margin-bottom:8px;">已保存的配置</div>
          <div id="llm-profiles-list"></div>
        </div>

        <!-- 添加 / 修改表单 -->
        <div style="font-size:10px;font-weight:700;color:#666;letter-spacing:.8px;text-transform:uppercase;margin-bottom:8px;" id="llm-form-label">添加配置</div>
        <label style="margin-top:0;">快速预设</label>
        <select id="global-llm-preset" style="width:100%;padding:7px 10px;background:#2d2d2d;border:1px solid #444;border-radius:4px;color:#e0e0e0;font-size:13px;outline:none;">
          <option value="">— 选择预设 —</option>
          <option value="deepseek">DeepSeek（便宜，中文好）</option>
          <option value="siliconflow">硅基流动 SiliconFlow（国内，性价比高）</option>
          <option value="openrouter">OpenRouter（有免费模型）</option>
          <option value="groq">Groq（免费额度）</option>
          <option value="ollama">本地 Ollama（完全免费）</option>
          <option value="openai">OpenAI</option>
        </select>
        <label style="margin-top:10px;">配置名（可重命名，如"OpenRouter 免费"）</label>
        <input type="text" id="global-llm-name" placeholder="留空则用预设名或接口地址">
        <label style="margin-top:8px;">接口地址（OpenAI 兼容）</label>
        <input type="text" id="global-llm-base" placeholder="https://api.deepseek.com/v1">
        <label style="margin-top:8px;">模型名</label>
        <input type="text" id="global-llm-model" placeholder="deepseek-chat">
        <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-secondary" id="global-llm-free-btn" title="一键拉取 OpenRouter 当前可用的免费模型（带 :free 后缀）">🎁 OpenRouter 免费模型</button>
          <span style="font-size:11px;color:#888;">点一下自动填好接口地址和模型名</span>
        </div>
        <div id="global-llm-free-list" style="display:none;margin-top:8px;max-height:180px;overflow-y:auto;background:#222;border:1px solid #444;border-radius:6px;padding:6px;"></div>
        <label style="margin-top:8px;">API Key <span style="color:#3ddc84;font-weight:normal;">（存入系统钥匙串，不落明文）</span></label>
        <input type="password" id="global-llm-key" placeholder="留空则复用同接口地址已有 Key；本地 Ollama 无需填">
        <div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap;">
          <button class="btn btn-primary" id="global-llm-save" style="flex:1;">保存并使用</button>
          <button class="btn btn-secondary" id="global-llm-test">测试</button>
          <button class="btn btn-secondary" id="global-llm-clear" title="清除当前配置的 API Key">清除 Key</button>
        </div>
        <div id="global-llm-result" style="margin-top:8px;font-size:12px;color:#4fc3f7;"></div>
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
    window.__m2a_vscode = vscode;

    // ─── 图标按钮悬浮提示（悬停 1 秒后显示）───
    (function () {
      const tipEl = document.createElement('div');
      tipEl.className = 'm2a-tip';
      document.body.appendChild(tipEl);
      let timer = null;
      function showTip(el) {
        const text = el.getAttribute('data-tip');
        if (!text) return;
        tipEl.textContent = text;
        tipEl.style.display = 'block';
        const r = el.getBoundingClientRect();
        const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
        let left = r.left + r.width / 2 - tw / 2;
        left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
        let top = r.top - th - 8;
        if (top < 4) top = r.bottom + 8; // 上方放不下就放按钮下方
        tipEl.style.left = left + 'px';
        tipEl.style.top  = top + 'px';
      }
      function hideTip() { clearTimeout(timer); tipEl.style.display = 'none'; }
      document.addEventListener('mouseover', (e) => {
        const el = e.target.closest && e.target.closest('[data-tip]');
        if (!el) { hideTip(); return; }
        if (el._m2aTipFor === e) return;
        el._m2aTipFor = e;
        hideTip();
        timer = setTimeout(() => showTip(el), 1000);
      });
      document.addEventListener('mouseout', (e) => {
        const el = e.target.closest && e.target.closest('[data-tip]');
        if (el) {
          const to = e.relatedTarget;
          if (to && to.closest && to.closest('[data-tip]')) return; // 移到按钮内部元素
        }
        hideTip();
      });
      document.addEventListener('scroll', hideTip, true);
    })();

    // ─── 状态 ───
    let currentTitle = '';
    let currentBodyHtml = '';
    let currentThemeBg = '#ffffff';
    // 用对象统一管理面板开关状态，避免 let 变量与 window 属性不同步的 bug
    const panelState = { stylePanelOpen: false, uploadPanelOpen: false, xhsPanelOpen: false, tocPanelOpen: false, zhihuPublishPanelOpen: false, twitterPanelOpen: false, pptPanelOpen: false, wordPanelOpen: false, llmConfigPanelOpen: false, coverPanelOpen: false };

    // 系统出厂默认值（恢复出厂用）
    const XHS_DEFAULTS          = { width: 1080, height: 1440, padding: 40, tolerance: 15, density: 100 };
    const XHS_ADAPTIVE_DEFAULTS = { width: 1080, height: 1440, padding: 48, tolerance: 15, density: 36  };

    function getXhsExportMode() {
      const el = document.getElementById('xhs-export-mode');
      return el && el.value === 'adaptive' ? 'adaptive' : 'classic';
    }

    // 用户自定义默认值（localStorage 持久化）
    function xhsUserDefs(mode) {
      try { return JSON.parse(localStorage.getItem('xhsDefs_' + mode)) || null; } catch(e) { return null; }
    }
    function xhsSaveUserDefs(mode, vals) {
      localStorage.setItem('xhsDefs_' + mode, JSON.stringify(vals));
    }
    function xhsEffectiveDefs(mode) {
      return xhsUserDefs(mode) || (mode === 'adaptive' ? XHS_ADAPTIVE_DEFAULTS : XHS_DEFAULTS);
    }

    // resetAll: false=仅更新标签/提示, true=应用用户默认, 'factory'=应用出厂默认
    function applyXhsModeDefaults(mode, resetAll) {
      const isAdaptive = mode === 'adaptive';
      const factory  = isAdaptive ? XHS_ADAPTIVE_DEFAULTS : XHS_DEFAULTS;
      const defs     = resetAll === 'factory' ? factory : xhsEffectiveDefs(mode);

      const dLabel = document.getElementById('xhs-density-label');
      const dInput = document.getElementById('xhs-density');
      const dHint  = document.getElementById('xhs-density-hint');
      if (dLabel) dLabel.textContent = isAdaptive ? '正文字号（px）' : '字体缩放（%）';
      if (dInput) {
        dInput.min  = isAdaptive ? '20'  : '60';
        dInput.max  = isAdaptive ? '60'  : '200';
        dInput.step = isAdaptive ? '1'   : '5';
        if (resetAll) dInput.value = defs.density;
      }
      if (dHint) dHint.textContent = isAdaptive
        ? '字号越小每张图内容越多；出厂 36px，建议 28–44px。'
        : '100% = 原始主题大小；调小可让每张图容纳更多内容。';

      if (resetAll) {
        document.getElementById('xhs-width').value     = defs.width;
        document.getElementById('xhs-height').value    = defs.height;
        document.getElementById('xhs-padding').value   = defs.padding;
        document.getElementById('xhs-tolerance').value = defs.tolerance;
      }
      const hint = document.getElementById('xhs-mode-hint');
      hint.textContent = isAdaptive
        ? '独立排版，所有尺寸随字号等比缩放，适合手机阅读。'
        : '保留当前主题 HTML 排版，可用字体缩放调节内容密度。';
    }

    document.getElementById('xhs-export-mode').addEventListener('change', function() {
      const mode = getXhsExportMode();
      applyXhsModeDefaults(mode, true);
      const row=document.getElementById('xhs-theme-row');
      if(row) row.style.display = mode==='adaptive' ? 'flex' : 'none';
      window._xhsLastSlices = null;
      document.getElementById('xhs-output').innerHTML = '';
      const pd = document.getElementById('xhs-preview-details');
      if (pd) { pd.open = false; document.getElementById('xhs-preview-count').textContent = ''; }
      vscode.postMessage({ type: 'setXhsExportMode', mode });
    });
    (function(){
      const cb=document.getElementById('xhs-adaptive-theme');
      if(cb) cb.addEventListener('change', ()=> vscode.postMessage({ type:'setXhsAdaptiveUseTheme', enabled: cb.checked }));
    })();
    applyXhsModeDefaults(getXhsExportMode(), true);

    // ─── 工具函数 ───
    function showToast(msg, type = '', duration = 2500) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast show' + (type ? ' ' + type : '');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => { el.className = 'toast'; }, duration);
    }

    // ─── 主题强调色（用于小红书面板/封面等 UI 跟随主题色） ───
    const M2A_THEME_ACCENT = {
      wechat: '#de7456', claude: '#d97706', macos: '#0071e3', dark: '#89b4fa',
      zhihu: '#0f6fec', monochrome: '#111111', spring: '#e86f8c', academic: '#1a1a1a',
      xhs: '#ff2442', notion: '#0f7b6c', 'claude-pro': '#c2410c', medium: '#1a1a1a',
      ryf: '#0079c1', 'clean-blue': '#3182ce',
    };
    function webThemeAccent(theme) {
      if (theme && M2A_THEME_ACCENT[theme.id]) return M2A_THEME_ACCENT[theme.id];
      const m = String((theme && theme.css) || '').match(/strong\s*\{[^}]*color\s*:\s*(#[0-9a-fA-F]{3,6}|rgb\([^)]+\))/i);
      if (m) {
        const c = m[1];
        if (c.startsWith('#')) return c;
        const rgb = c.match(/\d+/g);
        if (rgb && rgb.length >= 3) return '#' + rgb.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
      }
      return '#ff2442';
    }
    function accentSoftRgba(accent) {
      let h = String(accent).replace('#', '').trim();
      if (h.length === 3) h = h.split('').map(x => x + x).join('');
      if (h.length !== 6) return 'rgba(255,36,66,0.15)';
      const r = parseInt(h.slice(0,2), 16), g = parseInt(h.slice(2,4), 16), b = parseInt(h.slice(4,6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',0.15)';
    }
    function darkenHex(hex, ratio) {
      let h = String(hex).replace('#', '').trim();
      if (h.length === 3) h = h.split('').map(x => x + x).join('');
      if (h.length !== 6) return '#ff2442';
      const r = Math.round(parseInt(h.slice(0,2), 16) * (1 - ratio));
      const g = Math.round(parseInt(h.slice(2,4), 16) * (1 - ratio));
      const b = Math.round(parseInt(h.slice(4,6), 16) * (1 - ratio));
      return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
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
      // 注入主题强调色，供小红书面板/封面等 UI 使用
      const accent = webThemeAccent(theme);
      document.documentElement.style.setProperty('--m2a-accent', accent);
      document.documentElement.style.setProperty('--m2a-accent-soft', accentSoftRgba(accent));
      document.documentElement.style.setProperty('--m2a-accent-dim', darkenHex(accent, 0.3));
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
      const pd  = document.getElementById('xhs-preview-details');
      const cnt = document.getElementById('xhs-preview-count');
      if (!slices.length) {
        out.innerHTML = '<p class="hint" style="padding:8px;">未生成任何图片</p>';
        if (cnt) cnt.textContent = '';
        exportBtn.disabled = true;
        return;
      }
      exportBtn.disabled = false;
      if (pd)  pd.open = true;
      if (cnt) cnt.textContent = '（' + slices.length + ' 张）';
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
      const mode   = getXhsExportMode();
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
      // 工具栏按钮：仅直接触发面板的按钮需要 active 状态
      // 下拉菜单触发按钮：微信/知乎/小红书的面板都通过下拉子项打开，
      // 用对应 dropdown 触发按钮高亮
      // 只改工具栏上真正的触发按钮，下拉菜单里的 dropdown-item 不在这里管
      const map = [
        ['btn-toc',        'btn-toc',       panelState.tocPanelOpen],
        ['btn-twitter',    'btn-twitter',   panelState.twitterPanelOpen],
        ['btn-dd-wechat',  'btn-primary',   panelState.uploadPanelOpen],
        ['btn-dd-zhihu',   'btn-zhihu',     panelState.zhihuPublishPanelOpen],
        ['btn-dd-xhs',     'btn-xhs',       panelState.xhsPanelOpen],
        ['btn-dd-export',  'btn-secondary', panelState.pptPanelOpen || panelState.wordPanelOpen],
      ];
      for (const [id, base, active] of map) {
        const el = document.getElementById(id);
        if (!el) continue;
        const isTrigger = el.classList.contains('dropdown-trigger');
        el.className = 'btn ' + base + (active ? ' btn-panel-open' : '') + (isTrigger ? ' dropdown-trigger' : '');
      }
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

    // ─── 下拉菜单系统 ───────────────────────────────────────────
    // 统一管理所有下拉菜单的开关，点其他地方自动关闭
    const dropdownMenus = {
      wechat:  document.getElementById('menu-wechat'),
      zhihu:   document.getElementById('menu-zhihu'),
      xhs:     document.getElementById('menu-xhs'),
      export:  document.getElementById('menu-export'),
      more:    document.getElementById('menu-more'),
    };

    function fitMenu(menu) {
      if (!menu) return;
      menu.style.transform = '';
      const r = menu.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      let dx = 0;
      if (r.left < 6) dx = 6 - r.left;
      else if (r.right > vw - 6) dx = (vw - 6) - r.right;
      if (dx) menu.style.transform = 'translateX(' + dx + 'px)';
    }
    function openDropdown(key) {
      Object.entries(dropdownMenus).forEach(([k, el]) => {
        if (el) el.classList.toggle('open', k === key);
        if (el && k === key && el.classList.contains('open')) fitMenu(el);
      });
    }
    function closeAllDropdowns() {
      Object.values(dropdownMenus).forEach(el => { if (el) { el.classList.remove('open'); el.style.transform = ''; } });
    }

    document.getElementById('btn-dd-wechat').addEventListener('click', (e) => {
      e.stopPropagation();
      const already = dropdownMenus.wechat.classList.contains('open');
      closeAllDropdowns();
      if (!already) openDropdown('wechat');
    });
    document.getElementById('btn-dd-zhihu').addEventListener('click', (e) => {
      e.stopPropagation();
      const already = dropdownMenus.zhihu.classList.contains('open');
      closeAllDropdowns();
      if (!already) openDropdown('zhihu');
    });
    document.getElementById('btn-dd-xhs').addEventListener('click', (e) => {
      e.stopPropagation();
      const already = dropdownMenus.xhs.classList.contains('open');
      closeAllDropdowns();
      if (!already) openDropdown('xhs');
    });
    document.getElementById('btn-dd-export').addEventListener('click', (e) => {
      e.stopPropagation();
      const already = dropdownMenus.export.classList.contains('open');
      closeAllDropdowns();
      if (!already) openDropdown('export');
    });
    document.getElementById('btn-dd-more').addEventListener('click', (e) => {
      e.stopPropagation();
      const already = dropdownMenus.more.classList.contains('open');
      closeAllDropdowns();
      if (!already) openDropdown('more');
    });

    // 点任意地方关闭所有下拉
    document.addEventListener('click', () => closeAllDropdowns());
    // 菜单内点击不关闭（由各 item handler 负责关闭）
    Object.values(dropdownMenus).forEach(el => {
      if (el) el.addEventListener('click', e => e.stopPropagation());
    });
    // 「更多」菜单项点击后关闭菜单（它们打开的是侧边面板）
    ['btn-llm-config', 'btn-style', 'btn-cover'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => closeAllDropdowns());
    });

    // ─── 微信 ───
    // 复制内容（向 extension 请求带内联 CSS 的 HTML，再写入剪贴板）
    document.getElementById('btn-copy').addEventListener('click', () => {
      closeAllDropdowns();
      const btn = document.getElementById('btn-copy');
      btn.disabled = true;
      const label = btn.querySelector('.item-label');
      if (label) label.textContent = '⏳ 处理中...';
      vscode.postMessage({ type: 'getWechatHtml' });
    });

    // 上传公众号草稿箱
    document.getElementById('btn-upload').addEventListener('click', () => {
      closeAllDropdowns();
      togglePanel('upload-panel', 'uploadPanelOpen',
        [{panelId:'style-panel',stateKey:'stylePanelOpen'},{panelId:'xhs-panel',stateKey:'xhsPanelOpen'},{panelId:'zhihu-publish-panel',stateKey:'zhihuPublishPanelOpen'}]);
      if (panelState.uploadPanelOpen) {
        const titleInput = document.getElementById('input-title');
        if (!titleInput.value && currentTitle) titleInput.value = currentTitle;
        vscode.postMessage({ type: 'getConfig' });
      }
    });

    // ─── 知乎 ───
    // 知乎复制
    document.getElementById('btn-zhihu').addEventListener('click', () => {
      closeAllDropdowns();
      const btn = document.getElementById('btn-zhihu');
      btn.disabled = true;
      const label = btn.querySelector('.item-label');
      if (label) label.textContent = '⏳ 处理中...';
      vscode.postMessage({ type: 'getZhihuHtml' });
    });

    // 知乎自动发布（打开侧面板）
    document.getElementById('btn-zhihu-publish').addEventListener('click', () => {
      closeAllDropdowns();
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

    const _allPanels = [
      {panelId:'style-panel',stateKey:'stylePanelOpen'},{panelId:'upload-panel',stateKey:'uploadPanelOpen'},
      {panelId:'zhihu-publish-panel',stateKey:'zhihuPublishPanelOpen'},{panelId:'xhs-panel',stateKey:'xhsPanelOpen'},
      {panelId:'twitter-panel',stateKey:'twitterPanelOpen'},{panelId:'ppt-panel',stateKey:'pptPanelOpen'},
      {panelId:'word-panel',stateKey:'wordPanelOpen'},{panelId:'llm-config-panel',stateKey:'llmConfigPanelOpen'},
      {panelId:'cover-panel',stateKey:'coverPanelOpen'}
    ];

    // ─── 小红书 ───
    // 截图为长图（打开 xhs 侧面板）
    document.getElementById('btn-xhs').addEventListener('click', () => {
      closeAllDropdowns();
      togglePanel('xhs-panel', 'xhsPanelOpen', _allPanels.filter(p => p.panelId !== 'xhs-panel'));
    });

    // 小红书长文复制
    document.getElementById('btn-xhs-copy').addEventListener('click', () => {
      closeAllDropdowns();
      const btn = document.getElementById('btn-xhs-copy');
      btn.disabled = true;
      const label = btn.querySelector('.item-label');
      if (label) label.textContent = '⏳ 处理中...';
      vscode.postMessage({ type: 'getXhsCopyHtml' });
    });

    // ─── Twitter ───
    document.getElementById('btn-twitter').addEventListener('click', () => {
      togglePanel('twitter-panel', 'twitterPanelOpen', _allPanels.filter(p => p.panelId !== 'twitter-panel'));
    });

    // ─── 导出格式 ───
    document.getElementById('btn-ppt').addEventListener('click', () => {
      closeAllDropdowns();
      togglePanel('ppt-panel', 'pptPanelOpen', _allPanels.filter(p => p.panelId !== 'ppt-panel'));
    });
    document.getElementById('btn-word').addEventListener('click', () => {
      closeAllDropdowns();
      togglePanel('word-panel', 'wordPanelOpen', _allPanels.filter(p => p.panelId !== 'word-panel'));
    });

    // ─── 封面 ───
    document.getElementById('btn-cover').addEventListener('click', () => {
      const wasOpen = panelState.coverPanelOpen;
      togglePanel('cover-panel', 'coverPanelOpen', _allPanels.filter(p => p.panelId !== 'cover-panel'));
      if (!wasOpen) {
        const t = document.getElementById('cover-title');
        if (t && !t.value && currentTitle) t.value = currentTitle;
      }
    });

    // ─── LLM 全局配置 ───
    document.getElementById('btn-llm-config').addEventListener('click', () => {
      const wasOpen = panelState.llmConfigPanelOpen;
      togglePanel('llm-config-panel', 'llmConfigPanelOpen', _allPanels.filter(p => p.panelId !== 'llm-config-panel'));
      if (!wasOpen) {
        window._m2a_formTouched = false;
        vscode.postMessage({ type: 'llmGetConfig' });
      }
    });
    document.getElementById('global-llm-save').addEventListener('click', () => {
      const baseUrl      = (document.getElementById('global-llm-base')  || {}).value || '';
      const model        = (document.getElementById('global-llm-model') || {}).value || '';
      const apiKey       = (document.getElementById('global-llm-key')   || {}).value || undefined;
      const preset       = (document.getElementById('global-llm-preset')|| {}).value || '';
      const customName   = (document.getElementById('global-llm-name')  || {}).value.trim();
      const profileId    = preset || 'custom';
      const profileName  = customName || preset || baseUrl;
      vscode.postMessage({ type: 'llmSaveConfig', baseUrl, model, apiKey, profileId, profileName });
    });
    document.getElementById('global-llm-test').addEventListener('click', () => {
      const result = document.getElementById('global-llm-result');
      if (result) { result.style.color = '#4ea1ff'; result.textContent = '正在测试连接…'; }
      vscode.postMessage({ type: 'llmTestConnection' });
    });
    document.getElementById('global-llm-clear').addEventListener('click', () => {
      const preset = (document.getElementById('global-llm-preset') || {}).value || '';
      const profileId = preset || 'custom';
      vscode.postMessage({ type: 'llmSaveConfig', profileId, apiKey: '' });
    });
    // 🎁 OpenRouter 免费模型：拉取并展示，点选自动填好接口地址 + 模型名
    const freeBtn  = document.getElementById('global-llm-free-btn');
    const freeList = document.getElementById('global-llm-free-list');
    if (freeBtn) freeBtn.addEventListener('click', () => {
      freeBtn.textContent = '⏳ 正在拉取免费模型…';
      freeBtn.disabled = true;
      vscode.postMessage({ type: 'llmFetchFreeModels' });
    });
    if (freeList) freeList.addEventListener('click', (e) => {
      const item = e.target.closest('[data-slug]');
      if (!item) return;
      const base  = document.getElementById('global-llm-base');
      const mdl   = document.getElementById('global-llm-model');
      const psel  = document.getElementById('global-llm-preset');
      if (base) base.value = 'https://openrouter.ai/api/v1';
      if (mdl)  mdl.value  = item.dataset.slug;
      if (psel) psel.value  = 'openrouter';
      freeList.style.display = 'none';
      const result = document.getElementById('global-llm-result');
      if (result) { result.style.color = '#3ddc84'; result.textContent = '已填入：' + item.dataset.slug + '（可直接保存并使用）'; }
    });

    // ─── 封面：拖拽/缩放/历史 + LLM ───
    let _coverBgDataUrl = '';
    let _coverLastPrompt = '';
    let _coverTitleState = { x:50, y:50, fontSize:78, width:70 };
    let _coverBgHistory = [];
    function coverApplyPreview(){
      const title=(document.getElementById('cover-title')||{}).value||currentTitle||'标题预览';
      const tagline=(document.getElementById('cover-tagline')||{}).value||'';
      const tEl=document.getElementById('cover-preview-title');
      const tlEl=document.getElementById('cover-preview-tagline');
      const wrap=document.getElementById('cover-draggable-title');
      if(tEl) { tEl.textContent=title; tEl.style.fontSize=_coverTitleState.fontSize+'px'; }
      if(tlEl) { tlEl.textContent=tagline; tlEl.style.display=tagline?'':'none'; }
      if(wrap){
        wrap.style.left=_coverTitleState.x+'%';
        wrap.style.top=_coverTitleState.y+'%';
        wrap.style.width=_coverTitleState.width+'%';
        wrap.style.transform='translate(-50%,-50%)';
      }
      const fsVal=document.getElementById('cover-fontsize-val');
      const wVal=document.getElementById('cover-width-val');
      const fsInput=document.getElementById('cover-fontsize');
      const wInput=document.getElementById('cover-width');
      if(fsVal) fsVal.textContent=_coverTitleState.fontSize;
      if(wVal) wVal.textContent=_coverTitleState.width+'%';
      if(fsInput) fsInput.value=_coverTitleState.fontSize;
      if(wInput) wInput.value=_coverTitleState.width;
      const bgPrev=document.getElementById('cover-preview-bg');
      if(bgPrev) {
        if(_coverBgDataUrl) bgPrev.src=_coverBgDataUrl;
        else bgPrev.removeAttribute('src');
        bgPrev.style.display=_coverBgDataUrl?'':'none';
      }
    }
    function coverSaveTitleStateDebounced(){
      clearTimeout(coverSaveTitleStateDebounced._t);
      coverSaveTitleStateDebounced._t=setTimeout(()=>{
        vscode.postMessage({ type:'coverSaveTitleState', x:_coverTitleState.x, y:_coverTitleState.y, fontSize:_coverTitleState.fontSize, width:_coverTitleState.width });
      }, 400);
    }
    function coverRenderHistory(list, defaultId){
      const c=document.getElementById('cover-bg-history');
      if(!c) return;
      if(!list||!list.length){ c.innerHTML='<span style="font-size:11px;color:#666;">暂无历史，上传后自动保留</span>'; return; }
      c.innerHTML=list.map(function(item){
        const isDef=item.id===defaultId;
        return '<div data-id="'+item.id+'" style="position:relative;width:72px;height:96px;border:2px solid '+(isDef?'#ff2442':'#333')+';border-radius:6px;overflow:hidden;cursor:pointer;background:#111;" title="'+(item.name||'')+'">'
          +'<img src="'+item.dataUrl+'" style="width:100%;height:100%;object-fit:cover;">'
          +'<button data-del="'+item.id+'" style="position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:50%;border:none;background:rgba(0,0,0,0.65);color:#fff;font-size:10px;cursor:pointer;line-height:16px;">\u00d7</button>'
          +(isDef?'<span style="position:absolute;bottom:0;left:0;right:0;background:rgba(255,36,66,0.9);color:#fff;font-size:8px;text-align:center;padding:1px 0;">默认</span>':'')
          +'</div>';
      }).join('');
      c.querySelectorAll('[data-id]').forEach(function(el){
        el.addEventListener('click', function(e){
          if(e.target.hasAttribute('data-del')) return;
          const id=el.getAttribute('data-id');
          const it=list.find(function(x){return x.id===id;});
          if(it){ _coverBgDataUrl=it.dataUrl; const inp=document.getElementById('cover-bg'); if(inp) inp.value='[历史] '+it.name; coverApplyPreview(); vscode.postMessage({type:'coverSetDefaultBg', id:id}); }
        });
      });
      c.querySelectorAll('[data-del]').forEach(function(btn){
        btn.addEventListener('click', function(e){
          e.stopPropagation();
          const id=btn.getAttribute('data-del');
          vscode.postMessage({type:'coverDeleteBg', id:id});
        });
      });
    }
    // 拖拽
    (function(){
      const wrap=document.getElementById('cover-preview-wrap');
      const drag=document.getElementById('cover-draggable-title');
      if(!wrap||!drag) return;
      let dragging=false, startX=0, startY=0, startLeft=0, startTop=0;
      function getPos(e){
        const rect=wrap.getBoundingClientRect();
        const cx=(e.touches?e.touches[0].clientX:e.clientX);
        const cy=(e.touches?e.touches[0].clientY:e.clientY);
        return { cx:cx, cy:cy, rect:rect };
      }
      drag.addEventListener('mousedown', function(e){
        dragging=true; drag.style.cursor='grabbing'; wrap.style.cursor='grabbing';
        const p=getPos(e); startX=p.cx; startY=p.cy; startLeft=_coverTitleState.x; startTop=_coverTitleState.y;
        e.preventDefault();
      });
      drag.addEventListener('touchstart', function(e){
        dragging=true; const p=getPos(e); startX=p.cx; startY=p.cy; startLeft=_coverTitleState.x; startTop=_coverTitleState.y; e.preventDefault();
      }, {passive:false});
      window.addEventListener('mousemove', function(e){
        if(!dragging) return;
        const p=getPos(e);
        const dx=(p.cx-startX)/p.rect.width*100;
        const dy=(p.cy-startY)/p.rect.height*100;
        _coverTitleState.x=Math.max(10, Math.min(90, startLeft+dx));
        _coverTitleState.y=Math.max(10, Math.min(90, startTop+dy));
        coverApplyPreview();
      });
      window.addEventListener('touchmove', function(e){
        if(!dragging) return;
        const p=getPos(e);
        const dx=(p.cx-startX)/p.rect.width*100;
        const dy=(p.cy-startY)/p.rect.height*100;
        _coverTitleState.x=Math.max(10, Math.min(90, startLeft+dx));
        _coverTitleState.y=Math.max(10, Math.min(90, startTop+dy));
        coverApplyPreview(); e.preventDefault();
      }, {passive:false});
      window.addEventListener('mouseup', function(){ if(dragging){ dragging=false; drag.style.cursor='move'; wrap.style.cursor='grab'; } });
      window.addEventListener('touchend', function(){ if(dragging){ dragging=false; } });
      // 滚轮缩放字号：仅按住 Ctrl/Cmd 时生效，避免触控板双指滚动误触
      wrap.addEventListener('wheel', function(e){
        if(!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const delta=e.deltaY>0?-2:2;
        _coverTitleState.fontSize=Math.max(28, Math.min(120, _coverTitleState.fontSize+delta));
        coverApplyPreview();
      }, {passive:false});
    })();
    // 标题/标语实时预览
    ['cover-title','cover-tagline'].forEach(function(id){
      const el=document.getElementById(id);
      if(el) el.addEventListener('input', function(){ coverApplyPreview(); });
    });
    // 滑条
    (function(){
      const fs=document.getElementById('cover-fontsize');
      const w=document.getElementById('cover-width');
      if(fs) fs.addEventListener('input', function(){ _coverTitleState.fontSize=parseInt(fs.value,10)||78; coverApplyPreview(); });
      if(w) w.addEventListener('input', function(){ _coverTitleState.width=parseInt(w.value,10)||70; coverApplyPreview(); });
      const reset=document.getElementById('btn-cover-reset-pos');
      if(reset) reset.addEventListener('click', function(){ _coverTitleState={x:50,y:50,fontSize:78,width:70}; coverApplyPreview(); });
      const confirmBtn=document.getElementById('btn-cover-confirm');
      if(confirmBtn) confirmBtn.addEventListener('click', function(){
        vscode.postMessage({ type:'coverSaveTitleState', x:_coverTitleState.x, y:_coverTitleState.y, fontSize:_coverTitleState.fontSize, width:_coverTitleState.width });
        showToast('✅ 排版已确认，将作为以后默认值','success');
        confirmBtn.textContent='✓ 已确认';
        setTimeout(function(){ confirmBtn.textContent='✓ 确认排版'; }, 1500);
      });
    })();
    // 背景上传：自动设为默认并入历史
    (function(){
      const el=document.getElementById('cover-bg-file');
      if(el) el.addEventListener('change', function(e){
        const f=e.target.files&&e.target.files[0];
        if(!f) return;
        const reader=new FileReader();
        reader.onload=function(){
          const dataUrl=reader.result;
          vscode.postMessage({ type:'coverSaveBg', dataUrl:dataUrl, name:f.name });
          _coverBgDataUrl=dataUrl; coverApplyPreview();
          const inp=document.getElementById('cover-bg'); if(inp) inp.value='[本地文件] '+f.name;
        };
        reader.readAsDataURL(f);
        el.value='';
      });
      const bgInput=document.getElementById('cover-bg');
      if(bgInput) bgInput.addEventListener('input', function(){
        const v=bgInput.value.trim();
        if(!v){ _coverBgDataUrl=''; coverApplyPreview(); return; }
        if(v.startsWith('http')||v.startsWith('data:')){ _coverBgDataUrl=v; coverApplyPreview(); }
      });
    })();
    // 封面面板打开时加载历史与默认排版
    (function(){
      const btn=document.getElementById('btn-cover');
      if(btn) btn.addEventListener('click', function(){ setTimeout(function(){ vscode.postMessage({type:'coverGetHistory'}); }, 80); });
      // 首次若已打开也拉一次
      setTimeout(function(){ vscode.postMessage({type:'coverGetHistory'}); }, 800);
    })();
    document.getElementById('btn-cover-generate').addEventListener('click', function(){
      const title=(document.getElementById('cover-title')||{}).value||currentTitle||'';
      if(!title.trim()){ showToast('请填写封面标题','error'); return; }
      const btn=document.getElementById('btn-cover-generate');
      btn.disabled=true; btn.textContent='⏳ 合成中...';
      document.getElementById('cover-progress').textContent='⏳ 正在合成封面...';
      const tagline=(document.getElementById('cover-tagline')||{}).value||'';
      let bg=_coverBgDataUrl|| (document.getElementById('cover-bg')||{}).value||'';
      vscode.postMessage({ type:'coverGenerate', title:title, tagline:tagline, bgDataUrl:bg, titleState:_coverTitleState });
    });
    document.getElementById('btn-cover-copy').addEventListener('click', async function(){
      const img=document.getElementById('cover-result-img');
      if(!img||!img.src) return;
      try{ await navigator.clipboard.writeText(img.src); showToast('已复制 data URL','success'); }catch(e){ showToast('复制失败','error'); }
    });
    (function(){
      const img=document.getElementById('cover-result-img');
      const genImg=document.getElementById('cover-bg-gen-img');
      [img,genImg].forEach(function(el){
        if(!el) return;
        el.addEventListener('click', function(){
          const lb=document.getElementById('xhs-lightbox');
          const lbImg=document.getElementById('xhs-lightbox-img');
          if(lb&&lbImg&&el.src){ lbImg.src=el.src; lb.classList.add('show'); }
        });
      });
    })();
    document.getElementById('btn-cover-prompt').addEventListener('click', function(){
      const title=(document.getElementById('cover-title')||{}).value||currentTitle||'';
      const vibe=(document.getElementById('cover-vibe')||{}).value||'';
      const instruction=(document.getElementById('cover-instruction')||{}).value||'';
      const btn=document.getElementById('btn-cover-prompt');
      btn.disabled=true; btn.textContent='⏳ 生成中';
      document.getElementById('cover-llm-progress').textContent='⏳ 正在生成 Prompt...';
      const abstract=(currentBodyHtml||'').replace(/<[^>]+>/g,' ').slice(0,800);
      vscode.postMessage({ type:'coverGeneratePrompt', title:title, abstract:abstract, vibe:vibe, instruction:instruction });
    });
    document.getElementById('btn-cover-image').addEventListener('click', function(){
      let prompt=_coverLastPrompt;
      const outEl=document.getElementById('cover-prompt-out');
      if(!prompt && outEl && outEl.dataset.prompt) prompt=outEl.dataset.prompt;
      if(!prompt){ showToast('请先生成 Prompt','error'); return; }
      const btn=document.getElementById('btn-cover-image');
      btn.disabled=true; btn.textContent='⏳ 生图中';
      document.getElementById('cover-llm-progress').textContent='⏳ 正在生成背景图（无字）...';
      vscode.postMessage({ type:'coverGenerateImage', prompt:prompt, negativePrompt:'' });
    });

    // ─── PPT 导出 ───

    function setPptProgress(step, total, label) {
      const wrap = document.getElementById('ppt-progress-wrap');
      const lbl  = document.getElementById('ppt-progress-label');
      const stp  = document.getElementById('ppt-progress-step');
      const bar  = document.getElementById('ppt-progress-bar');
      if (!wrap) return;
      wrap.style.display = 'block';
      if (lbl) lbl.textContent = label || '';
      if (stp) stp.textContent = step + (total ? '/' + total : '');
      if (bar) bar.style.width = total ? Math.min(100, Math.round((step / total) * 100)) + '%' : '50%';
    }

    // 当前选中的 ppt backend
    function getPptBackend() {
      const el = document.querySelector('input[name="ppt-backend"]:checked');
      return el ? el.value : 'slidev';
    }

    // Backend 切换：显示/隐藏对应选项，自动刷新 LLM 指令
    document.querySelectorAll('input[name="ppt-backend"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const backend = getPptBackend();
        document.getElementById('ppt-slidev-opts').style.display = backend === 'slidev' ? '' : 'none';
        document.getElementById('ppt-marp-opts').style.display   = backend === 'marp'   ? '' : 'none';
        document.getElementById('ppt-pandoc-opts').style.display = backend === 'pandoc' ? '' : 'none';
        // 预览 label 更新
        const lbl = document.getElementById('ppt-llm-preview-label');
        if (lbl) lbl.textContent = \`改写后的 \${backend === 'pandoc' ? 'Pandoc' : backend === 'marp' ? 'Marp' : 'Slidev'} Markdown（可直接编辑）\`;
        // 已启用 LLM 且指令未手动改过时，自动切换到新 backend 对应的默认指令
        if (document.getElementById('ppt-llm-enable').checked) {
          vscode.postMessage({ type: 'getPptLlmInstruction', backend });
        }
      });
    });

    // LLM 开关
    document.getElementById('ppt-llm-enable').addEventListener('change', (e) => {
      document.getElementById('ppt-llm-opts').style.display = e.target.checked ? '' : 'none';
      if (e.target.checked) {
        const ta = document.getElementById('ppt-llm-instruction');
        if (!ta.value) vscode.postMessage({ type: 'getPptLlmInstruction', backend: getPptBackend() });
        // 同时加载该 backend 的版本历史
        vscode.postMessage({ type: 'pptGetVersions', backend: getPptBackend() });
      }
    });

    // 重置指令：根据当前选中 backend 重置为对应默认 prompt
    document.getElementById('btn-ppt-llm-reset').addEventListener('click', () => {
      vscode.postMessage({ type: 'getPptLlmInstruction', backend: getPptBackend() });
    });

    // 预览改写结果
    document.getElementById('btn-ppt-llm-preview').addEventListener('click', () => {
      const instruction = document.getElementById('ppt-llm-instruction').value;
      const btn = document.getElementById('btn-ppt-llm-preview');
      btn.disabled = true; btn.textContent = '⏳ 改写中...';
      setPptProgress(1, 3, '正在调用 LLM 改写...');
      document.getElementById('ppt-result').style.display = 'none';
      vscode.postMessage({ type: 'pptLlmGenerate', instruction, backend: getPptBackend() });
    });

    document.getElementById('btn-ppt-llm-preview-close').addEventListener('click', () => {
      document.getElementById('ppt-llm-preview-wrap').style.display = 'none';
    });

    // ─── PPT 版本管理 ───────────────────────────────────────
    let _pptVerState = { current: -1, total: 0, list: [] };

    function updatePptVerBar(versions) {
      if (!versions) return;
      _pptVerState = versions;
      const bar   = document.getElementById('ppt-ver-bar');
      const label = document.getElementById('ppt-ver-label');
      if (!bar) return;
      if (versions.total <= 0) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      const v = versions.list[versions.current];
      const dt = v ? new Date(v.at).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
      const src = v ? v.instruction.slice(0, 20) || '(无指令)' : '';
      label.textContent = \`版本 \${versions.current + 1}/\${versions.total}  \${dt}  \${src}…\`;
      document.getElementById('btn-ppt-ver-prev').disabled = versions.current <= 0;
      document.getElementById('btn-ppt-ver-next').disabled = versions.current >= versions.total - 1;
    }

    // 保存当前编辑内容到当前版本
    document.getElementById('btn-ppt-ver-save').addEventListener('click', () => {
      const markdown = document.getElementById('ppt-llm-preview-text').value;
      vscode.postMessage({ type: 'pptSaveVersion', backend: getPptBackend(), markdown });
    });

    // 切换版本 ◀ ▶
    document.getElementById('btn-ppt-ver-prev').addEventListener('click', () => {
      if (_pptVerState.current > 0)
        vscode.postMessage({ type: 'pptSwitchVersion', backend: getPptBackend(), index: _pptVerState.current - 1 });
    });
    document.getElementById('btn-ppt-ver-next').addEventListener('click', () => {
      if (_pptVerState.current < _pptVerState.total - 1)
        vscode.postMessage({ type: 'pptSwitchVersion', backend: getPptBackend(), index: _pptVerState.current + 1 });
    });

    // 删除当前版本
    document.getElementById('btn-ppt-ver-del').addEventListener('click', () => {
      if (!_pptVerState.total) return;
      if (!confirm(\`确认删除版本 \${_pptVerState.current + 1}？\`)) return;
      vscode.postMessage({ type: 'pptDeleteVersion', backend: getPptBackend(), index: _pptVerState.current });
    });

    // backend 切换时拉取该 backend 的版本历史（追加到已有 change listener 上）
    document.querySelectorAll('input[name="ppt-backend"]').forEach(r => {
      r.addEventListener('change', () => {
        if (document.getElementById('ppt-llm-enable').checked) {
          vscode.postMessage({ type: 'pptGetVersions', backend: getPptBackend() });
        }
      });
    });

    // 生成按钮
    document.getElementById('btn-ppt-export').addEventListener('click', () => {
      const backend    = getPptBackend();
      const theme      = document.getElementById('ppt-slidev-theme').value;
      const marpTheme  = document.getElementById('ppt-marp-theme').value;
      const pandocTheme= document.getElementById('ppt-pandoc-theme').value;
      const split      = document.getElementById('ppt-split').value;
      const llmEnabled = document.getElementById('ppt-llm-enable').checked;
      const llmMd      = llmEnabled ? (document.getElementById('ppt-llm-preview-text').value || '') : '';

      const btn    = document.getElementById('btn-ppt-export');
      const cancel = document.getElementById('btn-ppt-cancel');
      const result = document.getElementById('ppt-result');
      btn.disabled = true; btn.textContent = '⏳ 生成中...';
      if (cancel) cancel.style.display = '';
      result.style.display = 'none';
      setPptProgress(1, 5, '准备中...');

      vscode.postMessage({ type: 'exportPpt', backend, theme, marpTheme, pandocTheme, split, llmEnabled, llmMd });
    });

    document.getElementById('btn-ppt-cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelPpt' });
      const cancel = document.getElementById('btn-ppt-cancel');
      if (cancel) cancel.style.display = 'none';
    });

    // ─── Word 导出 ───
    document.getElementById('btn-word-export').addEventListener('click', () => {
      const mathFmt = document.getElementById('word-math').value;
      const hlStyle = document.getElementById('word-highlight').value;
      const btn    = document.getElementById('btn-word-export');
      const prog   = document.getElementById('word-progress');
      const result = document.getElementById('word-result');
      btn.disabled = true; btn.textContent = '⏳ 生成中...';
      prog.style.display = 'block'; prog.textContent = '⏳ 正在用 pandoc 转换...';
      result.style.display = 'none';
      vscode.postMessage({ type: 'exportWord', mathFmt, hlStyle });
    });

    document.getElementById('btn-xhs-python').addEventListener('click', () => {
      const imgW   = parseInt(document.getElementById('xhs-width').value)   || XHS_DEFAULTS.width;
      const imgH   = parseInt(document.getElementById('xhs-height').value)  || XHS_DEFAULTS.height;
      const pad    = parseInt(document.getElementById('xhs-padding').value) || 0;
      const density = parseInt(document.getElementById('xhs-density').value) || 100;
      const bgColor = currentThemeBg || '#ffffff';
      const mode    = getXhsExportMode();
      const btn = document.getElementById('btn-xhs-python');
      btn.disabled = true; btn.textContent = '⏳ 渲染中...';
      document.getElementById('xhs-output').innerHTML = '<p class="hint">⏳ 正在生成，请稍候...</p>';
      vscode.postMessage({ type: 'generateXhsViaPython', width: imgW, height: imgH, padding: pad, bg: bgColor, autoExport: false, mode, density });
    });

    document.getElementById('btn-xhs-reset').addEventListener('click', () => {
      applyXhsModeDefaults(getXhsExportMode(), 'factory');
      showToast('已恢复系统出厂参数');
    });
    document.getElementById('btn-xhs-save-defaults').addEventListener('click', () => {
      const mode = getXhsExportMode();
      xhsSaveUserDefs(mode, {
        width:     parseInt(document.getElementById('xhs-width').value)     || XHS_DEFAULTS.width,
        height:    parseInt(document.getElementById('xhs-height').value)    || XHS_DEFAULTS.height,
        padding:   parseInt(document.getElementById('xhs-padding').value)   || 0,
        tolerance: parseInt(document.getElementById('xhs-tolerance').value) || 0,
        density:   parseInt(document.getElementById('xhs-density').value)   || (mode === 'adaptive' ? 36 : 100),
      });
      showToast('已设为' + (mode === 'adaptive' ? '自适应' : '默认') + '模式的默认参数 ✓', 'success');
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
        const imgW    = parseInt(document.getElementById('xhs-width').value)   || XHS_DEFAULTS.width;
        const imgH    = parseInt(document.getElementById('xhs-height').value)  || XHS_DEFAULTS.height;
        const pad     = parseInt(document.getElementById('xhs-padding').value) || 0;
        const density = parseInt(document.getElementById('xhs-density').value) || 100;
        const bgColor = currentThemeBg || '#ffffff';
        const mode    = getXhsExportMode();
        btn.disabled = true; btn.textContent = '⏳ 生成并导出中...';
        document.getElementById('btn-xhs-python').disabled = true;
        document.getElementById('btn-xhs-python').textContent = '⏳ 渲染中...';
        document.getElementById('xhs-output').innerHTML = '<p class="hint">⏳ 正在生成，请稍候...</p>';
        vscode.postMessage({ type: 'generateXhsViaPython', width: imgW, height: imgH, padding: pad, bg: bgColor, autoExport: true, mode, density });
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
      const outputPath = (document.getElementById('html-output-path').value || '').trim();
      closeAllDropdowns();
      vscode.postMessage({ type: 'exportHtml', outputPath });
    });

    document.getElementById('btn-style').addEventListener('click', () => {
      togglePanel('style-panel', 'stylePanelOpen',
        [{panelId:'upload-panel',stateKey:'uploadPanelOpen'},{panelId:'xhs-panel',stateKey:'xhsPanelOpen'},{panelId:'zhihu-publish-panel',stateKey:'zhihuPublishPanelOpen'}]);
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
    window.addEventListener('message', async ({ data: msg }) => {
      switch (msg.type) {
        case 'update': {
          currentBodyHtml = msg.bodyHtml || '';
          currentTitle    = msg.title || '';
          document.getElementById('preview-content').innerHTML = currentBodyHtml;
          // 有表格才显示「表格显示模式」切换按钮
          const tmb = document.getElementById('btn-table-mode');
          if (tmb) tmb.style.display = document.querySelector('#preview-content table') ? '' : 'none';
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
          const coverTitleInput = document.getElementById('cover-title');
          if (coverTitleInput && !coverTitleInput.value && currentTitle) { coverTitleInput.value = currentTitle; if(typeof coverApplyPreview==='function') try{ coverApplyPreview(); }catch(_){} }
          // 内容更新后同步重建目录
          if (panelState.tocPanelOpen) buildToc();
          break;
        }

        case 'syncToLine': {
          // 编辑器光标行 → 滚动到预览对应标题位置
          // data-source-line 只有标题元素有，找最近的小于等于目标行的那个
          const targetLine = typeof msg.line === 'number' ? msg.line : 0;
          const headings = Array.from(document.querySelectorAll('#preview-content [data-source-line]'));
          if (!headings.length) break;
          let best = null;
          for (const el of headings) {
            const l = parseInt(el.dataset.sourceLine, 10);
            if (l <= targetLine) best = el;
          }
          // 如果光标在第一个标题之前，滚到顶部
          if (!best) {
            document.getElementById('preview-scroll').scrollTo({ top: 0, behavior: 'smooth' });
            break;
          }
          const scroller = document.getElementById('preview-scroll');
          // offsetTop 已经在 CSS zoom 坐标系里，scrollTop 也是同一坐标系，直接使用
          scroller.scrollTo({ top: Math.max(0, best.offsetTop - 60), behavior: 'smooth' });
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
          const _wl = btn.querySelector('.item-label'); if (_wl) _wl.textContent = '复制到剪贴板';
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
          const _wle = btn.querySelector('.item-label'); if (_wle) _wle.textContent = '复制到剪贴板';
          showToast('复制失败：' + (msg.message || '未知错误'), 'error');
          break;
        }
        case 'zhihuHtml': {
          const btn = document.getElementById('btn-zhihu');
          btn.disabled = false;
          const _zl = btn.querySelector('.item-label'); if (_zl) _zl.textContent = '复制到剪贴板';
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
          btn.disabled = false;
          const _zle = btn.querySelector('.item-label'); if (_zle) _zle.textContent = '复制到剪贴板';
          showToast('复制失败：' + (msg.message || '未知错误'), 'error');
          break;
        }
        case 'xhsCopyHtml': {
          const btn = document.getElementById('btn-xhs-copy');
          btn.disabled = false;
          const _xl = btn.querySelector('.item-label'); if (_xl) _xl.textContent = '复制到剪贴板';
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
          btn.disabled = false;
          const _xle = btn.querySelector('.item-label'); if (_xle) _xle.textContent = '复制到剪贴板';
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
          document.getElementById('btn-xhs-export-all').textContent = '💾 一键导出全部';
          if (msg.autoExport) {
            // 截图脚本已将文件写到项目目录（xhs_NN.png），无需再走 saveXhsImages 重复保存
            showToast(\`✅ 已导出 \${msg.dataUrls.length} 张到 \${msg.outDir}\`, 'success', 4000);
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

        case 'pptLlmInstruction': {
          const ta = document.getElementById('ppt-llm-instruction');
          if (ta) ta.value = msg.instruction || '';
          break;
        }
        case 'pptLlmProgress': {
          setPptProgress(1, 3, msg.label || '');
          break;
        }
        case 'pptLlmResult': {
          const btn = document.getElementById('btn-ppt-llm-preview');
          if (btn) { btn.disabled = false; btn.textContent = '👁 预览改写结果'; }
          const wrap = document.getElementById('ppt-llm-preview-wrap');
          const ta   = document.getElementById('ppt-llm-preview-text');
          if (ta) ta.value = msg.slidevMd || '';
          if (wrap) wrap.style.display = '';
          document.getElementById('ppt-progress-wrap').style.display = 'none';
          // 更新版本导航栏
          if (msg.versions) updatePptVerBar(msg.versions);
          showToast('✅ AI 改写完成，已保存版本 ' + ((msg.versions?.current ?? 0) + 1), 'success');
          break;
        }

        case 'pptVersionsLoaded': {
          updatePptVerBar(msg.versions);
          if (msg.current) {
            const ta = document.getElementById('ppt-llm-preview-text');
            if (ta) { ta.value = msg.current; document.getElementById('ppt-llm-preview-wrap').style.display = ''; }
          }
          break;
        }
        case 'pptVersionSaved': {
          updatePptVerBar(msg.versions);
          showToast('✅ 已保存', 'success');
          break;
        }
        case 'pptVersionSwitched': {
          updatePptVerBar(msg.versions);
          const ta = document.getElementById('ppt-llm-preview-text');
          if (ta && msg.markdown !== undefined) ta.value = msg.markdown;
          break;
        }
        case 'pptVersionDeleted': {
          updatePptVerBar(msg.versions);
          const ta = document.getElementById('ppt-llm-preview-text');
          if (ta) ta.value = msg.markdown || '';
          if (!msg.versions?.total) document.getElementById('ppt-llm-preview-wrap').style.display = 'none';
          showToast('已删除', '');
          break;
        }
        case 'pptLlmError': {
          const btn = document.getElementById('btn-ppt-llm-preview');
          if (btn) { btn.disabled = false; btn.textContent = '👁 预览改写结果'; }
          document.getElementById('ppt-progress-wrap').style.display = 'none';
          showToast('❌ LLM 改写失败：' + (msg.message || ''), 'error', 4000);
          break;
        }
        case 'pptProgress': {
          setPptProgress(msg.step || 1, msg.total || 5, msg.label || '');
          break;
        }
        case 'pptResult': {
          const btn = document.getElementById('btn-ppt-export');
          if (btn) { btn.disabled = false; btn.textContent = '📊 生成 PPTX'; }
          const cancel = document.getElementById('btn-ppt-cancel');
          if (cancel) cancel.style.display = 'none';
          const wrap = document.getElementById('ppt-progress-wrap');
          if (wrap) wrap.style.display = 'none';
          const bar = document.getElementById('ppt-progress-bar');
          if (bar) bar.style.width = '0%';
          const res = document.getElementById('ppt-result');
          if (res) {
            if (msg.success) {
              res.className = 'upload-result success';
              res.textContent = \`✅ 已生成：\${msg.filename || 'output.pptx'}\`;
              showToast('PPTX 已生成！', 'success');
            } else {
              res.className = 'upload-result error';
              res.textContent = msg.error === '已取消'
                ? '⏹ 已取消'
                : \`❌ 生成失败：\${msg.error || '未知错误'}\`;
            }
            res.style.display = 'block';
          }
          break;
        }

        case 'wordProgress': {
          const prog = document.getElementById('word-progress');
          if (prog) { prog.style.display = 'block'; prog.textContent = msg.message || ''; }
          break;
        }
        case 'wordResult': {
          const btn = document.getElementById('btn-word-export');
          if (btn) { btn.disabled = false; btn.textContent = '📄 生成 Word'; }
          const prog = document.getElementById('word-progress');
          if (prog) prog.style.display = 'none';
          const res = document.getElementById('word-result');
          if (res) {
            if (msg.success) {
              res.className = 'upload-result success';
              res.textContent = \`✅ 已生成：\${msg.filename || 'output.docx'}\`;
              showToast('Word 已生成！', 'success');
            } else {
              res.className = 'upload-result error';
              res.textContent = \`❌ 生成失败：\${msg.error || '未知错误'}\`;
            }
            res.style.display = 'block';
          }
          break;
        }

        case 'coverProgress': {
          const el=document.getElementById('cover-progress');
          if(el) el.textContent=msg.message||'';
          break;
        }
        case 'coverResult': {
          const btn=document.getElementById('btn-cover-generate');
          if(btn){ btn.disabled=false; btn.textContent='🎨 脚本合成封面'; }
          const prog=document.getElementById('cover-progress');
          const wrap=document.getElementById('cover-result');
          const img=document.getElementById('cover-result-img');
          const pathEl=document.getElementById('cover-result-path');
          if(msg.ok){
            if(img) img.src=msg.dataUrl||'';
            if(wrap) wrap.style.display='';
            if(pathEl) pathEl.textContent=msg.outPath||'';
            if(prog) prog.textContent='✅ 已生成';
            showToast('✅ 封面已生成','success');
          } else {
            if(prog) prog.textContent='❌ '+ (msg.message||'失败');
            showToast('封面失败: '+(msg.message||''),'error');
          }
          break;
        }
        case 'coverPromptResult': {
          const btn=document.getElementById('btn-cover-prompt');
          if(btn){ btn.disabled=false; btn.textContent='✨ 生成 Prompt'; }
          const prog=document.getElementById('cover-llm-progress');
          const out=document.getElementById('cover-prompt-out');
          if(msg.ok){
            _coverLastPrompt=msg.prompt||'';
            if(out){
              out.dataset.prompt=msg.prompt||'';
              out.textContent='Prompt:\\n'+(msg.prompt||'')+'\\n\\n调色: '+(msg.palette||'')+'\\n布局: '+(msg.layoutHint||'');
              out.style.display='';
            }
            if(prog) prog.textContent='✅ Prompt 已生成，可点“生成背景图”';
            showToast('✅ Prompt 已生成','success');
          } else {
            if(prog) prog.textContent='❌ '+(msg.message||'');
            showToast('Prompt 失败: '+(msg.message||''),'error');
          }
          break;
        }
        case 'coverImageResult': {
          const btn=document.getElementById('btn-cover-image');
          if(btn){ btn.disabled=false; btn.textContent='🎨 生成背景图'; }
          const prog=document.getElementById('cover-llm-progress');
          const wrap=document.getElementById('cover-bg-gen-preview');
          const img=document.getElementById('cover-bg-gen-img');
          if(msg.ok){
            _coverBgDataUrl=msg.dataUrl||'';
            const bgInp=document.getElementById('cover-bg');
            if(bgInp) bgInp.value='[LLM 生成] '+ (msg.outPath||'');
            // 同步到背景预览
            const prev=document.getElementById('cover-bg-preview');
            const prevImg=document.getElementById('cover-bg-preview-img');
            if(prev&&prevImg){ prevImg.src=msg.dataUrl; prev.style.display=''; }
            if(wrap&&img){ img.src=msg.dataUrl; wrap.style.display=''; }
            if(prog) prog.textContent='✅ 背景图已生成，已填入背景栏，可直接合成封面';
            showToast('✅ 背景图已生成','success');
          } else {
            if(prog) prog.textContent='❌ '+(msg.message||'') + (msg.needCopy?'\\n提示：当前模型不支持生图，已复制 Prompt，可去即梦/MJ 生成后拖回':'');
            if(msg.needCopy && _coverLastPrompt){
              try{ await navigator.clipboard.writeText(_coverLastPrompt); showToast('Prompt 已复制，去外部生图后拖回','',4000);}catch(_){}
            }
            showToast('生图失败: '+(msg.message||''),'error');
          }
          break;
        }
        case 'coverHistory': {
          _coverBgHistory = msg.bgs || [];
          if(msg.titleState){ _coverTitleState = { x: msg.titleState.x||50, y: msg.titleState.y||50, fontSize: msg.titleState.fontSize||78, width: msg.titleState.width||70 }; }
          // 自动选中默认底图
          const def = _coverBgHistory.find(function(b){return b.id===msg.defaultBgId;}) || _coverBgHistory[0];
          if(def && !_coverBgDataUrl){
            _coverBgDataUrl = def.dataUrl;
            const inp=document.getElementById('cover-bg'); if(inp) inp.value='[历史] '+def.name;
          } else if(def && _coverBgHistory.length) {
            // 若当前无选中，但历史有，则保持预览为默认（仅首次）
            if(!_coverBgDataUrl) { _coverBgDataUrl=def.dataUrl; }
          }
          if(typeof coverRenderHistory==='function') coverRenderHistory(_coverBgHistory, msg.defaultBgId);
          if(typeof coverApplyPreview==='function') coverApplyPreview();
          break;
        }
        case 'coverSaveBgDone': {
          if(!msg.ok){ showToast('保存底图失败: '+(msg.message||''),'error'); }
          else { showToast('✅ 底图已保存并设为默认','success'); }
          break;
        }
      }
    });

    // ─── 局部缩放：transform scale + 拖拽平移 ───
    // 用 transform:scale() 代替 zoom，放大后可拖拽查看任意局部，不影响滚动位置
    // ─── 缩放系统：两种模式 ───────────────────────────────────
    // 整体缩放（工具栏 ＋/－/↺）：改 font-size，内容正常重排，位置稳定
    // ─── 缩放系统 ───────────────────────────────────────────────
    // 所有缩放方式（工具栏+/-、触控板双指、Ctrl+滚轮）统一做局部缩放：
    // 以当前视口中心为锚点，缩放后该锚点对应的内容保持在视口同一位置。
    // 实现：CSS zoom 影响布局（scrollHeight 等比变化），
    // 缩放前后保持"锚点内容位置 / scrollHeight"的比值不变，反算出新的 scrollTop。

    let currentZoom = 100;  // 当前缩放百分比，100 = 原始大小

    function applyZoom(newZoom, anchorY) {
      const scroller = document.getElementById('preview-scroll');
      const canvas   = document.getElementById('zoom-canvas');
      if (!canvas || !scroller) return;

      newZoom = Math.max(30, Math.min(500, Math.round(newZoom)));
      if (newZoom === currentZoom) return;

      // 锚点：视口内哪个 Y 坐标的内容要保持不动
      // 传入 anchorY（鼠标位置）；不传则用视口中心
      const ay = (anchorY !== undefined) ? anchorY : scroller.clientHeight / 2;

      // 缩放前，锚点对应的内容坐标 = scrollTop + ay
      // （scrollTop 和 ay 都在"已缩放"坐标系里，二者一致）
      const anchorContent = scroller.scrollTop + ay;

      const ratio = newZoom / currentZoom;
      currentZoom = newZoom;
      canvas.style.zoom = currentZoom / 100;

      // 读 scrollHeight 触发同步 layout reflow，确保 zoom 已生效
      void scroller.scrollHeight;

      // 缩放后同一内容点在新坐标系里的位置 = anchorContent * ratio
      // 要让它仍出现在视口的 ay 处：scrollTop = anchorContent * ratio - ay
      scroller.scrollTop = anchorContent * ratio - ay;

      const zv = document.getElementById('zoom-value');
      if (zv) zv.textContent = currentZoom + '%';
    }

    // 工具栏 +/- 以视口中心为锚点
    const scrollEl = document.getElementById('preview-scroll');
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      applyZoom(currentZoom + 10);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      applyZoom(currentZoom - 10);
    });
    document.getElementById('btn-zoom-reset').addEventListener('click', () => {
      currentZoom = 100;
      document.getElementById('zoom-canvas').style.zoom = 1;
      document.getElementById('preview-scroll').scrollTop = 0;
      const zv = document.getElementById('zoom-value');
      if (zv) zv.textContent = '100%';
    });

    // 触控板双指捏合 / Ctrl+滚轮 → 以鼠标位置为锚点
    // macOS 触控板 pinch 会触发 ctrlKey=true 的 wheel 事件，deltaY 是小数
    // 普通鼠标滚轮 deltaY 通常是 ±100，用比例因子统一处理
    scrollEl.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect   = scrollEl.getBoundingClientRect();
      const mouseY = e.clientY - rect.top;
      // 触控板 pinch: deltaY 是小数（±1~5），鼠标滚轮: ±100~120
      // 统一换算为缩放比例：每 100 deltaY 对应 20% 变化
      const factor = Math.abs(e.deltaY) < 10
        ? e.deltaY * 0.5          // 触控板：精细控制
        : e.deltaY > 0 ? 10 : -10; // 鼠标滚轮：固定步长
      applyZoom(currentZoom - factor, mouseY);
    }, { passive: false });

    // ─── 表格显示模式：横向滚动 ↔ 完整显示 ───
    // 横向滚动（默认）：宽表格在正文宽度内滚动，不撑宽整页排版
    // 完整显示：宽表格自然展开，预览区出现横向滚动条以看全表（仅预览，不影响导出 HTML）
    const tableModeBtn = document.getElementById('btn-table-mode');
    let tablesExpanded = false;
    try {
      // 防御：某些环境 getState 可能异常，不允许它阻断整个 webview 初始化
      const st = (typeof vscode !== 'undefined' && vscode.getState) ? vscode.getState() : null;
      tablesExpanded = !!(st && st.tablesExpanded);
    } catch (_) {}

    function applyTableMode() {
      document.body.classList.toggle('tables-expanded', tablesExpanded);
      if (!tableModeBtn) return;
      tableModeBtn.textContent = tablesExpanded ? '▦ 展开' : '▦ 滚动';
      tableModeBtn.setAttribute('data-tip', tablesExpanded
        ? '当前：完整显示。点击切换为「横向滚动」——宽表格在正文内滚动，不撑宽排版'
        : '当前：横向滚动。点击切换为「完整显示」——宽表格完整展示，可横向滚动看全表');
    }
    if (tableModeBtn) {
      tableModeBtn.addEventListener('click', () => {
        tablesExpanded = !tablesExpanded;
        if (vscode.setState) vscode.setState({ tablesExpanded });
        applyTableMode();
        showToast(tablesExpanded ? '表格：完整显示' : '表格：横向滚动', '', 1500);
      });
    }
    applyTableMode();

    // ─── 双向同步：编辑器 ↔ 预览（纯手动，不自动触发）───
    // data-source-line 已在渲染时注入到每个标题元素，无需手动配对

    // 「→ 预览」按钮：请求编辑器当前光标行，extension 推送 syncToLine 消息
    document.getElementById('btn-sync-to-preview').addEventListener('click', () => {
      vscode.postMessage({ type: 'requestCursorLine' });
    });

    // 「← 编辑器」按钮：找预览视口内第一个可见标题，把其行号发给 extension
    document.getElementById('btn-sync-to-editor').addEventListener('click', () => {
      const scroller = document.getElementById('preview-scroll');
      const scrollTop = scroller.scrollTop;
      const headings = Array.from(document.querySelectorAll('#preview-content [data-source-line]'));
      let best = null;
      for (const el of headings) {
        const top = el.offsetTop; // CSS zoom 下 offsetTop 已是缩放后坐标，与 scrollTop 一致
        if (top <= scrollTop + 80) {
          best = el; // 更新到最后一个在视口上方的标题
        } else {
          break; // 已过了视口上沿，停止
        }
      }
      const line = best ? parseInt(best.dataset.sourceLine, 10) : 0;
      vscode.postMessage({ type: 'scrollToEditorLine', line });
    });

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
  <!-- 预览区图片：悬浮「复制图片 / 拖我」工具条 -->
  <div id="img-hover-bar">
    <button id="img-copy-btn" title="复制为真正的图片（PNG），可直接粘贴到知乎/公众号，平台会自动上传">📋 复制图片</button>
    <span class="drag-handle" id="img-drag-handle" draggable="true" title="按住拖到知乎/公众号编辑器里">⠿ 拖我</span>
  </div>
  <script nonce="${nonce}">
  (function(){
    const bar  = document.getElementById('img-hover-bar');
    const btn  = document.getElementById('img-copy-btn');
    const grip = document.getElementById('img-drag-handle');
    let cur = null;

    function place(img){
      const r = img.getBoundingClientRect();
      bar.style.display = 'flex';
      bar.style.top  = Math.max(4, r.top + 8) + 'px';
      bar.style.left = Math.max(4, r.right - bar.offsetWidth - 8) + 'px';
    }

    document.addEventListener('mouseover', (e) => {
      const img = e.target && e.target.closest ? e.target.closest('#preview-content img') : null;
      if (img) { cur = img; place(img); }
    });
    document.addEventListener('mouseout', (e) => {
      const to = e.relatedTarget;
      if (to && to.closest && (to.closest('#img-hover-bar') || to.closest('#preview-content img'))) return;
      bar.style.display = 'none';
    });
    const scroller = document.querySelector('.preview-scroll');
    if (scroller) scroller.addEventListener('scroll', () => { if (cur && bar.style.display !== 'none') place(cur); });

    /** 把 <img> 转成真正的 PNG Blob（data URL / 同源图都不会污染 canvas） */
    function toPngBlob(img){
      return new Promise((resolve, reject) => {
        try {
          const c = document.createElement('canvas');
          c.width  = img.naturalWidth  || img.width;
          c.height = img.naturalHeight || img.height;
          c.getContext('2d').drawImage(img, 0, 0);
          c.toBlob(b => b ? resolve(b) : reject(new Error('canvas 转 blob 失败')), 'image/png');
        } catch (err) { reject(err); }
      });
    }

    btn.addEventListener('click', async () => {
      if (!cur) return;
      const old = btn.textContent;
      try {
        // 关键：往剪贴板写的是 image/png 位图，不是 data URL。
        // 这样粘进知乎/公众号，平台会把它当作"粘贴的图片"自动上传到自己的图床。
        const blob = await toPngBlob(cur);
        await navigator.clipboard.write([ new ClipboardItem({ 'image/png': blob }) ]);
        btn.textContent = '✅ 已复制，去粘贴';
        btn.classList.add('ok');
      } catch (err) {
        btn.textContent = '❌ ' + (err.message || '复制失败');
      }
      setTimeout(() => { btn.textContent = old; btn.classList.remove('ok'); }, 1800);
    });

    // 拖出去：用 DownloadURL 让它以"文件"的形式落到目标编辑器里
    grip.addEventListener('dragstart', (e) => {
      if (!cur) return;
      const name = (cur.getAttribute('alt') || 'image').replace(/[^\\w\\u4e00-\\u9fa5.-]/g, '_') + '.png';
      try {
        e.dataTransfer.setData('DownloadURL', 'image/png:' + name + ':' + cur.src);
        e.dataTransfer.setData('text/html', '<img src="' + cur.src + '">');
        e.dataTransfer.setData('text/uri-list', cur.src);
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setDragImage(cur, 20, 20);
      } catch (_) {}
    });
  })();
  </script>

  <!-- 社交发布（小红书 / Twitter）客户端逻辑 -->
  <script nonce="${nonce}">
  (function(){
    const vscode = window.__m2a_vscode;
    if(!vscode) return;
    const NAMES = { xiaohongshu: '小红书', twitter: 'Twitter' };
    const registered = {};   // platform -> prefix
    const PRESETS = {
      siliconflow: { name:'硅基流动', baseUrl:'https://api.siliconflow.cn/v1', model:'deepseek-ai/DeepSeek-V3',
                     note:'硅基流动，国内访问速度快，注册送免费额度；模型名如 deepseek-ai/DeepSeek-V3、Qwen/Qwen2.5-72B-Instruct，可在 siliconflow.cn 查看完整列表' },
      openrouter: { name:'OpenRouter', baseUrl:'https://openrouter.ai/api/v1', model:'deepseek/deepseek-chat-v3.1:free',
                    note:'OpenRouter 带 :free 后缀的模型免费，需去 openrouter.ai 注册一个免费 key' },
      groq:       { name:'Groq', baseUrl:'https://api.groq.com/openai/v1', model:'llama-3.3-70b-versatile',
                    note:'Groq 有免费额度，需去 console.groq.com 注册免费 key' },
      deepseek:   { name:'DeepSeek', baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat',
                    note:'DeepSeek 便宜、中文文案质量好（付费，但很便宜）' },
      ollama:     { name:'Ollama', baseUrl:'http://localhost:11434/v1', model:'qwen2.5:7b',
                    note:'完全免费、数据不出本机。需先本地装好 Ollama 并 ollama pull qwen2.5:7b' },
      openai:     { name:'OpenAI', baseUrl:'https://api.openai.com/v1', model:'gpt-4o-mini', note:'需 OpenAI 付费 key' },
      custom:     { name:'自定义', baseUrl:'', model:'', note:'' },
    };

    // 预设下拉切换：自动填入接口地址和模型名（优先使用已保存的该预设配置，否则用预设默认值）
    (function(){
      const sel = document.getElementById('global-llm-preset');
      if (!sel) return;
      sel.addEventListener('change', (e) => {
        window._m2a_formTouched = true;
        const presetKey = e.target.value;
        const p = PRESETS[presetKey];
        if (!p) return;
        const base   = document.getElementById('global-llm-base');
        const model  = document.getElementById('global-llm-model');
        const nameEl = document.getElementById('global-llm-name');
        const result = document.getElementById('global-llm-result');
        // 优先使用已保存的该预设配置（上一次的配置）
        const saved = (_llmProfilesCache || []).find(function(s){ return s.id === presetKey; });
        if (saved) {
          if (base)   base.value   = saved.baseUrl || p.baseUrl;
          if (model)  model.value  = saved.model   || p.model;
          if (nameEl) nameEl.value = saved.name    || '';
        } else {
          if (base)   base.value   = p.baseUrl;
          if (model)  model.value  = p.model;
          if (nameEl) nameEl.value = p.name || '';
        }
        if (result) result.textContent = p.note || '';
      });
    })();

    function applyLlmState(prefix, cfg){
      if(!cfg) return;
      const st = $(prefix+'-llmstate');
      if(st){
        if(cfg.hasKey){ st.textContent='LLM 已配置 ✓'; st.style.color='#3ddc84'; }
        else if(cfg.keyOptional){ st.textContent='LLM 本地端点 ✓'; st.style.color='#3ddc84'; }
        else { st.textContent='⚠️ LLM 未配置'; st.style.color='#ffb020'; }
      }
    }

    let _activeProfileId = '';
    let _llmProfileStatus = {}; // profileId -> 'untested'|'testing'|'ok'|'fail'

    function llmStatusUi(p) {
      const st = _llmProfileStatus[p.id] || 'untested';
      if (st === 'ok')       return '<span class="llm-status llm-status-ok">● 连接成功</span>';
      if (st === 'fail')     return '<span class="llm-status llm-status-fail">● 连接失败</span>';
      if (st === 'testing')  return '<span class="llm-status llm-status-testing">⋯ 测试中</span>';
      return '<span class="llm-status llm-status-untested">○ 未测试</span>';
    }

    function renderLlmProfiles(profiles, activeId) {
      _activeProfileId = activeId || '';
      const section = $('llm-profiles-section');
      const list    = $('llm-profiles-list');
      const formLbl = $('llm-form-label');
      if (!section || !list) return;
      if (!profiles || !profiles.length) { section.style.display = 'none'; return; }
      section.style.display = '';
      if (formLbl) formLbl.textContent = activeId ? '修改配置' : '添加配置';
      list.innerHTML = profiles.map(function(p) {
        const isActive = p.id === activeId;
        const keyLabel = p.hasKey ? '🔑 ' + (p.keyHint || 'Key 已存') : (p.keyOptional ? '免 Key（本地）' : '⚠ 无 Key');
        const keyColor = p.hasKey ? '#3ddc84' : (p.keyOptional ? '#4ea1ff' : '#ffb020');
        const keyTip   = p.hasKey ? '此配置使用 Key: ' + (p.keyHint || '…') + '（留空保存将复用同接口地址已有 Key）' : (p.keyOptional ? '本地端点无需 Key' : '未填写 Key，留空保存将复用同接口地址已有 Key');
        const modelShort = (p.model || '').split('/').pop().slice(0, 28);
        const activeCls = isActive ? ' llm-profile-active' : '';
        const host = (p.baseUrl || '').split('://').pop().split('/')[0];
        return '<div class="llm-profile-row' + activeCls + '" data-pid="' + p.id + '" data-tip="点击切换到「' + (p.name || p.id) + '」">'
          + '<div class="llm-profile-header">'
          + '<span class="llm-profile-name">' + (p.name || p.id) + (isActive ? ' <span class="llm-profile-badge">使用中</span>' : '') + '</span>'
          + llmStatusUi(p)
          + '</div>'
          + '<div class="llm-profile-meta">'
          + (modelShort || '—') + '&nbsp;&nbsp;<span style="color:#555;">|</span>&nbsp;&nbsp;'
          + (host || '—')
          + '</div>'
          + '<div class="llm-profile-actions">'
          + '<button class="llm-profile-test" data-pid="' + p.id + '" title="测试此配置的连接">测试连接</button>'
          + '<span style="font-size:11px;color:' + keyColor + ';cursor:default;" title="' + keyTip + '">' + keyLabel + '</span>'
          + '<button class="llm-profile-edit" data-pid="' + p.id + '">编辑</button>'
          + '<button class="llm-profile-del" data-pid="' + p.id + '" title="删除">🗑</button>'
          + '</div>'
          + '</div>';
      }).join('');
      // 整卡点击 = 切换配置（活动卡不切换）
      list.querySelectorAll('.llm-profile-row').forEach(function(row) {
        row.addEventListener('click', function() {
          const pid = row.dataset.pid;
          if (pid && pid !== _activeProfileId) vscode.postMessage({ type:'llmSwitchProfile', profileId: pid });
        });
      });
      list.querySelectorAll('.llm-profile-test').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          _llmProfileStatus[btn.dataset.pid] = 'testing';
          renderLlmProfiles(_llmProfilesCache, _activeProfileId);
          vscode.postMessage({ type:'llmTestProfile', profileId: btn.dataset.pid });
        });
      });
      list.querySelectorAll('.llm-profile-edit').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          const pid = btn.dataset.pid;
          const full = (_llmProfilesCache || []).find(function(p){ return p.id === pid; });
          if (!full) return;
          const nameEl = $('global-llm-name');
          const base   = $('global-llm-base');
          const mdl    = $('global-llm-model');
          const psel   = $('global-llm-preset');
          if (nameEl) nameEl.value = full.name || '';
          if (base)   base.value  = full.baseUrl || '';
          if (mdl)    mdl.value   = full.model || '';
          if (psel)   psel.value  = Object.prototype.hasOwnProperty.call(PRESETS, pid) ? pid : '';
          const nameInput = $('global-llm-name');
          if (nameInput) { nameInput.focus(); nameInput.scrollIntoView({ behavior:'smooth', block:'center' }); }
        });
      });
      list.querySelectorAll('.llm-profile-del').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (confirm('确认删除此配置？')) {
            vscode.postMessage({ type:'llmDeleteProfile', profileId: btn.dataset.pid });
          }
        });
      });
    }

    let _llmProfilesCache = [];

    function applyLlmStateGlobal(cfg, opts){
      if(!cfg) return;
      _llmProfilesCache = cfg.profiles || [];
      const profileChanged = cfg.activeProfile && cfg.activeProfile !== _activeProfileId;
      // init：面板初次打开，只要用户还没手动改过预设就回填；profileChanged：切换配置始终回填
      const shouldFill = (opts && opts.init && !window._m2a_formTouched) || profileChanged;
      if (shouldFill) {
        const base   = $('global-llm-base');
        const model  = $('global-llm-model');
        const nameEl = $('global-llm-name');
        if (base)   base.value   = cfg.baseUrl || '';
        if (model)  model.value  = cfg.model   || '';
        // 找到激活配置的 name 填入配置名框
        if (nameEl && cfg.activeProfile) {
          const active = (cfg.profiles || []).find(function(p){ return p.id === cfg.activeProfile; });
          if (active) nameEl.value = active.name || '';
        }
        // 同步预设选择框到当前激活配置
        const psel = $('global-llm-preset');
        if (psel && cfg.activeProfile) {
          psel.value = Object.prototype.hasOwnProperty.call(PRESETS, cfg.activeProfile) ? cfg.activeProfile : '';
        }
      }
      renderLlmProfiles(cfg.profiles, cfg.activeProfile);
    }

    const $ = (id) => document.getElementById(id);

    function fmtStatus(status){
      if(!status || !status.loggedIn){
        return status && status.state==='expired'
          ? { text:'● 登录已过期，请重新登录', color:'#ff6b6b' }
          : { text:'● 未登录', color:'#888' };
      }
      if(status.state==='soon') return { text:'● 已登录 · 剩 '+status.daysLeft+' 天（即将过期）', color:'#ffb020' };
      if(status.daysLeft!=null) return { text:'● 已登录 · 剩 '+status.daysLeft+' 天', color:'#3ddc84' };
      return { text:'● 已登录', color:'#3ddc84' };
    }

    function applyStatus(platform, prefix, status){
      const s = fmtStatus(status);
      const el = $(prefix+'-status'); if(el){ el.textContent = s.text; el.style.color = s.color; }
      const logout = $(prefix+'-logout'); if(logout) logout.style.display = (status && status.loggedIn) ? '' : 'none';
      const loginBtn = $(prefix+'-login');
      if(loginBtn) loginBtn.textContent = (status && status.loggedIn) ? '重新登录' : ('登录'+NAMES[platform]);
      const hint = $(prefix+'-cookiehint');
      if(hint){
        if(status && status.expiresAt){
          hint.style.display=''; hint.textContent='Cookie 有效期至 '+new Date(status.expiresAt).toLocaleString();
        } else { hint.style.display='none'; }
      }
    }

    function progress(prefix, msg, isErr){
      const el = $(prefix+'-progress');
      if(el){ el.textContent = msg || ''; el.style.color = isErr ? '#ff6b6b' : '#4ea1ff'; }
    }

    function showStep(prefix, s){
      const box=$(prefix+'-steps'); if(!box) return;
      box.style.display='';
      const pct = s.total ? Math.round(s.done/s.total*100) : 0;
      $(prefix+'-stepbar').style.width = pct+'%';
      $(prefix+'-steplabel').textContent = s.label || '';
      $(prefix+'-stepnum').textContent = s.done+'/'+s.total;
    }
    function showResume(prefix, on){
      const b=$(prefix+'-resume'); if(b) b.style.display = on ? '' : 'none';
    }

    // ── 版本历史 ──
    const verState = {};   // platform -> {current, total, list}
    const SRC_NAME = { llm:'LLM 生成', local:'本地提取', manual:'手动编辑', legacy:'旧版', switch:'' };
    function renderVersions(prefix, platform, v){
      if(!v) return;
      verState[platform] = v;
      const bar=$(prefix+'-verbar'); if(!bar) return;
      if(!v.total){ bar.style.display='none'; return; }
      bar.style.display='flex';
      const cur = v.list[v.current] || {};
      const when = cur.at ? new Date(cur.at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
      $(prefix+'-verlabel').textContent =
        'v'+(v.current+1)+'/'+v.total + (SRC_NAME[cur.source] ? ' · '+SRC_NAME[cur.source] : '') + (when ? ' · '+when : '');
      $(prefix+'-verprev').disabled = v.current<=0;
      $(prefix+'-vernext').disabled = v.current>=v.total-1;
    }

    // 标签用分号分隔（中英混排时天然有空格，用空格分隔会切错）
    function parseTags(s){
      return String(s||'').split(/[;；]+/).map(t=>t.replace(/^#/,'').trim()).filter(Boolean);
    }
    function joinTags(arr){ return (arr||[]).join('; '); }

    // X 的加权字数：中文算 2、URL 固定算 23、其余算 1
    function xLen(text){
      let n=0;
      const stripped=String(text||'').replace(/https?:\\/\\/\\S+/g, ()=>{ n+=23; return ''; });
      for(const ch of stripped){
        const c=ch.codePointAt(0);
        const wide=(c>=0x1100&&c<=0x11FF)||(c>=0x2E80&&c<=0xA4CF)||(c>=0xA960&&c<=0xA97F)||
                   (c>=0xAC00&&c<=0xD7FF)||(c>=0xF900&&c<=0xFAFF)||(c>=0xFE10&&c<=0xFE19)||
                   (c>=0xFE30&&c<=0xFE6F)||(c>=0xFF00&&c<=0xFF60)||(c>=0xFFE0&&c<=0xFFE6)||
                   (c>=0x20000&&c<=0x3FFFD);
        n+=wide?2:1;
      }
      return n;
    }

    // 每篇必带的固定标签
    const FIXED_TAG = 'marsggbo';
    function withFixedTag(tags){
      const t=(tags||[]).filter(Boolean);
      if(!t.some(x=>x.toLowerCase()===FIXED_TAG)) t.push(FIXED_TAG);
      return t;
    }

    // 算某条推文最终发出去的完整文本（含编号/共用标签/链接），用于真实字数
    function tweetFullText(prefix, card, i, N){
      const link = ($(prefix+'-link')||{}).value || '';
      const pos  = ($(prefix+'-linkpos')||{}).value || 'all';
      const auto = !!($(prefix+'-autonum')||{}).checked;
      const num  = (auto && N>1) ? (i+1)+'/'+N+' ' : '';
      const tags = withFixedTag(parseTags(($(prefix+'-tags')||{}).value));   // 整串共用
      const tagStr = tags.length ? '\\n\\n'+tags.map(x=>'#'+x).join(' ') : '';
      const show = link && (pos==='all' || (pos==='first'&&i===0) || (pos==='last'&&i===N-1));
      const lk = show ? '\\n\\n全文：'+link : '';
      return num + (card.querySelector('.tw-body').value||'') + tagStr + lk;
    }

    function refreshCounts(prefix){
      const box=$(prefix+'-thread'); if(!box) return;
      const cards=[...box.querySelectorAll('.tweet-card')];
      cards.forEach((c,i)=>{
        const n = xLen(tweetFullText(prefix, c, i, cards.length));
        const el = c.querySelector('.tw-count');
        el.textContent = n+'/280';
        el.style.color = n>280 ? '#ff6b6b' : (n>250 ? '#ffb020' : '#888');
      });
    }

    function isThread(prefix){ return !!$(prefix+'-thread'); }

    // ── Twitter 串推卡片 ──
    function renderThread(prefix, tweets){
      const box = $(prefix+'-thread');
      if(!box) return;
      box.innerHTML = '';
      (tweets||[]).forEach((t,i)=>box.appendChild(tweetCard(prefix, t, i)));
      renumber(prefix);
    }
    function tweetCard(prefix, t, i){
      const d = document.createElement('div');
      d.className = 'tweet-card';
      d.style.cssText = 'border:1px solid #3a3a3a;border-radius:4px;padding:8px;margin-top:8px;';
      d.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'+
          '<b class="tw-idx" style="font-size:12px;color:#4ea1ff;"></b>'+
          '<span><span class="tw-count" style="font-size:12px;color:#888;margin-right:6px;">0/280</span>'+
          '<button class="btn btn-secondary tw-del" style="padding:2px 8px;font-size:12px;">删除</button></span>'+
        '</div>'+
        '<textarea class="tw-body" rows="4" style="width:100%;box-sizing:border-box;font-family:inherit;"></textarea>';
      d.querySelector('.tw-body').value = (t && t.body) || '';
      d.querySelector('.tw-body').addEventListener('input', ()=>refreshCounts(prefix));
      d.querySelector('.tw-del').addEventListener('click', ()=>{ d.remove(); renumber(prefix); refreshCounts(prefix); });
      return d;
    }
    function renumber(prefix){
      const cards = [...($(prefix+'-thread')||{querySelectorAll:()=>[]}).querySelectorAll('.tweet-card')];
      const pos = ($(prefix+'-linkpos')||{}).value || 'all';
      cards.forEach((c,i)=>{
        const last = i===cards.length-1;
        const hasLink = (pos==='all') || (pos==='first'&&i===0) || (pos==='last'&&last);
        c.querySelector('.tw-idx').textContent =
          '第 '+(i+1)+' 条 / 共 '+cards.length + (hasLink?'  🔗链接':'');
      });
      refreshCounts(prefix);
    }

    function collectContent(prefix){
      if(isThread(prefix)){
        const cards = [...$(prefix+'-thread').querySelectorAll('.tweet-card')];
        const shared = withFixedTag(parseTags(($(prefix+'-tags')||{}).value));   // 整串统一标签
        return {
          tweets: cards.map(c=>({
            body: c.querySelector('.tw-body').value || '',
            tags: shared,                        // 每条都用同一组标签
          })).filter(t=>t.body.trim()),
          tags: shared,
          autoNumber: !!($(prefix+'-autonum')||{}).checked,
          linkPos: ($(prefix+'-linkpos')||{}).value || 'all',
          oneImagePerTweet: true,
        };
      }
      return {
        title: ($(prefix+'-title')||{}).value || '',
        body:  ($(prefix+'-body')||{}).value || '',
        tags:  withFixedTag(parseTags(($(prefix+'-tags')||{}).value)),
      };
    }

    function fillContent(prefix, copy){
      if(isThread(prefix)){
        // 标签整串共用
        if($(prefix+'-tags')) $(prefix+'-tags').value = joinTags(withFixedTag(copy.tags||[]));
        const tweets = (copy.tweets && copy.tweets.length)
          ? copy.tweets
          : [{ body: copy.body || '' }];
        renderThread(prefix, tweets);
        return;
      }
      if($(prefix+'-title')) $(prefix+'-title').value = copy.title || '';
      if($(prefix+'-body'))  $(prefix+'-body').value  = copy.body  || '';
      if($(prefix+'-tags'))  $(prefix+'-tags').value  = joinTags(withFixedTag(copy.tags||[]));
      updateTitleCount(prefix);
    }

    function updateTitleCount(prefix){
      const limit = parseInt((document.querySelector('[data-prefix="'+prefix+'"]')||{}).dataset?.titleLimit || '0', 10);
      const cnt = $(prefix+'-titlecount');
      const inp = $(prefix+'-title');
      if(cnt && inp && limit){
        const n = (inp.value||'').length;
        cnt.textContent = n+'/'+limit;
        cnt.style.color = n>limit ? '#ff6b6b' : '#888';
      }
    }

    function initBlock(platform, prefix){
      registered[platform] = prefix;
      // 请求初始化数据
      vscode.postMessage({ type:'socialGetInit', platform });

      // 模式切换
      document.querySelectorAll('input[name="'+prefix+'-mode"]').forEach(r=>{
        r.addEventListener('change', ()=>{
          const isAi = (document.querySelector('input[name="'+prefix+'-mode"]:checked')||{}).value==='ai';
          if($(prefix+'-ai')) $(prefix+'-ai').style.display = isAi ? '' : 'none';
        });
      });
      // 标题字数
      if($(prefix+'-title')) $(prefix+'-title').addEventListener('input', ()=>updateTitleCount(prefix));
      // 打开登录页
      if($(prefix+'-openlogin')) $(prefix+'-openlogin').addEventListener('click', (e)=>{
        e.preventDefault();
        vscode.postMessage({ type:'socialOpenLoginPage', platform });
      });
      // 手动粘贴 cookie
      if($(prefix+'-pastetoggle')) $(prefix+'-pastetoggle').addEventListener('click', (e)=>{
        e.preventDefault();
        const box = $(prefix+'-pastebox');
        if(box) box.style.display = (box.style.display==='none') ? '' : 'none';
      });
      if($(prefix+'-pastesave')) $(prefix+'-pastesave').addEventListener('click', ()=>{
        const raw = ($(prefix+'-pasteinput')||{}).value || '';
        if(!raw.trim()){ progress(prefix,'Cookie 不能为空', true); return; }
        vscode.postMessage({ type:'socialSaveCookie', platform, raw });
      });
      // 生成
      if($(prefix+'-gen')) $(prefix+'-gen').addEventListener('click', ()=>{
        progress(prefix, '正在生成文案…');
        vscode.postMessage({ type:'socialGenerateCopy', platform,
          instruction: ($(prefix+'-prompt')||{}).value || '',
          link: ($(prefix+'-link')||{}).value || '' });
      });
      // 恢复默认指令
      if($(prefix+'-reprompt')) $(prefix+'-reprompt').addEventListener('click', ()=>{
        if(defaultInstruction[platform] && $(prefix+'-prompt')) $(prefix+'-prompt').value = defaultInstruction[platform];
      });
      // 本地提取（不调模型）
      if($(prefix+'-local')) $(prefix+'-local').addEventListener('click', ()=>{
        vscode.postMessage({ type:'socialLocalExtract', platform });
      });
      // 串推：添加一条
      if($(prefix+'-addtweet')) $(prefix+'-addtweet').addEventListener('click', ()=>{
        const box=$(prefix+'-thread');
        if(box){ box.appendChild(tweetCard(prefix, {body:'',tags:[]}, 0)); renumber(prefix); }
      });
      // 链接位置 / 编号 / 链接改变 → 刷新 🔗 标记和真实字数
      if($(prefix+'-linkpos')) $(prefix+'-linkpos').addEventListener('change', ()=>renumber(prefix));
      if($(prefix+'-autonum')) $(prefix+'-autonum').addEventListener('change', ()=>refreshCounts(prefix));
      if($(prefix+'-link'))    $(prefix+'-link').addEventListener('input',   ()=>refreshCounts(prefix));
      // 保存文案
      if($(prefix+'-savecopy')) $(prefix+'-savecopy').addEventListener('click', ()=>{
        vscode.postMessage({ type:'socialSaveCopy', platform,
          content: collectContent(prefix), link: ($(prefix+'-link')||{}).value || '' });
      });
      // 断点续传
      if($(prefix+'-resume')) $(prefix+'-resume').addEventListener('click', ()=>{
        progress(prefix, '正在重连浏览器，从断点继续…');
        showResume(prefix, false);
        vscode.postMessage({ type:'socialResume', platform });
      });
      // 关闭浏览器
      if($(prefix+'-closebrowser')) $(prefix+'-closebrowser').addEventListener('click', ()=>{
        vscode.postMessage({ type:'socialCloseBrowser', platform });
      });
      // 版本切换 / 删除
      if($(prefix+'-verprev')) $(prefix+'-verprev').addEventListener('click', ()=>{
        const v=verState[platform]; if(v && v.current>0)
          vscode.postMessage({ type:'socialSwitchVersion', platform, index:v.current-1 });
      });
      if($(prefix+'-vernext')) $(prefix+'-vernext').addEventListener('click', ()=>{
        const v=verState[platform]; if(v && v.current<v.total-1)
          vscode.postMessage({ type:'socialSwitchVersion', platform, index:v.current+1 });
      });
      if($(prefix+'-verdel')) $(prefix+'-verdel').addEventListener('click', ()=>{
        const v=verState[platform]; if(!v || !v.total) return;
        vscode.postMessage({ type:'socialDeleteVersion', platform, index:v.current });
      });
      // ── 生成指令折叠 ──
      if($(prefix+'-prompttoggle')) $(prefix+'-prompttoggle').addEventListener('click', (e)=>{
        e.preventDefault();
        const ta=$(prefix+'-prompt');
        const lnk=$(prefix+'-prompttoggle');
        if(ta){ const hidden=(ta.style.display==='none'); ta.style.display=hidden?'':'none'; if(lnk) lnk.textContent=hidden?'收起指令 ▴':'展开指令 ▾'; }
      });
      // ── 更多操作折叠 ──
      if($(prefix+'-moretoggle')) $(prefix+'-moretoggle').addEventListener('click', (e)=>{
        e.preventDefault();
        const box=$(prefix+'-morebox');
        const lnk=$(prefix+'-moretoggle');
        if(box){ const hidden=(box.style.display==='none'); box.style.display=hidden?'':'none'; if(lnk) lnk.textContent=hidden?'更多 ▴':'更多 ▾'; }
      });
      // 登录 / 退出
      if($(prefix+'-login')) $(prefix+'-login').addEventListener('click', ()=>{
        progress(prefix, '正在启动浏览器登录…');
        vscode.postMessage({ type:'socialLogin', platform });
      });
      if($(prefix+'-logout')) $(prefix+'-logout').addEventListener('click', ()=>{
        vscode.postMessage({ type:'socialLogout', platform });
      });
      // 复制文案
      if($(prefix+'-copytext')) $(prefix+'-copytext').addEventListener('click', ()=>{
        const c = collectContent(prefix);
        const link = ($(prefix+'-link')||{}).value || '';
        let text;
        if(c.tweets){
          const N = c.tweets.length;
          const pos = c.linkPos || 'all';
          text = c.tweets.map((t,i)=>{
            const num = (c.autoNumber && N>1) ? (i+1)+'/'+N+' ' : '';
            const tg = t.tags.length ? '\\n\\n'+t.tags.map(x=>'#'+x).join(' ') : '';
            const show = link && (pos==='all' || (pos==='first'&&i===0) || (pos==='last'&&i===N-1));
            const lk = show ? '\\n\\n全文：'+link : '';
            return num + t.body + tg + lk;
          }).join('\\n\\n———\\n\\n');
        } else {
          const tg = c.tags.length ? '\\n\\n'+c.tags.map(t=>'#'+t).join(' ') : '';
          const lk = link ? '\\n\\n全文：'+link : '';
          text = (c.title?c.title+'\\n\\n':'') + c.body + tg + lk;
        }
        navigator.clipboard.writeText(text).then(()=>progress(prefix,'已复制文案到剪贴板'));
      });
      // 发布
      if($(prefix+'-publish')) $(prefix+'-publish').addEventListener('click', ()=>{
        const c = collectContent(prefix);
        const empty = c.tweets ? !c.tweets.length : !(c.body||'').trim();
        if(empty){ progress(prefix,'正文不能为空', true); return; }
        // 用 X 的加权字数拦截（中文算 2！），否则「+」和「发帖」会被平台禁用导致点击超时
        if(isThread(prefix)){
          const cards=[...$(prefix+'-thread').querySelectorAll('.tweet-card')];
          const bad=[];
          cards.forEach((cd,i)=>{
            const n=xLen(tweetFullText(prefix, cd, i, cards.length));
            if(n>280) bad.push('第'+(i+1)+'条('+n+')');
          });
          if(bad.length){
            progress(prefix, '⚠️ 以下推文超出 X 的 280 字上限（中文算 2 个字符）：'+bad.join('、')+'，请精简后再发', true);
            return;
          }
        }
        progress(prefix, c.tweets ? ('正在发布 '+c.tweets.length+' 条串推…') : '正在打开浏览器…');
        vscode.postMessage({ type:'socialPublish', platform, content:c, link: ($(prefix+'-link')||{}).value || '' });
      });
    }

    const defaultInstruction = {};

    window.addEventListener('message', ({ data: msg })=>{
      // LLM 配置类消息与平台无关，广播给所有已注册的块
      if(msg.type==='llmConfig' || msg.type==='llmConfigSaved'){
        if(msg.type==='llmConfig') _llmProfileStatus = {}; // 面板首次打开，重置连接状态
        for(const pf of Object.values(registered)) applyLlmState(pf, msg.llm);
        // llmConfig = 面板初次打开，允许回填表单；llmConfigSaved = 操作后刷新，只更新列表
        applyLlmStateGlobal(msg.llm, { init: msg.type==='llmConfig' });
        if(msg.type==='llmConfigSaved'){
          window._m2a_formTouched = false;
          const gr=$('global-llm-result');
          if(gr){ gr.style.color='#3ddc84'; gr.textContent='✅ 已保存'; }
          const gk=$('global-llm-key'); if(gk) gk.value='';
        }
        return;
      }
      if(msg.type==='llmTestProfileResult'){
        if(msg.profileId){
          _llmProfileStatus[msg.profileId] = msg.ok ? 'ok' : 'fail';
          renderLlmProfiles(_llmProfilesCache, _activeProfileId);
          showToast(msg.ok ? '✅ 连接成功：' + (msg.reply || '') : '❌ 连接失败：' + (msg.message || ''), msg.ok ? 'ok' : 'err', 3000);
        }
        return;
      }
      if(msg.type==='llmFreeModels'){
        const fb = document.getElementById('global-llm-free-btn');
        const fl = document.getElementById('global-llm-free-list');
        if(fb){ fb.textContent = '🎁 OpenRouter 免费模型'; fb.disabled = false; }
        if(!fl) return;
        if(msg.error){
          fl.innerHTML = '<div style="padding:8px;color:#ff6b6b;font-size:12px;">拉取失败：' + msg.error + '</div>';
          fl.style.display = 'block';
          return;
        }
        const models = (msg.models || []).slice().sort((a,b) => (b.context_length||0)-(a.context_length||0));
        if(!models.length){
          fl.innerHTML = '<div style="padding:8px;color:#ffb020;font-size:12px;">当前 OpenRouter 暂无免费模型</div>';
          fl.style.display = 'block';
          return;
        }
        fl.innerHTML = models.map(m =>
          '<div data-slug="' + m.id + '" style="padding:7px 9px;cursor:pointer;border-radius:4px;font-size:12px;display:flex;justify-content:space-between;gap:8px;align-items:center;">'
          + '<span style="color:#e0e0e0;">' + m.name + '</span>'
          + '<span style="color:#777;flex-shrink:0;">' + (m.id.replace(/:free$/,'')) + '</span>'
          + '</div>'
        ).join('') + '<div style="padding:6px 4px 2px;color:#888;font-size:10.5px;">点击上方任意一项 → 自动填入接口地址和模型名</div>';
        fl.style.display = 'block';
        return;
      }
      if(msg.type==='llmTestResult' || msg.type==='llmTestProgress' || msg.type==='llmConfigError'){
        const gr=$('global-llm-result');
        if(gr){
          if(msg.type==='llmTestProgress'){ gr.style.color='#4ea1ff'; gr.textContent=msg.message; }
          else if(msg.type==='llmConfigError'){ gr.style.color='#ff6b6b'; gr.textContent='保存失败：'+msg.message; }
          else if(msg.ok){ gr.style.color='#3ddc84'; gr.textContent='✅ 连接成功，模型回复：'+msg.reply; }
          else { gr.style.color='#ff6b6b'; gr.textContent='❌ 连接失败：'+msg.message; }
        }
        return;
      }

      const p = msg.platform;
      const prefix = registered[p];
      if(!prefix) return;
      switch(msg.type){
        case 'socialInit':
          defaultInstruction[p] = msg.defaultInstruction;
          if($(prefix+'-prompt') && !$(prefix+'-prompt').value) $(prefix+'-prompt').value = msg.defaultInstruction || '';
          if($(prefix+'-link') && !$(prefix+'-link').value)
            $(prefix+'-link').value = msg.savedLink || (msg.meta && msg.meta.link) || '';
          applyStatus(p, prefix, msg.status);
          applyLlmState(prefix, msg.llm);
          // 本地算法预填（零配置，可直接发；点「生成文案」才用 LLM 覆盖）
          if(msg.prefill){
            const empty = isThread(prefix)
              ? !$(prefix+'-thread').querySelectorAll('.tweet-card').length
              : !(($(prefix+'-body')||{}).value);
            if(empty) fillContent(prefix, msg.prefill);
          }
          renderVersions(prefix, p, msg.versions);
          if($(prefix+'-progress')){
            const src = msg.fromSaved ? '已载入保存的文案' : '文案已用本地算法预填';
            const img = msg.imageCount ? ('检测到 '+msg.imageCount+' 张长图') : '还没导出长图（发布时会自动导出）';
            progress(prefix, src + ' · ' + img);
          }
          break;
        case 'socialCopyProgress': progress(prefix, msg.message); break;
        case 'socialCopyResult':
          fillContent(prefix, msg.copy || {});
          renderVersions(prefix, p, msg.versions);
          if(msg.deleted) progress(prefix, '🗑 已删除该版本');
          else if(msg.source==='local') progress(prefix, '已用本地算法重新提取（未调用模型）');
          else if(msg.source==='switch'||msg.source==='manual'||msg.source==='legacy') progress(prefix, '已切换版本');
          else progress(prefix, '✨ 已生成新版本'+(msg.versions ? (' v'+(msg.versions.current+1)+'/'+msg.versions.total) : '')+'，旧版本已保留，可用 ◀ ▶ 对比');
          break;
        case 'socialSaveCopyResult':
          renderVersions(prefix, p, msg.versions);
          progress(prefix, msg.ok ? ('💾 已覆盖保存当前版本 → '+msg.path) : '保存失败', !msg.ok);
          break;
        case 'socialCopyError': progress(prefix, '生成失败：'+msg.message, true); break;
        case 'socialLoginProgress': progress(prefix, msg.message); break;
        case 'socialLoginResult': applyStatus(p, prefix, msg.status); progress(prefix, msg.status.loggedIn?'登录成功':'已退出'); break;
        case 'socialLoginError': progress(prefix, msg.message, true); break;
        case 'socialPublishProgress': progress(prefix, msg.message); break;
        case 'socialPublishStep':    showStep(prefix, msg.step); break;
        case 'socialPublishResult':
          showResume(prefix, false);
          progress(prefix, msg.status==='ready'
            ? '✅ 文字和图片都填好了！请到浏览器里核对，然后【自己点页面上的「发布」】。发完可点「关闭浏览器」。'
            : '✅ 已提交发布。浏览器保持打开，请自行确认结果。');
          break;
        case 'socialPublishError':
          progress(prefix, '发布失败：'+msg.message, true);
          showResume(prefix, !!msg.canResume);   // 可断点续传
          break;
      }
    });

    if($('xhs-social-status')) initBlock('xiaohongshu', 'xhs-social');
    if($('tw-social-status'))  initBlock('twitter',     'tw-social');
  })();
  </script>

</body>
</html>`;
}

module.exports = { activate, deactivate };
