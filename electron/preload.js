'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { PUBLISH_COMMANDS, PUBLISH_EVENTS } = require('../lib/publishing/messages');

const FORWARD_CHANNELS = [
  'update', 'themeList', 'config', 'error',
  'wechatHtml', 'wechatHtmlError', 'zhihuHtml', 'zhihuHtmlError', 'xhsCopyHtml', 'xhsCopyHtmlError',
  'xhsPythonProgress', 'xhsPythonDone', 'xhsPythonError', 'imageBase64Result',
  'configSaved', 'saveXhsImagesDone', 'saveXhsImagesError', 'savePreviewSettingDone',
  'llmConfig', 'llmConfigSaved', 'llmTestProfileResult', 'llmProfileKey', 'llmExportResult',
  'llmImportResult', 'llmTestAllProgress', 'llmFreeModels', 'llmTestResult', 'llmTestProgress', 'llmConfigError',
  'coverProgress', 'coverResult', 'coverPromptResult', 'coverImageResult', 'coverHistory',
  'coverSaveBgDone', 'coverTitleStateSaved',
  ...PUBLISH_EVENTS,
];
const SEND_CHANNELS = [
  'editorContentChanged', 'ready', 'getConfig', 'saveConfig', 'setTheme',
  'getWechatHtml', 'getZhihuHtml', 'getXhsCopyHtml', 'exportHtml', 'fetchImageBase64',
  'generateXhsViaPython', 'saveXhsImages', 'todoToggle', 'newFile', 'openExternal', 'saveFile',
  'savePreviewSetting', 'requestCursorLine', 'scrollToEditorLine',
  'llmGetConfig', 'llmSaveConfig', 'llmTestConnection', 'llmFetchFreeModels', 'llmTestAll',
  'llmExportConfig', 'llmImportConfig', 'llmGetProfileKey',
  'coverGeneratePrompt', 'coverGenerateImage', 'coverGenerate', 'coverGetHistory', 'coverSaveBg',
  'coverSetBg', 'coverSetDefaultBg', 'coverDeleteBg', 'coverSaveTitleState',
  ...PUBLISH_COMMANDS,
];
const SEND_CHANNEL_SET = new Set(SEND_CHANNELS);

for (const channel of FORWARD_CHANNELS) {
  ipcRenderer.on(channel, (_event, payload) => {
    window.postMessage({ type: channel, ...(payload || {}) }, '*');
  });
}

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => {
  const stateKey = 'm2a:vscode:state';
  return {
    postMessage: message => {
      if (message && typeof message.type === 'string' && SEND_CHANNEL_SET.has(message.type)) ipcRenderer.send(message.type, message);
    },
    getState: () => { try { return JSON.parse(localStorage.getItem(stateKey) || 'null'); } catch (_) { return null; } },
    setState: state => { try { localStorage.setItem(stateKey, JSON.stringify(state || {})); } catch (_) {} },
  };
});

contextBridge.exposeInMainWorld('__m2a_bridge', {
  invoke: (channel, ...args) => {
    const allowed = ['dialog:openFile', 'dialog:saveFileAs', 'getAppPath'];
    if (allowed.includes(channel)) return ipcRenderer.invoke(channel, ...args);
    return Promise.reject(new Error(`Unknown channel: ${channel}`));
  },
});
