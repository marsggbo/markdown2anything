'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const urlMod = require('url');
const crypto = require('crypto');

const { renderMarkdown, buildWechatCopyHtml, buildZhihuCopyHtml, buildXhsCopyHtml, convertMarkdownToWeChat, buildXhsRenderHtml } = require('../lib/converter');
const { THEMES, DEFAULT_THEME_ID, getTheme } = require('../lib/themes');
const cover = require('../lib/cover');
const coverLlm = require('../lib/cover-llm');

// ── State ───────────────────────────────────────────────

let mainWindow;
let currentFilePath = null;
let currentThemeId = DEFAULT_THEME_ID;
let configStore = {};
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

// ── Safe IPC sender ──────────────────────────────────────

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Config persistence ──────────────────────────────────

function loadConfig() {
  try {
    configStore = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    configStore = { appid: '', appSecret: '', author: '', digest: '' };
  }
}

function saveConfigToDisk() {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configStore, null, 2), 'utf8');
  } catch (_) {}
}

// ── Render preview from Markdown file ───────────────────

// 用 Markdown 字符串渲染并发送预览（Electron 编辑器主路径）
function renderMarkdownFromString(markdown) {
  try {
    const { bodyHtml, title, rawMarkdown } = renderMarkdownFromText(markdown);
    sendRenderedPreview(bodyHtml, title, rawMarkdown);
  } catch (err) {
    sendToRenderer('error', { message: err.message });
  }
}

// 渲染给定文本的 Markdown（临时文件法，避免 lib 差异）
function renderMarkdownFromText(text) {
  const tmpFile = path.join(os.tmpdir(), `m2a_render_${crypto.randomUUID()}.md`);
  fs.writeFileSync(tmpFile, text || '', 'utf8');
  const result = renderMarkdown(tmpFile);
  try { fs.unlinkSync(tmpFile); } catch (_) {}
  return result;
}

// 发送渲染结果到预览
function sendRenderedPreview(bodyHtml, title, rawMarkdown) {
  const isBlank = !rawMarkdown || !rawMarkdown.trim() || !bodyHtml || !bodyHtml.replace(/<[^>]*>/g, '').trim();
  if (!isBlank) {
    lastBodyHtml = bodyHtml;
    lastRawMarkdown = rawMarkdown;
  }
  const theme = getTheme(currentThemeId);
  sendToRenderer('update', {
    bodyHtml: isBlank
      ? '<div style="text-align:center;padding:56px 24px;color:#999;font-size:15px;line-height:1.8;"><div style="font-size:44px;margin-bottom:14px;">✏️</div><div>在左侧编辑器中输入 Markdown 内容</div><div style="font-size:13px;color:#bbb;margin-top:6px;">右侧将实时渲染预览，支持公式、代码、表格、图片</div></div>'
      : bodyHtml,
    title,
    theme: { id: theme.id, css: theme.css, wrapperBg: theme.wrapperBg },
  });
}

function renderAndSendPreview(mdPath) {
  try {
    const { bodyHtml, title, rawMarkdown } = renderMarkdown(mdPath);
    sendRenderedPreview(bodyHtml, title, rawMarkdown);
  } catch (err) {
    sendToRenderer('error', { message: err.message });
  }
}

// ── Get template path ────────────────────────────────────

function getTemplatePath() {
  const appRoot = path.join(__dirname, '..');

  // 1. Check workspace-relative custom template
  if (currentFilePath) {
    const workspacePath = path.dirname(currentFilePath);
    const tplName = configStore.template || 'wechat';
    const custom = path.join(workspacePath, 'templates', `${tplName}.html`);
    if (fs.existsSync(custom)) return custom;
  }

  // 2. Built-in template
  const tplName = configStore.template || 'wechat';
  const builtin = path.join(appRoot, 'templates', `${tplName}.html`);
  if (fs.existsSync(builtin)) return builtin;

  // 3. Fallback
  const fallback = path.join(appRoot, 'templates', 'wechat.html');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

// ── Create window ────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Markdown2Anything ©marsggbo',
    show: !process.env.M2A_HEADLESS,   // 后台测试时不显示窗口
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'panel.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ───────────────────────────────────────

app.whenReady().then(() => {
  loadConfig();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ────────────────────────────────────────────────────────
//  IPC Handlers
// ────────────────────────────────────────────────────────

// ── File dialogs ────────────────────────────────────────

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开 Markdown 文件',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;

  const filePath = result.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    currentFilePath = filePath;
    renderAndSendPreview(filePath);
    return {
      content,
      filePath,
      fileName: path.basename(filePath),
      dirName: path.dirname(filePath),
    };
  } catch (err) {
    sendToRenderer('error', { message: '无法读取文件: ' + err.message });
    return null;
  }
});

ipcMain.handle('dialog:saveFileAs', async (_event, content) => {
  const defaultPath = currentFilePath
    ? path.basename(currentFilePath)
    : 'untitled.md';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存 Markdown 文件',
    defaultPath,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return null;

  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    currentFilePath = result.filePath;
    renderAndSendPreview(result.filePath);
    return {
      filePath: result.filePath,
      fileName: path.basename(result.filePath),
    };
  } catch (err) {
    sendToRenderer('error', { message: '无法保存文件: ' + err.message });
    return null;
  }
});

ipcMain.handle('getAppPath', () => {
  return path.join(__dirname, '..');
});

// ── Save file to current path ─────────────────────────

ipcMain.on('saveFile', (_event, msg) => {
  const content = typeof msg === 'string' ? msg : (msg && msg.content);
  if (currentFilePath && typeof content === 'string') {
    try {
      fs.writeFileSync(currentFilePath, content, 'utf8');
      renderAndSendPreview(currentFilePath);
    } catch (err) {
      sendToRenderer('error', { message: '保存失败: ' + err.message });
    }
  }
});

// ── Editor content changed (debounced by renderer) ──────

ipcMain.on('editorContentChanged', (_event, msg) => {
  const content = typeof msg === 'string' ? msg : (msg && msg.content);
  if (typeof content !== 'string') { sendToRenderer('error', { message: '无效的编辑器内容' }); return; }
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `markdown2anything_edit_${crypto.randomUUID()}.md`);
  try {
    fs.writeFileSync(tmpFile, content, 'utf8');
    renderAndSendPreview(tmpFile);
  } catch (err) {
    sendToRenderer('error', { message: '渲染失败: ' + err.message });
  }
  // Schedule cleanup
  setTimeout(() => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }, 10000);
});

// ── Set theme（切换主题立即重渲染，保证预览实时更新）──
ipcMain.on('setTheme', (_event, msg) => {
  currentThemeId = (msg && msg.themeId) || DEFAULT_THEME_ID;
  if (lastRawMarkdown !== undefined && lastRawMarkdown !== null) {
    renderMarkdownFromString(lastRawMarkdown);
  } else if (currentFilePath) {
    renderAndSendPreview(currentFilePath);
  }
});

// ── Ready (renderer loaded) ─────────────────────────────

ipcMain.on('ready', () => {
  sendToRenderer('themeList', {
    themes: THEMES.map(t => ({ id: t.id, name: t.name })),
    currentId: currentThemeId,
  });
  sendToRenderer('config', configStore);
});

// ── Open external URL ──────────────────────────────────

ipcMain.on('openExternal', (_event, url) => {
  try {
    const parsed = new urlMod.URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(url);
    }
  } catch (_) {}
});

// ── Theme ──────────────────────────────────────────────

// ── Config ─────────────────────────────────────────────

ipcMain.on('getConfig', () => {
  sendToRenderer('config', configStore);
});

ipcMain.on('saveConfig', (_event, cfg) => {
  Object.assign(configStore, cfg);
  saveConfigToDisk();
  sendToRenderer('configSaved');
});

// ── New file ───────────────────────────────────────────

ipcMain.on('newFile', () => {
  currentFilePath = null;
  sendToRenderer('update', {
    bodyHtml: '<p style="color:#999;text-align:center;">新建或打开一个 Markdown 文件开始预览</p>',
    title: '未命名',
    theme: { id: currentThemeId, css: '', wrapperBg: '#ffffff' },
  });
});

// ── Export HTML ────────────────────────────────────────

ipcMain.on('exportHtml', async () => {
  if (!lastBodyHtml) {
    sendToRenderer('error', { message: '请先在左侧编辑器输入内容' });
    return;
  }

  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存 HTML',
      defaultPath: 'markdown.html',
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (result.canceled || !result.filePath) return;
    const templatePath = getTemplatePath();
    if (!templatePath) {
      sendToRenderer('error', { message: '找不到模板文件' });
      return;
    }
    const theme = getTheme(currentThemeId);
    const html = buildWechatCopyHtml(lastBodyHtml, templatePath, theme);
    fs.writeFileSync(result.filePath, html, 'utf8');
    const action = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '导出完成',
      message: `HTML 已导出到:\n${result.filePath}`,
      buttons: ['打开文件', '打开目录', '确定'],
    });
    if (action.response === 0) shell.openPath(result.filePath);
    else if (action.response === 1) shell.showItemInFolder(result.filePath);
  } catch (err) {
    sendToRenderer('error', { message: err.message });
  }
});

// ── Get WeChat HTML ────────────────────────────────────

// 最近一次渲染的正文（编辑器临时内容 / 打开的文件），供复制/导出使用
let lastBodyHtml = '';
let lastRawMarkdown = '';

ipcMain.on('getWechatHtml', () => {
  try {
    if (!lastBodyHtml) {
      sendToRenderer('wechatHtmlError', { message: '请先在左侧编辑器输入内容' });
      return;
    }
    const templatePath = getTemplatePath();
    const theme = getTheme(currentThemeId);
    const html = buildWechatCopyHtml(lastBodyHtml, templatePath, theme);
    sendToRenderer('wechatHtml', { html });
  } catch (err) {
    sendToRenderer('wechatHtmlError', { message: err.message });
  }
});

// ── Editor / preview sync（Electron 内编辑器与预览同页，主进程仅透传/记录）──

ipcMain.on('savePreviewSetting', (_event, msg) => {
  // panel 已本地应用；记录到 config 持久化
  if (msg && msg.key !== undefined) {
    configStore.previewSettings = configStore.previewSettings || {};
    configStore.previewSettings[msg.key] = msg.value;
    saveConfigToDisk();
  }
  sendToRenderer('savePreviewSettingDone', { key: msg && msg.key });
});

ipcMain.on('requestCursorLine', () => {
  // Electron 编辑器与预览同页，由注入脚本直接处理，主进程无需响应
});

ipcMain.on('scrollToEditorLine', () => {
  // 同上
});

// ── LLM 配置（Electron 本地持久化 + OpenAI 兼容测试）──

const LLM_PATH = path.join(app.getPath('userData'), 'llm-config.json');

function loadLlmConfig() {
  try { return JSON.parse(fs.readFileSync(LLM_PATH, 'utf8')) || { profiles: [] }; }
  catch (_) { return { profiles: [] }; }
}
function saveLlmConfig(llm) {
  try { fs.writeFileSync(LLM_PATH, JSON.stringify(llm, null, 2), 'utf8'); } catch (_) {}
}

ipcMain.on('llmGetConfig', () => {
  sendToRenderer('llmConfig', { llm: loadLlmConfig() });
});

ipcMain.on('llmSaveConfig', (_event, msg) => {
  try {
    const { profileId, baseUrl, model, apiKey, profileName, deleteProfile } = msg || {};
    const llm = loadLlmConfig();
    const profiles = Array.isArray(llm.profiles) ? llm.profiles : [];
    if (deleteProfile) {
      const updated = profiles.filter((p) => p.id !== profileId);
      saveLlmConfig({ profiles: updated });
      sendToRenderer('llmConfigSaved', { llm: { profiles: updated } });
      return;
    }
    const now = new Date().toISOString();
    if (profileId && profiles.some((p) => p.id === profileId)) {
      const updated = profiles.map((p) => {
        if (p.id !== profileId) return p;
        const np = { ...p, baseUrl, model, name: profileName || p.name, updatedAt: now };
        if (apiKey) np.apiKey = apiKey;
        return np;
      });
      saveLlmConfig({ profiles: updated });
      sendToRenderer('llmConfigSaved', { llm: { profiles: updated } });
    } else {
      const id = profileId || ('p_' + Date.now().toString(36));
      const np = { id, baseUrl, model, name: profileName || model, apiKey: apiKey || '', createdAt: now, updatedAt: now };
      const updated = profiles.concat([np]);
      saveLlmConfig({ profiles: updated });
      sendToRenderer('llmConfigSaved', { llm: { profiles: updated } });
    }
  } catch (err) {
    sendToRenderer('llmConfigError', { message: err.message });
  }
});

ipcMain.on('llmGetProfileKey', (_event, msg) => {
  const llm = loadLlmConfig();
  const p = (llm.profiles || []).find((x) => x.id === (msg && msg.profileId));
  sendToRenderer('llmProfileKey', { profileId: msg && msg.profileId, key: p && p.apiKey || '' });
});

ipcMain.on('llmTestConnection', async (_event, msg) => {
  try {
    const { baseUrl, model, apiKey } = msg || {};
    if (!baseUrl || !model) { sendToRenderer('llmTestResult', { ok: false, message: '请填写接口地址和模型' }); return; }
    const endpoint = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (apiKey || '') },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { sendToRenderer('llmTestResult', { ok: false, message: 'HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120) }); return; }
    const data = await res.json();
    const reply = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    sendToRenderer('llmTestResult', { ok: true, reply: String(reply).slice(0, 80) });
  } catch (err) {
    sendToRenderer('llmTestResult', { ok: false, message: err.message });
  }
});

// llmTestAll / llmExportConfig / llmImportConfig / llmFetchFreeModels：提供基本实现
ipcMain.on('llmTestAll', () => sendToRenderer('llmTestAllProgress', { total: 0, done: 0 }));
ipcMain.on('llmExportConfig', () => {
  const llm = loadLlmConfig();
  const profiles = (llm.profiles || []).map(({ id, baseUrl, model, name }) => ({ id, baseUrl, model, name }));
  sendToRenderer('llmExportResult', { ok: true, json: JSON.stringify(profiles, null, 2) });
});
ipcMain.on('llmImportConfig', (_event, msg) => {
  try {
    const arr = JSON.parse((msg && msg.json) || '[]');
    if (!Array.isArray(arr)) throw new Error('格式错误');
    const llm = loadLlmConfig();
    const existing = Array.isArray(llm.profiles) ? llm.profiles : [];
    let imported = 0;
    for (const item of arr) {
      if (!item || !item.model) continue;
      const dup = existing.find((p) => p.baseUrl === item.baseUrl && p.model === item.model);
      if (dup) continue;
      existing.push({ id: item.id || ('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), baseUrl: item.baseUrl, model: item.model, name: item.name || item.model, apiKey: '', createdAt: new Date().toISOString() });
      imported++;
    }
    saveLlmConfig({ profiles: existing });
    sendToRenderer('llmImportResult', { ok: true, imported, llm: { profiles: existing } });
  } catch (err) {
    sendToRenderer('llmImportResult', { ok: false, message: err.message });
  }
});
ipcMain.on('llmFetchFreeModels', () => sendToRenderer('llmFreeModels', { models: [], error: 'Electron 版暂未接入 OpenRouter 免费模型' }));

// ── 知乎发布（复用 lib/zhihu.js）──

const zhihu = require('../lib/zhihu');
const ZHIHU_COOKIE_PATH = path.join(app.getPath('userData'), 'zhihu-cookie.txt');

function getZhihuCookie() {
  try { return fs.readFileSync(ZHIHU_COOKIE_PATH, 'utf8'); } catch (_) { return ''; }
}
function setZhihuCookie(v) {
  try { fs.writeFileSync(ZHIHU_COOKIE_PATH, v, 'utf8'); } catch (_) {}
}

ipcMain.on('zhihuCheckLogin', async () => {
  try {
    const cookieStr = getZhihuCookie();
    if (zhihu.isLoggedIn(cookieStr)) {
      const info = await zhihu.verifyLogin(cookieStr);
      sendToRenderer('zhihuLoginStatus', { loggedIn: info.valid, name: info.name });
    } else {
      sendToRenderer('zhihuLoginStatus', { loggedIn: false });
    }
  } catch (err) {
    sendToRenderer('zhihuLoginStatus', { loggedIn: false });
  }
});

ipcMain.on('zhihuStartQr', async () => {
  const { spawn } = require('child_process');
  const scriptPath = path.join(__dirname, '..', 'scripts', 'zhihu_login.js');
  sendToRenderer('zhihuQrProgress', { message: '正在启动浏览器，请在弹出的窗口中登录...' });
  const proc = spawn(process.execPath, [scriptPath], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') } });
  proc.stdout.on('data', async (d) => {
    const text = d.toString();
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (l === 'READY') { sendToRenderer('zhihuQrReady'); }
      else if (l.startsWith('COOKIE:')) {
        try {
          const cookies = JSON.parse(l.slice(7));
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          const info = await zhihu.verifyLogin(cookieStr);
          if (info.valid) { setZhihuCookie(cookieStr); sendToRenderer('zhihuPollResult', { status: 'confirmed', name: info.name }); }
          else sendToRenderer('zhihuQrError', { message: '登录成功但 Cookie 验证失败' });
        } catch (e) { sendToRenderer('zhihuQrError', { message: '解析登录结果失败：' + e.message }); }
      } else if (l.startsWith('ERROR:')) { sendToRenderer('zhihuQrError', { message: l.slice(6) }); }
    }
  });
  proc.on('error', (err) => sendToRenderer('zhihuQrError', { message: '启动失败：' + err.message }));
});

ipcMain.on('zhihuPollQr', () => {});

ipcMain.on('zhihuLogout', () => {
  setZhihuCookie('');
  sendToRenderer('zhihuLoginStatus', { loggedIn: false });
});

ipcMain.on('zhihuSaveCookie', async (_event, msg) => {
  try {
    const raw = String((msg && msg.z_c0) || '').trim();
    if (!raw) { sendToRenderer('zhihuSaveCookieResult', { success: false, error: 'z_c0 值不能为空' }); return; }
    const cookieStr = `z_c0=${raw};`;
    const info = await zhihu.verifyLogin(cookieStr);
    if (info.valid) { setZhihuCookie(cookieStr); sendToRenderer('zhihuSaveCookieResult', { success: true, name: info.name }); }
    else sendToRenderer('zhihuSaveCookieResult', { success: false, error: 'Cookie 无效或已过期，请重新获取' });
  } catch (err) {
    sendToRenderer('zhihuSaveCookieResult', { success: false, error: err.message });
  }
});

ipcMain.on('zhihuGetArticleId', () => {});

ipcMain.on('zhihuPublish', async (_event, msg) => {
  try {
    const cookieStr = getZhihuCookie();
    if (!zhihu.isLoggedIn(cookieStr)) { sendToRenderer('zhihuPublishResult', { success: false, error: '未登录，请先扫码登录' }); return; }
    const title = String((msg && msg.title) || '').trim();
    if (!title) { sendToRenderer('zhihuPublishResult', { success: false, error: '文章标题不能为空' }); return; }
    const articleId = (msg && msg.articleId) || null;
    if (!lastBodyHtml) { sendToRenderer('zhihuPublishResult', { success: false, error: '请先在左侧编辑器输入内容' }); return; }
    sendToRenderer('zhihuPublishStart');
    const htmlContent = zhihu.buildPublishHtml(lastBodyHtml);
    if (articleId) {
      const result = await zhihu.updateAndPublishArticle({ articleId, title, htmlContent, cookieStr });
      sendToRenderer('zhihuPublishResult', { success: true, url: result.url || 'https://zhuanlan.zhihu.com/p/' + articleId });
    } else {
      const result = await zhihu.createAndPublishArticle({ title, htmlContent, cookieStr });
      sendToRenderer('zhihuPublishResult', { success: true, url: result.url || '' });
    }
  } catch (err) {
    sendToRenderer('zhihuPublishResult', { success: false, error: err.message });
  }
});

ipcMain.on('zhihuSaveDraft', async (_event, msg) => {
  try {
    const cookieStr = getZhihuCookie();
    if (!zhihu.isLoggedIn(cookieStr)) { sendToRenderer('zhihuSaveDraftResult', { success: false, error: '未登录，请先扫码登录' }); return; }
    const title = String((msg && msg.title) || '').trim();
    const articleId = (msg && msg.articleId) || null;
    if (!lastBodyHtml) { sendToRenderer('zhihuSaveDraftResult', { success: false, error: '请先在左侧编辑器输入内容' }); return; }
    const htmlContent = zhihu.buildPublishHtml(lastBodyHtml);
    const result = await zhihu.saveAsDraft({ articleId, title, htmlContent, cookieStr });
    sendToRenderer('zhihuSaveDraftResult', { success: true, editUrl: (result && result.editUrl) || '' });
  } catch (err) {
    sendToRenderer('zhihuSaveDraftResult', { success: false, error: err.message });
  }
});

// ── PPT / Word 导出（Electron 版暂不支持，静默提示）──

['exportPpt', 'exportWord', 'getPptLlmInstruction', 'pptDeleteVersion', 'pptGetVersions', 'pptLlmGenerate', 'pptSaveVersion', 'pptSwitchVersion', 'cancelPpt'].forEach((ch) => {
  ipcMain.on(ch, () => {
    sendToRenderer('error', { message: 'Electron 桌面版暂不支持 PPT / Word 导出，请使用 VS Code 插件版' });
  });
});

ipcMain.on('setXhsExportMode', () => {
  // Electron 小红书导出走 Playwright 经典模式，无需切换
});

// ── Get Zhihu HTML ─────────────────────────────────────

// 知乎编辑器不识别 mac-dots/带样式的 <pre>，统一替换成最干净的 <pre><code> 纯文本
function cleanZhihuCode(html) {
  return String(html).replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (fullMatch, preContent) => {
    const codeMatch = preContent.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    if (!codeMatch) return fullMatch;
    // 反转标签拿纯文本（hljs span / mac-dots svg 全部剥掉）
    const raw = codeMatch[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/\r\n|\r/g, '\n');
    const esc = String(raw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code>${esc}</code></pre>`;
  });
}

ipcMain.on('getZhihuHtml', () => {
  try {
    if (!lastBodyHtml) {
      sendToRenderer('zhihuHtmlError', { message: '请先在左侧编辑器输入内容' });
      return;
    }
    const templatePath = getTemplatePath();
    const theme = getTheme(currentThemeId);
    const html = cleanZhihuCode(buildZhihuCopyHtml(lastBodyHtml, templatePath, theme));
    sendToRenderer('zhihuHtml', { html });
  } catch (err) {
    sendToRenderer('zhihuHtmlError', { message: err.message });
  }
});

// ── Get XHS Copy HTML ──────────────────────────────────

ipcMain.on('getXhsCopyHtml', () => {
  try {
    if (!lastBodyHtml) {
      sendToRenderer('xhsCopyHtmlError', { message: '请先在左侧编辑器输入内容' });
      return;
    }
    const theme = getTheme(currentThemeId);
    const html = buildXhsCopyHtml(bodyHtml, theme);
    sendToRenderer('xhsCopyHtml', { html });
  } catch (err) {
    sendToRenderer('xhsCopyHtmlError', { message: err.message });
  }
});

// ── Todo toggle ────────────────────────────────────────

ipcMain.on('todoToggle', (_event, msg) => {
  if (!currentFilePath) return;
  try {
    const content = fs.readFileSync(currentFilePath, 'utf8');
    let count = 0;
    const updated = content.replace(/^(\s*[-*+]\s)\[( |x|X)\]/gm, (match, prefix) => {
      if (count++ === msg.index) {
        return prefix + (msg.checked ? '[x]' : '[ ]');
      }
      return match;
    });
    if (updated !== content) {
      fs.writeFileSync(currentFilePath, updated, 'utf8');
    }
  } catch (e) {
    console.error('todoToggle failed:', e.message);
  }
});

// ── Fetch image base64 (from webview) ──────────────────

ipcMain.on('fetchImageBase64', (_event, msg) => {
  const imgUrl = msg.url;
  const reqId = msg.reqId;
  try {
    const parsed = new urlMod.URL(imgUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const data = [];
    const req = client.get(imgUrl, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        sendToRenderer('imageBase64Result', { reqId, url: imgUrl, dataUrl: null, error: 'HTTP ' + res.statusCode });
        return;
      }
      res.on('data', c => data.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(data);
        const ext = (parsed.pathname.split('.').pop() || 'png').toLowerCase();
        const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
        const mime = mimeMap[ext] || 'image/png';
        sendToRenderer('imageBase64Result', { reqId, url: imgUrl, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
      });
    });
    req.on('error', (err) => {
      sendToRenderer('imageBase64Result', { reqId, url: imgUrl, dataUrl: null, error: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      sendToRenderer('imageBase64Result', { reqId, url: imgUrl, dataUrl: null, error: 'timeout' });
    });
  } catch (err) {
    sendToRenderer('imageBase64Result', { reqId, url: imgUrl, dataUrl: null, error: err.message });
  }
});

// ── Generate XHS via Playwright ────────────────────────

function installChromium() {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const appRoot = path.join(__dirname, '..');
    const cliPath = path.join(appRoot, 'node_modules', 'playwright-core', 'lib', 'cli', 'program.js');
    const proc = spawn(process.execPath, [cliPath, 'install', 'chromium']);
    proc.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) sendToRenderer('xhsPythonProgress', { message: '📥 ' + line });
    });
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) sendToRenderer('xhsPythonProgress', { message: '📥 ' + line });
    });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

// ─────────────────────────────────────────────
//  封面模块（与扩展端 extension.js 的 cover 逻辑保持一致）
//  存储位于 userData/cover/（config.json + bgs/）
// ─────────────────────────────────────────────

const COVER_STORE_DIR = path.join(app.getPath('userData'), 'cover');
const COVER_CONFIG_PATH = path.join(COVER_STORE_DIR, 'config.json');
const COVER_APP_ROOT = path.join(__dirname, '..');

function coverPresetDir() { return path.join(COVER_APP_ROOT, 'assets', 'covers'); }
function ensureCoverStoreDir() {
  if (!fs.existsSync(COVER_STORE_DIR)) fs.mkdirSync(COVER_STORE_DIR, { recursive: true });
  const bg = path.join(COVER_STORE_DIR, 'bgs');
  if (!fs.existsSync(bg)) fs.mkdirSync(bg, { recursive: true });
  return COVER_STORE_DIR;
}
function loadCoverConfig() {
  try {
    if (fs.existsSync(COVER_CONFIG_PATH)) {
      const j = JSON.parse(fs.readFileSync(COVER_CONFIG_PATH, 'utf8'));
      return { defaultBgId: j.defaultBgId || null, defaultBgIdByType: (j.defaultBgIdByType && typeof j.defaultBgIdByType === 'object') ? j.defaultBgIdByType : {}, titleState: j.titleState || null, bgs: Array.isArray(j.bgs) ? j.bgs : [], mdBgs: (j.mdBgs && typeof j.mdBgs === 'object') ? j.mdBgs : {} };
    }
  } catch (_) {}
  return { defaultBgId: null, defaultBgIdByType: {}, titleState: null, bgs: [], mdBgs: {} };
}
function saveCoverConfig(cfg) {
  try {
    ensureCoverStoreDir();
    fs.writeFileSync(COVER_CONFIG_PATH, JSON.stringify({ defaultBgId: cfg.defaultBgId || null, defaultBgIdByType: cfg.defaultBgIdByType || {}, titleState: cfg.titleState || null, bgs: cfg.bgs || [], mdBgs: cfg.mdBgs || {} }, null, 2) + '\n', 'utf8');
  } catch (e) { console.error('保存封面配置失败: ' + e.message); }
}
/** 把内置的预设背景注册进 cfg.bgs（带 preset 标记，删除后重启会重新出现） */
function coverEnsurePresets(cfg) {
  try {
    const dir = coverPresetDir();
    if (!dir || !fs.existsSync(dir)) return cfg;
    const files = fs.readdirSync(dir).filter(f => /^preset-.+\.(png|jpe?g)$/i.test(f));
    if (!files.length) return cfg;
    const haveIds = new Set((cfg.bgs || []).map(b => b.id));
    let changed = false;
    for (const f of files) {
      const id = 'preset-' + f.replace(/^preset-/, '').replace(/\.(png|jpe?g)$/i, '');
      if (haveIds.has(id)) continue;
      const name = {
        'preset-dreamy': '梦境蓝紫', 'preset-sunset': '落日橙紫', 'preset-minimal': '极简灰白',
        'preset-forest': '墨绿森林', 'preset-night': '夜空繁星', 'preset-mint': '清新薄荷',
        'preset-horizon': '签售会横版', 'preset-vertical2': '签售会竖版',
      }[id] || id.replace('preset-', '');
      cfg.bgs.push({ id, ext: f.match(/jpe?g$/i) ? 'jpg' : 'png', name, preset: true, presetFile: f, path: path.join(dir, f), createdAt: new Date().toISOString() });
      haveIds.add(id);
      changed = true;
    }
    if (changed && !cfg.defaultBgId && cfg.bgs.length) cfg.defaultBgId = cfg.bgs[0].id;
    // 旧版配置迁移：默认背景只有一个全局 id。为保证「切换规格时默认背景自动切换」，
    // 为各规格分配不同的默认：当前默认（用户选择或第一个预设）→ xhs，其余规格轮流用其他预设
    if (!cfg.defaultBgIdByType) cfg.defaultBgIdByType = {};
    if (!Object.keys(cfg.defaultBgIdByType).length) {
      const others = (cfg.bgs || []).filter(b => b.preset && b.id !== cfg.defaultBgId);
      const cur = cfg.defaultBgId || ((cfg.bgs || [])[0] || {}).id || null;
      cfg.defaultBgIdByType['xhs'] = cur;
      cfg.defaultBgIdByType['wx-head'] = (others[0] || {}).id || cur;
      cfg.defaultBgIdByType['wx-thumb'] = (others[1] || others[0] || {}).id || cur;
    }
    return cfg;
  } catch (e) { return cfg; }
}
/** 当前 mdPath + 封面规格生效的背景 id：per-md 覆盖优先，其次该规格的全局默认，最后旧版全局默认 */
function coverEffectiveBgId(cfg, mdPath, coverType) {
  if (mdPath && cfg.mdBgs && cfg.mdBgs[mdPath]) return cfg.mdBgs[mdPath];
  if (coverType && cfg.defaultBgIdByType && cfg.defaultBgIdByType[coverType]) return cfg.defaultBgIdByType[coverType];
  return cfg.defaultBgId || null;
}
/** 归一化封面排版配置为「按类型」的映射，兼容旧版平面对象格式 */
function coverTitleStateByType(cfg) {
  const ts = cfg.titleState || {};
  const byType = {};
  byType.xhs = (ts.xhs && ts.xhs.x !== undefined) ? ts.xhs : { x: 50, y: 50, fontSize: 78, width: 70 };
  byType['wx-head'] = (ts['wx-head'] && ts['wx-head'].x !== undefined) ? ts['wx-head'] : { x: 50, y: 42, fontSize: 72, width: 62 };
  byType['wx-thumb'] = (ts['wx-thumb'] && ts['wx-thumb'].x !== undefined) ? ts['wx-thumb'] : { x: 50, y: 50, fontSize: 56, width: 78 };
  if (ts.x !== undefined && !ts.xhs) {
    byType.xhs = { x: Number(ts.x) || 50, y: Number(ts.y) || 50, fontSize: Number(ts.fontSize) || 78, width: Number(ts.width) || 70 };
  }
  return byType;
}
function coverBgFilePath(id, ext = 'png') { return path.join(COVER_STORE_DIR, 'bgs', `${id}.${ext}`); }
/** 保存背景图并设为指定规格的默认背景 */
function coverSaveBgFromDataUrl(dataUrl, nameHint, coverType) {
  ensureCoverStoreDir();
  const m = String(dataUrl).match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) throw new Error('无效的图片 dataUrl');
  const ext = (m[1] === 'jpeg' ? 'jpg' : m[1]);
  const id = Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
  const fp = coverBgFilePath(id, ext);
  fs.writeFileSync(fp, Buffer.from(m[2], 'base64'));
  let cfg = loadCoverConfig();
  cfg = coverEnsurePresets(cfg);
  const item = { id, ext, name: (nameHint || '').slice(0, 40) || `bg_${id}`, createdAt: new Date().toISOString(), path: fp };
  cfg.bgs.unshift(item);
  if (cfg.bgs.length > 20) {
    const old = cfg.bgs.splice(20);
    for (const o of old) try { fs.unlinkSync(o.path); } catch (_) {}
  }
  cfg.defaultBgId = id;
  cfg.defaultBgIdByType = cfg.defaultBgIdByType || {};
  cfg.defaultBgIdByType[coverType || 'xhs'] = id;
  saveCoverConfig(cfg);
  return { item, cfg };
}
function coverGetBgDataUrl(item) {
  try {
    if (!item || !fs.existsSync(item.path)) return null;
    const ext = item.ext || 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const b64 = fs.readFileSync(item.path).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch (_) { return null; }
}
/** 组装发给 renderer 的 coverHistory 载荷（默认背景按当前规格解析） */
function coverHistoryPayload(cfg, mdPath, coverType) {
  const list = cfg.bgs.map(item => ({ id: item.id, name: item.name, preset: !!item.preset, createdAt: item.createdAt, dataUrl: coverGetBgDataUrl(item) })).filter(x => x.dataUrl);
  return {
    type: 'coverHistory',
    bgs: list,
    defaultBgId: coverEffectiveBgId(cfg, mdPath, coverType || 'xhs'),
    mdBgId: (cfg.mdBgs && cfg.mdBgs[mdPath]) || null,
    defaultBgIdByType: cfg.defaultBgIdByType || {},
    titleState: coverTitleStateByType(cfg),
  };
}

/**
 * 查找可用的 Chromium 可执行文件（进程内渲染封面用，与 extension.js 一致）
 */
function findCoverChromium() {
  const home = os.homedir();
  const cacheDirs = [
    path.join(home, '.cache', 'ms-playwright'),
    process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : null,
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright') : null,
  ].filter(Boolean);
  for (const cacheDir of cacheDirs) {
    if (!fs.existsSync(cacheDir)) continue;
    const entries = fs.readdirSync(cacheDir).filter(e => e.startsWith('chromium'));
    for (const entry of entries) {
      const candidates = {
        darwin: path.join(cacheDir, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        linux: path.join(cacheDir, entry, 'chrome-linux', 'chrome'),
        win32: path.join(cacheDir, entry, 'chrome-win', 'chrome.exe'),
      };
      const p = candidates[process.platform];
      if (p && fs.existsSync(p)) return p;
      if (process.platform === 'darwin') {
        const shell = path.join(cacheDir, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
        if (fs.existsSync(shell)) return shell;
        const shellX64 = path.join(cacheDir, entry, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell');
        if (fs.existsSync(shellX64)) return shellX64;
      }
    }
  }
  const system = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ],
    linux: [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser', '/usr/bin/chromium',
      '/snap/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  };
  for (const p of (system[process.platform] || [])) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 从文件内容提取标题（无 readArticleMeta 时的轻量替代） */
function readCoverTitleFromFile(p) {
  try {
    const m = fs.readFileSync(p, 'utf8').match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : '';
  } catch (_) { return ''; }
}

/** 取当前激活的 LLM 配置（与扩展端 getLlmConfig 对齐） */
function coverLlmCfg() {
  const llm = loadLlmConfig();
  const profiles = Array.isArray(llm.profiles) ? llm.profiles : [];
  const p = profiles.find(x => x.id === llm.activeProfile) || profiles[0] || null;
  return { baseUrl: (p && p.baseUrl) || '', model: (p && p.model) || '', apiKey: (p && p.apiKey) || '' };
}

// 封面面板当前上下文：生成输出到当前文章同目录；未打开文件时用临时目录
function coverMdPath() { return currentFilePath; }
function coverOutDirFor(mdPath) {
  return mdPath
    ? path.join(path.dirname(mdPath), `${path.basename(mdPath, path.extname(mdPath))}_cover`)
    : path.join(os.tmpdir(), 'm2a_cover');
}

ipcMain.on('coverGetHistory', (_event, msg) => {
  try {
    const cfg = coverEnsurePresets(loadCoverConfig());
    sendToRenderer('coverHistory', coverHistoryPayload(cfg, coverMdPath(), msg && msg.coverType));
  } catch (e) {
    sendToRenderer('coverHistory', { bgs: [], defaultBgId: null, mdBgId: null, defaultBgIdByType: {}, titleState: coverTitleStateByType(loadCoverConfig()) });
  }
});

ipcMain.on('coverSaveBg', (_event, msg) => {
  try {
    const dataUrl = msg && msg.dataUrl;
    if (!dataUrl || !dataUrl.startsWith('data:')) throw new Error('请先选择图片');
    const { item, cfg } = coverSaveBgFromDataUrl(dataUrl, msg.name || '', (msg.coverType || 'xhs'));
    // scope=md：仅当前文章用这张背景（覆盖全局默认）；未打开文件时按全局处理
    if (msg.scope === 'md' && currentFilePath) {
      cfg.mdBgs[currentFilePath] = item.id;
      saveCoverConfig(cfg);
    }
    sendToRenderer('coverHistory', coverHistoryPayload(cfg, coverMdPath(), msg.coverType));
    sendToRenderer('coverSaveBgDone', { id: item.id, dataUrl: coverGetBgDataUrl(item) });
  } catch (e) { sendToRenderer('coverSaveBgDone', { ok: false, message: e.message }); }
});

// 统一设置封面背景：scope='global' 写当前规格的全局默认；scope='md' 仅当前文章（可传 id=null 清除 md 覆盖）
ipcMain.on('coverSetBg', (_event, msg) => {
  try {
    const cfg = coverEnsurePresets(loadCoverConfig());
    const coverType = (msg && msg.coverType) || 'xhs';
    const scope = msg && msg.scope === 'md' ? 'md' : 'global';
    if (scope === 'md') {
      if (msg.id && cfg.bgs.some(b => b.id === msg.id) && currentFilePath) cfg.mdBgs[currentFilePath] = msg.id;
      else if (!msg.id && currentFilePath) delete cfg.mdBgs[currentFilePath];
    } else {
      if (msg.id && cfg.bgs.some(b => b.id === msg.id)) {
        cfg.defaultBgId = msg.id;
        if (!cfg.defaultBgIdByType) cfg.defaultBgIdByType = {};
        cfg.defaultBgIdByType[coverType] = msg.id;
        if (currentFilePath) delete cfg.mdBgs[currentFilePath];
      }
    }
    saveCoverConfig(cfg);
    sendToRenderer('coverHistory', coverHistoryPayload(cfg, coverMdPath(), coverType));
  } catch (e) { sendToRenderer('coverHistory', { bgs: [], defaultBgId: null, mdBgId: null }); }
});

ipcMain.on('coverSetDefaultBg', (_event, msg) => {
  try {
    const cfg = coverEnsurePresets(loadCoverConfig());
    const coverType = (msg && msg.coverType) || 'xhs';
    if (msg && msg.id && cfg.bgs.some(b => b.id === msg.id)) {
      cfg.defaultBgId = msg.id;
      if (!cfg.defaultBgIdByType) cfg.defaultBgIdByType = {};
      cfg.defaultBgIdByType[coverType] = msg.id;
      if (currentFilePath) delete cfg.mdBgs[currentFilePath];
      saveCoverConfig(cfg);
    }
    sendToRenderer('coverHistory', coverHistoryPayload(cfg, coverMdPath(), coverType));
  } catch (e) { sendToRenderer('coverHistory', { bgs: [], defaultBgId: null, mdBgId: null }); }
});

ipcMain.on('coverDeleteBg', (_event, msg) => {
  try {
    const cfg = coverEnsurePresets(loadCoverConfig());
    const idx = cfg.bgs.findIndex(b => b.id === msg.id);
    if (idx >= 0) {
      if (!cfg.bgs[idx].preset) { try { fs.unlinkSync(cfg.bgs[idx].path); } catch (_) {} }
      cfg.bgs.splice(idx, 1);
      if (cfg.defaultBgId === msg.id) cfg.defaultBgId = (cfg.bgs[0] && cfg.bgs[0].id) || null;
      if (cfg.defaultBgIdByType) {
        for (const t of Object.keys(cfg.defaultBgIdByType)) {
          if (cfg.defaultBgIdByType[t] === msg.id) cfg.defaultBgIdByType[t] = (cfg.bgs[0] && cfg.bgs[0].id) || null;
        }
      }
      if (cfg.mdBgs && currentFilePath && cfg.mdBgs[currentFilePath] === msg.id) delete cfg.mdBgs[currentFilePath];
      saveCoverConfig(cfg);
    }
    sendToRenderer('coverHistory', coverHistoryPayload(cfg, coverMdPath(), msg.coverType));
  } catch (e) { sendToRenderer('coverHistory', { bgs: [], defaultBgId: null }); }
});

ipcMain.on('coverSaveTitleState', (_event, msg) => {
  try {
    const cfg = loadCoverConfig();
    const type = (msg && msg.coverType) || 'xhs';
    const byType = (cfg.titleState && !cfg.titleState.xhs && !cfg.titleState['wx-head'] && !cfg.titleState['wx-thumb'])
      ? { xhs: cfg.titleState }
      : (cfg.titleState || {});
    byType[type] = { x: Number(msg.x) || 50, y: Number(msg.y) || 50, fontSize: Number(msg.fontSize) || 78, width: Number(msg.width) || 70 };
    cfg.titleState = byType;
    saveCoverConfig(cfg);
    sendToRenderer('coverTitleStateSaved', { titleState: byType });
  } catch (e) { sendToRenderer('coverTitleStateSaved', { ok: false, message: e.message }); }
});

ipcMain.on('coverGeneratePrompt', async (_event, msg) => {
  try {
    const mdPath = coverMdPath();
    const title = ((msg && msg.title) || readCoverTitleFromFile(mdPath) || '').trim();
    const result = await coverLlm.generateCoverPrompt({
      title, abstract: (msg && msg.abstract) || '', vibe: (msg && msg.vibe) || '',
      instruction: (msg && msg.instruction) || '', config: coverLlmCfg(),
    });
    sendToRenderer('coverPromptResult', { ok: true, ...result });
  } catch (e) {
    sendToRenderer('coverPromptResult', { ok: false, message: e.message });
  }
});

ipcMain.on('coverGenerateImage', async (_event, msg) => {
  try {
    const cfg = coverLlmCfg();
    const size = '1024x1536';
    const { b64 } = await coverLlm.generateCoverImage({
      prompt: msg && msg.prompt, negativePrompt: (msg && msg.negativePrompt) || '', config: cfg, size,
    });
    // 保存到封面输出目录 + 同步入全局历史（自动设为默认）
    const mdPath = coverMdPath();
    const outDir = coverOutDirFor(mdPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `cover_bg_${Date.now()}.png`);
    coverLlm.saveB64ToFile(b64, outPath);
    const dataUrl = `data:image/png;base64,${b64}`;
    try { coverSaveBgFromDataUrl(dataUrl, 'LLM_' + Date.now(), (msg && msg.coverType) || 'xhs'); } catch (_) {}
    sendToRenderer('coverImageResult', { ok: true, dataUrl, outPath });
    try {
      const cfg2 = coverEnsurePresets(loadCoverConfig());
      sendToRenderer('coverHistory', coverHistoryPayload(cfg2, coverMdPath(), msg && msg.coverType));
    } catch (_) {}
  } catch (e) {
    sendToRenderer('coverImageResult', { ok: false, message: e.message, needCopy: /404|not found|不支持/i.test(e.message) });
  }
});

ipcMain.on('coverGenerate', (_event, msg) => {
  // 合成封面：标题 + 背景图 -> PNG（主进程内渲染，不依赖子进程脚本）
  try {
    const mdPath = coverMdPath() || path.join(os.tmpdir(), 'm2a_untitled');
    const title = ((msg && msg.title) || '').trim() || readCoverTitleFromFile(mdPath) || '未命名封面';
    let bgDataUrl = (msg && (msg.bgDataUrl || msg.bg)) || '';
    const coverType = (msg && msg.coverType) || 'xhs';
    // 优先按 id 从存储解析（renderer 与主进程共用同一份文件，避免传大 data URL）
    if (msg && msg.bgId) {
      try {
        const cfg = coverEnsurePresets(loadCoverConfig());
        const it = (cfg.bgs || []).find(b => b.id === msg.bgId);
        if (it) bgDataUrl = coverGetBgDataUrl(it) || '';
      } catch (_) {}
    }
    if (!bgDataUrl) {
      // 未显式传背景时，用当前生效背景（per-md 覆盖优先，其次该规格的全局默认）
      try {
        const cfg = coverEnsurePresets(loadCoverConfig());
        const bid = coverEffectiveBgId(cfg, mdPath, coverType);
        if (bid) {
          const it = cfg.bgs.find(b => b.id === bid);
          if (it) bgDataUrl = coverGetBgDataUrl(it) || '';
        }
      } catch (_) {}
    }
    const tagline = (msg && msg.tagline) || '';
    let bgPath = '';
    if (bgDataUrl && bgDataUrl.startsWith('data:')) {
      const m = bgDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
      if (m) {
        bgPath = path.join(os.tmpdir(), `m2a_cover_bg_${Date.now()}.png`);
        fs.writeFileSync(bgPath, Buffer.from(m[1], 'base64'));
      }
    } else if (bgDataUrl && !bgDataUrl.startsWith('http')) {
      if (bgDataUrl && fs.existsSync(bgDataUrl)) bgPath = bgDataUrl;
      else bgPath = bgDataUrl;
    }
    const outDir = coverOutDirFor(mdPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const cw = Number(msg && msg.width) || 1080;
    const ch = Number(msg && msg.height) || 1440;
    const typeTag = coverType === 'xhs' ? '' : `_${coverType}`;
    const outPath = path.join(outDir, `cover${typeTag}_${Date.now()}.png`);

    let finished = false;
    let watchdog = null;
    let browserRef = null;
    const cleanupBg = () => { try { if (bgPath && bgPath.includes(os.tmpdir()) && fs.existsSync(bgPath)) fs.unlinkSync(bgPath); } catch (_) {} };
    const finish = (ok, message, dataUrl, out) => {
      if (finished) return;
      finished = true;
      if (watchdog) clearTimeout(watchdog);
      cleanupBg();
      if (ok) sendToRenderer('coverResult', { ok: true, dataUrl, outPath: out });
      else sendToRenderer('coverResult', { ok: false, message });
    };
    // 看门狗：渲染/下载挂死时兜底报错，避免界面永远停在「正在合成封面」
    const armWatchdog = (ms) => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        try {
          if (browserRef) { const b = browserRef; browserRef = null; b.close().catch(() => {}); }
        } catch (_) {}
        finish(false, '封面合成超时（' + Math.round(ms / 1000) + ' 秒），请重试；若持续失败请检查浏览器是否可用');
      }, ms);
    };
    armWatchdog(180000);

    (async () => {
      try {
        if (finished) return;
        const bgImage = bgPath || (bgDataUrl.startsWith('http') ? bgDataUrl : '');
        const htmlContent = cover.buildCoverHtml({ title: title || '未命名封面', subtitle: 'marsggbo', bgImage, tagline, width: cw, height: ch, titleState: (msg && msg.titleState) || null });
        const tmpHtml = path.join(os.tmpdir(), `m2a_cover_${Date.now()}.html`);
        fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

        let executablePath = findCoverChromium();
        if (!executablePath) {
          if (finished) return;
          sendToRenderer('coverProgress', { message: '📥 首次使用，正在下载 Chromium...' });
          if (watchdog) clearTimeout(watchdog);
          await installChromium();
          if (finished) return;
          executablePath = findCoverChromium();
          if (!executablePath) { finish(false, '未找到可用浏览器，请安装 Chrome 或重试「安装 Chromium」后再生成'); return; }
          armWatchdog(180000);
        }
        if (finished) return;

        const { chromium } = require('playwright-core');
        const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        browserRef = browser;
        let buf = null;
        try {
          const page = await browser.newPage({ viewport: { width: cw, height: ch }, deviceScaleFactor: 2 });
          await page.goto('file://' + path.resolve(tmpHtml), { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(600);
          // 截图的物理像素是 viewport*scale，需用 clip 限制
          buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: cw, height: ch } });
        } finally {
          browserRef = null;
          try { await browser.close(); } catch (_) {}
          try { if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml); } catch (_) {}
        }
        if (finished) return;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, buf);
        finish(true, '', `data:image/png;base64,${buf.toString('base64')}`, outPath);
      } catch (e) { finish(false, e.message); }
    })();
  } catch (e) { sendToRenderer('coverResult', { ok: false, message: e.message }); }
});

ipcMain.on('generateXhsViaPython', async (_event, msg) => {
  if (!lastBodyHtml) {
    sendToRenderer('xhsPythonError', { message: '请先在左侧编辑器输入内容' });
    return;
  }

  const { spawn } = require('child_process');
  const { width = 1080, height = 1440, padding = 40, bg = '#ffffff', autoExport = false } = msg;
  const appRoot = path.join(__dirname, '..');

  // Generate standalone render HTML（用最近渲染的正文，无需文件路径）
  const theme = getTheme(currentThemeId);
  const htmlContent = buildXhsRenderHtml(lastBodyHtml, os.tmpdir(), theme);

  const tmpHtml = path.join(os.tmpdir(), `markdown2anything_xhs_${crypto.randomUUID()}.html`);
  const base = 'markdown2anything';
  const outDir = autoExport
    ? path.join(os.homedir(), 'Desktop', `${base}_xhs`)
    : path.join(os.tmpdir(), `markdown2anything_xhs_preview_${crypto.randomUUID()}`);

  fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

  const scriptPath = path.join(appRoot, 'scripts', 'xhs_screenshot.js');

  function runScreenshot(retryAfterInstall) {
    sendToRenderer('xhsPythonProgress', { message: '⏳ 渲染中，请稍候...' });

    const proc = spawn(process.execPath, [
      scriptPath, tmpHtml, outDir,
      '--width', String(width), '--height', String(height),
      '--padding', String(padding), '--bg', bg,
    ]);

    let stdout = '';
    proc.stdout.on('data', d => {
      stdout += d.toString();
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.startsWith('INFO:')) {
          sendToRenderer('xhsPythonProgress', { message: '⏳ ' + line.slice(5).trim() });
        }
      }
    });

    proc.on('close', async (code) => {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}

      if (code === 2 && !retryAfterInstall) {
        sendToRenderer('xhsPythonProgress', { message: '📥 首次使用，正在下载 Chromium（约 150MB）...' });
        await installChromium();
        const htmlContent2 = buildXhsRenderHtml(bodyHtml, path.dirname(currentFilePath), theme);
        fs.writeFileSync(tmpHtml, htmlContent2, 'utf8');
        runScreenshot(true);
        return;
      }

      if (code !== 0) {
        const errLine = stdout.split('\n').find(l => l.startsWith('ERROR:')) || '截图失败';
        sendToRenderer('xhsPythonError', { message: errLine.replace('ERROR:', '').trim() });
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

      sendToRenderer('xhsPythonDone', { dataUrls, outDir, autoExport });
    });

    proc.on('error', (err) => {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}
      sendToRenderer('xhsPythonError', { message: err.message });
    });
  }

  runScreenshot(false);
});

// ── Save XHS images ────────────────────────────────────

ipcMain.on('saveXhsImages', (_event, msg) => {
  try {
    const dataUrls = (msg && msg.dataUrls) || [];
    if (!dataUrls.length) { sendToRenderer('saveXhsImagesError', { message: '没有可保存的图片' }); return; }
    const dir = currentFilePath
      ? path.join(path.dirname(currentFilePath), `${path.basename(currentFilePath, path.extname(currentFilePath))}_xhs`)
      : path.join(os.homedir(), 'Desktop', 'markdown2anything_xhs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    dataUrls.forEach((dataUrl, i) => {
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const fname = `xiaohongshu-${String(i + 1).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(dir, fname), buf);
    });

    sendToRenderer('saveXhsImagesDone', { count: dataUrls.length, dir });
    if (!process.env.M2A_HEADLESS) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '导出完成',
        message: `已导出 ${dataUrls.length} 张图片到:\n${dir}`,
        buttons: ['打开目录', '确定'],
      }).then(({ response }) => {
        if (response === 0) shell.openPath(dir);
      });
    }
  } catch (err) {
    sendToRenderer('saveXhsImagesError', { message: err.message });
  }
});

// ── Upload to WeChat (via FastPen API) ─────────────────

ipcMain.on('upload', async (_event, msg) => {
  if (!lastRawMarkdown) {
    sendToRenderer('uploadResult', { success: false, error: '请先在左侧编辑器输入内容' });
    return;
  }

  const rawMarkdown = lastRawMarkdown;
  const { appid, appSecret, title, author, digest } = msg;

  if (!appid || !appSecret) {
    sendToRenderer('uploadResult', { success: false, error: '请先配置 AppID 和 AppSecret' });
    return;
  }

  sendToRenderer('uploadStart');

  try {
    const result = await postToFastPen({ markdown: rawMarkdown, title, appid, appSecret, author, digest });
    if (result.success) {
      sendToRenderer('uploadResult', {
        success: true,
        mediaId: result.data && result.data.media_id,
      });
    } else {
      sendToRenderer('uploadResult', {
        success: false,
        error: result.message || '上传失败，请检查配置',
      });
    }
  } catch (err) {
    sendToRenderer('uploadResult', { success: false, error: err.message });
  }
});

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
        'User-Agent': 'markdown2anything-electron/1.0',
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
