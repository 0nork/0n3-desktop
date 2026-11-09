// Runs the 0n3 desk agent (package 0nmcp, desk-agent.js) under this app's own Node (ELECTRON_RUN_AS_NODE=1).
// Exit 3 = this computer is not signed in yet; the app waits for the chat to hand it a token.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const pkg = process.env.ON3_DESK_PKG; const bin = process.env.ON3_DESK_BIN || '0n3';
if (!pkg) { console.error('ON3_DESK_PKG is not set'); process.exit(2); }
const { loadConfig, loop } = await import(pathToFileURL(join(pkg, 'desk-agent.js')).href);
const cfg = loadConfig();
if (!cfg?.token) { console.log('not signed in'); process.exit(3); }
if (process.env.ON3_URL) cfg.url = process.env.ON3_URL;
await loop(cfg, { everyMs: 10_000, bin });
