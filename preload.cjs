// The bridge the 0n3 pages see inside the desktop app. Nothing else from Node reaches the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('on3desktop', {
  status: () => ipcRenderer.invoke('desk:status'),
  login: (token) => ipcRenderer.invoke('desk:login', String(token || '')),
  open: (url) => ipcRenderer.invoke('desk:open', String(url || '')),
  hide: () => ipcRenderer.invoke('panel:hide'),
  // first-run setup: which AI programs are on this computer, and put 0n3 into one of them
  detect: () => ipcRenderer.invoke('desk:detect'),
  connect: (key, o) => ipcRenderer.invoke('desk:connect', String(key || ''), { token: String(o?.token || ''), mcp: String(o?.mcp || '') }),
  version: process.env.npm_package_version || '',
});
contextBridge.exposeInMainWorld('on3bubble', { toggle: () => ipcRenderer.invoke('bubble:toggle') });
