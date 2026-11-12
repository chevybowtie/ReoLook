// Everything in the process that reads from a camera shares one signed-in client: one session on the
// camera, not one each for the recorder, the detector and the web page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { startRecorders } from '../src/service.mjs';
import { createDetection } from '../src/detect/index.mjs';
import { createServer } from '../src/server.mjs';
import { ClientPool } from '../src/client-pool.mjs';
import { MODEL_FILE } from '../src/detect/helper-client.mjs';
import { startFakeCamera } from './support/fake-camera.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ZONE = [[0.5, 0.3], [0.95, 0.3], [0.95, 0.9], [0.5, 0.9]];
const count = (cam, cmd) => cam.requests.filter((r) => r.cmd === cmd).length;

async function world({ detection = true } = {}) {
  const cam = await startFakeCamera({ commands: { GetMdState: () => ({ state: 0 }), GetDevInfo: () => ({ DevInfo: { name: 'Door', model: 'M', firmVer: 'f', channelNum: 1 } }) } });
  const dir = mkdtempSync(path.join(tmpdir(), 'ss-'));
  const root = path.join(dir, 'rec'); mkdirSync(root);
  const detDir = path.join(dir, 'detector');
  for (const f of ['venv/bin/python', MODEL_FILE]) { mkdirSync(path.dirname(path.join(detDir, f)), { recursive: true }); writeFileSync(path.join(detDir, f), 'x'); }
  const config = normalize({ root, record: { enabled: true }, cameras: [{ name: 'Door', host: cam.host }],
    detection: detection ? { enabled: true, intervalMs: 500, cameras: { door: { enabled: true, rules: [{ id: 'r1', enabled: true, label: 'truck', zone: ZONE, minStopSec: 6, classes: ['truck'] }] } } } : {} });
  const fakeDetector = { close() {}, detect: async () => ({ width: 1, height: 1, ms: 1, detections: [] }) };
  const makeDetection = (o) => createDetection({ ...o, detectorDir: detDir, makeDetector: () => fakeDetector });
  return { cam, dir, config, makeDetection, cleanup: async () => { await cam.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('the recorder, detection and the server use one client, so the camera sees one sign-in', async () => {
  const w = await world();
  const pool = new ClientPool();
  const runtime = createRuntime({ config: w.config, user: 'viewer', password: 'secret123', log: () => {}, makeDetection: w.makeDetection, clients: pool });
  const server = createServer({ config: w.config, configPath: path.join(w.dir, 'c.json'), user: 'viewer', password: 'secret123', runtime, clientPool: pool });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await runtime.start();
  await sleep(2300);                                                     // a couple of polls from the recorder and from detection
  const base = `http://127.0.0.1:${server.address().port}`;
  await (await fetch(`${base}/api/motion-state`)).json();
  assert.equal(pool.size, 1, 'one device, one client');
  assert.equal(count(w.cam, 'Login'), 1, 'one session on the camera, not one per part');
  assert.ok(count(w.cam, 'GetMdState') >= 2, 'it was polled');
  await runtime.stop(); server.closeAllConnections(); server.close(); await pool.close();
  assert.equal(count(w.cam, 'Logout'), 1, 'and one sign-out when the pool closes');
  await w.cleanup();
});

test('a reload (a settings change) reuses the session instead of signing in again', async () => {
  const w = await world({ detection: false });
  const pool = new ClientPool();
  const runtime = createRuntime({ config: w.config, user: 'viewer', password: 'secret123', log: () => {}, clients: pool });
  await runtime.start(); await sleep(1300);
  const before = count(w.cam, 'Login');
  await runtime.reload(); await sleep(1300);
  assert.equal(count(w.cam, 'Login'), before, 'no new sign-in after the reload');
  assert.equal(before, 1);
  await runtime.stop(); await pool.close(); await w.cleanup();
});

test('stopping detection does not sign out a session the recorder is still using', async () => {
  const w = await world();
  const pool = new ClientPool();
  const runtime = createRuntime({ config: w.config, user: 'viewer', password: 'secret123', log: () => {}, makeDetection: w.makeDetection, clients: pool });
  await runtime.start(); await sleep(1300);
  const det = runtime.detection();
  assert.ok(det, 'detection is running');
  await det.stop();
  await sleep(50);
  assert.equal(count(w.cam, 'Logout'), 0, 'the shared session is still open');
  await runtime.stop(); await pool.close(); await w.cleanup();
});

test('detection started on its own, with no pool given, keeps its own session and signs out on stop', async () => {
  const w = await world();
  const det = await w.makeDetection({ config: w.config, user: 'viewer', password: 'secret123', events: { add: async () => ({}) }, log: () => {} });
  await sleep(1300);
  assert.equal(count(w.cam, 'Login'), 1);
  await det.stop();
  await sleep(150);
  assert.equal(count(w.cam, 'Logout'), 1);
  await w.cleanup();
});

test('startRecorders without a pool still works, with a client of its own', async () => {
  const w = await world({ detection: false });
  const rec = startRecorders({ config: w.config, user: 'viewer', password: 'secret123', log: () => {} });
  await sleep(1300);
  assert.equal(count(w.cam, 'Login'), 1);
  assert.equal(rec.status().length, 1);
  await rec.stop(); await w.cleanup();
});
