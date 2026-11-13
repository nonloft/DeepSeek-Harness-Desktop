'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  onStatus: (callback) => {
    ipcRenderer.on('shell:status', (_event, payload) => callback(payload));
  },
  onLog: (callback) => {
    ipcRenderer.on('shell:log', (_event, text) => callback(text));
  },
  retry: () => ipcRenderer.send('shell:retry'),
  version: () => ipcRenderer.invoke('shell:version'),
  readLog: () => ipcRenderer.invoke('shell:log'),
  copyLog: () => ipcRenderer.invoke('shell:copy-log'),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
});
