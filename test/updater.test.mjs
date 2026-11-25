import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newer, assetName, pickAsset, check, installTarget, swapScript, bundleVersion } from '../updater.mjs';

const REL = { tag_name: 'v0.7.0', name: '0n3 0.7.0 — update now', body: 'An Update now button.\n\nA start screen.', html_url: 'https://github.com/0nork/0n3-desktop/releases/tag/v0.7.0',
  assets: ['0n3-mac-arm64.dmg', '0n3-mac-arm64.zip', '0n3-mac-x64.zip', '0n3-win-x64.exe'].map((name) => ({ name, size: 100_000_000, browser_download_url: `https://example.test/${name}` })) };
const feed = (rel, status = 200) => async () => ({ ok: status === 200, status, json: async () => rel });

test('versions compare as numbers, not text', () => {
  assert.equal(newer('0.10.0', '0.9.3'), true); assert.equal(newer('v0.7.0', '0.6.0'), true); assert.equal(newer('1.0.0', '0.99.99'), true);
  assert.equal(newer('0.6.0', '0.6.0'), false); assert.equal(newer('0.5.9', '0.6.0'), false); assert.equal(newer('', '0.6.0'), false);
});

test('each computer gets its own file', () => {
  assert.equal(assetName('darwin', 'arm64'), '0n3-mac-arm64.zip'); assert.equal(assetName('darwin', 'x64'), '0n3-mac-x64.zip'); assert.equal(assetName('win32', 'x64'), '0n3-win-x64.exe'); assert.equal(assetName('linux', 'x64'), null);
  assert.equal(pickAsset(REL, 'darwin', 'arm64').url, 'https://example.test/0n3-mac-arm64.zip');
  assert.equal(pickAsset({ assets: [] }, 'darwin', 'arm64'), null);
});

test('a newer release turns the button on; the same or an older one does not', async () => {
  const up = await check({ current: '0.6.0', fetchImpl: feed(REL), platform: 'darwin', arch: 'arm64' });
  assert.equal(up.available, true); assert.equal(up.version, '0.7.0'); assert.equal(up.asset.name, '0n3-mac-arm64.zip'); assert.match(up.notes, /Update now button/);
  assert.equal((await check({ current: '0.7.0', fetchImpl: feed(REL) })).available, false);
  assert.equal((await check({ current: '0.8.0', fetchImpl: feed(REL) })).available, false);
  assert.equal((await check({ current: '0.6.0', fetchImpl: feed({ ...REL, prerelease: true }) })).available, false);
});

test('no network or a refusal is reported, never shown as "up to date"', async () => {
  const off = await check({ current: '0.6.0', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(off.available, false); assert.match(off.error, /offline/);
  assert.match((await check({ current: '0.6.0', fetchImpl: feed({}, 403) })).error, /403/);
});

test('the app only replaces itself where it safely can', () => {
  assert.match(installTarget('/Volumes/0n3/0n3.app/Contents/MacOS/0n3', 'darwin').why, /Applications/);
  assert.match(installTarget('/private/var/folders/x/AppTranslocation/ABC/d/0n3.app/Contents/MacOS/0n3', 'darwin').why, /Applications/);
  assert.equal(installTarget('/usr/local/bin/node', 'darwin').ok, false);
  assert.equal(installTarget('C:\\Program Files\\0n3\\0n3.exe', 'win32').kind, 'win');
  const dir = mkdtempSync(join(tmpdir(), 'upd-')); mkdirSync(join(dir, '0n3.app', 'Contents', 'MacOS'), { recursive: true });
  const t = installTarget(join(dir, '0n3.app', 'Contents', 'MacOS', '0n3'), 'darwin');
  assert.equal(t.ok, true); assert.equal(t.bundle, join(dir, '0n3.app'));
});

const fakeApp = (dir, name, version) => { const b = join(dir, name); mkdirSync(join(b, 'Contents', 'MacOS'), { recursive: true }); writeFileSync(join(b, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>`); writeFileSync(join(b, 'Contents', 'MacOS', '0n3'), version); return b; };

test('the swap puts the new app in place and removes the old one', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-')); const apps = join(dir, 'Applications'); const stage = join(dir, 'stage'); mkdirSync(apps); mkdirSync(stage);
  const bundle = fakeApp(apps, '0n3.app', '0.6.0'); const fresh = fakeApp(stage, '0n3.app', '0.7.0'); const log = join(dir, 'app.log');
  const script = join(dir, 'swap.sh'); writeFileSync(script, swapScript({ pid: 999999, bundle, fresh, log, open: false }));
  execFileSync('/bin/sh', [script]);
  assert.equal(bundleVersion(bundle), '0.7.0'); assert.equal(existsSync(`${bundle}.old`), false); assert.equal(existsSync(fresh), false);
  assert.match(readFileSync(log, 'utf8'), /update: installed/);
});

test('a missing download changes nothing: the old app is still there', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-')); const apps = join(dir, 'Applications'); mkdirSync(apps);
  const bundle = fakeApp(apps, '0n3.app', '0.6.0'); const log = join(dir, 'app.log');
  const script = join(dir, 'swap.sh'); writeFileSync(script, swapScript({ pid: 999999, bundle, fresh: join(dir, 'nope', '0n3.app'), log, open: false }));
  assert.throws(() => execFileSync('/bin/sh', [script], { stdio: 'ignore' }));
  assert.equal(bundleVersion(bundle), '0.6.0'); assert.match(readFileSync(log, 'utf8'), /nothing changed/);
});

test('a folder name with spaces and a quote survives the script', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sw ap's-")); const apps = join(dir, 'My Apps'); const stage = join(dir, 'st age'); mkdirSync(apps); mkdirSync(stage);
  const bundle = fakeApp(apps, '0n3.app', '0.6.0'); const fresh = fakeApp(stage, '0n3.app', '0.7.0');
  const script = join(dir, 'swap.sh'); writeFileSync(script, swapScript({ pid: 999999, bundle, fresh, log: join(dir, 'l.log'), open: false }));
  execFileSync('/bin/sh', [script]); assert.equal(bundleVersion(bundle), '0.7.0');
});
