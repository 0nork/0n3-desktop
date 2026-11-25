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
import { existsSync, mkdirSync, writeFileSync, chmodSync, appendFileSync, unlinkSync, readFileSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, basename, extname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { TermSession, WORKSPACE, setAiContext } from './term-session.mjs';
import * as ai from './ai-setup.mjs';
import * as updater from './updater.mjs';

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
const BUBBLE = 64; const PANEL = { w: 520, h: 720 };
const APP = join(HERE, 'app.html');
// The app's own installer for the AI programs (ai-setup.mjs): it fetches the official Node.js into ~/.0n/ai once and
// installs with that, so a computer with no Node, no npm and no terminal knowledge still gets Claude Code, Codex and Gemini CLI.
const AI = setAiContext(process.env.ON3_AI_CLEAN ? { extraDirs: [] } : {}); // ON3_AI_CLEAN: a proof run that sees only the PATH and the app's own installs

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
  if (process.env.ON3_NO_AGENT) { agentState = 'stopped'; return; } // proof runs on a machine whose desk is already working: never a second helper
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
  setTimeout(() => provision('sign-in'), 500);
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
    if (plan.alsoSkill) {
      // NEVER overwrite a SKILL.md the person wrote themselves (2026-11-10: this line replaced Mike's 1,000-line /0n3 skill with the
      // public one). Only write when the file is missing or is an earlier copy of the public skill (carries its marker line).
      try {
        const have = existsSync(plan.alsoSkill) ? readFileSync(plan.alsoSkill, 'utf8') : '';
        if (have && !/your connected apps, as tools|your 0n account as tools/.test(have)) log(`skill: kept the existing ${plan.alsoSkill} (not ours)`);
        else { const t = await (await fetch(`${ON3}/api/install/skill`)).text(); if (/^---\nname: 0n3/.test(t)) { mkdirSync(dirname(plan.alsoSkill), { recursive: true }); writeFileSync(plan.alsoSkill, t); skill = plan.alsoSkill; } }
      } catch (e) { log(`skill download failed: ${e.message}`); }
    }
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
      if (url.pathname === '/ai-keys' && req.method === 'POST') { takeKeys(b.keys, '0n3.app'); provT = 0; setTimeout(() => provision('keys'), 300); return send(res, 200, { ok: true }); }
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
// THE TERMINAL (2026-11-24): the panel opens on app.html — this app's own terminal, one live Claude session (term-session.mjs).
// The 0n3.app chat (jobs, the phone, alerts) is one tab away; the panel loads it and comes back with on3desktop.terminal().
const sendTerm = (o) => { if (panel && !panel.isDestroyed() && isAppUrl(panel.webContents.getURL())) panel.webContents.send('term:event', o); };
const term = new TermSession(sendTerm);
const isAppUrl = (u) => { try { return new URL(u).protocol === 'file:' && decodeURIComponent(new URL(u).pathname).endsWith('/app.html'); } catch { return false; } };
const fromApp = (e) => e.sender === panel?.webContents && isAppUrl(e.senderFrame?.url || e.sender.getURL());
const fromOurPage = (e) => { try { return new URL(e.senderFrame?.url || e.sender.getURL()).origin === new URL(ON3).origin || e.sender === bubble?.webContents || fromApp(e); } catch { return false; } };

// ── YOUR AIs, SET UP FOR YOU (0.8.0, Mike 2026-11-25) ─────────────────────────────────────────────────────────────────
// "It also needs to install those CLI connections automatically with a login whenever Gemini, GPT or Claude is connected."
// At start, after sign-in and each time the window is opened (at most every 5 minutes): ask 0n3 which of the three the
// person connected, install the matching program if it is not on this computer, and sign it in with the connected key.
// A browser sign-in is never opened by the app on its own: that waits for the person to click the AI's name.
const on3Get = async (path) => { const { loadConfig } = await deskAgent(); const cfg = loadConfig(); if (!cfg?.token) return { status: 0, body: null }; const r = await fetch(`${ON3}${path}`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(20_000) }); return { status: r.status, body: await r.json().catch(() => null) }; };
let provT = 0; let provBusy = false; let provAgain = false; let keysAsked = 0;
function takeKeys(keys, from) { const next = ai.saveKeys(AI, keys || {}); log(`ai keys from ${from}: ${Object.entries(next).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`); return next; }
/** The keys can only be read by the person's own sign-in. A helper key made before 0.8.0 cannot: the signed-in 0n3 page hands them over instead. */
function askPageForKeys() {
  if (Date.now() - keysAsked < 10 * 60_000) return; keysAsked = Date.now();
  const w = new BrowserWindow({ show: false, width: 420, height: 600, webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.loadURL(`${ON3}/chat?keys=1`).catch(() => {});
  setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 40_000);
}
async function provision(why = 'start') {
  if (provBusy) { if (why !== 'open') provAgain = true; return; }
  if (why === 'open' && Date.now() - provT < 5 * 60_000) return;
  provBusy = true; provT = Date.now();
  try {
    const k = await on3Get('/api/vault/ai-keys').catch(() => ({ status: 0 }));
    if (k.status === 0 && !k.body) { const { loadConfig } = await deskAgent(); if (!loadConfig()?.token) return; }
    if (k.status === 200 && k.body?.keys) takeKeys(k.body.keys, 'the helper key'); else if (k.status === 403) askPageForKeys();
    const r = await on3Get('/api/ai/router').catch(() => ({ status: 0 }));
    const connected = (r.body?.providers || []).filter((p) => p.connected && p.enabled !== false).map((p) => p.service || p.key);
    const wanted = [...new Set(connected.map((p) => ai.PROVIDER_TO_AI[p]).filter(Boolean))];
    log(`provision (${why}): connected on 0n3 = ${wanted.join(', ') || 'none of the three'} · here = ${Object.entries(ai.installed(AI)).filter(([, v]) => v).map(([n]) => n).join(', ') || 'none'}`);
    for (const key of wanted) { const res = await term.setup(key, { quiet: true }).catch((e) => ({ ok: false, error: e.message })); if (!res.ok && !res.needsBrowser) log(`provision ${key}: ${res.error}`); }
    await ai.writeLaunchMap(AI).catch((e) => log(`launch map: ${e.message}`));
    // Who you are talking to changes by itself ONLY when the current one cannot answer here (the Bot, or an AI that is gone).
    const here = ai.installed(AI);
    if (!term.picked && term.idle && (term.engine === 'bot' || !here[term.engine])) { const { loadConfig } = await deskAgent(); term.setEngine(ai.pickEngine({ deskAgent: loadConfig()?.agent, have: here, connected }), false); }
    sendTerm({ t: 'info', info: term.info() });
  } catch (e) { log(`provision: ${e.message}`); } finally { provBusy = false; if (provAgain) { provAgain = false; setTimeout(() => provision('again'), 500); } }
}

// ── THE START SCREEN (0.7.0) ──────────────────────────────────────────────────────────────────────────────────────────
// Mike: "I want this application to go through an installation process when called … something that at least shows the logo
// and progress bar saying 'installing' when it's run." A small window with the logo and a bar that follows the REAL start-up
// steps. The first time a version runs on this computer it says "Installing 0n3 x.y.z" (that is what is happening: the
// `0n3` command is written and your AI programs are found); after that it says "Starting 0n3".
let splash = null;
const VERSION_FILE = join(HOME, '.0n', 'desk', 'app-version');
const lastRunVersion = () => { try { return readFileSync(VERSION_FILE, 'utf8').trim(); } catch { return ''; } };
function makeSplash() {
  const { workArea } = screen.getPrimaryDisplay(); const w = 420; const h = 300;
  splash = new BrowserWindow({ width: w, height: h, x: Math.round(workArea.x + (workArea.width - w) / 2), y: Math.round(workArea.y + (workArea.height - h) / 2), frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false, webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  splash.on('closed', () => { splash = null; });
  const ready = new Promise((ok) => splash.webContents.once('did-finish-load', ok));
  splash.loadFile(join(HERE, 'splash.html'));
  splash.once('ready-to-show', () => splash && splash.show());
  return ready;
}
const splashSay = (o) => { try { if (splash && !splash.isDestroyed()) splash.webContents.send('splash', o); } catch { /* closing */ } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ── UPDATE NOW (0.7.0, updater.mjs) ───────────────────────────────────────────────────────────────────────────────────
let upd = { available: false, current: app.getVersion() }; let updBusy = false;
const updView = () => ({ ...upd, current: app.getVersion(), busy: updBusy });
const updSay = (o) => { try { if (panel && !panel.isDestroyed() && isAppUrl(panel.webContents.getURL())) panel.webContents.send('app:update', o); } catch { /* closing */ } };
async function checkForUpdate() {
  if (updBusy) return updView();
  try { upd = await updater.check({ current: app.getVersion() }); } catch (e) { upd = { available: false, current: app.getVersion(), error: e.message }; }
  if (upd.error) log(`update check: ${upd.error}`); else if (upd.available) log(`update available: ${upd.version}`);
  refreshTray(); updSay({ t: 'state', ...updView() });
  return updView();
}
async function installUpdate() {
  if (updBusy) return { ok: false, error: 'An update is already being installed.' };
  if (!upd.available) await checkForUpdate();
  if (!upd.available) return { ok: false, error: upd.error || 'You already have the newest version.' };
  const target = updater.installTarget();
  if (!target.ok || !upd.asset) { shell.openExternal(upd.page || updater.RELEASES_PAGE); return { ok: false, manual: true, error: target.ok ? 'There is no download for this kind of computer in that release. The download page is open in your browser.' : `${target.why} The download page is open in your browser.` }; }
  updBusy = true; const tmp = join(app.getPath('temp'), `0n3-update-${upd.version}`);
  try {
    updSay({ t: 'progress', pct: 0, text: `Downloading 0n3 ${upd.version}…` });
    const file = await updater.download(upd.asset, tmp, ({ pct, got, total }) => updSay({ t: 'progress', pct: Math.round(pct * 0.9), text: `Downloading 0n3 ${upd.version}… ${pct}%${total ? ` of ${Math.round(total / 1048576)} MB` : ''}`, got }));
    updSay({ t: 'progress', pct: 93, text: 'Installing…' });
    const r = await updater.install({ file, version: upd.version, target, tmp });
    log(`update ${upd.version}: ${r.restart} started; quitting`);
    updSay({ t: 'progress', pct: 100, text: 'Installed. 0n3 is restarting…', done: true });
    setTimeout(() => app.quit(), 900);
    return { ok: true };
  } catch (e) { updBusy = false; log(`update failed: ${e.message}`); updSay({ t: 'error', text: e.message }); return { ok: false, error: e.message }; }
}

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
  panel = new BrowserWindow({ width: PANEL.w, height: PANEL.h, minWidth: 340, minHeight: 420, frame: false, alwaysOnTop: true, resizable: true, skipTaskbar: true, show: false, backgroundColor: '#0c0e0c', webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  panel.setAlwaysOnTop(true, 'floating'); panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // the panel shows only 0n3 pages; a link elsewhere opens in the person's browser
  panel.webContents.on('will-navigate', (e, url) => { if (isAppUrl(url)) return; if (new URL(url).origin !== new URL(ON3).origin) { e.preventDefault(); shell.openExternal(url); } });
  panel.loadFile(APP);
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
  if (show) { placePanel(); panel.show(); panel.focus(); provision('open'); } else panel.hide();
}

function refreshTray() {
  if (!tray) return;
  const label = agentState === 'running' ? 'Your AI is running on this computer' : agentState === 'not signed in' ? 'Open the chat to sign this computer in' : agentState === 'restarting' ? 'Your AI stopped — restarting' : 'Your AI is stopped';
  tray.setToolTip(`0n3 — ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    ...(upd.available ? [{ label: `Update to ${upd.version} now`, click: () => { if (!panel) makePanel(); else if (!isAppUrl(panel.webContents.getURL())) panel.loadFile(APP); togglePanel(true); setTimeout(() => installUpdate(), 600); } }, { type: 'separator' }] : []),
    { label: 'Open the terminal', accelerator: 'CommandOrControl+Shift+Space', click: () => { if (!panel) makePanel(); else if (!isAppUrl(panel.webContents.getURL())) panel.loadFile(APP); togglePanel(true); } },
    { label: 'Jobs & phone (0n3 chat)', click: () => { if (!panel) makePanel(); panel.loadURL(`${ON3}/chat`); togglePanel(true); } },
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
// (the start-screen proof run registers nothing: it must not take the 0n3:// links away from the installed app)
if (!process.env.ON3_SPLASH_SHOT) { if (process.defaultApp) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [join(HERE, 'main.js')]); else app.setAsDefaultProtocolClient(SCHEME); }
app.on('open-url', (e, url) => { e.preventDefault(); if (app.isReady()) deepLink(url); else app.whenReady().then(() => deepLink(url)); });
if (!process.env.ON3_SPLASH_SHOT && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (e, argv) => { const link = (argv || []).find((a) => String(a).startsWith(`${SCHEME}://`)); if (link) deepLink(link); else togglePanel(true); });
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopAgent(); term.kill(); for (const x of Object.values(term.alt)) x.kill(); });

ipcMain.handle('desk:status', (e) => (fromOurPage(e) ? status() : null));
ipcMain.handle('desk:login', (e, token) => (fromOurPage(e) ? login(token) : null));
ipcMain.handle('desk:open', (e, url) => { if (fromOurPage(e) && /^https?:\/\//.test(String(url))) shell.openExternal(String(url)); });
ipcMain.handle('desk:detect', (e) => (fromOurPage(e) ? detect() : null));
ipcMain.handle('desk:connect', async (e, key, o) => { if (!fromOurPage(e)) return null; try { return await connect(String(key || ''), o || {}); } catch (err) { log(`connect ${key} failed: ${err.message}`); return { ok: false, error: err.message }; } });
ipcMain.handle('bubble:toggle', (e) => { if (fromOurPage(e)) togglePanel(); });
ipcMain.handle('panel:hide', (e) => { if (fromOurPage(e)) togglePanel(false); });
// the terminal's own calls: only from app.html in the panel
// THE LOOK (0.9.0): which color theme and which corner icon. looks.js owns the lists; here only the choice is kept
// (~/.0n/desk/look.json) and handed to the two windows. Only the app's own Settings may change it.
const LOOK_FILE = process.env.ON3_LOOK_FILE || join(HOME, '.0n', 'desk', 'look.json');
const lookId = (s, d) => (typeof s === 'string' && /^[a-z0-9-]{1,24}$/.test(s) ? s : d);
const cleanLook = (o) => ({ theme: lookId(o?.theme, 'green'), icon: lookId(o?.icon, 'grid') });
let look = (() => { try { return cleanLook(JSON.parse(readFileSync(LOOK_FILE, 'utf8'))); } catch { return cleanLook(null); } })();
ipcMain.handle('look:get', (e) => (fromApp(e) || e.sender === bubble?.webContents ? look : null));
ipcMain.handle('look:set', (e, o) => {
  if (!fromApp(e)) return null;
  look = cleanLook(o);
  try { mkdirSync(dirname(LOOK_FILE), { recursive: true }); writeFileSync(LOOK_FILE, JSON.stringify(look)); } catch (err) { log(`look not saved: ${err.message}`); return null; }
  try { if (bubble && !bubble.isDestroyed()) bubble.webContents.send('look', look); } catch { /* closing */ }
  return look;
});
ipcMain.handle('update:state', (e) => (fromApp(e) ? updView() : null));
ipcMain.handle('update:check', (e) => (fromApp(e) ? checkForUpdate() : null));
ipcMain.handle('update:install', (e) => (fromApp(e) ? installUpdate() : null));
ipcMain.handle('term:info', (e) => (fromApp(e) ? term.info() : null));
ipcMain.handle('term:send', (e, text) => (fromApp(e) ? term.send(String(text || '').slice(0, 20000)) : false));
ipcMain.handle('term:stop', (e) => (fromApp(e) ? term.stop() : false));
ipcMain.handle('term:engine', (e, name) => (fromApp(e) ? term.setEngine(String(name || '')) : null));
// Click an AI's name: it is installed if missing, signed in if it is not, and becomes the one you talk to.
ipcMain.handle('term:setup', async (e, name) => { if (!fromApp(e)) return null; const r = await term.setup(String(name || ''), { switchTo: true }).catch((err) => ({ ok: false, error: err.message })); return { ...r, info: term.info() }; }); // the Jobs helper is NOT restarted (that kills a job in flight): it reads launch.json on every turn
// "Sign in to … with my account": the key connected on 0n3 steps aside and the AI's own browser sign-in opens.
ipcMain.handle('term:signin', async (e, name) => { if (!fromApp(e)) return null; const r = await term.setup(String(name || ''), { switchTo: true, account: true }).catch((err) => ({ ok: false, error: err.message })); return { ...r, info: term.info() }; });
// The person's own signed-in 0n3 page hands over the AI keys they connected (never an app or AI key: see /api/vault/ai-keys).
ipcMain.handle('ai:keys', (e, keys) => { try { if (new URL(e.senderFrame?.url || e.sender.getURL()).origin !== new URL(ON3).origin) return false; } catch { return false; } takeKeys(keys, 'the 0n3 page'); provT = 0; setTimeout(() => provision('keys'), 300); return true; });
ipcMain.handle('term:reset', (e) => (fromApp(e) ? term.reset() : false));
ipcMain.handle('term:pick', async (e) => { if (!fromApp(e)) return null; const { dialog } = await import('electron'); const r = await dialog.showOpenDialog(panel, { properties: ['openDirectory', 'createDirectory'], defaultPath: term.cwd || WORKSPACE, title: 'The folder your terminal works in' }); return r.canceled || !r.filePaths[0] ? term.info() : term.setCwd(r.filePaths[0]); });
// Dropped onto the terminal: say what each path is (folder, image or file) so the page can show it and the AI is told the kind.
const IMG = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.svg', '.avif']);
function describeDrop(paths) {
  const out = []; const seen = new Set();
  for (const p of (Array.isArray(paths) ? paths : []).slice(0, 60)) {
    const path = String(p || ''); if (!path || !isAbsolute(path) || seen.has(path)) continue; seen.add(path);
    try { const st = statSync(path); out.push({ path, name: basename(path) || path, kind: st.isDirectory() ? 'folder' : IMG.has(extname(path).toLowerCase()) ? 'image' : 'file', size: st.isDirectory() ? null : st.size }); }
    catch (err) { log(`drop: cannot read ${path}: ${err.message}`); }
  }
  return out;
}
ipcMain.handle('term:attach', (e, paths) => (fromApp(e) ? describeDrop(paths) : []));
ipcMain.handle('term:jobs', (e) => { if (fromApp(e) && panel) panel.loadURL(`${ON3}/chat`); });
ipcMain.handle('panel:terminal', (e) => { if (fromOurPage(e) && panel) panel.loadFile(APP); });

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  const version = app.getVersion(); const fresh = lastRunVersion() !== version; const t0 = Date.now();
  const title = fresh ? `Installing 0n3 ${version}` : 'Starting 0n3';
  // ON3_SPLASH_SHOT=<dir>: prove the start screen and nothing else — no tray, no bubble, no agent. Captures each step, quits.
  if (process.env.ON3_SPLASH_SHOT) {
    const dir = process.env.ON3_SPLASH_SHOT; mkdirSync(dir, { recursive: true });
    try {
      await makeSplash(); await pause(700);
      const shots = [[12, 'Getting things ready…'], [45, 'Looking for the AI programs on this computer…'], [72, 'Starting your desk…'], [100, 'Ready']];
      for (const [i, [pct, text]] of shots.entries()) { splashSay({ title: process.env.ON3_SPLASH_TITLE || title, version: `v${version}`, pct, text, done: pct === 100 }); await pause(650); writeFileSync(join(dir, `splash-${i + 1}.png`), (await splash.webContents.capturePage()).toPNG()); }
    } catch (e) { writeFileSync(join(dir, 'error.txt'), String(e.stack || e)); }
    app.exit(0); return;
  }
  await makeSplash();
  const step = (pct, text) => splashSay({ title, version: `v${version}`, pct, text });
  step(10, fresh ? 'Setting up the 0n3 command…' : 'Getting things ready…');
  tray = new Tray(nativeImage.createFromPath(join(HERE, 'assets', 'tray.png')));
  tray.on('click', () => togglePanel());
  refreshTray();
  try { writeShim(); } catch (e) { log(`shim: ${e.message}`); }
  startLoopback();
  globalShortcut.register('CommandOrControl+Shift+Space', () => togglePanel());
  step(35, 'Looking for the AI programs on this computer…');
  try { await Promise.race([detect(), pause(6000)]); } catch (e) { log(`detect: ${e.message}`); }
  step(60, 'Starting your desk…');
  try { await ai.writeLaunchMap(AI); } catch (e) { log(`launch map: ${e.message}`); } // the Jobs helper starts the same AIs the terminal does
  await startAgent();
  setTimeout(() => provision('start'), 4000);
  step(82, 'Checking for a newer version…');
  await Promise.race([checkForUpdate(), pause(5000)]);
  setInterval(() => checkForUpdate().catch(() => {}), 6 * 60 * 60 * 1000); // and again every six hours while the app stays open
  await pause(Math.max(0, 1800 - (Date.now() - t0))); // long enough to be read, never longer than the work plus this
  splashSay({ title, version: `v${version}`, pct: 100, text: upd.available ? `Ready. Version ${upd.version} is available.` : 'Ready', done: true });
  await pause(650);
  try { mkdirSync(dirname(VERSION_FILE), { recursive: true }); writeFileSync(VERSION_FILE, version); } catch (e) { log(`version file: ${e.message}`); }
  if (splash && !splash.isDestroyed()) splash.close();
  makeBubble();
  // first run: open the chat so the person signs in and this computer becomes their desk
  if (agentState === 'not signed in') setTimeout(() => togglePanel(true), 800);
  // ON3_LOOK_SHOT=<dir>: prove the look — the terminal with a sample conversation, Settings, then every theme and the
  // corner button with every icon. Run with ON3_LOOK_FILE=<tmp file> and ON3_NO_AGENT=1 so nothing of the person's changes.
  if (process.env.ON3_LOOK_SHOT) setTimeout(async () => {
    const dir = process.env.ON3_LOOK_SHOT; mkdirSync(dir, { recursive: true });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const js = (c) => panel.webContents.executeJavaScript(c);
    const cap = async (w, name) => writeFileSync(join(dir, `${name}.png`), (await w.webContents.capturePage()).toPNG());
    try {
      togglePanel(true); await wait(2500);
      const lists = await js('({ themes: Object.keys(LOOKS.THEMES), icons: Object.keys(LOOKS.ICONS) })');
      await cap(panel, '1-open');
      await js(`bubble('Check my websites and tell me what is broken', 'me'); newCard(); ensureText().innerHTML = inl(esc('All **4 sites** answer. One thing to fix: \`0ncore.com/pricing\` loads in 4.1 s.')); (() => { const s = document.createElement('div'); s.className = 'step ok'; s.textContent = 'check 4 websites'; card.appendChild(s); const m = document.createElement('div'); m.className = 'meta'; m.textContent = 'done · 6.2s'; card.appendChild(m); })(); bubble('$ ls', 'me cmd'); newCard(); out = document.createElement('pre'); out.className = 'out'; out.textContent = 'notes.txt  photos  site'; card.appendChild(out); 1`);
      await wait(300); await cap(panel, '2-conversation');
      await js("document.querySelector('[data-p=cmds]').click(); 1"); await wait(300); await cap(panel, '3-commands');
      await js("document.querySelector('[data-p=set]').click(); 1"); await wait(400); await cap(panel, '4-settings');
      for (const [i, t] of lists.themes.entries()) {
        await js(`document.querySelector('[data-p=set]').click(); document.querySelector('[data-theme=${t}]').click(); document.querySelector('[data-icon=${lists.icons[(i + 1) % lists.icons.length]}]').click(); 1`); await wait(450);
        await cap(bubble, `bubble-${t}`);
        if (i === 1) await cap(panel, `settings-${t}`);
        await js("document.querySelector('[data-p=term]').click(); 1"); await wait(300); await cap(panel, `theme-${t}`);
      }
      const seen = await js("({ saved: localStorage.getItem('0n3.look'), neon: getComputedStyle(document.documentElement).getPropertyValue('--neon') })");
      writeFileSync(join(dir, 'look.json'), JSON.stringify({ lists, look, file: readFileSync(LOOK_FILE, 'utf8'), seen, bubbleIcon: await bubble.webContents.executeJavaScript("document.getElementById('btn').dataset.icon") }, null, 2));
    } catch (e) { writeFileSync(join(dir, 'error.txt'), String(e.stack || e)); }
    app.quit();
  }, 1500);
  // ON3_TERM_SHOT=<dir>: prove the terminal — open it, say one thing, run one command, capture each, quit.
  if (process.env.ON3_TERM_SHOT) setTimeout(async () => {
    const dir = process.env.ON3_TERM_SHOT; mkdirSync(dir, { recursive: true });
    try {
      togglePanel(true); await new Promise((r) => setTimeout(r, 2500));
      writeFileSync(join(dir, '1-open.png'), (await panel.webContents.capturePage()).toPNG());
      // ON3_SHOT_SETUP=<ai>: prove click-to-install on a fresh profile — click the name, wait for the card, say one thing.
      if (process.env.ON3_SHOT_SETUP) {
        const k = process.env.ON3_SHOT_SETUP;
        await panel.webContents.executeJavaScript(`document.querySelector('#eng [data-e=${k}]').click();true`); await new Promise((r) => setTimeout(r, 6000));
        writeFileSync(join(dir, 's1-setting-up.png'), (await panel.webContents.capturePage()).toPNG());
        for (let i = 0; i < 90 && term.info().setting.length; i++) await new Promise((r) => setTimeout(r, 2000));
        await new Promise((r) => setTimeout(r, 1500));
        writeFileSync(join(dir, 's2-ready.png'), (await panel.webContents.capturePage()).toPNG());
        await panel.webContents.executeJavaScript("document.getElementById('in').value='Say hello in five words.';document.getElementById('f').requestSubmit();true");
        await new Promise((r) => setTimeout(r, 25000));
        writeFileSync(join(dir, 's3-answer.png'), (await panel.webContents.capturePage()).toPNG());
        writeFileSync(join(dir, 'setup.json'), JSON.stringify({ info: term.info(), text: await panel.webContents.executeJavaScript("document.getElementById('log').innerText") }, null, 2));
        app.quit(); return;
      }
      await panel.webContents.executeJavaScript("document.getElementById('in').value='Use 0n3 to tell me which account I am signed in as, in one short sentence.';document.getElementById('f').requestSubmit();true");
      await new Promise((r) => setTimeout(r, 20000));
      writeFileSync(join(dir, '2-answer.png'), (await panel.webContents.capturePage()).toPNG());
      await panel.webContents.executeJavaScript("document.getElementById('in').value='Thanks. Now list three things you could do for me on this computer, one line each.';document.getElementById('f').requestSubmit();true");
      await new Promise((r) => setTimeout(r, 9000));
      await panel.webContents.executeJavaScript("document.getElementById('in').value='$ echo terminal ok && sw_vers -productVersion';document.getElementById('f').requestSubmit();true");
      await new Promise((r) => setTimeout(r, 2500));
      writeFileSync(join(dir, '2b-followup.png'), (await panel.webContents.capturePage()).toPNG());
      // 0.8.0: the 0n3 Bot (nothing installed), then "Which AIs do I have?"
      await panel.webContents.executeJavaScript("document.querySelector('#eng [data-e=bot]').click();true"); await new Promise((r) => setTimeout(r, 1200));
      await panel.webContents.executeJavaScript("document.getElementById('in').value='In one short sentence: which 0n3 account is this?';document.getElementById('f').requestSubmit();true");
      await new Promise((r) => setTimeout(r, Number(process.env.ON3_BOT_WAIT || 25000)));
      writeFileSync(join(dir, '2c-bot.png'), (await panel.webContents.capturePage()).toPNG());
      writeFileSync(join(dir, 'info.json'), JSON.stringify({ info: term.info(), text: await panel.webContents.executeJavaScript("document.getElementById('log').innerText") }, null, 2));
      await panel.webContents.executeJavaScript("document.querySelector('.tab[data-p=cmds]').click();true"); await new Promise((r) => setTimeout(r, 800));
      writeFileSync(join(dir, '3-commands.png'), (await panel.webContents.capturePage()).toPNG());
    } catch (e) { writeFileSync(join(dir, 'error.txt'), String(e.stack || e)); }
    app.quit();
  }, 1500);
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
