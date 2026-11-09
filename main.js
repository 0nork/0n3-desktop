/**
 * 0n3 DESKTOP (2026-11-09). Mike: "a desktop app that they download that adds a simple 'chat' floating icon on their desktop
 * that shows up on top of everything … a chat window that accesses 0n3, which essentially will use their desktop powered
 * AI — it will push the requests to 0n3 and 0n3 then carries all of the capability to run the requests."
 *
 * One download, three things:
 *   the BUBBLE   a small always-on-top button; click it (or ⌘⇧Space / Ctrl+Shift+Space) and the chat opens beside it
 *   the PANEL    https://0n3.app/chat — the person's 0n3 account, signed in once; a message is a desk run
 *   the DESK     the 0n3 desk agent (package 0nmcp, desk-agent.js) running as a child of this app: it claims runs for THIS
 *                computer and works them with the AI installed here (Claude Code, Codex, Gemini CLI, Ollama)
 * The panel page hands this app a desk token ONCE (window.on3desktop.login) — it is written to ~/.0n/desk.json by the same
 * code `0n3 desk login` uses, and never shown again. Claude Code's turns call `0n3 desk ask/note/done`; there is no global
 * 0n3 command here, so the app writes a shim at ~/.0n/bin/0n3 that runs the bundled cli.js with this app's own Node.
 */
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, screen, nativeImage } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync, appendFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
// electron-builder leaves node_modules and the runner outside app.asar (asarUnpack) so a child Node process can read them.
const UNPACKED = HERE.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
const PKG = join(UNPACKED, 'node_modules', '0nmcp');
const RUNNER = join(UNPACKED, 'agent-runner.mjs');
const PRELOAD = join(HERE, 'preload.cjs');
const ON3 = (process.env.ON3_URL || 'https://0n3.app').replace(/\/$/, '');
const HOME = os.homedir();
const LOG = join(HOME, '.0n', 'desk', 'app.log');
const WIN = process.platform === 'win32';
const SHIM = WIN ? join(HOME, '.0n', 'bin', '0n3.cmd') : join(HOME, '.0n', 'bin', '0n3');
const BUBBLE = 64; const PANEL = { w: 400, h: 620 };

const log = (s) => { try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`); } catch { /* */ } };
let deskMod = null;
const deskAgent = async () => deskMod || (deskMod = await import(pathToFileURL(join(PKG, 'desk-agent.js')).href));

/** The `0n3` command Claude Code's turns call, pointing at this app's Node and the bundled CLI. */
function writeShim() {
  mkdirSync(dirname(SHIM), { recursive: true });
  const cli = join(PKG, 'cli.js');
  if (WIN) writeFileSync(SHIM, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cli}" %*\r\n`);
  else { writeFileSync(SHIM, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cli}" "$@"\n`); chmodSync(SHIM, 0o755); }
  return SHIM;
}

// ── the desk agent, as a child of this app ───────────────────────────────────
let agent = null; let agentState = 'stopped'; let restartT = 0; let backoff = 5_000;
async function startAgent() {
  const { loadConfig } = await deskAgent();
  if (!loadConfig()?.token) { agentState = 'not signed in'; refreshTray(); return; }
  if (agent) return;
  const shim = writeShim();
  agent = spawn(process.execPath, [RUNNER], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ON3_DESK_PKG: PKG, ON3_DESK_BIN: shim, ON3_URL: ON3 }, stdio: ['ignore', 'pipe', 'pipe'] });
  agentState = 'running'; refreshTray(); log(`agent start pid ${agent.pid}`);
  agent.stdout.on('data', (d) => log(`agent: ${String(d).trim()}`)); agent.stderr.on('data', (d) => log(`agent! ${String(d).trim()}`));
  agent.on('exit', (code) => {
    log(`agent exit ${code}`); agent = null;
    if (code === 3) { agentState = 'not signed in'; refreshTray(); return; } // the runner found no config
    agentState = 'restarting'; refreshTray();
    clearTimeout(restartT); restartT = setTimeout(() => { backoff = Math.min(backoff * 2, 120_000); startAgent(); }, backoff);
  });
  backoff = 5_000;
}
function stopAgent() { clearTimeout(restartT); if (agent) { agent.kill(); agent = null; } agentState = 'stopped'; refreshTray(); }

async function status() {
  const { loadConfig, AGENTS } = await deskAgent(); const cfg = loadConfig();
  return { loggedIn: !!cfg?.token, machine: cfg?.machine || os.hostname().replace(/\.local$/, ''), agent: cfg?.agent || 'claude_code', agentName: AGENTS[cfg?.agent || 'claude_code']?.name || 'Claude Code', running: agentState, version: app.getVersion(), platform: process.platform, url: ON3 };
}
/** Exactly what `0n3 desk login --token` does: check the token with 0n3, remember it, say hello, start working. */
async function login(token) {
  if (!/^0n_/.test(String(token || ''))) throw new Error('That is not an 0n token.');
  const { loadConfig, saveConfig, client, AGENTS } = await deskAgent();
  const prev = loadConfig() || {};
  const cfg = { ...prev, url: ON3, token, machine: prev.machine || os.hostname().replace(/\.local$/, ''), agent: AGENTS[prev.agent] ? prev.agent : 'claude_code' };
  const me = await client(cfg).call('/api/x/whoami');
  if (me.error) throw new Error(me.error);
  saveConfig(cfg);
  await client(cfg).call('/api/desk/hello', { method: 'POST', body: JSON.stringify({ machine: cfg.machine, agent: cfg.agent, version: `desktop-${app.getVersion()}` }) }).catch(() => {});
  log(`signed in as ${me.account?.email || me.email || '?'} machine ${cfg.machine}`);
  await startAgent();
  return status();
}
async function signOut() {
  stopAgent();
  const { CONFIG } = await deskAgent();
  try { unlinkSync(CONFIG); } catch { /* */ }
  refreshTray();
}

// ── windows ──────────────────────────────────────────────────────────────────
let bubble = null; let panel = null; let tray = null;
const fromOurPage = (e) => { try { return new URL(e.senderFrame?.url || e.sender.getURL()).origin === new URL(ON3).origin || e.sender === bubble?.webContents; } catch { return false; } };

function makeBubble() {
  const { workArea } = screen.getPrimaryDisplay();
  bubble = new BrowserWindow({ width: BUBBLE, height: BUBBLE, x: workArea.x + workArea.width - BUBBLE - 24, y: workArea.y + workArea.height - BUBBLE - 24, frame: false, transparent: true, alwaysOnTop: true, resizable: false, movable: true, skipTaskbar: true, hasShadow: false, show: false, webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  bubble.setAlwaysOnTop(true, 'screen-saver'); bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubble.loadFile(join(HERE, 'bubble.html'));
  bubble.once('ready-to-show', () => bubble.show());
  bubble.on('moved', placePanel);
  bubble.on('closed', () => { bubble = null; });
}
function makePanel() {
  panel = new BrowserWindow({ width: PANEL.w, height: PANEL.h, minWidth: 340, minHeight: 420, frame: false, alwaysOnTop: true, resizable: true, skipTaskbar: true, show: false, backgroundColor: '#fafafa', webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  panel.setAlwaysOnTop(true, 'floating'); panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // the panel shows only 0n3 pages; a link elsewhere opens in the person's browser
  panel.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== new URL(ON3).origin) { e.preventDefault(); shell.openExternal(url); } });
  panel.loadURL(`${ON3}/chat`);
  panel.on('closed', () => { panel = null; });
}
function placePanel() {
  if (!panel || !bubble) return;
  const b = bubble.getBounds(); const d = screen.getDisplayMatching(b).workArea;
  const x = Math.max(d.x, Math.min(b.x + b.width - PANEL.w, d.x + d.width - PANEL.w));
  const y = b.y - PANEL.h - 12 >= d.y ? b.y - PANEL.h - 12 : Math.min(b.y + b.height + 12, d.y + d.height - PANEL.h);
  panel.setPosition(Math.round(x), Math.round(y));
}
function togglePanel(force) {
  if (!panel) makePanel();
  const show = force !== undefined ? force : !panel.isVisible();
  if (show) { placePanel(); panel.show(); panel.focus(); } else panel.hide();
}

function refreshTray() {
  if (!tray) return;
  const label = agentState === 'running' ? 'Your AI is running on this computer' : agentState === 'not signed in' ? 'Open the chat to sign this computer in' : agentState === 'restarting' ? 'Your AI stopped — restarting' : 'Your AI is stopped';
  tray.setToolTip(`0n3 — ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Show chat', accelerator: 'CommandOrControl+Shift+Space', click: () => togglePanel(true) },
    { label: 'Open 0n3.app', click: () => shell.openExternal(ON3) },
    { label: 'Open 0nCanvas', click: () => shell.openExternal(`${ON3}/canvas`) },
    { label: 'Alerts', click: () => shell.openExternal(`${ON3}/alerts`) },
    { type: 'separator' },
    { label: 'Start when I log in', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked, openAsHidden: true }) },
    { label: agentState === 'stopped' ? 'Start your AI' : 'Pause your AI', enabled: agentState !== 'not signed in', click: () => (agentState === 'stopped' ? startAgent() : stopAgent()) },
    { label: 'Sign this computer out', enabled: agentState !== 'not signed in', click: () => signOut() },
    { label: `Log file: ${LOG}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit 0n3', click: () => { app.quit(); } },
  ]));
}

// ── app ──────────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => togglePanel(true));
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopAgent(); });

ipcMain.handle('desk:status', (e) => (fromOurPage(e) ? status() : null));
ipcMain.handle('desk:login', (e, token) => (fromOurPage(e) ? login(token) : null));
ipcMain.handle('desk:open', (e, url) => { if (fromOurPage(e) && /^https?:\/\//.test(String(url))) shell.openExternal(String(url)); });
ipcMain.handle('bubble:toggle', (e) => { if (fromOurPage(e)) togglePanel(); });
ipcMain.handle('panel:hide', (e) => { if (fromOurPage(e)) togglePanel(false); });

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  tray = new Tray(nativeImage.createFromPath(join(HERE, 'assets', 'tray.png')));
  tray.on('click', () => togglePanel());
  refreshTray();
  makeBubble();
  globalShortcut.register('CommandOrControl+Shift+Space', () => togglePanel());
  await startAgent();
  // first run: open the chat so the person signs in and this computer becomes their desk
  if (agentState === 'not signed in') setTimeout(() => togglePanel(true), 800);
});
