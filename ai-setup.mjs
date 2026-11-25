/**
 * THE AIs, SET UP BY THE APP (Mike, 2026-11-25: "it needs to be able to run with Gemini, Codex or Claude. It also needs to
 * install those CLI connections automatically with a login whenever Gemini, GPT or Claude is connected … these people do not
 * know how to use a traditional terminal").
 *
 * What was wrong on Windows, measured in the code before this file existed:
 *   - the app looked for `claude.cmd` / `gemini.cmd` in a fixed list of macOS folders, never in the PATH and never in
 *     %APPDATA%\npm where Windows puts them, so an installed Gemini was "not installed" and the app fell back to Claude;
 *   - the install buttons ran `npm install -g …`, and a normal Windows computer has no npm;
 *   - a `.cmd` cannot be started without a shell on Node 20.12+ (EINVAL), so even a found one would not have run;
 *   - the Jobs side looked with `command -v`, which does not exist on Windows.
 *
 * What this does instead. NOTHING here needs Node, npm, Homebrew or a terminal on the computer:
 *   install   the app downloads the official Node.js (pinned version, SHA-256 checked) into ~/.0n/ai/node once, and uses
 *             the npm inside it to put Claude Code, Codex and Gemini CLI in ~/.0n/ai.
 *             WHY A REAL NODE, measured 2026-11-25: run on the app's own runtime (Electron as Node), Gemini CLI 0.71
 *             refuses `-p "…"` with "Cannot use both a positional prompt and the --prompt flag" — its argument parser
 *             sees `process.versions.electron` and counts the script path as a prompt. Real Node has no such trap, and
 *             an AI that starts VS Code does not inherit ELECTRON_RUN_AS_NODE.
 *   find      the person's own install first (PATH + the folders each platform really uses), then the app's. A Windows
 *             `.cmd` is never started: its package's real entry is run directly.
 *   sign in   with the key the person already connected on 0n3 when there is one (no browser, no typing); otherwise the
 *             AI's own browser sign-in is opened for them. A key is NEVER used when the AI is already signed in by itself
 *             (a Claude subscription must not be silently replaced by pay-per-use key billing).
 *   tell      ~/.0n/ai/launch.json says how to start each AI, so the Jobs helper (desk-agent.js) starts the same ones.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import os from 'node:os';

export const AIS = {
  claude: { key: 'claude', name: 'Claude', cli: 'Claude Code', pkg: '@anthropic-ai/claude-code', bin: 'claude', provider: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', agent: 'claude_code' },
  codex: { key: 'codex', name: 'ChatGPT', cli: 'Codex', pkg: '@openai/codex', bin: 'codex', provider: 'openai', keyEnv: 'OPENAI_API_KEY', agent: 'codex' },
  gemini: { key: 'gemini', name: 'Gemini', cli: 'Gemini CLI', pkg: '@google/gemini-cli', bin: 'gemini', provider: 'gemini', keyEnv: 'GEMINI_API_KEY', agent: 'gemini_cli' },
};
export const ORDER = ['claude', 'codex', 'gemini'];
// The Node.js the app fetches for the AI programs. PINNED, with the publisher's SHA-256 for each file (nodejs.org/dist/v22.23.5/
// SHASUMS256.txt, read 2026-11-25): an unpinned "latest" moves underneath you (CLAUDE.md law 8).
export const NODE = { version: '22.23.5', files: {
  'win32-x64': ['node-v22.23.5-win-x64.zip', '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3'],
  'win32-arm64': ['node-v22.23.5-win-arm64.zip', 'c1856817f611738c77534efbff8a5a17990593eab24046bc8d2c23a77a160d13'],
  'darwin-arm64': ['node-v22.23.5-darwin-arm64.tar.gz', 'e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d'],
  'darwin-x64': ['node-v22.23.5-darwin-x64.tar.gz', 'c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422'],
} };
/** 0n3 service name → which AI it signs in. */
export const PROVIDER_TO_AI = { anthropic: 'claude', openai: 'codex', gemini: 'gemini', google_ai: 'gemini' };

export function context(o = {}) {
  const home = o.home || os.homedir(); const platform = o.platform || process.platform; const env = o.env || process.env;
  return { home, platform, env, win: platform === 'win32', arch: o.arch || process.arch, aiDir: o.aiDir || join(home, '.0n', 'ai'), exists: o.exists || existsSync, extraDirs: o.extraDirs || null };
}
const sep = (c) => (c.win ? ';' : ':');
const j = (c, ...p) => (c.win ? p.join('\\').replace(/\//g, '\\') : join(...p));

/** Every folder an AI program may really live in on this computer: the PATH first, then the usual places. */
export function searchDirs(c) {
  const fromPath = String(c.env.PATH || c.env.Path || '').split(sep(c)).filter(Boolean);
  const extra = c.extraDirs ? c.extraDirs : c.win
    ? [c.env.APPDATA && j(c, c.env.APPDATA, 'npm'), j(c, c.home, '.local', 'bin'), j(c, c.home, '.claude', 'local'), c.env.LOCALAPPDATA && j(c, c.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), c.env.ProgramFiles && j(c, c.env.ProgramFiles, 'nodejs')]
    : [j(c, c.home, '.local', 'bin'), j(c, c.home, '.claude', 'local'), j(c, c.home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const mine = j(c, c.home, '.0n'); // never our own shims: they point back here
  return [...new Set([...fromPath, ...extra.filter(Boolean)])].filter((d) => !d.startsWith(mine));
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const isJs = (f) => /\.(c|m)?js$/i.test(f);
/** The Node the AI programs run on: the one the app fetched, else one already on this computer. null = none yet. */
export const nodeHome = (c) => j(c, c.aiDir, 'node');
export function nodeBin(c) {
  const mine = c.win ? j(c, nodeHome(c), 'node.exe') : j(c, nodeHome(c), 'bin', 'node');
  if (c.exists(mine)) return mine;
  for (const d of searchDirs(c)) { const p = j(c, d, c.win ? 'node.exe' : 'node'); if (c.exists(p)) return p; }
  return null;
}
const npmCliOf = (c) => (c.win ? j(c, nodeHome(c), 'node_modules', 'npm', 'bin', 'npm-cli.js') : j(c, nodeHome(c), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
/** A JavaScript entry runs on that Node. No Node on the computer = it cannot start (and counts as not installed). */
const viaNode = (c, file) => { const n = nodeBin(c); return n ? { cmd: n, pre: [file], env: {} } : null; };

/** A package folder → how to start its command. Native program: run it. JavaScript entry: run it with the app's runtime. */
function fromPackage(c, pkgDir, ai, read = readJson) {
  const pj = read(j(c, pkgDir, 'package.json')); if (!pj) return null;
  const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[ai.bin]; if (!rel) return null;
  const file = j(c, pkgDir, ...String(rel).split('/'));
  if (!c.exists(file)) return null;
  if (isJs(file)) { const l = viaNode(c, file); return l ? { ...l, version: pj.version || null } : null; }
  // Claude Code ships a small placeholder that its install step swaps for the real program. If that step did not run, the
  // real one is in the platform package beside it.
  let size = Infinity; try { size = statSync(file).size; } catch { /* a test's fake file system */ }
  if (size < 1_000_000) {
    const alt = j(c, dirname(pkgDir), `${pkgDir.split(/[\\/]/).pop()}-${c.platform}-${c.arch}`, c.win ? `${ai.bin}.exe` : ai.bin);
    if (c.exists(alt)) return { cmd: alt, pre: [], env: {}, version: pj.version || null };
    return null;
  }
  return { cmd: file, pre: [], env: {}, version: pj.version || null };
}

/**
 * How to start one AI on this computer, or null when it is not here.
 * → { cmd, pre: [], env: {}, where: 'yours' | 'app', path }
 */
export function resolve(key, c = context(), read = readJson) { return withAlways(key, find(key, c, read)); }
function find(key, c, read) {
  const ai = AIS[key]; if (!ai) return null;
  for (const d of searchDirs(c)) {
    if (c.win) {
      const exe = j(c, d, `${ai.bin}.exe`);
      if (c.exists(exe)) return { cmd: exe, pre: [], env: {}, where: 'yours', path: exe };
      const cmd = j(c, d, `${ai.bin}.cmd`);
      if (c.exists(cmd)) { // npm's shim: the package sits beside it. Run the package, never the .cmd.
        const l = fromPackage(c, j(c, d, 'node_modules', ...ai.pkg.split('/')), ai, read);
        if (l) return { ...l, where: 'yours', path: cmd };
      }
    } else {
      const p = j(c, d, ai.bin);
      if (c.exists(p)) return { cmd: p, pre: [], env: {}, where: 'yours', path: p };
    }
  }
  // Each AI the app installs has its OWN folder (~/.0n/ai/<name>): installing one never rewrites another's files while it runs.
  const l = fromPackage(c, j(c, c.aiDir, key, 'node_modules', ...ai.pkg.split('/')), ai, read);
  return l ? { ...l, where: 'app', path: l.pre[0] || l.cmd } : null;
}
/** What every start of this AI needs besides its sign-in. */
const always = (key) => (key === 'gemini' ? { GEMINI_CLI_TRUST_WORKSPACE: 'true' } : {}); // headless Gemini refuses a folder nobody "trusted" in its own screen (measured, 0.71)
const withAlways = (key, l) => (l ? { ...l, env: { ...l.env, ...always(key) } } : l);
export const installed = (c = context()) => Object.fromEntries(ORDER.map((k) => [k, !!resolve(k, c)]));

/** The environment an AI is started with. `keys` are added only when the caller decided this AI needs its key. */
export function envFor(c, launcher, extra = {}) {
  const n = nodeBin(c);
  const PATH = [j(c, c.home, '.0n', 'bin'), ...(n ? [dirname(n)] : []), ...searchDirs(c)].join(sep(c));
  return { ...c.env, PATH, ON3_TERMINAL: '1', ...(launcher?.env || {}), ...extra };
}

// ── keys the person connected on 0n3, handed over by their own signed-in session ─────────────────────────────────────────
const keysFile = (c) => j(c, c.aiDir, 'keys.json');
const mark = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 16);
export function loadKeys(c = context()) { const k = readJson(keysFile(c)) || {}; return { anthropic: k.anthropic || null, openai: k.openai || null, gemini: k.gemini || null }; }
function writeKeys(c, next, refused) {
  mkdirSync(c.aiDir, { recursive: true });
  writeFileSync(keysFile(c), JSON.stringify({ ...next, refused }), { mode: 0o600 }); try { chmodSync(keysFile(c), 0o600); } catch { /* Windows */ }
}
export function saveKeys(c, keys = {}) {
  const refused = (readJson(keysFile(c)) || {}).refused || {};
  const cur = loadKeys(c); const next = { ...cur };
  for (const [prov, ai] of Object.entries(PROVIDER_TO_AI)) {
    const v = keys[prov]; if (typeof v !== 'string' || v.trim().length < 8) continue;
    const p = AIS[ai].provider; if (refused[p] === mark(v.trim())) continue; // the provider already said no to this exact key
    next[p] = v.trim();
  }
  writeKeys(c, next, refused);
  return next;
}
/** The provider refused this key (wrong, revoked): stop using it, and do not take the same one back. A NEW key is welcome. */
export function dropKey(c, key) {
  const p = AIS[key]?.provider; if (!p) return; const cur = loadKeys(c); if (!cur[p]) return;
  const refused = { ...((readJson(keysFile(c)) || {}).refused || {}), [p]: mark(cur[p]) };
  writeKeys(c, { ...cur, [p]: null }, refused);
}
export const keyFor = (c, key) => loadKeys(c)[AIS[key].provider] || null;

// ── running things ───────────────────────────────────────────────────────────────────────────────────────────────────────
function run(cmd, args, { env, cwd, input = null, timeoutMs = 60_000, onLine = null } = {}) {
  return new Promise((done) => {
    let out = ''; let p;
    try { p = spawn(cmd, args, { env, cwd, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return done({ code: 1, out: e.message }); }
    const take = (d) => { const s = String(d); out += s; if (out.length > 200_000) out = out.slice(-200_000); if (onLine) for (const l of s.split(/\r?\n/)) if (l.trim()) onLine(l.trim()); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const t = setTimeout(() => { try { p.kill(); } catch { /* */ } }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); done({ code: 1, out: `${out}${e.message}` }); });
    p.on('close', (code) => { clearTimeout(t); done({ code: code ?? 1, out }); });
    if (input != null) { try { p.stdin.write(input); p.stdin.end(); } catch { /* */ } }
  });
}
const runAi = (c, l, args, o = {}) => run(l.cmd, [...l.pre, ...args], { ...o, env: envFor(c, l, o.extraEnv || {}) });

/**
 * The official Node.js, fetched once into ~/.0n/ai/node: the pinned version, checked against the publisher's SHA-256,
 * unpacked with the `tar` every Mac and every Windows 10/11 already has. → the path of node.
 */
export async function ensureNode(c = context(), onLine = () => {}, fetchImpl = fetch) {
  const have = c.win ? j(c, nodeHome(c), 'node.exe') : j(c, nodeHome(c), 'bin', 'node');
  if (existsSync(have) && existsSync(npmCliOf(c))) return have;
  const pick = NODE.files[`${c.platform}-${c.arch}`];
  if (!pick) throw new Error(`0n3 cannot set an AI up on this kind of computer yet (${c.platform} ${c.arch}).`);
  const [file, sha] = pick;
  mkdirSync(c.aiDir, { recursive: true });
  onLine('Getting things ready (one time)…');
  const r = await fetchImpl(`https://nodejs.org/dist/v${NODE.version}/${file}`);
  if (!r.ok) throw new Error(`ENOTFOUND: nodejs.org answered ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== sha) throw new Error('The download did not arrive whole (its checksum is wrong). Press the button again.');
  const archive = j(c, c.aiDir, file); writeFileSync(archive, buf);
  const tmp = j(c, c.aiDir, 'node.new'); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  const tar = c.win ? j(c, c.env.SystemRoot || c.env.windir || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  const x = await run(tar, ['-xf', archive, '-C', tmp, '--strip-components=1'], { env: c.env, timeoutMs: 5 * 60_000 });
  rmSync(archive, { force: true });
  if (x.code !== 0) throw new Error(`EPERM: could not unpack (${x.out.trim().split(/\r?\n/).pop() || `tar exit ${x.code}`})`);
  rmSync(nodeHome(c), { recursive: true, force: true }); renameSync(tmp, nodeHome(c));
  if (!existsSync(have)) throw new Error('EPERM: Node was unpacked but is not where it should be.');
  return have;
}

// ONE set-up at a time, install and sign-in together. Measured 2026-11-25 in the app: with two running at once, Codex's key
// sign-in failed ("key was not accepted") because npm was rewriting the shared folder under it for Gemini.
let chain = Promise.resolve();
const inLine = (fn) => { const job = chain.then(fn); chain = job.catch(() => {}); return job; };
/** Install one AI into ~/.0n/ai/<name>. → the launcher, or throws with the reason in plain words. */
export const install = (key, c = context(), onLine = () => {}) => inLine(() => installNow(key, c, onLine));
async function installNow(key, c, onLine) {
  {
    const ai = AIS[key]; if (!ai) throw new Error(`Unknown AI "${key}".`);
    const have = resolve(key, c); if (have) return have;
    let node;
    try { node = await ensureNode(c, onLine); } catch (e) { throw new Error(plainInstallError(ai, e.message)); }
    const dir = join(c.aiDir, key); mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `on3-ai-${key}`, private: true, description: 'An AI program 0n3 installed for you. Safe to delete; 0n3 puts it back.' }));
    onLine(`Downloading ${ai.cli}…`);
    const env = { ...c.env, PATH: [dirname(node), c.env.PATH || c.env.Path || ''].join(delimiter), npm_config_update_notifier: 'false' };
    const r = await run(node, [npmCliOf(c), 'install', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error', `${ai.pkg}@latest`], { env, cwd: dir, timeoutMs: 15 * 60_000, onLine: (l) => { if (!/^npm (warn|notice)|^added |^changed |^up to date/i.test(l)) onLine(l.slice(0, 200)); } });
    const l = resolve(key, c);
    if (!l) throw new Error(plainInstallError(ai, r.out));
    onLine(`${ai.cli} is installed.`);
    return l;
  }
}
export function plainInstallError(ai, out) {
  const s = String(out || '');
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(s)) return `${ai.cli} could not be downloaded: this computer could not reach the internet. Check the connection and press the button again.`;
  if (/ENOSPC/i.test(s)) return `${ai.cli} could not be installed: this computer's disk is full.`;
  if (/EPERM|EACCES/i.test(s)) return `${ai.cli} could not be installed: Windows or an antivirus blocked the folder ${'~/.0n/ai'}. Allow 0n3 there and press the button again.`;
  if (/checksum|cannot set an AI up on this kind/i.test(s)) return s;
  return `${ai.cli} could not be installed. ${s.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 260)}`;
}

// ── is it signed in, and signing it in ───────────────────────────────────────────────────────────────────────────────────
/** → { signedIn, how } where how = 'own' (its own sign-in) | 'key' (the key connected on 0n3) | null */
export async function authStatus(key, c = context(), launcher = resolve(key, c)) {
  if (!launcher) return { signedIn: false, how: null };
  const hasKey = !!keyFor(c, key);
  if (key === 'claude') {
    const r = await runAi(c, launcher, ['auth', 'status'], { timeoutMs: 20_000 });
    let own = false; try { own = JSON.parse(r.out.slice(r.out.indexOf('{'))).loggedIn === true; } catch { own = r.code === 0 && /logged ?in["']?\s*[:=]\s*true/i.test(r.out); }
    return own ? { signedIn: true, how: 'own' } : { signedIn: hasKey, how: hasKey ? 'key' : null };
  }
  if (key === 'codex') {
    const r = await runAi(c, launcher, ['login', 'status'], { timeoutMs: 20_000 });
    // measured (Codex 0.170/0.172): "Logged in using ChatGPT" · "API key configured - sk-…" · "Not logged in" (exit 1)
    const yes = r.code === 0 && /logged in|api key configured/i.test(r.out) && !/not logged in/i.test(r.out);
    return yes ? { signedIn: true, how: /api key/i.test(r.out) ? 'key' : 'own' } : { signedIn: false, how: null };
  }
  // Gemini keeps what it was told in ~/.gemini/settings.json; the engine settles the rest when the session opens.
  const type = readJson(join(c.home, '.gemini', 'settings.json'))?.security?.auth?.selectedType || null;
  if (type === 'oauth-personal' && existsSync(join(c.home, '.gemini', 'oauth_creds.json'))) return { signedIn: true, how: 'own' };
  if (type && type !== 'gemini-api-key' && type !== 'oauth-personal') return { signedIn: true, how: 'own' }; // Vertex, a gateway: theirs
  return { signedIn: hasKey || !!c.env.GEMINI_API_KEY, how: hasKey ? 'key' : c.env.GEMINI_API_KEY ? 'own' : null };
}

/** Gemini's own handshake (Agent Client Protocol): tell it how this person signs in. 'gemini-api-key' is silent; 'oauth-personal' opens the browser. */
export function geminiAuthenticate(c, launcher, methodId, { apiKey = null, timeoutMs = 5 * 60_000, onLine = () => {} } = {}) {
  return new Promise((done) => {
    const p = spawn(launcher.cmd, [...launcher.pre, '--acp'], { env: envFor(c, launcher, apiKey ? { GEMINI_API_KEY: apiKey } : {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = ''; let over = false;
    const end = (ok, error) => { if (over) return; over = true; clearTimeout(t); try { p.kill(); } catch { /* */ } done({ ok, error: error || null }); };
    const t = setTimeout(() => end(false, 'Gemini sign-in was not finished in time.'), timeoutMs);
    const say = (o) => { try { p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`); } catch { /* */ } };
    p.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 1) { if (m.error) return end(false, m.error.message); if (methodId === 'oauth-personal') onLine('Your browser is opening: choose your Google account there.'); say({ id: 2, method: 'authenticate', params: { methodId } }); }
      else if (m.id === 2) end(!m.error, m.error?.message);
    } });
    p.on('error', (e) => end(false, e.message)); p.on('close', () => end(false, 'Gemini closed before it was signed in.'));
    say({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
  });
}

/**
 * Sign one AI in. With a key connected on 0n3: silent. Without: the AI's own browser sign-in, opened for the person.
 * → { ok, how: 'own' | 'key', error? }
 */
export async function signIn(key, c = context(), { onLine = () => {}, browser = true } = {}) {
  const ai = AIS[key]; const l = resolve(key, c); if (!l) return { ok: false, error: `${ai.cli} is not installed yet.` };
  const st = await authStatus(key, c, l);
  if (st.signedIn && st.how === 'own') return { ok: true, how: 'own', already: true };
  if (st.signedIn && key === 'codex') return { ok: true, how: 'key', already: true }; // Codex already holds the key
  const apiKey = keyFor(c, key);
  if (apiKey) {
    if (key === 'claude') { onLine(`Signed in to ${ai.name} with the key you connected on 0n3.`); return { ok: true, how: 'key' }; } // rides in the environment on each start
    if (key === 'codex') {
      const r = await runAi(c, l, ['login', '--with-api-key'], { input: `${apiKey}\n`, timeoutMs: 30_000 });
      if (r.code === 0) { onLine('Signed in to ChatGPT (Codex) with the key you connected on 0n3.'); return { ok: true, how: 'key' }; }
      onLine('The connected OpenAI key was not accepted.');
    } else {
      const r = await geminiAuthenticate(c, l, 'gemini-api-key', { apiKey, timeoutMs: 40_000 });
      if (r.ok) { onLine('Signed in to Gemini with the key you connected on 0n3.'); return { ok: true, how: 'key' }; }
      onLine(`The connected Gemini key was not accepted${r.error ? `: ${String(r.error).slice(0, 140)}` : '.'}`);
    }
  }
  if (!browser) return { ok: false, needsBrowser: true, error: `${ai.name} needs you to sign in.` };
  onLine(`Opening ${ai.name}'s sign-in in your browser. Finish there and come back; this window continues by itself.`);
  if (key === 'gemini') { const r = await geminiAuthenticate(c, l, 'oauth-personal', { onLine }); return r.ok ? { ok: true, how: 'own' } : { ok: false, error: r.error || 'Gemini sign-in did not finish.' }; }
  const r = await runAi(c, l, key === 'claude' ? ['auth', 'login'] : ['login'], { timeoutMs: 6 * 60_000, onLine: (line) => { if (/https?:\/\//.test(line) || /sign|log|browser|success|code/i.test(line)) onLine(line.slice(0, 300)); } });
  const after = await authStatus(key, c, l);
  return after.signedIn && after.how === 'own' ? { ok: true, how: 'own' } : { ok: false, error: `${ai.name} sign-in did not finish${r.code ? '' : ' (the window was closed)'}. Press the button to try again.` };
}

/** Stop using the key connected on 0n3 for this AI (the provider refused it, or the person wants their own account). */
export async function refuseKey(key, c = context()) {
  const had = !!keyFor(c, key); dropKey(c, key);
  const l = resolve(key, c);
  if (had && l && key === 'codex') await runAi(c, l, ['logout'], { timeoutMs: 20_000 }).catch(() => {}); // Codex kept the key itself
  await writeLaunchMap(c).catch(() => {});
  return had;
}

/** The environment one AI needs to be signed in on this start: its key, only when it has no sign-in of its own. */
export async function signedEnv(key, c = context(), launcher = resolve(key, c)) {
  const apiKey = keyFor(c, key); if (!apiKey || !launcher) return {};
  if (key === 'codex') return {}; // Codex keeps the key itself after `login --with-api-key`
  const st = await authStatus(key, c, launcher);
  return st.how === 'key' ? { [AIS[key].keyEnv]: apiKey } : {};
}

// ── telling the Jobs helper how to start the same AIs ────────────────────────────────────────────────────────────────────
export async function writeLaunchMap(c = context()) {
  const map = {};
  for (const k of ORDER) { const l = resolve(k, c); if (!l) continue; map[AIS[k].agent] = { cmd: l.cmd, pre: l.pre, env: { ...l.env, ...(await signedEnv(k, c, l).catch(() => ({}))) }, where: l.where }; }
  mkdirSync(c.aiDir, { recursive: true });
  const file = j(c, c.aiDir, 'launch.json');
  writeFileSync(file, JSON.stringify(map), { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* Windows */ }
  return map;
}

/**
 * Everything, for one AI: install if missing, sign in, tell the Jobs helper. Lines of plain English go to onLine.
 * → { ok, key, installed, signedIn, how, error? }
 */
export const setup = (key, c = context(), o = {}) => inLine(() => setupNow(key, c, o));
async function setupNow(key, c, { onLine = () => {}, browser = true, account = false } = {}) {
  const ai = AIS[key]; if (!ai) return { ok: false, key, error: `Unknown AI "${key}".` };
  let l = resolve(key, c);
  try { if (!l) l = await installNow(key, c, onLine); else onLine(`${ai.cli} is already on this computer.`); }
  catch (e) { return { ok: false, key, installed: false, signedIn: false, error: e.message }; }
  if (account) await refuseKey(key, c); // "with my own account": the connected key steps aside
  const s = await signIn(key, c, { onLine, browser });
  await writeLaunchMap(c).catch(() => {});
  return { ok: !!s.ok, key, installed: true, signedIn: !!s.ok, how: s.how || null, needsBrowser: !!s.needsBrowser, error: s.ok ? null : s.error };
}

/**
 * Which AI the terminal should talk to. `have` = the ones usable on this computer. In order: the person's own pick; the AI
 * this computer's desk already works with; the first one they connected on 0n3; any that is here; else the 0n3 Bot.
 * (The desk's AI comes BEFORE the 0n3 order: measured 2026-11-25, the order alone moved a working Claude session to a
 * ChatGPT whose sign-in had expired.)
 */
export function pickEngine({ saved = null, deskAgent = null, have = {}, connected = [] } = {}) {
  const fromDesk = Object.values(AIS).find((a) => a.agent === deskAgent)?.key || null;
  if (saved === 'bot' || (saved && have[saved])) return saved;
  if (fromDesk && have[fromDesk]) return fromDesk;
  const wanted = connected.map((p) => PROVIDER_TO_AI[p]).filter(Boolean);
  return wanted.find((k) => have[k]) || ORDER.find((k) => have[k]) || 'bot';
}
