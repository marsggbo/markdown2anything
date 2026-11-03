'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPublishingRuntime, registerElectronPublishing } = require('../lib/publishing/host-entry');
const { SecretStore, validateZhihuCookies } = require('../lib/publishing/secrets');
const { sha256 } = require('../lib/publishing/model');
const { renderMarkdown, buildWechatCopyHtml, buildZhihuCopyHtml, buildXhsCopyHtml } = require('../lib/converter');
const { THEMES, DEFAULT_THEME_ID, getTheme } = require('../lib/themes');

const SECRET_FILE = 'secrets.json';
const PUBLISHING_DIR = 'publishing';
const LEGACY_COOKIE_FILE = 'zhihu-cookie.txt';

function bootstrapError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}
function fsyncDirectory(directory) {
  let descriptor;
  try { descriptor = fs.openSync(directory, 'r'); fs.fsyncSync(descriptor); } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function atomicWriteVerified(filePath, value, mode) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const contents = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode || 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode || 0o600);
  fsyncDirectory(directory);
  const reread = fs.readFileSync(filePath);
  if (!reread.equals(contents)) throw bootstrapError('SECURE_STORAGE_UNAVAILABLE');
  return reread;
}
function safeStorageAvailable(safeStorage) {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable() &&
      (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  } catch (_) { return false; }
}
function legacyCookieValue(value) {
  if (!value) return null;
  try { return validateZhihuCookies(value); } catch (_) {}
  const zc0 = /(?:^|;\s*)z_c0=([^;\s]+)/.exec(String(value));
  if (!zc0) return null;
  return validateZhihuCookies(JSON.stringify([{
    name: 'z_c0', value: zc0[1], domain: '.zhihu.com', path: '/', expires: -1,
    httpOnly: false, secure: true, sameSite: 'Lax',
  }]));
}

function createElectronSecretStore({ userData, safeStorage, fileSystem = fs }) {
  const root = path.join(userData, PUBLISHING_DIR);
  const secretPath = path.join(root, SECRET_FILE);
  const available = safeStorageAvailable(safeStorage);
  const port = {
    availability: async () => available ? { available: true } : { available: false, reason: 'SECURE_STORAGE_UNAVAILABLE' },
    get: async slot => {
      if (!available) return null;
      const saved = readJson(secretPath, { version: 1, values: {} });
      const encoded = saved.values && saved.values[slot];
      if (typeof encoded !== 'string') return null;
      try { return safeStorage.decryptString(Buffer.from(encoded, 'base64')); } catch (_) { throw bootstrapError('SECURE_STORAGE_UNAVAILABLE'); }
    },
    set: async (slot, value) => {
      if (!available) throw bootstrapError('SECURE_STORAGE_UNAVAILABLE');
      const saved = readJson(secretPath, { version: 1, values: {} });
      saved.version = 1;
      saved.values = saved.values && typeof saved.values === 'object' ? saved.values : {};
      saved.values[slot] = safeStorage.encryptString(value).toString('base64');
      atomicWriteVerified(secretPath, JSON.stringify(saved), 0o600);
    },
    delete: async slot => {
      if (!available) throw bootstrapError('SECURE_STORAGE_UNAVAILABLE');
      const saved = readJson(secretPath, { version: 1, values: {} });
      if (!saved.values || typeof saved.values !== 'object') saved.values = {};
      delete saved.values[slot];
      atomicWriteVerified(secretPath, JSON.stringify(saved), 0o600);
    },
  };
  return { store: new SecretStore(port), available, secretPath, root };
}

async function migrateElectronSecrets({ userData, safeStorage, configPath, cookiePath, fileSystem = fs }) {
  const secure = createElectronSecretStore({ userData, safeStorage, fileSystem });
  if (!secure.available) return { ...secure, migrated: false };
  const config = readJson(configPath, {});
  const writes = [];
  if (typeof config.appSecret === 'string' && config.appSecret) writes.push(['publishing.wechat.appSecret', config.appSecret]);
  let cookie = null;
  try { cookie = fileSystem.readFileSync(cookiePath, 'utf8'); } catch (_) {}
  const normalizedCookie = legacyCookieValue(cookie);
  if (normalizedCookie) writes.push(['publishing.zhihu.browserCookies', normalizedCookie]);
  for (const [slot, value] of writes) {
    await secure.store.set(slot, value);
    if (await secure.store.get(slot) !== value) throw bootstrapError('SECURE_STORAGE_UNAVAILABLE');
  }
  if (Object.prototype.hasOwnProperty.call(config, 'appSecret')) {
    delete config.appSecret;
    atomicWriteVerified(configPath, JSON.stringify(config, null, 2) + '\n', 0o600);
  }
  if (normalizedCookie && fileSystem.existsSync(cookiePath)) fileSystem.unlinkSync(cookiePath);
  return { ...secure, migrated: writes.length > 0 };
}

function createElectronPublishingServices(options) {
  const state = options.state;
  const dialog = options.dialog;
  const shell = options.shell;
  const secure = options.secure;
  const configPath = options.configPath;
  const userData = options.userData;
  const secretStore = secure.store;
  const revisions = new Map();
  const selections = new Map();
  function currentDocument() {
    if (!state.currentFilePath || state.documentDirty || !state.savedDocumentHash) return { dirty: true };
    let content;
    try { content = fs.readFileSync(state.currentFilePath, 'utf8'); } catch (_) { return { dirty: true }; }
    if (sha256(content) !== state.savedDocumentHash) return { dirty: true };
    return { dirty: false, documentPath: state.currentFilePath, displayName: path.basename(state.currentFilePath), content };
  }
  async function chooseCoverFile() {
    const result = await dialog.showOpenDialog(state.mainWindow, {
      title: '选择发布封面', filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }], properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    const selectionId = crypto.randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    selections.set(selectionId, { path: result.filePaths[0], expiresAt });
    return { selectionId, label: path.basename(result.filePaths[0]), expiresAt };
  }
  function resolveCoverSelection(selectionId) {
    const selection = selections.get(selectionId);
    if (!selection || Date.parse(selection.expiresAt) <= Date.now()) return null;
    selections.delete(selectionId);
    return selection.path;
  }
  function publishConfig() {
    return { wechat: { appId: typeof state.config.appid === 'string' ? state.config.appid : '' } };
  }
  return {
    jobRoot: path.join(userData, PUBLISHING_DIR, 'jobs'),
    publishAvailable: secure.available,
    readDocument: async () => currentDocument(),
    chooseCoverFile,
    resolveCoverSelection,
    getTargetContext: async target => ({
      account: target === 'wechat' ? { appId: publishConfig().wechat.appId } : null,
      config: publishConfig(),
      getSecret: slot => secretStore.get(slot),
      getCredentialRevision: slot => secretStore.getRevision(slot),
    }),
    savePublishConfig: async config => {
      const incoming = config && typeof config === 'object' ? config : {};
      if (typeof incoming.appid === 'string') state.config.appid = incoming.appid;
      atomicWriteVerified(configPath, JSON.stringify(state.config, null, 2) + '\n', 0o600);
    },
    requestCredentialEntry: async () => ({ available: false }),
    clearCredential: slot => secretStore.delete(slot),
    openReviewUrl: url => shell.openExternal(url),
    rememberSavedDocument(content) {
      state.savedDocumentHash = sha256(content);
      state.documentDirty = false;
    },
    markDirty(content) {
      state.documentDirty = sha256(content) !== state.savedDocumentHash;
    },
    recordCredentialRevision: async slot => { revisions.set(slot, await secretStore.getRevision(slot)); return revisions.get(slot); },
  };
}

function writeSavedDocument(filePath, content) {
  atomicWriteVerified(filePath, content, 0o600);
  return fs.readFileSync(filePath, 'utf8');
}

function bootElectronApp(overrides) {
  const electron = overrides && overrides.electron || require('electron');
  const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = electron;
  const state = { mainWindow: null, currentFilePath: null, currentThemeId: DEFAULT_THEME_ID, config: {}, savedDocumentHash: null, documentDirty: true, lastBodyHtml: '', lastRawMarkdown: '' };
  const userData = overrides && overrides.userData || app.getPath('userData');
  const configPath = path.join(userData, 'config.json');
  const cookiePath = path.join(userData, LEGACY_COOKIE_FILE);
  let publishing;
  let publishRegistration;

  function send(channel, payload) {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.webContents.send(channel, payload);
  }
  function renderFromText(text) {
    const file = path.join(os.tmpdir(), `m2a_render_${crypto.randomUUID()}.md`);
    try { fs.writeFileSync(file, text || '', 'utf8'); const output = renderMarkdown(file); state.lastBodyHtml = output.bodyHtml; state.lastRawMarkdown = output.rawMarkdown; const theme = getTheme(state.currentThemeId); send('update', { bodyHtml: output.bodyHtml, title: output.title, theme: { id: theme.id, css: theme.css, wrapperBg: theme.wrapperBg } }); } catch (error) { send('error', { message: error.message }); } finally { try { fs.unlinkSync(file); } catch (_) {} }
  }
  function renderSaved() { if (!state.currentFilePath) return; try { renderFromText(fs.readFileSync(state.currentFilePath, 'utf8')); } catch (error) { send('error', { message: error.message }); } }
  function createWindow() {
    state.mainWindow = new BrowserWindow({ width: 1400, height: 900, minWidth: 900, minHeight: 600, show: !process.env.M2A_HEADLESS, webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true } });
    state.mainWindow.loadFile(path.join(__dirname, 'panel.html'));
    state.mainWindow.on('closed', () => { state.mainWindow = null; });
  }
  function openFile() {
    return dialog.showOpenDialog(state.mainWindow, { title: '打开 Markdown 文件', filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }], properties: ['openFile'] }).then(result => {
      if (result.canceled || !result.filePaths.length) return null;
      const filePath = result.filePaths[0]; const content = fs.readFileSync(filePath, 'utf8');
      state.currentFilePath = filePath; publishing.rememberSavedDocument(content); renderFromText(content);
      return { content, filePath, fileName: path.basename(filePath), dirName: path.dirname(filePath) };
    });
  }

  app.whenReady().then(async () => {
    state.config = readJson(configPath, {});
    const secure = await migrateElectronSecrets({ userData, safeStorage, configPath, cookiePath });
    const services = createElectronPublishingServices({ state, dialog, shell, secure, configPath, userData });
    publishing = createPublishingRuntime(services, { browserClientOptions: { execPath: process.execPath, environment: process.env } });
    publishRegistration = registerElectronPublishing(publishing, services, event => send(event.type, event));
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

  ipcMain.handle('dialog:openFile', () => openFile());
  ipcMain.handle('dialog:saveFileAs', async (_event, content) => {
    const result = await dialog.showSaveDialog(state.mainWindow, { title: '保存 Markdown 文件', defaultPath: state.currentFilePath ? path.basename(state.currentFilePath) : 'untitled.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return null;
    const saved = writeSavedDocument(result.filePath, String(content || ''));
    state.currentFilePath = result.filePath; publishing && publishing.orchestrator && servicesRememberSaved(publishing, saved); state.savedDocumentHash = sha256(saved); state.documentDirty = false; renderFromText(saved);
    return { filePath: result.filePath, fileName: path.basename(result.filePath) };
  });
  ipcMain.handle('getAppPath', () => path.join(__dirname, '..'));
  ipcMain.on('saveFile', (_event, msg) => {
    const content = typeof msg === 'string' ? msg : msg && msg.content;
    if (!state.currentFilePath || typeof content !== 'string') return;
    try { const saved = writeSavedDocument(state.currentFilePath, content); state.savedDocumentHash = sha256(saved); state.documentDirty = false; renderFromText(saved); } catch (error) { send('error', { message: `保存失败: ${error.message}` }); }
  });
  ipcMain.on('editorContentChanged', (_event, msg) => { const content = typeof msg === 'string' ? msg : msg && msg.content; if (typeof content !== 'string') return; state.documentDirty = sha256(content) !== state.savedDocumentHash; renderFromText(content); });
  ipcMain.on('newFile', () => { state.currentFilePath = null; state.savedDocumentHash = null; state.documentDirty = true; renderFromText(''); });
  ipcMain.on('setTheme', (_event, msg) => { state.currentThemeId = msg && msg.themeId || DEFAULT_THEME_ID; renderFromText(state.lastRawMarkdown); });
  ipcMain.on('ready', () => { send('themeList', { themes: THEMES.map(theme => ({ id: theme.id, name: theme.name })), currentId: state.currentThemeId }); send('config', { previewContentWidth: state.config.previewSettings && state.config.previewSettings.contentWidth }); });
  ipcMain.on('getWechatHtml', () => { try { send('wechatHtml', { html: buildWechatCopyHtml(state.lastBodyHtml, null, getTheme(state.currentThemeId)) }); } catch (error) { send('wechatHtmlError', { message: error.message }); } });
  ipcMain.on('getZhihuHtml', () => { try { send('zhihuHtml', { html: buildZhihuCopyHtml(state.lastBodyHtml, null, getTheme(state.currentThemeId)) }); } catch (error) { send('zhihuHtmlError', { message: error.message }); } });
  ipcMain.on('getXhsCopyHtml', () => { try { send('xhsCopyHtml', { html: buildXhsCopyHtml(state.lastBodyHtml, getTheme(state.currentThemeId)) }); } catch (error) { send('xhsCopyHtmlError', { message: error.message }); } });
  ipcMain.on('openExternal', (_event, value) => { try { const url = new URL(value); if (url.protocol === 'https:' || url.protocol === 'http:') shell.openExternal(url.toString()); } catch (_) {} });
  ipcMain.on('savePreviewSetting', (_event, message) => { if (!message || message.key !== 'contentWidth') return; state.config.previewSettings = { ...(state.config.previewSettings || {}), contentWidth: Number(message.value) }; try { atomicWriteVerified(configPath, JSON.stringify(state.config, null, 2) + '\n', 0o600); send('savePreviewSettingDone', { key: message.key }); } catch (_) {} });
  const publishChannels = require('../lib/publishing/messages').PUBLISH_COMMANDS;
  publishChannels.forEach(channel => ipcMain.on(channel, (_event, message) => { if (publishRegistration) publishRegistration.dispatch(message); }));
  return { state, get publishing() { return publishing; }, dispose: () => publishRegistration && publishRegistration.dispose() };
}
function servicesRememberSaved(_publishing, _content) {}

module.exports = { bootElectronApp, createElectronSecretStore, migrateElectronSecrets, createElectronPublishingServices, atomicWriteVerified, safeStorageAvailable, legacyCookieValue, writeSavedDocument };
