import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.mjs';

/** A runtime whose recorders, retention loop and detection are recorded fakes. */
function rig({ record = true, root = mkdtempSync(path.join(tmpdir(), 'rt-')), detection = false } = {}) {
  const calls = [];
  const logs = [];
  const config = { root, record: { enabled: record } };
  const rt = createRuntime({
    config, user: 'u', password: 'p', log: (m) => logs.push(m),
    makeRecorders: () => { calls.push('recorders:start'); return { status: () => [{ id: 'cam' }], stop: async () => { calls.push('recorders:stop'); } }; },
    makeRetention: () => { calls.push('retention:start'); return { status: () => ({ configured: true, apply: false, lastRun: null, last: null, running: false }), stop: () => calls.push('retention:stop') }; },
    makeDetection: detection ? async () => { calls.push('detection:start'); return { service: { status: () => ({ running: true, frames: 3, cameras: {} }) }, stop: async () => { calls.push('detection:stop'); } }; } : null,
  });
  return { rt, calls, logs, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('start brings up recorders and retention; stop takes them down again', async () => {
  const r = rig();
  await r.rt.start();
  assert.deepEqual(r.calls, ['recorders:start', 'retention:start']);
  assert.deepEqual(r.rt.status().recording, { enabled: true, cameras: [{ id: 'cam' }] });
  assert.equal(r.rt.status().retention.configured, true);
  await r.rt.stop();
  assert.deepEqual(r.calls.slice(2).sort(), ['recorders:stop', 'retention:stop']);
  assert.deepEqual(r.rt.status().recording, { enabled: false, cameras: [] });
  assert.deepEqual(r.rt.status().retention, { configured: false, apply: false, lastRun: null, last: null, running: false });
  r.cleanup();
});

test('recording off, or no folder, starts no recorders', async () => {
  const off = rig({ record: false });
  await off.rt.start();
  assert.deepEqual(off.calls, ['retention:start']);
  const none = rig({ root: null });
  await none.rt.start();
  assert.deepEqual(none.calls, ['retention:start']);
  assert.equal(none.rt.status().recording.enabled, false);
  off.cleanup();
});

test('detection is optional, is reported in status, and a failure to start is logged and ignored', async () => {
  assert.deepEqual(rig().rt.status().detection, { running: false, frames: 0, cameras: {} });
  const on = rig({ detection: true });
  await on.rt.start();
  assert.equal(on.rt.status().detection.frames, 3);
  assert.equal(on.rt.detection().service.status().running, true);
  await on.rt.stop();
  assert.ok(on.calls.includes('detection:stop'));
  assert.equal(on.rt.detection(), null);

  const logs = [];
  const bad = createRuntime({ config: { root: null, record: { enabled: false } }, user: 'u', password: 'p', log: (m) => logs.push(m),
    makeRetention: () => ({ status: () => ({}), stop() {} }), makeDetection: async () => { throw new Error('no model'); } });
  await bad.start();
  assert.deepEqual(logs, ['detection could not start: no model']);
  assert.equal(bad.detection(), null);
  on.cleanup();
});

test('reload stops then starts again, and overlapping reloads queue in order', async () => {
  const r = rig();
  await r.rt.start();
  r.calls.length = 0;
  await Promise.all([r.rt.reload(), r.rt.reload()]);
  assert.deepEqual(r.calls, [
    'retention:stop', 'recorders:stop', 'recorders:start', 'retention:start',
    'retention:stop', 'recorders:stop', 'recorders:start', 'retention:start',
  ], 'each reload finishes before the next begins');
  r.cleanup();
});

test('checkStorage: writable folder is ok, cached for 30 s unless forced, and no folder is unknown', async () => {
  const r = rig();
  const first = await r.rt.checkStorage(true);
  assert.equal(first.ok, true);
  assert.equal(first.error, null);
  assert.equal(await r.rt.checkStorage(), first, 'served from the cache');
  assert.notEqual(await r.rt.checkStorage(true), first, 'forced check measures again');
  const none = rig({ root: null });
  assert.equal((await none.rt.checkStorage(true)).ok, null);
  rmSync(r.config.root, { recursive: true, force: true });
  const gone = await r.rt.checkStorage(true);
  assert.equal(gone.ok, false);
  assert.ok(gone.error);
});

test('start says once, loudly, when recording cannot work', async () => {
  const r = rig();
  rmSync(r.config.root, { recursive: true, force: true });
  await r.rt.start();
  await new Promise((x) => setTimeout(x, 50));
  assert.ok(r.logs.some((l) => /^ERROR recording cannot work: /.test(l)), r.logs.join('|'));
});
