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

function renderAndSendPreview(mdPath) {
  try {
    const { bodyHtml, title, rawMarkdown } = renderMarkdown(mdPath);
    // lastBodyHtml/lastRawMarkdown 始终存真实内容（供复制/发布用），空状态仅用于预览展示
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
    title: 'Markdown2Anything',
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

ipcMain.on('setTheme', (_event, msg) => {
  currentThemeId = (msg && msg.themeId) || DEFAULT_THEME_ID;
  if (currentFilePath) {
    renderAndSendPreview(currentFilePath);
  }
});

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
