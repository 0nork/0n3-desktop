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
  terminal: () => ipcRenderer.invoke('panel:terminal'), // back from the 0n3 chat to this app's terminal
});
contextBridge.exposeInMainWorld('on3bubble', { toggle: () => ipcRenderer.invoke('bubble:toggle') });

// THE TERMINAL (app.html only; main checks the sender page on every call)
contextBridge.exposeInMainWorld('on3term', {
  info: () => ipcRenderer.invoke('term:info'),
  send: (text) => ipcRenderer.invoke('term:send', String(text || '')),
  stop: () => ipcRenderer.invoke('term:stop'),
  reset: () => ipcRenderer.invoke('term:reset'),
  pickFolder: () => ipcRenderer.invoke('term:pick'),
  openJobs: () => ipcRenderer.invoke('term:jobs'),
  hide: () => ipcRenderer.invoke('panel:hide'),
  onEvent: (cb) => { const h = (_e, o) => cb(o); ipcRenderer.on('term:event', h); return () => ipcRenderer.removeListener('term:event', h); },
});
