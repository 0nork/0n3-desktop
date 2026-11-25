// 0n3 desktop: the Terminal, the Commands shelf and the way back to Jobs. Talks to the main process only through
// window.on3term (preload.cjs). No network from this page (CSP connect-src 'none').
const T = window.on3term;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inl = (t) => t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
const home = (p, h) => String(p || '').replace(h || '', '~');
const MAC = navigator.platform.toLowerCase().includes('mac');

// ── click-to-run commands. kind: 'ai' = said to the terminal in plain English, 'sh' = a command run as-is ─────────────────
const CMDS = [
  ['Your computer', [
    ['Launch Chrome', 'Opens Google Chrome', 'sh', MAC ? 'open -a "Google Chrome"' : 'start chrome'],
    ['Open this folder', 'In Finder / Explorer', 'sh', MAC ? 'open .' : 'start .'],
    ['What is in this folder', 'A quick look', 'ai', 'Look at this folder and tell me in a few lines what is in it and what it is for.'],
    ['Free up space', 'Shows the plan first', 'ai', 'Find the biggest files and folders in my home folder that are safe to clean up. Show me a list with sizes. Do NOT delete anything.'],
    ['Is my Mac healthy?', 'Disk, memory, battery', 'ai', 'Check this computer: free disk space, memory pressure, battery health and anything unusual running. Short report.'],
    ['Install Claude Code', 'If it is missing', 'sh', 'npm install -g @anthropic-ai/claude-code && claude --version'],
  ]],
  ['Your AIs', [
    ['Install Codex', 'OpenAI\'s coding agent', 'sh', 'npm install -g @openai/codex && codex --version'],
    ['Sign in to Codex', 'Opens your browser', 'sh', 'codex login'],
    ['Install Gemini CLI', 'Google\'s agent', 'sh', 'npm install -g @google/gemini-cli && gemini --version'],
    ['Sign in to Gemini', 'Opens Gemini in Terminal', 'sh', MAC ? 'osascript -e \'tell application "Terminal" to do script "gemini"\' -e \'tell application "Terminal" to activate\'' : 'start cmd /k gemini'],
    ['Sign in to Claude', 'Opens Claude in Terminal', 'sh', MAC ? 'osascript -e \'tell application "Terminal" to do script "claude"\' -e \'tell application "Terminal" to activate\'' : 'start cmd /k claude'],
    ['Which AIs do I have?', 'Versions on this computer', 'sh', 'for b in claude codex gemini; do printf "%-8s" $b; ($b --version 2>/dev/null | head -1) || echo "not installed"; done'],
  ]],
  ['Your business (0n3 apps)', [
    ['Today\'s briefing', 'Leads, payments, calendar', 'ai', 'Use 0n3 to give me a short briefing for today from my connected apps: new CRM leads, payments, calendar and anything that needs me. Most important first.'],
    ['Newest leads', 'From your CRM', 'ai', 'Use 0n3 to list my 10 newest CRM contacts with name, email, source and when they came in.'],
    ['Sales this week', 'From Stripe', 'ai', 'Use 0n3 to summarize my Stripe payments for the last 7 days: total, count, biggest and any failed.'],
    ['Draft follow-ups', 'Nothing gets sent', 'ai', 'Use 0n3 to find leads from the last 14 days with no reply and draft a short follow-up for each. Do NOT send anything.'],
    ['My apps', 'What is connected', 'ai', 'Use 0n3 to list which apps I have connected, then suggest 3 jobs you could run for me right now.'],
  ]],
  ['Websites & code', [
    ['Check my websites', 'Up? Fast? Broken?', 'ai', 'Check my websites (ask me which if you do not know): are they up, how fast do they load, any broken links or errors? Plain answer.'],
    ['Find what is broken', 'In this folder', 'ai', 'This folder is a project. Find what is broken (build errors, failing tests, obvious bugs) and tell me before changing anything.'],
    ['Git status', 'What changed here', 'sh', 'git status -sb && git log --oneline -5'],
  ]],
  ['0n3 helper', [
    ['Check everything', 'The helper doctor', 'sh', '0n3-desk doctor || ~/.0n/bin/0n3-desk doctor'],
    ['Pair Chrome', 'Show the pairing code', 'ai', 'Read ~/.0n/desk.json and tell me only the Chrome pairing code (browse.code) and the steps: click the 0n extension, Desk browsing, type the code, On.'],
  ]],
];
const MINE_KEY = '0n3.mycmds';
const mine = () => { try { return JSON.parse(localStorage.getItem(MINE_KEY) || '[]'); } catch { return []; } };

function renderCmds() {
  const groups = [...CMDS, ...(mine().length ? [['Yours', mine().map((m) => [m.name, m.kind === 'sh' ? m.text : 'Plain English', m.kind, m.text, true])]] : [])];
  $('cmds').innerHTML = groups.map(([g, list]) => `<div class="grp"><h3>${esc(g)}</h3><div class="grid">${list.map(([n, s, k, q, own]) => `<button class="cmd${own ? ' mine' : ''}" data-k="${k}" data-q="${esc(q)}" title="${esc(q)}"><b>${esc(n)}</b><small>${esc(s)}</small></button>`).join('')}</div></div>`).join('')
    + `<div class="grp"><h3>Add your own</h3><div class="add"><input id="cn" placeholder="Name, e.g. Morning check"><input id="cq" placeholder="What it should do, or $ a command" style="flex:3"><button id="ca">Add</button></div></div>`;
  document.querySelectorAll('.cmd').forEach((b) => (b.onclick = () => { show('term'); run(b.dataset.k === 'sh' ? `$ ${b.dataset.q}` : b.dataset.q); }));
  $('ca').onclick = () => { const n = $('cn').value.trim(); const q = $('cq').value.trim(); if (!n || !q) return; const list = mine(); list.push({ name: n, kind: q.startsWith('$') ? 'sh' : 'ai', text: q.replace(/^\$\s*/, '') }); localStorage.setItem(MINE_KEY, JSON.stringify(list)); renderCmds(); renderQuick(); };
}
function renderQuick() {
  const all = CMDS.flatMap(([, l]) => l); const by = (n) => all.find((c) => c[0] === n);
  const q = [by('Launch Chrome'), by('Today\'s briefing'), by('My apps'), by('What is in this folder'), ...mine().slice(0, 2).map((m) => [m.name, '', m.kind, m.text])].filter(Boolean);
  $('quick').innerHTML = q.map(([n, , k, t]) => `<button data-k="${k}" data-q="${esc(t)}">${esc(n)}</button>`).join('');
  $('quick').querySelectorAll('button').forEach((b) => (b.onclick = () => run(b.dataset.k === 'sh' ? `$ ${b.dataset.q}` : b.dataset.q)));
}

// ── the transcript ────────────────────────────────────────────────────────────────────────────────────────────────────
const log = $('log'); let card = null; let tx = null; let raw = ''; let out = null; let homeDir = ''; const steps = {}; const hist = []; let hi = -1;
const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
const down = (force) => { if (force || atBottom()) log.scrollTop = log.scrollHeight; };
const clearEmpty = () => { const e = $('empty'); if (e) e.remove(); };
function bubble(text, cls) { clearEmpty(); const d = document.createElement('div'); d.className = cls; d.textContent = text; log.appendChild(d); down(true); }
function newCard() { card = document.createElement('div'); card.className = 'ai'; log.appendChild(card); tx = null; raw = ''; out = null; return card; }
function ensureText() { if (!tx) { tx = document.createElement('div'); tx.className = 'tx'; card.appendChild(tx); raw = ''; } return tx; }
function busy(on) { $('stop').disabled = !on; $('dot').className = `dot ${on ? 'busy' : 'on'}`; }

T.onEvent((o) => {
  const stick = atBottom();
  if (o.t === 'turn') { bubble(o.s, 'me'); newCard(); ensureText().innerHTML = '<span class="cursor"></span>'; busy(true); }
  else if (o.t === 'msg') { if (card && tx && raw) tx = null; }
  else if (o.t === 'text') { if (!card) newCard(); const t = ensureText(); raw += o.s; t.innerHTML = inl(esc(raw)) + '<span class="cursor"></span>'; }
  else if (o.t === 'step') { if (!card) newCard(); if (tx) { tx.innerHTML = inl(esc(raw)); tx = null; } const s = document.createElement('div'); s.className = 'step'; s.textContent = o.s; card.appendChild(s); steps[o.id] = s; }
  else if (o.t === 'result') { const s = steps[o.id]; if (s) { s.classList.add(o.error ? 'bad' : 'ok'); if (o.error && o.s) s.title = o.s; } }
  else if (o.t === 'done') { if (card) { if (tx) tx.innerHTML = inl(esc(raw)); card.querySelectorAll('.cursor').forEach((c) => c.remove()); const m = document.createElement('div'); m.className = 'meta'; m.textContent = `${o.stopped ? 'stopped' : 'done'} · ${(o.ms / 1000).toFixed(1)}s`; card.appendChild(m); if (o.error) { const e = document.createElement('div'); e.className = 'err'; e.textContent = o.error; card.appendChild(e); } } card = null; busy(false); }
  else if (o.t === 'shell') { bubble(`$ ${o.s}`, 'me cmd'); newCard(); out = document.createElement('pre'); out.className = 'out'; card.appendChild(out); busy(true); }
  else if (o.t === 'out') { if (!out) { newCard(); out = document.createElement('pre'); out.className = 'out'; card.appendChild(out); } out.textContent += o.s; out.scrollTop = out.scrollHeight; }
  else if (o.t === 'shelldone') { if (card) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = `exit ${o.code} · ${(o.ms / 1000).toFixed(1)}s`; card.appendChild(m); if (out && !out.textContent) out.textContent = '(no output)'; } card = null; out = null; busy(false); }
  else if (o.t === 'error') { if (!card) newCard(); const e = document.createElement('div'); e.className = 'err'; e.textContent = o.s; card.appendChild(e); }
  else if (o.t === 'engine') { /* the picker already shows it */ }
  else if (o.t === 'ready') { $('st').textContent = `live · ${o.model || 'Claude'}${o.tools ? ` · ${o.tools} tools` : ''}${(o.mcp || []).some((m) => /^0n3:connected/.test(m)) ? ' · 0n3 connected' : ''}`; $('dot').className = 'dot on'; }
  else if (o.t === 'cwd') { $('cwd').textContent = home(o.cwd, homeDir); }
  else if (o.t === 'reset') { log.innerHTML = '<div class="empty" id="empty"><b>New conversation.</b><br>Ask anything.</div>'; card = null; busy(false); }
  else if (o.t === 'exit') { if (!$('stop').disabled) busy(false); }
  down(stick);
});

let sending = false;
function run(text) {
  text = String(text || '').trim(); if (!text || sending) return;
  sending = true; setTimeout(() => { sending = false; }, 600);
  hist.unshift(text); hi = -1; T.send(text);
}
// ── attachments: whatever was dropped rides along with the next message as real paths the AI can open ─────────────────
let atts = [];
const GLYPH = { folder: '▣', image: '◩', file: '▤' };
const sizeOf = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);
function renderAtts() {
  const box = $('atts'); box.classList.toggle('on', atts.length > 0);
  box.innerHTML = atts.map((a, i) => `<span class="att" title="${esc(a.path)}"><i>${GLYPH[a.kind] || GLYPH.file}</i><span>${esc(a.name)}</span>${a.size != null ? `<small>${sizeOf(a.size)}</small>` : '<small>folder</small>'}<button type="button" data-i="${i}" title="Remove">×</button></span>`).join('');
  box.querySelectorAll('button').forEach((b) => (b.onclick = () => { atts.splice(Number(b.dataset.i), 1); renderAtts(); $('in').focus(); }));
}
/** The message the AI gets: the kind and the full path of each thing, then what the person typed. */
function withAtts(text) {
  if (!atts.length) return text;
  const list = atts.map((a) => `- ${a.kind}: ${a.path}${a.kind === 'folder' ? '/' : ''}`).join('\n');
  return `Attached (dropped into the app; open them from these paths):\n${list}\n\n${text.trim() || 'Look at what I attached and tell me what it is.'}`;
}
$('f').onsubmit = (e) => {
  e.preventDefault(); const v = $('in').value; const shell = v.trim().startsWith('$');
  if (!v.trim() && !atts.length) return;
  if (sending) return; // run() would drop it: keep the text and the attachments for the next press
  $('in').value = ''; grow();
  if (shell || !atts.length) { run(v); return; }
  run(withAtts(v)); atts = []; renderAtts();
};

// ── the drop screen ───────────────────────────────────────────────────────────────────────────────────────────────────
const drop = $('drop'); const plus = $('plus'); let depth = 0; let raf = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
const showDrop = (on) => { drop.classList.remove('out'); drop.classList.toggle('on', on); if (!on) { depth = 0; plus.style.setProperty('--rx', '0deg'); plus.style.setProperty('--ry', '0deg'); } };
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth += 1; showDrop(true); });
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  if (!drop.classList.contains('on')) showDrop(true);
  const x = e.clientX; const y = e.clientY;
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; plus.style.setProperty('--ry', `${((x / innerWidth) - 0.5) * 32}deg`); plus.style.setProperty('--rx', `${(0.5 - (y / innerHeight)) * 22}deg`); });
});
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth || e.relatedTarget === null) showDrop(false); });
window.addEventListener('dragend', () => showDrop(false));
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return; e.preventDefault();
  const paths = Array.from(e.dataTransfer.files || []).map((f) => T.pathFor(f)).filter(Boolean);
  showDrop(false); drop.classList.add('out'); // dropped: clear the screen quickly, the slow fade is only for arriving
  if (!paths.length) { bubble('That could not be attached: it has no location on this computer (drag it from Finder or your desktop).', 'err'); return; }
  const got = await T.attach(paths);
  for (const a of got || []) if (!atts.some((x) => x.path === a.path)) atts.push(a);
  if ((got || []).length < paths.length) bubble(`${paths.length - (got || []).length} of ${paths.length} could not be read and were left out.`, 'err');
  show('term'); renderAtts(); $('in').focus();
});
const grow = () => { const t = $('in'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 180)}px`; };
$('in').addEventListener('input', grow);
$('in').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('f').requestSubmit(); }
  else if (e.key === 'ArrowUp' && !$('in').value.includes('\n') && hist.length) { e.preventDefault(); hi = Math.min(hi + 1, hist.length - 1); $('in').value = hist[hi]; }
  else if (e.key === 'ArrowDown' && hi >= 0) { e.preventDefault(); hi -= 1; $('in').value = hi >= 0 ? hist[hi] : ''; }
  else if (e.key === 'c' && e.ctrlKey) T.stop();
});
$('stop').onclick = () => T.stop();
$('new').onclick = () => T.reset();
$('cwd').onclick = async () => { const i = await T.pickFolder(); if (i?.cwd) $('cwd').textContent = home(i.cwd, homeDir); };
$('hide').onclick = () => T.hide();

// ── tabs ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function show(p) {
  if (p === 'jobs') { T.openJobs(); return; }
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.p === p));
  document.querySelectorAll('.pane').forEach((x) => x.classList.toggle('on', x.id === `p-${p}`));
  if (p === 'term') $('in').focus();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => show(t.dataset.p)));

const ENG = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
function renderEng(i) {
  $('eng').innerHTML = Object.keys(ENG).map((k) => `<button data-e="${k}" class="${i.engine === k ? 'on' : ''} ${i.installed?.[k] ? '' : 'off'}" title="${i.installed?.[k] ? `Talk to ${ENG[k]}` : `${ENG[k]} is not installed: see Commands → Your AIs`}">${ENG[k]}</button>`).join('');
  $('eng').querySelectorAll('button').forEach((b) => (b.onclick = async () => { const k = b.dataset.e; if (!i.installed?.[k]) { show('cmds'); return; } try { localStorage.setItem('0n3.engine', k); } catch (e) { /* */ } const n = await T.setEngine(k); renderEng(n); $('st').textContent = `${ENG[k]} · ready`; }));
}
(async () => {
  let i = await T.info(); homeDir = i.home || '';
  const savedEng = (() => { try { return localStorage.getItem('0n3.engine'); } catch (e) { return null; } })();
  if (savedEng && savedEng !== i.engine && i.installed?.[savedEng]) i = await T.setEngine(savedEng);
  renderEng(i);
  $('cwd').textContent = home(i.cwd, homeDir);
  $('st').textContent = !i.installed?.[i.engine] ? `${ENG[i.engine]} is not installed: see Commands` : !i.signedIn ? 'Ready (sign in to 0n3 to use your apps)' : 'Ready';
  $('dot').className = `dot ${i.installed?.[i.engine] ? 'on' : ''}`;
  renderCmds(); renderQuick(); $('in').focus();
})();
