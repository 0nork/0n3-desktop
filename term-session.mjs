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

const HOME = os.homedir();
const WIN = process.platform === 'win32';
export const WORKSPACE = join(HOME, '.0n', 'desk', 'workspace');
const MCP_FILE = join(HOME, '.0n', 'desk', 'terminal-mcp.json');
const EXTRA_PATH = [join(HOME, '.0n', 'bin'), join(HOME, '.local', 'bin'), join(HOME, '.claude', 'local'), join(HOME, '.npm-global', 'bin'), join(HOME, '.0n', 'ai', 'node_modules', '.bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const env = () => ({ ...process.env, PATH: [...EXTRA_PATH, process.env.PATH || ''].join(WIN ? ';' : ':'), ON3_TERMINAL: '1' });

export function findClaude() {
  for (const d of EXTRA_PATH) { const p = join(d, WIN ? 'claude.cmd' : 'claude'); if (existsSync(p)) return p; }
  return null;
}
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
  constructor(emit) { this.emit = emit; this.p = null; this.cwd = WORKSPACE; this.started = false; this.busy = false; this.buf = ''; this.t0 = 0; this.blocks = {}; this.sh = null; }
  info() { return { claude: !!findClaude(), cwd: this.cwd, busy: this.busy || !!this.sh, live: !!this.p, signedIn: !!desk().token, home: HOME }; }
  setCwd(dir) { if (!dir || !existsSync(dir)) return this.info(); if (dir !== this.cwd) { this.kill(); this.started = false; this.cwd = dir; this.emit({ t: 'cwd', cwd: dir }); } return this.info(); }

  start() {
    if (this.p) return true;
    const bin = findClaude();
    if (!bin) { this.emit({ t: 'error', s: 'Claude Code is not on this computer yet. Click "Install Claude Code" in Commands, or run: npm install -g @anthropic-ai/claude-code' }); return false; }
    mkdirSync(this.cwd, { recursive: true });
    const mcp = mcpFile();
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'bypassPermissions', ...(mcp ? ['--mcp-config', mcp, '--strict-mcp-config'] : []), ...(this.started ? ['--continue'] : [])];
    this.p = spawn(bin, args, { cwd: this.cwd, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (j.type === 'result') { this.busy = false; this.emit({ t: 'done', ms: Date.now() - this.t0, cost: j.total_cost_usd ?? null, error: j.is_error ? short(j.result, 300) : null }); }
  }
  send(text) {
    const msg = String(text || '').trim(); if (!msg) return false;
    if (msg.startsWith('$')) return this.shell(msg.replace(/^\$\s*/, ''));
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
    this.sh = spawn(sh, WIN ? ['/d', '/s', '/c', cmd] : ['-lc', cmd], { cwd: this.cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.sh.stdout.on('data', (d) => this.emit({ t: 'out', s: String(d) }));
    this.sh.stderr.on('data', (d) => this.emit({ t: 'out', s: String(d) }));
    this.sh.on('error', (e) => this.emit({ t: 'error', s: e.message }));
    this.sh.on('close', (code) => { this.sh = null; this.emit({ t: 'shelldone', code, ms: Date.now() - t0 }); });
    return true;
  }
  stop() { if (this.sh) { try { this.sh.kill(); } catch { /* */ } } if (this.busy) this.kill(); return true; }
  reset() { this.kill(); this.started = false; this.emit({ t: 'reset' }); return true; }
  kill() { if (this.p) { try { this.p.kill(); } catch { /* */ } this.p = null; } }
}
