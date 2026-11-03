'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const sessionId = new URLSearchParams(window.location.search).get('sessionId') || '';
contextBridge.exposeInMainWorld('m2aCredentialEntry', {
  submit: value => {
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(sessionId)) ipcRenderer.send('publishingCredentialSubmit', { sessionId, value });
  },
  cancel: () => {
    if (/^[A-Za-z0-9_-]{16,256}$/.test(sessionId)) ipcRenderer.send('publishingCredentialSubmit', { sessionId, value: null });
  },
});
