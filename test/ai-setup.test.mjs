// The AIs, set up by the app (ai-setup.mjs). The Windows cases are the ones that failed in the field on 2026-11-25:
// an installed Gemini CLI was "not installed" and the app answered "Claude is not installed".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ai from '../ai-setup.mjs';
import { launcherFor, usableAgent } from '../node_modules/0nmcp/desk-agent.js';
import { botError, friendly } from '../engines.mjs';

const winCtx = (files, env = {}) => ai.context({ platform: 'win32', arch: 'x64', home: 'C:\\Users\\Dana', execPath: 'C:\\Users\\Dana\\AppData\\Local\\Programs\\0n3\\0n3.exe', env: { PATH: 'C:\\Windows\\system32;C:\\Windows', APPDATA: 'C:\\Users\\Dana\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Dana\\AppData\\Local', ...env }, exists: (p) => files.has(p) });
const reader = (pkgs) => (file) => pkgs[file] || null;

test('Windows: Gemini CLI installed with npm is FOUND in %APPDATA%\\npm, and its .cmd is never the thing that is started', () => {
  const npm = 'C:\\Users\\Dana\\AppData\\Roaming\\npm';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const files = new Set([`${npm}\\gemini.cmd`, `${npm}\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js`, node]);
  const l = ai.resolve('gemini', winCtx(files, { PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs', ProgramFiles: 'C:\\Program Files' }), reader({ [`${npm}\\node_modules\\@google\\gemini-cli\\package.json`]: { version: '0.71.1', bin: { gemini: 'bundle/gemini.js' } } }));
  assert.ok(l, 'Gemini must be found');
  assert.equal(l.where, 'yours');
  assert.equal(l.cmd, 'C:\\Program Files\\nodejs\\node.exe', 'started with real Node, directly');
  assert.deepEqual(l.pre, [`${npm}\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js`]);
  assert.equal(l.env.ELECTRON_RUN_AS_NODE, undefined, 'never the app runtime: Gemini misreads its arguments on it');
  assert.equal(l.env.GEMINI_CLI_TRUST_WORKSPACE, 'true');
  assert.ok(!/\.cmd$/i.test(l.cmd), 'a .cmd cannot be spawned without a shell on Node 20.12+');
});

test('Windows: Claude from its own installer (%USERPROFILE%\\.local\\bin\\claude.exe) is found and run directly', () => {
  const exe = 'C:\\Users\\Dana\\.local\\bin\\claude.exe';
  const l = ai.resolve('claude', winCtx(new Set([exe])), reader({}));
  assert.deepEqual({ cmd: l.cmd, pre: l.pre, where: l.where }, { cmd: exe, pre: [], where: 'yours' });
});

test('Windows: nothing on the computer → nothing found, and the terminal talks to the 0n3 Bot, never to a missing Claude', () => {
  const c = winCtx(new Set());
  assert.deepEqual(ai.installed(c), { claude: false, codex: false, gemini: false });
  assert.equal(ai.pickEngine({ have: ai.installed(c), deskAgent: 'claude_code', connected: ['gemini'] }), 'bot');
});

test('Windows: what the app installed itself (~/.0n/ai) is found; a JavaScript entry runs on the app runtime, a native one directly', () => {
  const at = (k) => `C:\\Users\\Dana\\.0n\\ai\\${k}\\node_modules`; // each AI in its own folder
  const files = new Set([`${at('gemini')}\\@google\\gemini-cli\\bundle\\gemini.js`, `${at('codex')}\\@openai\\codex\\bin\\codex.js`, `${at('claude')}\\@anthropic-ai\\claude-code\\bin\\claude.exe`, 'C:\\Users\\Dana\\.0n\\ai\\node\\node.exe']);
  const read = reader({
    [`${at('gemini')}\\@google\\gemini-cli\\package.json`]: { bin: { gemini: 'bundle/gemini.js' } },
    [`${at('codex')}\\@openai\\codex\\package.json`]: { bin: { codex: 'bin/codex.js' } },
    [`${at('claude')}\\@anthropic-ai\\claude-code\\package.json`]: { bin: { claude: 'bin/claude.exe' } },
  });
  const c = winCtx(files);
  assert.equal(ai.resolve('gemini', c, read).where, 'app');
  assert.deepEqual(ai.resolve('codex', c, read).pre, [`${at('codex')}\\@openai\\codex\\bin\\codex.js`]);
  assert.equal(ai.resolve('codex', c, read).cmd, 'C:\\Users\\Dana\\.0n\\ai\\node\\node.exe', 'the Node the app fetched');
  files.delete('C:\\Users\\Dana\\.0n\\ai\\node\\node.exe');
  assert.equal(ai.resolve('gemini', c, read), null, 'no Node on the computer: a JavaScript AI cannot start, so it counts as not installed');
  assert.ok(ai.resolve('claude', c, read), 'a native program needs no Node');
  assert.deepEqual(ai.resolve('claude', c, read).pre, []);
  assert.equal(ai.resolve('claude', c, read).cmd, `${at('claude')}\\@anthropic-ai\\claude-code\\bin\\claude.exe`);
});

test('our own shims in ~/.0n are never taken for an AI (they point back at the app)', () => {
  const c = ai.context({ platform: 'darwin', home: '/Users/dana', env: { PATH: '/Users/dana/.0n/bin:/usr/bin' }, exists: (p) => p === '/Users/dana/.0n/bin/claude' });
  assert.equal(ai.resolve('claude', c, () => null), null);
});

test('which AI answers: the person\'s pick, else what they connected on 0n3 and have, else what is here, else the Bot', () => {
  const have = { claude: true, codex: false, gemini: true };
  assert.equal(ai.pickEngine({ saved: 'gemini', have }), 'gemini');
  assert.equal(ai.pickEngine({ saved: 'codex', have, connected: ['gemini'] }), 'gemini', 'a saved pick that is not on this computer is not used');
  assert.equal(ai.pickEngine({ have, connected: ['openai', 'gemini'] }), 'gemini');
  assert.equal(ai.pickEngine({ have, deskAgent: 'claude_code' }), 'claude');
  assert.equal(ai.pickEngine({ have: { claude: true, codex: true, gemini: true }, deskAgent: 'claude_code', connected: ['openai', 'gemini', 'anthropic'] }), 'claude', 'the AI this desk already works with is not replaced by the order on 0n3');
  assert.equal(ai.pickEngine({ have: { claude: false, codex: false, gemini: true }, deskAgent: 'claude_code', connected: ['gemini'] }), 'gemini', 'the Windows case: Gemini connected, Claude never installed → Gemini, not "Claude is not installed"');
  assert.equal(ai.pickEngine({ saved: 'bot', have }), 'bot');
  assert.equal(ai.pickEngine({ have: {} }), 'bot');
});

test('keys handed over by the person\'s own 0n3 session are kept per provider; rubbish is ignored; nothing is dropped by a later partial hand-over', () => {
  const home = mkdtempSync(join(tmpdir(), 'on3-ai-')); const c = ai.context({ home });
  ai.saveKeys(c, { gemini: 'AIzaTESTTESTTEST', openai: 'x', anthropic: null });
  assert.deepEqual(ai.loadKeys(c), { anthropic: null, openai: null, gemini: 'AIzaTESTTESTTEST' });
  ai.saveKeys(c, { anthropic: 'sk-ant-TESTTEST' });
  assert.deepEqual(ai.loadKeys(c), { anthropic: 'sk-ant-TESTTEST', openai: null, gemini: 'AIzaTESTTESTTEST' });
  assert.equal(ai.keyFor(c, 'gemini'), 'AIzaTESTTESTTEST');
  assert.equal(ai.keyFor(c, 'codex'), null);
});

test('a key the provider refused is dropped, and the SAME key is not taken back; a new one is', () => {
  const home = mkdtempSync(join(tmpdir(), 'on3-ref-')); const c = ai.context({ home });
  ai.saveKeys(c, { anthropic: 'sk-ant-OLDOLDOLD' }); ai.dropKey(c, 'claude');
  assert.equal(ai.keyFor(c, 'claude'), null);
  ai.saveKeys(c, { anthropic: 'sk-ant-OLDOLDOLD' }); assert.equal(ai.keyFor(c, 'claude'), null, 'the refused key comes back from 0n3 on every check; it must stay out');
  ai.saveKeys(c, { anthropic: 'sk-ant-NEWNEWNEW' }); assert.equal(ai.keyFor(c, 'claude'), 'sk-ant-NEWNEWNEW');
});

test('an install that fails says why in plain words', () => {
  assert.match(ai.plainInstallError(ai.AIS.gemini, 'npm error code ENOTFOUND registry.npmjs.org'), /could not reach the internet/);
  assert.match(ai.plainInstallError(ai.AIS.claude, 'npm error EPERM: operation not permitted'), /antivirus/);
  assert.match(ai.plainInstallError(ai.AIS.codex, 'ENOSPC'), /disk is full/);
});

test('the Jobs helper starts the AI the app set up (launch.json), and uses an AI that IS here instead of failing on one that is not', () => {
  const home = mkdtempSync(join(tmpdir(), 'on3-launch-')); mkdirSync(join(home, '.0n', 'ai'), { recursive: true });
  const fake = join(home, 'gemini.js'); writeFileSync(fake, '');
  writeFileSync(join(home, '.0n', 'ai', 'launch.json'), JSON.stringify({ gemini_cli: { cmd: process.execPath, pre: [fake], env: { ELECTRON_RUN_AS_NODE: '1', GEMINI_API_KEY: 'k' } }, codex: { cmd: join(home, 'gone.exe'), pre: [] } }));
  assert.deepEqual(launcherFor('gemini_cli', home), { cmd: process.execPath, pre: [fake], env: { ELECTRON_RUN_AS_NODE: '1', GEMINI_API_KEY: 'k' } });
  assert.equal(usableAgent('gemini_cli', home), 'gemini_cli');
});

test('plain words for the person: no AI connected, signed out, and a sign-in that ran out', () => {
  assert.match(botError({ ok: false, error: 'No AI is connected yet.' }, 200), /Click Claude, ChatGPT or Gemini above/);
  assert.match(botError({}, 401), /signed out of 0n3/);
  assert.match(friendly('gemini', 'Gemini API key is missing or not configured.'), /Click its name above/);
  assert.match(friendly('codex', '401 Unauthorized'), /ChatGPT \(Codex\) needs you to sign in again/);
});

test('the page never tells anyone to install something by hand or to open a terminal', () => {
  const page = readFileSync(new URL('../app.js', import.meta.url), 'utf8') + readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  assert.ok(!/npm install/.test(page), 'no npm command is shown to a person');
  assert.ok(!/is not installed: see Commands/.test(page));
  assert.match(ai.NODE.version, /^22\.\d+\.\d+$/, 'the Node the app fetches is pinned');
  for (const [f, sha] of Object.values(ai.NODE.files)) { assert.ok(f.includes(ai.NODE.version)); assert.match(sha, /^[0-9a-f]{64}$/); }
});
