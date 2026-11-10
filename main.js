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
import { spawn, execFileSync, execFile } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync, chmodSync, appendFileSync, unlinkSync, readFileSync, copyFileSync } from 'node:fs';
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

// ── first-run setup: find the AIs on this computer, put 0n3 inside each ─────────
const PATH_EXTRA = [join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const pathEnv = () => ({ ...process.env, PATH: [...(process.env.PATH || '').split(WIN ? ';' : ':'), ...(WIN ? [] : PATH_EXTRA)].filter(Boolean).join(WIN ? ';' : ':') });
function which(bin) {
  try { return execFileSync(WIN ? 'where' : 'sh', WIN ? [bin] : ['-c', `command -v ${bin}`], { encoding: 'utf8', env: pathEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0] || null; } catch { return null; }
}
const setupMod = async () => import(pathToFileURL(join(PKG, 'desk-setup.js')).href);
async function detect() {
  const { detectClients } = await setupMod();
  const clients = detectClients({ platform: process.platform, home: HOME, env: process.env, exists: existsSync, which });
  log(`detect: ${clients.filter((c) => c.found).map((c) => c.key).join(', ') || 'nothing found'}`);
  return { platform: process.platform, clients };
}
/** Put 0n3 into one AI. Settings files are backed up beside the original before they change. */
async function connect(key, { token, mcp }) {
  if (!/^0n_/.test(String(token || ''))) throw new Error('No 0n3 key for this program.');
  const { planFor } = await setupMod();
  const plan = planFor(key, { platform: process.platform, home: HOME, env: process.env, token, mcp: mcp || `${ON3}/mcp` });
  if (plan.kind === 'file') {
    const existing = existsSync(plan.file) ? readFileSync(plan.file, 'utf8') : '';
    const next = plan.apply(existing);
    mkdirSync(dirname(plan.file), { recursive: true });
    if (existing) { const bak = `${plan.file}.0n3-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`; copyFileSync(plan.file, bak); }
    writeFileSync(plan.file, next);
    log(`connect ${key}: wrote ${plan.file}`);
    return { ok: true, did: 'file', file: plan.file };
  }
  if (plan.kind === 'command') {
    const bin = which(plan.bin); if (!bin) throw new Error(`${plan.bin} is not on this computer's PATH.`);
    // ASYNC on purpose (2026-11-10): execFileSync here blocked Electron's main process for up to 60 s per AI, which froze the
    // bubble, the panel and the loopback door at once — the "app freezes on Setup / Get" Mike saw.
    const run = (args) => new Promise((resolve) => execFile(bin, args, { encoding: 'utf8', env: pathEnv(), timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => resolve(err ? { ok: false, out: `${stdout || ''}${stderr || ''}${err.message || ''}` } : { ok: true, out: stdout })));
    let r = await run(plan.args);
    if (!r.ok && /already exists/i.test(r.out)) { await run(['mcp', 'remove', '--scope', 'user', '0n3']); r = await run(plan.args); }
    if (!r.ok) throw new Error(r.out.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'the command failed');
    let skill = null;
    if (plan.alsoSkill) { try { const t = await (await fetch(`${ON3}/api/install/skill`)).text(); mkdirSync(dirname(plan.alsoSkill), { recursive: true }); writeFileSync(plan.alsoSkill, t); skill = plan.alsoSkill; } catch (e) { log(`skill download failed: ${e.message}`); } }
    log(`connect ${key}: ran ${plan.bin} ${plan.args.slice(0, 3).join(' ')}…${skill ? ` + skill ${skill}` : ''}`);
    return { ok: true, did: 'command', skill };
  }
  if (plan.kind === 'manual') return { ok: true, did: 'manual', steps: plan.steps };
  return { ok: true, did: 'nothing', note: plan.note };
}

// ── the loopback door (2026-11-09): 0n3.app in a browser runs the same Setup through this app ─────────────────────────
// 127.0.0.1:7473 only. Answers only to 0n3.app (CORS + Origin check) and only for the account signed in on BOTH sides:
// every call carries the page's 0n token (x-0n3-token); its email must match the desk token's email (Rule 0-SSO: email is
// the join key). Before the app is signed in, /login accepts a desk token from the page, exactly like the panel does.
const LOOP_PORT = 7473;
const LOOP_ORIGINS = new Set([ON3, ON3.replace('://', '://www.'), 'http://localhost:5173', 'http://127.0.0.1:5173']);
const whoCache = new Map();
async function emailOf(token) {
  const hit = whoCache.get(token); if (hit && Date.now() - hit.at < 600_000) return hit.email;
  const r = await fetch(`${ON3}/api/x/whoami`, { headers: { Authorization: `Bearer ${token}` } }); const j = await r.json().catch(() => ({}));
  const email = String(j.account?.email || j.email || '').trim().toLowerCase() || null;
  whoCache.set(token, { email, at: Date.now() }); return email;
}
async function sameAccount(pageToken) {
  const { loadConfig } = await deskAgent(); const cfg = loadConfig();
  if (!cfg?.token) return { signedIn: false, same: false };
  const [a, b] = await Promise.all([emailOf(pageToken), emailOf(cfg.token)]);
  return { signedIn: true, same: !!a && a === b };
}
function startLoopback() {
  const send = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || '');
    if (LOOP_ORIGINS.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-0n3-token'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (!LOOP_ORIGINS.has(origin)) return send(res, 403, { error: 'Only 0n3.app may talk to this app.' });
    const token = String(req.headers['x-0n3-token'] || ''); if (!/^0n_/.test(token)) return send(res, 401, { error: 'Sign in to 0n3 first.' });
    let body = ''; for await (const c of req) { body += c; if (body.length > 65536) return send(res, 413, { error: 'Too big.' }); }
    const b = body ? (() => { try { return JSON.parse(body); } catch { return {}; } })() : {};
    try {
      const url = new URL(req.url, 'http://127.0.0.1'); const acct = await sameAccount(token);
      if (url.pathname === '/status' && req.method === 'GET') return send(res, 200, { app: true, ...(await status()), sameAccount: acct.same });
      if (url.pathname === '/login' && req.method === 'POST') { if (acct.signedIn && !acct.same) return send(res, 403, { error: 'This computer is signed in as someone else.' }); return send(res, 200, await login(String(b.token || token))); }
      if (acct.signedIn && !acct.same) return send(res, 403, { error: 'This computer is signed in to 0n3 as a different person.' });
      if (!acct.signedIn) return send(res, 409, { error: 'This computer is not signed in yet.', loggedIn: false });
      if (url.pathname === '/detect' && req.method === 'GET') return send(res, 200, await detect());
      if (url.pathname === '/connect' && req.method === 'POST') { try { return send(res, 200, await connect(String(b.key || ''), { token: b.token, mcp: b.mcp })); } catch (e) { return send(res, 200, { ok: false, error: e.message }); } }
      return send(res, 404, { error: 'No such door.' });
    } catch (e) { log(`loopback ${req.url}: ${e.message}`); return send(res, 500, { error: e.message }); }
  });
  server.on('error', (e) => log(`loopback not listening: ${e.message}`));
  server.listen(LOOP_PORT, '127.0.0.1', () => log(`loopback door on 127.0.0.1:${LOOP_PORT}`));
  return server;
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
// on3://setup — a link on 0n3.app opens this app and runs the Setup here (works in every browser, Safari included).
// The scheme is `on3`, not `0n3`: a URL scheme must start with a letter (RFC 3986), and macOS treats `0n3://…` as a file path.
const SCHEME = 'on3';
function deepLink(url) {
  const u = String(url || ''); if (!u.startsWith(`${SCHEME}://`)) return;
  log(`deep link ${u}`);
  if (!panel) makePanel();
  if (u.startsWith(`${SCHEME}://setup`)) panel.loadURL(`${ON3}/chat?setup=1`);
  togglePanel(true);
}
if (process.defaultApp) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [join(HERE, 'main.js')]); else app.setAsDefaultProtocolClient(SCHEME);
app.on('open-url', (e, url) => { e.preventDefault(); if (app.isReady()) deepLink(url); else app.whenReady().then(() => deepLink(url)); });
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (e, argv) => { const link = (argv || []).find((a) => String(a).startsWith(`${SCHEME}://`)); if (link) deepLink(link); else togglePanel(true); });
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopAgent(); });

ipcMain.handle('desk:status', (e) => (fromOurPage(e) ? status() : null));
ipcMain.handle('desk:login', (e, token) => (fromOurPage(e) ? login(token) : null));
ipcMain.handle('desk:open', (e, url) => { if (fromOurPage(e) && /^https?:\/\//.test(String(url))) shell.openExternal(String(url)); });
ipcMain.handle('desk:detect', (e) => (fromOurPage(e) ? detect() : null));
ipcMain.handle('desk:connect', async (e, key, o) => { if (!fromOurPage(e)) return null; try { return await connect(String(key || ''), o || {}); } catch (err) { log(`connect ${key} failed: ${err.message}`); return { ok: false, error: err.message }; } });
ipcMain.handle('bubble:toggle', (e) => { if (fromOurPage(e)) togglePanel(); });
ipcMain.handle('panel:hide', (e) => { if (fromOurPage(e)) togglePanel(false); });

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  tray = new Tray(nativeImage.createFromPath(join(HERE, 'assets', 'tray.png')));
  tray.on('click', () => togglePanel());
  refreshTray();
  makeBubble();
  startLoopback();
  globalShortcut.register('CommandOrControl+Shift+Space', () => togglePanel());
  await startAgent();
  // first run: open the chat so the person signs in and this computer becomes their desk
  if (agentState === 'not signed in') setTimeout(() => togglePanel(true), 800);
  // ON3_SMOKE=<dir>: prove the shell from a script — capture the bubble and the panel, dump window state, quit.
  if (process.env.ON3_SMOKE) setTimeout(async () => {
    const dir = process.env.ON3_SMOKE; mkdirSync(dir, { recursive: true });
    try {
      togglePanel(true); await new Promise((r) => setTimeout(r, 6000));
      writeFileSync(join(dir, 'bubble.png'), (await bubble.webContents.capturePage()).toPNG());
      writeFileSync(join(dir, 'panel.png'), (await panel.webContents.capturePage()).toPNG());
      const windows = BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), url: w.webContents.getURL(), bounds: w.getBounds(), visible: w.isVisible(), alwaysOnTop: w.isAlwaysOnTop() }));
      // the setup path, end to end on this machine: what is found, and one settings-file write (Cursor's file, under this HOME)
      const found = await detect();
      const wrote = await connect('cursor', { token: '0n_smoketest', mcp: `${ON3}/mcp` }).catch((e) => ({ ok: false, error: e.message }));
      // the loopback door from a "browser": the right origin without a token is 401, a wrong origin is 403, no origin is 403
      const probe = async (headers) => { const r = await fetch(`http://127.0.0.1:${LOOP_PORT}/status`, { headers }); return r.status; };
      const loop = { noToken: await probe({ Origin: ON3 }), wrongOrigin: await probe({ Origin: 'https://evil.example', 'x-0n3-token': '0n_x' }), preflight: (await fetch(`http://127.0.0.1:${LOOP_PORT}/detect`, { method: 'OPTIONS', headers: { Origin: ON3 } })).status };
      writeFileSync(join(dir, 'status.json'), JSON.stringify({ windows, agentState, shim: SHIM, pkg: PKG, runner: RUNNER, status: await status(), detect: found.clients.filter((c) => c.found).map((c) => `${c.key} via ${c.via}${c.connectable ? ' → connectable' : ''}`), connectCursor: wrote, loopback: loop, cursorFile: wrote.file && existsSync(wrote.file) ? readFileSync(wrote.file, 'utf8') : null }, null, 2));
    } catch (e) { writeFileSync(join(dir, 'error.txt'), String(e.stack || e)); }
    app.quit();
  }, 1500);
});
