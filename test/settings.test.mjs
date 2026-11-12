import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { checkPatch, mergePatch, saveSettings, SettingsError } from '../src/settings.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createServer } from '../src/server.mjs';
import { createSystem } from '../src/system.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'set-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rejects = (fn, re) => assert.rejects(fn, (e) => e instanceof SettingsError && re.test(e.message));

test('checkPatch rejects unknown keys, wrong types and relative paths', () => {
  assert.doesNotThrow(() => checkPatch({ record: { enabled: true, mode: 'continuous' }, retention: { maxAgeDays: 30, apply: false }, exportDir: '/home/u/x' }));
  for (const [patch, re] of [
    [{ port: 1 }, /unknown setting "port"/],
    [{ record: { bogus: 1 } }, /unknown setting "record.bogus"/],
    [{ record: { enabled: 'yes' } }, /true or false/],
    [{ record: { mode: 'always' } }, /motion/],
    [{ record: { postRollSec: 0 } }, /at least 1/],
    [{ retention: { maxAgeDays: -3 } }, /at least 0/],
    [{ retention: { apply: 1 } }, /true or false/],
    [{ root: 'relative/path' }, /absolute/],
    [{ exportDir: 5 }, /absolute/],
    [null, /object/], [[], /object/],
  ]) assert.throws(() => checkPatch(patch), re, JSON.stringify(patch));
});

test('mergePatch keeps unrelated keys, merges sections, and null clears an optional value', () => {
  const raw = { root: '/r', cameras: [{ name: 'A', host: '1.1.1.1' }], record: { enabled: true, stream: 'main', requireMount: '/mnt/v' }, extra: 1 };
  const next = mergePatch(raw, { record: { stream: 'sub', requireMount: null }, retention: { maxAgeDays: 30 }, exportDir: '/x' });
  assert.deepEqual(next.record, { enabled: true, stream: 'sub' });
  assert.deepEqual(next.retention, { maxAgeDays: 30 });
  assert.equal(next.extra, 1); assert.equal(next.exportDir, '/x');
  assert.deepEqual(raw.record, { enabled: true, stream: 'main', requireMount: '/mnt/v' }, 'input untouched');
});

test('saveSettings validates against the whole config, writes additively, and backs up once', async () => {
  const d = tmp(), lib = path.join(d, 'lib'); mkdirSync(lib);
  const f = path.join(d, 'config.json');
  writeFileSync(f, JSON.stringify({ root: lib, cameras: [{ name: 'Cam', host: '1.1.1.1' }], port: 9 }));
  const r = await saveSettings(f, { record: { enabled: true, mode: 'continuous' }, retention: { minFreeGB: 100 } });
  assert.equal(r.config.record.mode, 'continuous');
  const saved = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(saved.port, 9); assert.equal(saved.cameras[0].name, 'Cam'); assert.equal(saved.retention.minFreeGB, 100);
  const first = readFileSync(f + '.bak', 'utf8');
  await saveSettings(f, { retention: { minFreeGB: 50 } });
  assert.equal(readFileSync(f + '.bak', 'utf8'), first, 'backup is the pre-change original, kept once');
  rmSync(d, { recursive: true, force: true });
});

test('saveSettings refuses: missing root, export/snapshot inside the library, recording without a root, unknown device', async () => {
  const d = tmp(), lib = path.join(d, 'lib'); mkdirSync(lib);
  const f = path.join(d, 'config.json');
  writeFileSync(f, JSON.stringify({ root: lib, cameras: [{ name: 'Cam', host: '1.1.1.1' }] }));
  await rejects(() => saveSettings(f, { root: path.join(d, 'nope') }), /does not exist/);
  await rejects(() => saveSettings(f, { exportDir: path.join(lib, 'exports') }), /outside the recordings library/);
  await rejects(() => saveSettings(f, { snapshotDir: lib }), /outside the recordings library/);
  await rejects(() => saveSettings(f, { record: { cameras: ['ghost'] } }), /unknown camera "ghost"/);
  const f2 = path.join(d, 'noroot.json'); writeFileSync(f2, JSON.stringify({ cameras: [] }));
  await rejects(() => saveSettings(f2, { record: { enabled: true } }), /choose a recordings folder/);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).exportDir, undefined, 'nothing written for refused changes');
  rmSync(d, { recursive: true, force: true });
});

test('concurrent saves do not lose each other', async () => {
  const d = tmp(), f = path.join(d, 'config.json');
  writeFileSync(f, JSON.stringify({ cameras: [] }));
  await Promise.all([
    saveSettings(f, { retention: { maxAgeDays: 10 } }),
    saveSettings(f, { retention: { maxSizeGB: 500 } }),
    saveSettings(f, { exportDir: '/x/exports' }),
  ]);
  const s = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(s.retention.maxAgeDays, 10); assert.equal(s.retention.maxSizeGB, 500); assert.equal(s.exportDir, '/x/exports');
  rmSync(d, { recursive: true, force: true });
});

test('runtime.reload stops the old recorders before starting new ones, and queues overlapping reloads', async () => {
  const events = [];
  let n = 0;
  const config = normalize({ root: '/r', cameras: [{ name: 'A', host: '1.1.1.1' }], record: { enabled: true } });
  const rt = createRuntime({ config, user: 'u', password: 'p', log: () => {},
    makeRecorders: () => { const id = ++n; events.push(`start-${id}`); return { status: () => [], stop: async () => { await sleep(15); events.push(`stop-${id}`); } }; },
    makeRetention: () => ({ status: () => ({ configured: false }), stop: () => events.push('retention-stop') }) });
  rt.start();
  await Promise.all([rt.reload(), rt.reload()]);
  assert.deepEqual(events, ['start-1', 'retention-stop', 'stop-1', 'start-2', 'retention-stop', 'stop-2', 'start-3']);
  config.record.enabled = false;
  await rt.reload();
  assert.equal(rt.status().recording.enabled, false, 'recording off after disabling');
  await rt.stop();
});

function fakeCamera() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), cmd = u.searchParams.get('cmd');
    if (cmd === 'Snap') { res.setHeader('content-type', 'image/jpeg'); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ cmd, code: 0, value: cmd === 'Login' ? { Token: { name: 't' } } : { DevInfo: { name: 'X', model: 'M' } } }]));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function app({ camera = null, runtime = null, system = null } = {}) {
  const dir = tmp(), lib = path.join(dir, 'lib'); mkdirSync(path.join(lib, '10102026'), { recursive: true });
  writeFileSync(path.join(lib, '10102026', 'Cam-00-010000-010100.mp4'), Buffer.alloc(2048));
  const configPath = path.join(dir, 'config.json');
  const cameras = camera ? [{ name: 'Cam', host: `127.0.0.1:${camera.address().port}` }] : [];
  writeFileSync(configPath, JSON.stringify({ root: lib, cameras }));
  const config = normalize({ root: lib, cameras });
  const server = createServer({ config, configPath, user: 'u', password: 'p', runtime, system: system ?? createSystem({ exec: async () => ({ stdout: 'no\n' }) }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, p, body, headers = { origin: base }) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { dir, lib, base, config, configPath, send, close: async () => { await server.drainJobs(); await server.stopManual(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('GET/PUT /api/settings: applies in memory, persists, reloads the runtime, and refuses cross-origin and bad input', async () => {
  let reloads = 0;
  const a = await app({ runtime: { reload: async () => { reloads++; }, status: () => ({ recording: { enabled: false, cameras: [] }, retention: {} }) } });
  const exportDir = path.join(a.dir, 'out');
  const r = await a.send('PUT', '/api/settings', { exportDir, retention: { maxAgeDays: 45 }, record: { mode: 'continuous' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.exportDir, exportDir); assert.equal(body.retention.maxAgeDays, 45); assert.equal(body.record.mode, 'continuous');
  assert.equal(reloads, 1);
  assert.equal(JSON.parse(readFileSync(a.configPath, 'utf8')).retention.maxAgeDays, 45);
  assert.equal((await (await fetch(a.base + '/api/jobs')).json()).exportDir, exportDir, 'running server uses it immediately');
  assert.equal((await a.send('PUT', '/api/settings', { port: 1 })).status, 400);
  assert.equal((await a.send('PUT', '/api/settings', { exportDir: path.join(a.lib, 'x') })).status, 400);
  assert.equal((await a.send('PUT', '/api/settings', { exportDir: '/tmp/z' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await a.send('PUT', '/api/settings', { exportDir: '/tmp/z' }, {})).status, 403);
  assert.equal(reloads, 1, 'refused changes do not reload');
  await a.close();
});

test('changing the recordings folder is refused while a manual recording runs', async () => {
  const cam = await fakeCamera();
  const a = await app({ camera: cam });
  const other = path.join(a.dir, 'other'); mkdirSync(other);
  const start = await a.send('POST', '/api/record/cam');
  assert.equal(start.status, 201, JSON.stringify(await start.clone().json()));
  const r = await a.send('PUT', '/api/settings', { root: other });
  assert.equal(r.status, 409);
  await a.send('DELETE', '/api/record/cam');
  assert.equal((await a.send('PUT', '/api/settings', { root: other })).status, 200);
  assert.equal((await (await fetch(a.base + '/api/config')).json()).hasRoot, true);
  await a.close(); cam.close();
});

test('GET /api/storage reports space and library size; low flag follows retention.minFreeGB', async () => {
  const a = await app();
  const s = await (await fetch(a.base + '/api/storage')).json();
  assert.equal(s.root, a.lib);
  assert.ok(s.total > 0 && s.free > 0 && s.free <= s.total);
  assert.equal(s.library.clips, 1); assert.equal(s.library.bytes, 2048);
  assert.equal(s.low, false);
  await a.send('PUT', '/api/settings', { retention: { minFreeGB: 1e9 } });
  assert.equal((await (await fetch(a.base + '/api/storage?refresh=1')).json()).low, true);
  await a.close();
});

test('retention preview reports what a rule would remove and never deletes', async () => {
  const a = await app();
  const p = await (await fetch(`${a.base}/api/retention/preview?maxSizeGB=0`)).json();
  assert.equal(p.total, 1);
  assert.equal((await fetch(`${a.base}/api/retention/preview?maxAgeDays=abc`)).status, 400);
  assert.ok(existsSync(path.join(a.lib, '10102026', 'Cam-00-010000-010100.mp4')));
  await a.close();
});

test('system: reports service/linger; linger toggle validates input, is same-origin, and surfaces failures', async () => {
  const calls = [];
  const exec = async (c, args) => {
    calls.push([c, ...args].join(' '));
    if (c === 'systemctl') return { stdout: args[1] === 'is-enabled' ? 'enabled\n' : 'active\n' };
    if (args[0] === 'enable-linger') return { stdout: '' };
    if (args[0] === 'disable-linger') { const e = new Error('x'); e.stderr = 'Access denied\nmore'; throw e; }
    return { stdout: calls.some((c2) => c2.includes('enable-linger')) ? 'yes\n' : 'no\n' };
  };
  const a = await app({ system: createSystem({ exec, user: 'paul' }) });
  const sys = await (await fetch(a.base + '/api/system')).json();
  assert.deepEqual(sys.service, { enabled: 'enabled', active: 'active' });
  assert.equal(sys.linger, 'no'); assert.equal(sys.user, 'paul');
  assert.equal((await a.send('PUT', '/api/system/linger', { enabled: 'yes' })).status, 400);
  assert.equal((await a.send('PUT', '/api/system/linger', { enabled: true }, { origin: 'http://evil.example' })).status, 403);
  const on = await a.send('PUT', '/api/system/linger', { enabled: true });
  assert.equal((await on.json()).linger, 'yes');
  assert.ok(calls.includes('loginctl enable-linger paul'));
  const off = await a.send('PUT', '/api/system/linger', { enabled: false });
  assert.equal(off.status, 502);
  assert.match((await off.json()).error, /Access denied/);
  await a.close();
});

test('snapshot to a folder: saved with a unique name, refused when unset or inside the library', async () => {
  const cam = await fakeCamera();
  const a = await app({ camera: cam });
  assert.equal((await a.send('POST', '/api/snapshot/cam')).status, 409, 'no folder configured');
  const dir = path.join(a.dir, 'snaps');
  assert.equal((await a.send('PUT', '/api/settings', { snapshotDir: dir })).status, 200);
  const r = await a.send('POST', '/api/snapshot/cam');
  assert.equal(r.status, 201);
  const { file } = await r.json();
  assert.ok(file.startsWith(dir) && file.endsWith('.jpg'));
  assert.equal(readFileSync(file)[0], 0xff);
  assert.equal(readdirSync(dir).length, 1);
  assert.equal((await a.send('POST', '/api/snapshot/cam', undefined, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await a.send('POST', '/api/snapshot/nope')).status, 404);
  await a.close(); cam.close();
});
