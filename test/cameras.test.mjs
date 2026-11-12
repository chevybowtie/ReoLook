import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isValidHost, uniqueId, saveCameras, normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

test('isValidHost accepts hosts and ip[:port], rejects URLs and junk', () => {
  for (const ok of ['192.168.1.241', 'cam.local', 'cam-1.lan:8080', '127.0.0.1:9']) assert.equal(isValidHost(ok), true, ok);
  for (const bad of ['', 'http://10.0.0.1', '10.0.0.1/path', 'a b', 'user@10.0.0.1', '10.0.0.1:0', '10.0.0.1:99999', '-bad', 'x'.repeat(300), null, 42]) {
    assert.equal(isValidHost(bad), false, String(bad));
  }
});

test('uniqueId slugs names and avoids collisions', () => {
  assert.equal(uniqueId('Front porch - out', new Set()), 'front-porch-out');
  assert.equal(uniqueId('Camera 3', new Set(['camera-3'])), 'camera-3-2');
  assert.equal(uniqueId('!!!', new Set()), 'camera');
});

test('saveCameras is additive: keeps other keys, writes a one-time backup, atomic', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const f = path.join(d, 'config.json');
  writeFileSync(f, JSON.stringify({ root: '/r', port: 9, record: { enabled: true }, cameras: [{ name: 'A', host: '1.1.1.1' }] }));
  await saveCameras(f, [{ name: 'A', host: '1.1.1.1' }, { name: 'B', host: '2.2.2.2', channel: 1 }]);
  const after = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(after.root, '/r'); assert.equal(after.port, 9); assert.equal(after.record.enabled, true);
  assert.deepEqual(after.cameras, [{ name: 'A', host: '1.1.1.1' }, { name: 'B', host: '2.2.2.2', channel: 1 }]);
  assert.ok(existsSync(f + '.bak'));
  const original = readFileSync(f + '.bak', 'utf8');
  await saveCameras(f, [{ name: 'C', host: '3.3.3.3' }]);
  assert.equal(readFileSync(f + '.bak', 'utf8'), original, 'backup is kept from before the first change only');
  assert.doesNotThrow(() => normalize(JSON.parse(readFileSync(f, 'utf8'))));
  rmSync(d, { recursive: true, force: true });
});

function fakeCamera() {
  const srv = http.createServer((req, res) => {
    const cmd = new URL(req.url, 'http://x').searchParams.get('cmd');
    const v = cmd === 'Login' ? { Token: { name: 'tok' } } : cmd === 'GetDevInfo' ? { DevInfo: { name: 'Fake Cam', model: 'RLC-TEST' } } : {};
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ cmd, code: 0, value: v }]));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function app(cameras = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'srv-'));
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ root: null, cameras }));
  const config = normalize({ cameras });
  const server = createServer({ config, configPath, user: 'u', password: 'p' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  return { server, base, post, config, configPath, close: () => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('POST /api/cameras probes the device, names it, persists it, and lists it', async () => {
  const cam = await fakeCamera(); const a = await app();
  const host = `127.0.0.1:${cam.address().port}`;
  const r = await a.post('/api/cameras', { host });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.camera.name, 'Fake Cam');
  assert.equal(body.model, 'RLC-TEST');
  assert.equal(JSON.parse(readFileSync(a.configPath, 'utf8')).cameras[0].host, host);
  const cfg = await (await fetch(a.base + '/api/config')).json();
  assert.equal(cfg.cameras.length, 1);
  assert.ok(!JSON.stringify(cfg).includes('"p"'), 'no credentials in /api/config');
  assert.equal((await a.post('/api/cameras', { host })).status, 409, 'duplicate refused');
  a.close(); cam.close();
});

test('POST /api/cameras rejects bad hosts, other origins, bad JSON, unreachable devices', async () => {
  const a = await app();
  assert.equal((await a.post('/api/cameras', { host: 'http://evil' })).status, 400);
  assert.equal((await a.post('/api/cameras', { host: '10.0.0.1' }, { origin: 'http://evil.example' })).status, 403);
  const noOrigin = await fetch(a.base + '/api/cameras', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"host":"10.0.0.1"}' });
  assert.equal(noOrigin.status, 403);
  const bad = await fetch(a.base + '/api/cameras', { method: 'POST', headers: { origin: a.base }, body: '{nope' });
  assert.equal(bad.status, 400);
  const r = await a.post('/api/cameras', { host: '127.0.0.1:1' }); // nothing listens there
  assert.equal(r.status, 502);
  assert.equal(a.config.cameras.length, 0, 'failed probe adds nothing');
  a.close();
});

test('DELETE /api/cameras/:id removes and persists; unknown id is 404; cross-origin refused', async () => {
  const a = await app([{ name: 'A', host: '1.1.1.1' }, { name: 'B', host: '2.2.2.2' }]);
  assert.equal((await fetch(a.base + '/api/cameras/a', { method: 'DELETE', headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(a.base + '/api/cameras/nope', { method: 'DELETE', headers: { origin: a.base } })).status, 404);
  assert.equal((await fetch(a.base + '/api/cameras/a', { method: 'DELETE', headers: { origin: a.base } })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(a.configPath, 'utf8')).cameras.map((c) => c.name), ['B']);
  a.close();
});
