/**
 * GEMINI CLI and CODEX in the terminal (Mike, 2026-11-24: "Codex and Gemini need to be fully wired up for the downloadable
 * app for EVERYONE ELSE"). Same events as the Claude engine (term-session.mjs): turn · text · step · result · done · error.
 *
 * GEMINI — Agent Client Protocol: `gemini --acp` stays open (JSON-RPC over stdio): initialize → session/new {cwd,
 *   mcpServers:[0n3 over http]} → session/prompt per message; session/update streams agent_message_chunk / tool_call /
 *   tool_call_update. Approval requests (session/request_permission) are answered by the app with the first "allow" option —
 *   YOLO mode is often switched off by a Google Workspace admin (it is on Mike's), so the app never relies on it.
 *   Measured on Mike's Mac (Gemini CLI 0.59): the protocol works end to end; his project's prepaid credits are used up (402).
 * CODEX — `codex exec --json` per message, `codex exec resume --last --json` after the first; 0n3 rides in with
 *   -c mcp_servers.on3.url + bearer_token_env_var (the token goes in the environment, never argv). Codex 0.170 removed
 *   --full-auto → `-s workspace-write -c approval_policy="never"`. JSONL: thread.started · item.started/completed
 *   (agent_message, command_execution, mcp_tool_call, file_change, web_search) · turn.completed · turn.failed · error.
 *   Measured: runs; Mike's ChatGPT sign-in has expired (401), which the app turns into "Sign in to Codex".
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const HOME = os.homedir(); const WIN = process.platform === 'win32';
const PATHS = [join(HOME, '.0n', 'bin'), join(HOME, '.local', 'bin'), join(HOME, '.npm-global', 'bin'), join(HOME, '.0n', 'ai', 'node_modules', '.bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
export const env = (extra = {}) => ({ ...process.env, PATH: [...PATHS, process.env.PATH || ''].join(WIN ? ';' : ':'), ON3_TERMINAL: '1', ...extra });
export const findBin = (name) => { for (const d of PATHS) { const p = join(d, WIN ? `${name}.cmd` : name); if (existsSync(p)) return p; } return null; };
const desk = () => { try { return JSON.parse(readFileSync(join(HOME, '.0n', 'desk.json'), 'utf8')); } catch { return {}; } };
const base = () => (desk().url || 'https://0n3.app').replace(/\/$/, '');
const short = (s, n = 160) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

/** Turn a provider's raw failure into one plain sentence and the next step. */
export function friendly(engine, raw) {
  const s = String(raw || '');
  if (/prepayment credits are depleted|RESOURCE_EXHAUSTED|quota/i.test(s)) return `${engine === 'gemini' ? 'Gemini' : 'Your AI'} says your credits are used up. Top up at ai.studio, sign in with a Google account that has free usage left (Commands → Sign in to Gemini), or switch to another AI above.`;
  if (/refresh token|sign in again|401|Unauthorized|not logged in|auth_required|authenticate/i.test(s)) return `${engine === 'codex' ? 'Codex' : engine === 'gemini' ? 'Gemini' : 'Your AI'} needs you to sign in again. Click Commands → Sign in to ${engine === 'codex' ? 'Codex' : 'Gemini'}, finish in the browser, then try again.`;
  if (/rate limit|429/i.test(s)) return 'Your AI is rate limited right now. Wait a minute, or switch to another AI above.';
  return short(s, 400);
}

// ── GEMINI over ACP ─────────────────────────────────────────────────────────────────────────────────────────────────────
export class GeminiEngine {
  constructor(emit) { this.emit = emit; this.p = null; this.sid = null; this.cwd = null; this.busy = false; this.id = 0; this.pend = {}; this.buf = ''; this.t0 = 0; this.tools = {}; this.text = false; }
  rpc(method, params) { return new Promise((ok) => { const i = ++this.id; this.pend[i] = ok; this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); }); }
  reply(id, result) { this.p?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
  async start(cwd) {
    if (this.p && this.sid && this.cwd === cwd) return true;
    this.kill();
    const bin = findBin('gemini'); if (!bin) { this.emit({ t: 'error', s: 'Gemini CLI is not on this computer. Click Commands → Install Gemini CLI.' }); return false; }
    this.cwd = cwd; this.buf = '';
    this.p = spawn(bin, ['--acp'], { cwd, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.p.stdout.on('data', (d) => { this.buf += d; let k; while ((k = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, k); this.buf = this.buf.slice(k + 1); if (l.trim()) this.line(l); } });
    this.p.stderr.on('data', () => {});
    this.p.on('close', () => { this.p = null; this.sid = null; if (this.busy) { this.busy = false; this.emit({ t: 'done', ms: Date.now() - this.t0, stopped: true }); } });
    const init = await this.rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (init.error) { this.emit({ t: 'error', s: friendly('gemini', init.error.message) }); return false; }
    const c = desk();
    const mcpServers = c.token ? [{ type: 'http', name: '0n3', url: `${base()}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${c.token}` }] }] : [];
    const s = await this.rpc('session/new', { cwd, mcpServers });
    if (s.error) { this.emit({ t: 'error', s: friendly('gemini', s.error.message) }); return false; }
    this.sid = s.result.sessionId;
    this.emit({ t: 'ready', model: 'Gemini CLI', tools: null, mcp: c.token ? ['0n3:connected'] : [] });
    return true;
  }
  line(l) {
    let j; try { j = JSON.parse(l); } catch { return; }
    if (j.id && !j.method && this.pend[j.id]) { this.pend[j.id](j); delete this.pend[j.id]; return; }
    if (j.method === 'session/request_permission') { const o = (j.params.options || []).find((x) => /allow/i.test(x.kind || x.optionId)) || j.params.options?.[0]; return this.reply(j.id, { outcome: o ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' } }); }
    if (j.method && j.id) return this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'not supported by the 0n3 terminal' } }) + '\n');
    if (j.method !== 'session/update') return;
    const u = j.params?.update || {};
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') this.emit({ t: 'text', s: u.content.text });
    else if (u.sessionUpdate === 'tool_call') { this.tools[u.toolCallId] = 1; this.emit({ t: 'step', id: u.toolCallId, s: short(u.title || u.kind || 'tool', 140) }); }
    else if (u.sessionUpdate === 'tool_call_update' && /completed|failed/.test(u.status || '')) this.emit({ t: 'result', id: u.toolCallId, error: u.status === 'failed' });
  }
  async send(msg, cwd) {
    if (this.busy) { this.emit({ t: 'error', s: 'Still working on the last one. Press Stop, or wait a moment.' }); return false; }
    this.busy = true; this.t0 = Date.now(); this.emit({ t: 'turn', s: msg });
    if (!(await this.start(cwd))) { this.busy = false; this.emit({ t: 'done', ms: Date.now() - this.t0 }); return false; }
    this.emit({ t: 'msg' });
    const r = await this.rpc('session/prompt', { sessionId: this.sid, prompt: [{ type: 'text', text: msg }] });
    this.busy = false;
    this.emit({ t: 'done', ms: Date.now() - this.t0, error: r.error ? friendly('gemini', r.error.message) : null, stopped: r.result?.stopReason === 'cancelled' });
    return true;
  }
  async stop() { if (this.busy && this.sid) { try { this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sid } }) + '\n'); } catch { /* */ } } }
  reset() { this.kill(); }
  kill() { if (this.p) { try { this.p.kill(); } catch { /* */ } } this.p = null; this.sid = null; }
}

// ── CODEX per message, resumed ──────────────────────────────────────────────────────────────────────────────────────────
export class CodexEngine {
  constructor(emit) { this.emit = emit; this.p = null; this.busy = false; this.started = new Set(); this.t0 = 0; }
  send(msg, cwd) {
    if (this.busy) { this.emit({ t: 'error', s: 'Still working on the last one. Press Stop, or wait a moment.' }); return false; }
    const bin = findBin('codex'); if (!bin) { this.emit({ t: 'error', s: 'Codex is not on this computer. Click Commands → Install Codex.' }); return false; }
    const c = desk(); this.busy = true; this.t0 = Date.now(); this.emit({ t: 'turn', s: msg });
    const mcp = c.token ? ['-c', `mcp_servers.on3.url="${base()}/mcp"`, '-c', 'mcp_servers.on3.bearer_token_env_var="ON3_TOKEN"'] : [];
    const common = ['--json', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'approval_policy="never"', ...mcp];
    const args = this.started.has(cwd) ? ['exec', 'resume', '--last', ...common, msg] : ['exec', ...common, msg];
    this.p = spawn(bin, args, { cwd, env: env(c.token ? { ON3_TOKEN: c.token } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; let failed = null; let errText = '';
    this.p.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); let j; try { j = JSON.parse(l); } catch { continue; }
      const it = j.item || {};
      if (j.type === 'thread.started') this.emit({ t: 'ready', model: 'Codex', tools: null, mcp: c.token ? ['0n3:connected'] : [] });
      else if (j.type === 'item.started' && it.type === 'command_execution') this.emit({ t: 'step', id: it.id, s: `$ ${short(it.command, 140)}` });
      else if (j.type === 'item.started' && it.type === 'mcp_tool_call') this.emit({ t: 'step', id: it.id, s: `${it.server === 'on3' ? '0n3' : it.server} · ${it.tool}` });
      else if (j.type === 'item.completed' && it.type === 'agent_message') { this.emit({ t: 'msg' }); this.emit({ t: 'text', s: it.text || '' }); }
      else if (j.type === 'item.completed' && (it.type === 'command_execution' || it.type === 'mcp_tool_call')) this.emit({ t: 'result', id: it.id, error: it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0) });
      else if (j.type === 'item.completed' && it.type === 'file_change') this.emit({ t: 'step', id: it.id, s: `Edit ${(it.changes || []).map((x) => String(x.path || '').replace(HOME, '~')).join(', ').slice(0, 140)}` });
      else if (j.type === 'item.completed' && it.type === 'web_search') this.emit({ t: 'step', id: it.id, s: `Search “${short(it.query, 90)}”` });
      else if (j.type === 'turn.failed' || j.type === 'error') failed = j.error?.message || j.message || 'Codex stopped with an error.';
    } });
    this.p.stderr.on('data', (d) => { errText += String(d); if (errText.length > 20000) errText = errText.slice(-20000); });
    this.p.on('close', (code) => {
      this.p = null; this.busy = false; if (code === 0 && !failed) this.started.add(cwd);
      const why = failed || (code !== 0 ? (errText.match(/ERROR[^\n]*/g) || []).pop() || `Codex exited with ${code}` : null);
      this.emit({ t: 'done', ms: Date.now() - this.t0, error: why ? friendly('codex', why) : null });
    });
    return true;
  }
  stop() { if (this.p) { try { this.p.kill(); } catch { /* */ } } }
  reset() { this.started.clear(); this.stop(); }
  kill() { this.stop(); }
}
