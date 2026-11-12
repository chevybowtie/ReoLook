import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

function fakeRecorder() {
  const made = [];
  const make = (opts) => {
    const r = new EventEmitter();
    r.opts = opts; r.started = false; r.stopped = false;
    r.start = () => { r.started = true; };
    r.stop = async () => { r.stopped = true; r.emit('stop', { file: '/rec/10102026/Cam-00-010101-010202.mp4', bytes: 1 }); };
    made.push(r);
    return r;
  };
  make.made = made;
  return make;
}

async function app({ root = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rec-'));
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, '{}');
  const config = normalize({ root: root ? dir : null, cameras: [{ name: 'Cam', host: '10.0.0.9' }] });
  const makeRecorder = fakeRecorder();
  const server = createServer({ config, configPath, user: 'u', password: 'p', makeRecorder });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, headers = { origin: base }) => fetch(base + p, { method, headers });
  return { server, base, call, makeRecorder, close: async () => { await server.stopManual(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('start records the main stream continuously into the library root; status lists it', async () => {
  const a = await app();
  const r = await a.call('POST', '/api/record/cam');
  assert.equal(r.status, 201);
  const rec = a.makeRecorder.made[0];
  assert.equal(rec.started, true);
  assert.equal(rec.opts.always, true);
  assert.equal(rec.opts.stream, 'main');
  assert.equal(rec.opts.name, 'Cam');
  const st = await (await fetch(a.base + '/api/status')).json();
  assert.deepEqual(st.manual.map((m) => m.id), ['cam']);
  assert.ok(!JSON.stringify(st).includes('"p"'), 'no credentials in status');
  await a.close();
});

test('a second start is refused, stop finalizes and reports the file, then it can restart', async () => {
  const a = await app();
  await a.call('POST', '/api/record/cam');
  assert.equal((await a.call('POST', '/api/record/cam')).status, 409);
  const stop = await a.call('DELETE', '/api/record/cam');
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).file, 'Cam-00-010101-010202.mp4');
  assert.equal(a.makeRecorder.made[0].stopped, true);
  assert.deepEqual((await (await fetch(a.base + '/api/status')).json()).manual, []);
  assert.equal((await a.call('DELETE', '/api/record/cam')).status, 404, 'nothing to stop');
  assert.equal((await a.call('POST', '/api/record/cam')).status, 201);
  await a.close();
});

test('refuses without a recordings folder, for unknown devices, and cross-origin', async () => {
  const a = await app({ root: false });
  assert.equal((await a.call('POST', '/api/record/cam')).status, 400);
  await a.close();
  const b = await app();
  assert.equal((await b.call('POST', '/api/record/nope')).status, 404);
  assert.equal((await b.call('POST', '/api/record/cam', { origin: 'http://evil.example' })).status, 403);
  assert.equal((await b.call('POST', '/api/record/cam', {})).status, 403, 'no Origin header');
  assert.equal(b.makeRecorder.made.length, 0, 'no recorder created for refused requests');
  await b.close();
});

test('server shutdown stops running manual recordings', async () => {
  const a = await app();
  await a.call('POST', '/api/record/cam');
  await a.server.stopManual();
  assert.equal(a.makeRecorder.made[0].stopped, true);
  await a.close();
});
