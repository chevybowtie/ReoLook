import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnvFile, loadCredentials } from '../src/credentials.mjs';
import { findBrowser, appArgs, isUp, ensureServer, managedByService, BROWSERS } from '../src/launcher.mjs';

test('parseEnvFile handles comments, quotes, export and junk lines', () => {
  const v = parseEnvFile('# c\n\nREOLINK_USER=observer\nexport REOLINK_PASS="p w=d"\nBAD LINE\nQ=\'x\'\nEMPTY=\n');
  assert.deepEqual(v, { REOLINK_USER: 'observer', REOLINK_PASS: 'p w=d', Q: 'x', EMPTY: '' });
});

test('credentials: environment wins, then a 0600 env file, absent file is not an error', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cred-'));
  const f = path.join(d, 'env');
  assert.deepEqual(await loadCredentials({ env: { REOLINK_USER: 'a', REOLINK_PASS: 'b' }, file: f }), { user: 'a', password: 'b', source: 'environment' });
  assert.deepEqual(await loadCredentials({ env: {}, file: f }), { user: null, password: null, source: null });
  writeFileSync(f, 'REOLINK_USER=u\nREOLINK_PASS=p\n'); chmodSync(f, 0o600);
  const c = await loadCredentials({ env: {}, file: f });
  assert.equal(c.user, 'u'); assert.equal(c.password, 'p'); assert.equal(c.source, f);
  rmSync(d, { recursive: true, force: true });
});

test('credentials: an env file readable by others is refused, never read', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cred-'));
  const f = path.join(d, 'env');
  writeFileSync(f, 'REOLINK_USER=u\nREOLINK_PASS=p\n'); chmodSync(f, 0o644);
  await assert.rejects(() => loadCredentials({ env: {}, file: f }), /chmod 600/);
  rmSync(d, { recursive: true, force: true });
});

test('findBrowser prefers the requested command, else the first known one', async () => {
  const have = new Set(['chromium', 'google-chrome']);
  const whichFn = async (c) => (have.has(c) ? `/usr/bin/${c}` : null);
  assert.equal(await findBrowser({ whichFn }), '/usr/bin/chromium');
  assert.equal(await findBrowser({ preferred: 'google-chrome', whichFn }), '/usr/bin/google-chrome');
  assert.equal(await findBrowser({ preferred: 'firefox', whichFn }), null, 'a preferred browser that is missing does not silently fall back');
  assert.equal(await findBrowser({ whichFn: async () => null }), null);
  assert.ok(BROWSERS[0].includes('brave'));
});

test('app-mode arguments open the URL without tabs', () => {
  assert.deepEqual(appArgs('http://127.0.0.1:8787/'), ['--app=http://127.0.0.1:8787/', '--class=ReoLook', '--name=ReoLook']);
});

function listen(handler) {
  const s = http.createServer(handler);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

test('isUp is true only for a ReoLook-shaped answer', async () => {
  const good = await listen((q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"cameras":[],"hasRoot":false}'); });
  const other = await listen((q, r) => { r.end('<html>some other app</html>'); });
  const err = await listen((q, r) => { r.statusCode = 500; r.end('{}'); });
  assert.equal(await isUp(good.address().port), true);
  assert.equal(await isUp(other.address().port), false);
  assert.equal(await isUp(err.address().port), false);
  assert.equal(await isUp(1), false, 'nothing listening');
  for (const s of [good, other, err]) s.close();
});

test('ensureServer does not start a second server when one is up', async () => {
  let started = 0;
  const r = await ensureServer({ port: 1, up: async () => true, start: async () => { started++; } });
  assert.equal(r, 'already-running'); assert.equal(started, 0);
});

test('ensureServer starts it once and waits until it answers', async () => {
  let started = 0, ready = false, polls = 0;
  const r = await ensureServer({ port: 1, intervalMs: 5, timeoutMs: 2000,
    up: async () => { polls++; return ready; },
    start: async () => { started++; setTimeout(() => { ready = true; }, 40); } });
  assert.equal(r, 'started'); assert.equal(started, 1); assert.ok(polls > 2);
});

test('ensureServer gives a clear error when the server never comes up', async () => {
  await assert.rejects(() => ensureServer({ port: 8787, intervalMs: 5, timeoutMs: 60, up: async () => false, start: async () => {} }),
    /did not answer on port 8787/);
});

test('managedByService: active or starting means wait, anything else means start our own', async () => {
  for (const active of ['active', 'activating', 'reloading']) assert.equal(await managedByService(async () => ({ active })), true, active);
  for (const active of ['inactive', 'failed', 'unknown', 'deactivating']) assert.equal(await managedByService(async () => ({ active })), false, active);
  assert.equal(await managedByService(async () => { throw new Error('no systemd'); }), false);
});
