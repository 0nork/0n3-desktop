/**
 * THE 0n3 TERMINAL (Mike, 2026-11-24: "this application should actually be its own terminal … I want it to have this type of
 * speed and response"). Not a job queue: ONE live Claude Code session kept open by the app, spoken to over stream-json.
 *
 * Measured on Mike's Mac (Claude Code 2.1.325): first words 3.8 s after the first message (process start included), then
 * ~1 s to the first word of every later message, streamed token by token — the same feel as Claude Code in a terminal.
 *
 *   start(cwd)   spawn `claude -p --input-format stream-json --output-format stream-json --verbose
 *                --include-partial-messages --permission-mode bypassPermissions --mcp-config <0n3 MCP>` [--continue]
 *   send(text)   one user line into stdin; events stream out: ready · text (delta) · step (tool) · result (tool done)
 *                · done (turn over, ms) · error · exit
 *   stop()       kill the turn; the next send restarts with --continue so the conversation is not lost
 *   reset()      a brand-new conversation
 *   shell(cmd)   a `$` line or a click preset that is a plain command: the login shell, streamed the same way
 * The 0n3 MCP server rides along (desk token from ~/.0n/desk.json, written to a 0600 file, never in argv), so the session can
 * use every app the person connected. Folder: ~/.0n/desk/workspace unless they pick one.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { GeminiEngine, CodexEngine, BotEngine, ownAccountHint } from './engines.mjs';
import * as ai from './ai-setup.mjs';

const HOME = os.homedir();
const WIN = process.platform === 'win32';
export const WORKSPACE = join(HOME, '.0n', 'desk', 'workspace');
const MCP_FILE = join(HOME, '.0n', 'desk', 'terminal-mcp.json');
// Where each AI is and how it starts: ai-setup.mjs (2026-11-25). `aiCtx` is set by the app with its own runtime + npm.
let aiCtx = ai.context();
export const setAiContext = (o) => { aiCtx = ai.context(o); return aiCtx; };
export const getAiContext = () => aiCtx;
const env = (extra = {}) => ai.envFor(aiCtx, null, extra);
export const findClaude = () => ai.resolve('claude', aiCtx);
const NAMES = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Gemini', bot: '0n3 Bot' };
function desk() { try { return JSON.parse(readFileSync(join(HOME, '.0n', 'desk.json'), 'utf8')); } catch { return {}; } }
function mcpFile() {
  const c = desk(); if (!c.token) return null;
  mkdirSync(join(HOME, '.0n', 'desk'), { recursive: true });
  writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { '0n3': { type: 'http', url: `${(c.url || 'https://0n3.app').replace(/\/$/, '')}/mcp`, headers: { Authorization: `Bearer ${c.token}` } } } }), { mode: 0o600 });
  return MCP_FILE;
}
const HIDDEN = new Set(['ToolSearch', 'TodoWrite']);
const short = (s, n = 140) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
export function stepLabel(name, input = {}) {
  const n = String(name || '');
  if (n.startsWith('mcp__0n3__')) return `0n3 · ${n.slice(10)}${input.service ? ` · ${input.service}${input.endpoint ? `.${input.endpoint}` : ''}` : ''}`;
  if (n === 'Bash') return `$ ${short(input.command)}`;
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(n)) return `${n} ${String(input.file_path || '').replace(HOME, '~')}`;
  if (n === 'Glob' || n === 'Grep') return `${n} ${short(input.pattern, 80)}`;
  if (n === 'WebFetch') return `Open ${short(input.url, 100)}`;
  if (n === 'WebSearch') return `Search “${short(input.query, 90)}”`;
  return n;
}

export class TermSession {
  constructor(emit) {
    this.emit = emit; this.p = null; this.cwd = WORKSPACE; this.started = false; this.busy = false; this.buf = ''; this.t0 = 0; this.blocks = {}; this.sh = null;
    // which AI answers: claude (this class), gemini or codex (engines.mjs). Default = the desk's chosen AI, else the first installed.
    this.alt = { gemini: new GeminiEngine(emit), codex: new CodexEngine(emit), bot: new BotEngine(emit) };
    this.picked = false; this.setting = {}; this.claudeEnv = null;
    // Which AI answers: whichever is really on this computer; none yet = the 0n3 Bot, which needs nothing installed.
    this.engine = ai.pickEngine({ deskAgent: desk().agent, have: this.installed() });
  }
  installed() { return ai.installed(aiCtx); }
  /** `byPerson`: they clicked it. The app's own automatic switches never override a person's pick. */
  setEngine(name, byPerson = true) {
    if (!['claude', 'gemini', 'codex', 'bot'].includes(name)) return this.info();
    if (byPerson) this.picked = true;
    if (name === this.engine) return this.info();
    this.stop(); this.kill(); for (const e of Object.values(this.alt)) e.kill();
    this.engine = name; this.started = false; this.claudeEnv = null; this.emit({ t: 'engine', engine: name });
    if (name !== 'bot' && ai.AIS[name]) this.rememberAgent(name);
    return this.info();
  }
  /** The Jobs helper works with the same AI the person talks to here. */
  rememberAgent(name) { try { const c = desk(); if (c.token && c.agent !== ai.AIS[name].agent) writeFileSync(join(HOME, '.0n', 'desk.json'), JSON.stringify({ ...c, agent: ai.AIS[name].agent }, null, 2), { mode: 0o600 }); } catch { /* */ } }
  info() { const have = this.installed(); return { claude: have.claude, installed: { ...have, bot: true }, engine: this.engine, picked: this.picked, setting: Object.keys(this.setting), cwd: this.cwd, busy: this.busy || !!this.sh || Object.values(this.alt).some((e) => e.busy), live: !!this.p, signedIn: !!desk().token, home: HOME, platform: process.platform }; }
  get idle() { return !this.busy && !this.sh && !Object.values(this.alt).some((e) => e.busy); }

  /**
   * SET ONE AI UP, start to finish, with nobody opening a terminal: install it if it is missing, sign it in (the key
   * connected on 0n3 when there is one, else its own browser sign-in), tell the Jobs helper. Shown as one card.
   * `quiet`: started by the app itself (start-up, a newly connected AI) — never opens a browser, and stays silent when
   * there was nothing to do.
   */
  async setup(name, { quiet = false, switchTo = !quiet, account = false } = {}) {
    const a = ai.AIS[name]; if (!a) return { ok: false, error: 'Unknown AI.' };
    if (this.setting[name]) return this.setting[name];
    const job = (async () => {
      const was = !!ai.resolve(name, aiCtx);
      const pre = was ? await ai.authStatus(name, aiCtx).catch(() => ({ signedIn: false })) : { signedIn: false };
      if (was && pre.signedIn && !account) { await ai.writeLaunchMap(aiCtx).catch(() => {}); if (switchTo) this.setEngine(name, !quiet); return { ok: true, key: name, installed: true, signedIn: true, already: true }; }
      if (quiet && was && !ai.keyFor(aiCtx, name)) return { ok: false, key: name, installed: true, signedIn: false, needsBrowser: true }; // a browser sign-in is the person's move
      this.emit({ t: 'setup', k: name, s: was ? `Signing in to ${a.name}` : `Setting up ${a.name} on this computer (about a minute)` });
      if (account && this.engine === name) { this.kill(); for (const e of Object.values(this.alt)) e.kill(); this.started = false; }
      const r = await ai.setup(name, aiCtx, { onLine: (l) => this.emit({ t: 'out', k: name, s: `${l}\n` }), browser: !quiet, account });
      this.claudeEnv = null;
      // Set up by the app on its own (quiet): it never changes who you are talking to — the app picks once, after all of them.
      if (r.ok) { this.emit({ t: 'setupdone', k: name, ok: true, s: `${a.name} is ready.${switchTo ? ` You are talking to ${a.name} now.` : ''}` }); if (switchTo) this.setEngine(name, !quiet); }
      else if (r.needsBrowser) this.emit({ t: 'setupdone', k: name, ok: true, s: `${a.name} is installed. Click ${a.name} above to sign in.` });
      else this.emit({ t: 'setupdone', k: name, ok: false, s: r.error || `${a.name} could not be set up.` });
      this.emit({ t: 'info', info: this.info() });
      return r;
    })().finally(() => { delete this.setting[name]; });
    this.setting[name] = job;
    return job;
  }
  setCwd(dir) { if (!dir || !existsSync(dir)) return this.info(); if (dir !== this.cwd) { this.kill(); for (const e of Object.values(this.alt)) e.kill(); this.started = false; this.cwd = dir; this.emit({ t: 'cwd', cwd: dir }); } return this.info(); }

  start() {
    if (this.p) return true;
    const l = findClaude();
    if (!l) { this.emit({ t: 'error', s: 'Claude is not set up on this computer yet. Click Claude above and 0n3 sets it up for you.' }); return false; }
    mkdirSync(this.cwd, { recursive: true });
    const mcp = mcpFile();
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'bypassPermissions', ...(mcp ? ['--mcp-config', mcp, '--strict-mcp-config'] : []), ...(this.started ? ['--continue'] : [])];
    this.p = spawn(l.cmd, [...l.pre, ...args], { cwd: this.cwd, env: ai.envFor(aiCtx, l, this.claudeEnv || {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.started = true; this.buf = '';
    this.p.stdout.on('data', (d) => { this.buf += d; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (l.trim()) this.line(l); } });
    this.p.stderr.on('data', (d) => { const s = String(d); if (!/no stdin data|Warning:/i.test(s)) this.emit({ t: 'error', s: short(s, 400) }); });
    this.p.on('error', (e) => this.emit({ t: 'error', s: e.message }));
    this.p.on('close', (code) => { this.p = null; if (this.busy) { this.busy = false; this.emit({ t: 'done', ms: Date.now() - this.t0, stopped: true }); } this.emit({ t: 'exit', code }); });
    return true;
  }
  line(l) {
    let j; try { j = JSON.parse(l); } catch { return; }
    if (j.type === 'system' && j.subtype === 'init') return this.emit({ t: 'ready', model: j.model, tools: (j.tools || []).length, mcp: (j.mcp_servers || []).map((m) => `${m.name}:${m.status}`) });
    if (j.type === 'stream_event') {
      const e = j.event || {};
      if (e.type === 'content_block_start') this.blocks[e.index] = e.content_block?.type;
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') this.emit({ t: 'text', s: e.delta.text });
      if (e.type === 'message_start') this.emit({ t: 'msg' });
      return;
    }
    if (j.type === 'assistant') { for (const c of j.message?.content || []) if (c.type === 'tool_use' && !HIDDEN.has(c.name)) this.emit({ t: 'step', id: c.id, s: stepLabel(c.name, c.input) }); return; }
    if (j.type === 'user') { for (const c of j.message?.content || []) if (c.type === 'tool_result') this.emit({ t: 'result', id: c.tool_use_id, error: !!c.is_error, s: short(Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : c.content, 220) }); return; }
    if (j.type === 'result') {
      this.busy = false; let error = j.is_error ? short(j.result, 300) : null;
      // The Anthropic key connected on 0n3 was refused: stop using it (the next start has no key, and Claude's own sign-in takes over).
      if (error && /invalid api key|fix external api key|credit balance is too low/i.test(error)) { const low = /credit balance/i.test(error); if (!low) { ai.refuseKey('claude', aiCtx).catch(() => {}); this.claudeEnv = {}; this.kill(); this.started = false; } error = low ? `Claude says the key connected on 0n3 has no credit left. ${ownAccountHint('claude')}` : `The Claude key connected on 0n3 was refused, so 0n3 stopped using it. ${ownAccountHint('claude')}`; }
      this.emit({ t: 'done', ms: Date.now() - this.t0, cost: j.total_cost_usd ?? null, error });
    }
  }
  send(text) {
    const msg = String(text || '').trim(); if (!msg) return false;
    if (msg.startsWith('$')) return this.shell(msg.replace(/^\$\s*/, ''));
    // The chosen AI is not on this computer (a first run, or it was removed): set it up, then say the message.
    if (this.engine !== 'bot' && !ai.resolve(this.engine, aiCtx)) { const k = this.engine; this.setup(k, { switchTo: true }).then((r) => { if (r.ok && this.engine === k) this.send(msg); }); return true; }
    if (this.engine !== 'claude') { mkdirSync(this.cwd, { recursive: true }); this.alt[this.engine].send(msg, this.cwd); return true; }
    // Claude signed in with the key connected on 0n3 (only when it has no sign-in of its own): worked out once per session.
    if (!this.p && this.claudeEnv === null) { this.claudeEnv = {}; ai.signedEnv('claude', aiCtx).then((e) => { this.claudeEnv = e || {}; }).catch(() => {}).finally(() => this.send(msg)); return true; }
    if (this.busy && msg === this.last && Date.now() - this.t0 < 3000) return false; // the same line twice in a blink: one turn
    if (this.busy) { this.emit({ t: 'error', s: 'Still working on the last one. Press Stop, or wait a moment.' }); return false; }
    this.last = msg;
    if (!this.start()) return false;
    this.busy = true; this.t0 = Date.now(); this.emit({ t: 'turn', s: msg });
    this.p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg } }) + '\n');
    return true;
  }
  shell(cmd) {
    if (this.sh) { this.emit({ t: 'error', s: 'A command is still running. Press Stop first.' }); return false; }
    const t0 = Date.now(); this.emit({ t: 'shell', s: cmd });
    const sh = WIN ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh');
    mkdirSync(this.cwd, { recursive: true }); // a $ command before any AI message: the workspace folder may not exist yet, and spawn then fails as "spawn /bin/zsh ENOENT"
    this.sh = spawn(sh, WIN ? ['/d', '/s', '/c', cmd] : ['-lc', cmd], { cwd: this.cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.sh.stdout.on('data', (d) => this.emit({ t: 'out', s: String(d) }));
    this.sh.stderr.on('data', (d) => this.emit({ t: 'out', s: String(d) }));
    this.sh.on('error', (e) => this.emit({ t: 'error', s: e.message }));
    this.sh.on('close', (code) => { this.sh = null; this.emit({ t: 'shelldone', code, ms: Date.now() - t0 }); });
    return true;
  }
  stop() { if (this.sh) { try { this.sh.kill(); } catch { /* */ } } if (this.busy) this.kill(); for (const e of Object.values(this.alt)) e.stop(); return true; }
  reset() { this.kill(); for (const e of Object.values(this.alt)) e.reset(); this.started = false; this.emit({ t: 'reset' }); return true; }
  kill() { if (this.p) { try { this.p.kill(); } catch { /* */ } this.p = null; } }
}
