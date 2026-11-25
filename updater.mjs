/**
 * UPDATE NOW (0.7.0, 2026-11-25). Mike: "When an update is available for THIS APP that I'm using, how can we have an
 * 'update now' button show up?"
 *
 * The app is not code-signed yet, so the built-in updater (Squirrel on a Mac) refuses it. This does the same job plainly:
 *   check()     GitHub's "latest release" for 0nork/0n3-desktop, compared with the version that is running
 *   download()  the right file for this computer, streamed to a temp folder with progress
 *   install()   Mac: unpack the new app next to the old one, then a tiny script waits for this app to quit, swaps the two
 *               (the old one is kept until the new one is in place, and put back if the swap fails) and opens the new one.
 *               Windows: run the downloaded installer, which replaces the app and reopens it.
 * A file fetched by this app, not by a browser, carries no quarantine mark, so the unsigned app opens without the
 * "right-click → Open" step. When the app cannot replace itself (run from the disk image, or from a folder it may not
 * write to) it says so and opens the download page instead of pretending.
 *
 * Everything that decides something is a pure function here, tested in test/updater.test.mjs.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, accessSync, constants, rmSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import os from 'node:os';

export const REPO = '0nork/0n3-desktop';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** "0.10.0" is newer than "0.9.3"; a leading v and anything after the three numbers are ignored. */
export function newer(a, b) {
  const p = (v) => String(v || '').replace(/^v/i, '').split(/[.\-+]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = p(a); const y = p(b);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}

/** The file this computer installs from. Mac takes the .zip (the app itself); Windows the installer. */
export function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return `0n3-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
  if (platform === 'win32') return '0n3-win-x64.exe';
  return null;
}
export function pickAsset(release, platform = process.platform, arch = process.arch) {
  const want = assetName(platform, arch); if (!want) return null;
  const a = (release?.assets || []).find((x) => x.name === want);
  return a ? { name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 } : null;
}

/** What the button needs: is there a newer version, what is it called, and can this computer take it by itself. */
export async function check({ current, fetchImpl = fetch, platform = process.platform, arch = process.arch } = {}) {
  let r;
  try { r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': '0n3-desktop' }, signal: AbortSignal.timeout(8000) }); }
  catch (e) { return { available: false, current, error: `Could not reach the update server: ${e.message}` }; }
  if (!r.ok) return { available: false, current, error: `The update server answered ${r.status}.` };
  const rel = await r.json().catch(() => null);
  const version = String(rel?.tag_name || '').replace(/^v/i, '');
  if (!version) return { available: false, current, error: 'The update server sent no version.' };
  if (rel.draft || rel.prerelease || !newer(version, current)) return { available: false, current, latest: version };
  const asset = pickAsset(rel, platform, arch);
  return { available: true, current, version, title: String(rel.name || `0n3 ${version}`).slice(0, 120), notes: String(rel.body || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' ').slice(0, 320), asset, page: rel.html_url || RELEASES_PAGE };
}

/** Where the running app lives, and whether this app may replace it. `exe` = process.execPath. */
export function installTarget(exe = process.execPath, platform = process.platform) {
  if (platform === 'win32') return { ok: true, kind: 'win' };
  if (platform !== 'darwin') return { ok: false, why: 'Updating by itself works on Mac and Windows. Download the new version from the releases page.' };
  const bundle = dirname(dirname(dirname(exe))); // …/0n3.app/Contents/MacOS/0n3
  if (!/\.app$/i.test(bundle)) return { ok: false, why: 'This copy is not running from an installed app.' };
  if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return { ok: false, why: 'This copy is running from the download, not from Applications. Drag 0n3 into Applications, open it from there, then update.' };
  try { accessSync(dirname(bundle), constants.W_OK); accessSync(bundle, constants.W_OK); } catch { return { ok: false, why: `0n3 may not change ${dirname(bundle)} on this computer. Download the new version and drag it in.` }; }
  return { ok: true, kind: 'mac', bundle };
}

/** Stream the file to disk. onProgress({ got, total, pct }) is called as it arrives. */
export async function download(asset, dir, onProgress = () => {}, fetchImpl = fetch) {
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, asset.name);
  const r = await fetchImpl(asset.url, { headers: { 'user-agent': '0n3-desktop' }, redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`The download answered ${r.status}.`);
  const total = Number(r.headers.get('content-length')) || asset.size || 0; let got = 0; let last = -1;
  const out = createWriteStream(dest);
  try {
    for await (const chunk of r.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
      const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : 0;
      if (pct !== last) { last = pct; onProgress({ got, total, pct }); }
    }
  } finally { await new Promise((ok) => out.end(ok)); }
  if (total && got !== total) throw new Error(`The download stopped early (${got} of ${total} bytes).`);
  if (got < 1_000_000) throw new Error('The download is too small to be the app.');
  return dest;
}

const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => (e ? no(new Error(String(se || e.message).trim().split('\n').slice(-2).join(' '))) : ok(String(so)))));

/** The version inside an unpacked Mac app (Info.plist), so a wrong or half-unpacked download is never swapped in. */
export function bundleVersion(bundle) {
  try { const x = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8'); return (/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(x) || [])[1] || null; } catch { return null; }
}

/**
 * The swap script (Mac). Kept as text so the test can run it against two throwaway folders. It never deletes the old app
 * before the new one is in its place: old → "<app>.old", new → "<app>", and on any failure the old one is moved back.
 */
export function swapScript({ pid, bundle, fresh, log, open = true }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# 0n3 update: wait for the app to quit, swap in the new one, open it.
APP=${q(bundle)}; NEW=${q(fresh)}; LOG=${q(log)}; OLD="$APP.old"
say() { echo "$(date -u +%FT%TZ) update: $1" >> "$LOG"; }
i=0; while kill -0 ${Number(pid) || 0} 2>/dev/null && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done
[ -d "$NEW/Contents" ] || { say "the new app is missing; nothing changed"; ${open ? 'open "$APP"; ' : ''}exit 1; }
rm -rf "$OLD"
mv "$APP" "$OLD" || { say "could not move the old app aside; nothing changed"; ${open ? 'open "$APP"; ' : ''}exit 1; }
if mv "$NEW" "$APP"; then
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null
  rm -rf "$OLD"; say "installed"
else
  mv "$OLD" "$APP"; say "could not move the new app in; the old one was put back"; ${open ? 'open "$APP"; ' : ''}exit 1
fi
${open ? 'open "$APP"' : ':'}
`;
}

/**
 * Install what was downloaded, then the caller quits the app. Returns { ok, restart } or throws with the reason.
 * `quit` is called last, once the swap script (Mac) or the installer (Windows) is already running on its own.
 */
export async function install({ file, version, target, pid = process.pid, log = join(os.homedir(), '.0n', 'desk', 'app.log'), tmp = dirname(file) }) {
  if (target.kind === 'win') { spawn(file, [], { detached: true, stdio: 'ignore' }).unref(); return { ok: true, restart: 'installer' }; }
  const stage = join(tmp, 'unpacked'); rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
  await run('/usr/bin/ditto', ['-x', '-k', file, stage]); // ditto keeps the app's symlinks and permissions; unzip does not
  const fresh = join(stage, basename(target.bundle));
  const alt = existsSync(fresh) ? fresh : join(stage, '0n3.app');
  const got = bundleVersion(alt);
  if (!got) throw new Error('The download did not unpack into an app.');
  if (version && got !== version) throw new Error(`The download is version ${got}, not ${version}. Nothing was changed.`);
  const script = join(tmp, 'swap.sh'); writeFileSync(script, swapScript({ pid, bundle: target.bundle, fresh: alt, log })); chmodSync(script, 0o755);
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, restart: 'swap' };
}
