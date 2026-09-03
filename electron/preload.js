'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── Electron ↔ VS Code webview 桥接 ──
// panel.html 调用 acquireVsCodeApi() + vscode.postMessage({type, ...}) 与"扩展"通信。
// 这里把 vscode API mock 成 Electron IPC：
//   vscode.postMessage(msg) → ipcRenderer.send(msg.type, msg)
//   主进程 sendToRenderer(channel, payload) → window.postMessage({type: channel, ...payload})
// 所有转发在 preload 顶层注册（panel.html 不显式调用 electronAPI.on）。

const FORWARD_CHANNELS = [
  'update', 'themeList', 'config', 'error',
  'wechatHtml', 'wechatHtmlError',
  'zhihuHtml', 'zhihuHtmlError',
  'xhsCopyHtml', 'xhsCopyHtmlError',
  'xhsPythonProgress', 'xhsPythonDone', 'xhsPythonError',
  'imageBase64Result',
  'uploadStart', 'uploadResult',
  'configSaved',
  'saveXhsImagesDone', 'saveXhsImagesError',
  // LLM / 知乎 / 封面 / 推文 / 设置等
  'llmConfig', 'llmConfigSaved', 'llmTestProfileResult', 'llmProfileKey',
  'llmExportResult', 'llmImportResult', 'llmTestAllProgress', 'llmFreeModels',
  'llmTestResult', 'llmTestProgress', 'llmConfigError',
  'zhihuLoginStatus', 'zhihuCheckResult', 'zhihuArticleId', 'zhihuPublishResult',
  'zhihuSaveDraftResult', 'zhihuQrStatus',
  'savePreviewSettingDone',
];

// 顶层主动注册：主进程 → window.postMessage（panel.html 的 message 监听器接收）
for (const ch of FORWARD_CHANNELS) {
  ipcRenderer.on(ch, (_event, payload) => {
    window.postMessage({ type: ch, ...(payload || {}) }, '*');
  });
}

// renderer → 主进程 的 channel（与 main.js ipcMain.on 一致）
const SEND_CHANNELS = [
  'editorContentChanged', 'ready', 'getConfig', 'saveConfig',
  'setTheme', 'getWechatHtml', 'getZhihuHtml', 'getXhsCopyHtml',
  'exportHtml', 'fetchImageBase64', 'generateXhsViaPython',
  'saveXhsImages', 'upload', 'todoToggle',
  'newFile', 'openExternal', 'saveFile',
  // 补齐
  'savePreviewSetting', 'requestCursorLine', 'scrollToEditorLine',
  'zhihuCheckLogin', 'zhihuGetArticleId', 'zhihuStartQr', 'zhihuPollQr',
  'zhihuSaveCookie', 'zhihuLogout', 'zhihuPublish', 'zhihuSaveDraft',
  'llmGetConfig', 'llmSaveConfig', 'llmTestConnection', 'llmFetchFreeModels',
  'llmTestAll', 'llmExportConfig', 'llmImportConfig', 'llmGetProfileKey',
];

// panel.html 顶部会调用 acquireVsCodeApi() 拿到 vscode 对象。
// postMessage 直接走 ipcRenderer.send（channel = msg.type）。
contextBridge.exposeInMainWorld('acquireVsCodeApi', () => {
  const stateKey = 'm2a:vscode:state';
  return {
    postMessage: (msg) => {
      if (msg && msg.type && SEND_CHANNELS.includes(msg.type)) {
        ipcRenderer.send(msg.type, msg);
      }
    },
    getState: () => {
      try { return JSON.parse(localStorage.getItem(stateKey) || 'null'); } catch (_) { return null; }
    },
    setState: (st) => {
      try { localStorage.setItem(stateKey, JSON.stringify(st || {})); } catch (_) {}
    },
  };
});

// 编辑器（注入脚本）用：vscode.invoke 风格对话框
contextBridge.exposeInMainWorld('__m2a_bridge', {
  invoke: (channel, ...args) => {
    const allowed = ['dialog:openFile', 'dialog:saveFileAs', 'getAppPath'];
    if (allowed.includes(channel)) return ipcRenderer.invoke(channel, ...args);
    return Promise.reject(new Error('Unknown channel: ' + channel));
  },
});
