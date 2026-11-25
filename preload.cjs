// The bridge the 0n3 pages see inside the desktop app. Nothing else from Node reaches the page.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  // the AI keys this person connected on 0n3, from their own signed-in page, so the app can sign their AI programs in
  aiKeys: (keys) => ipcRenderer.invoke('ai:keys', keys && typeof keys === 'object' ? keys : {}),
});
contextBridge.exposeInMainWorld('on3bubble', { toggle: () => ipcRenderer.invoke('bubble:toggle') });
// THE LOOK (app.html + bubble.html): the color theme and the corner icon. Main keeps the choice and tells both windows.
contextBridge.exposeInMainWorld('on3look', {
  get: () => ipcRenderer.invoke('look:get'),
  set: (o) => ipcRenderer.invoke('look:set', { theme: String(o?.theme || ''), icon: String(o?.icon || '') }),
  on: (cb) => { const h = (_e, o) => cb(o); ipcRenderer.on('look', h); return () => ipcRenderer.removeListener('look', h); },
});

// THE START SCREEN (splash.html): main reports each real start-up step.
contextBridge.exposeInMainWorld('on3splash', { on: (cb) => { ipcRenderer.on('splash', (_e, o) => cb(o)); } });
// UPDATE NOW (app.html): is there a newer version, install it, and its progress.
contextBridge.exposeInMainWorld('on3app', {
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => { const h = (_e, o) => cb(o); ipcRenderer.on('app:update', h); return () => ipcRenderer.removeListener('app:update', h); },
});

// THE TERMINAL (app.html only; main checks the sender page on every call)
contextBridge.exposeInMainWorld('on3term', {
  info: () => ipcRenderer.invoke('term:info'),
  send: (text) => ipcRenderer.invoke('term:send', String(text || '')),
  stop: () => ipcRenderer.invoke('term:stop'),
  setEngine: (name) => ipcRenderer.invoke('term:engine', String(name || '')),
  setup: (name) => ipcRenderer.invoke('term:setup', String(name || '')), // install it if missing, sign it in, talk to it
  signin: (name) => ipcRenderer.invoke('term:signin', String(name || '')), // its own browser sign-in, instead of the key connected on 0n3
  reset: () => ipcRenderer.invoke('term:reset'),
  pickFolder: () => ipcRenderer.invoke('term:pick'),
  // drag and drop: the real path of each dropped File, then what main says it is ({ path, name, kind: folder|image|file, size })
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } },
  attach: (paths) => ipcRenderer.invoke('term:attach', (Array.isArray(paths) ? paths : []).map(String)),
  openJobs: () => ipcRenderer.invoke('term:jobs'),
  hide: () => ipcRenderer.invoke('panel:hide'),
  onEvent: (cb) => { const h = (_e, o) => cb(o); ipcRenderer.on('term:event', h); return () => ipcRenderer.removeListener('term:event', h); },
});
