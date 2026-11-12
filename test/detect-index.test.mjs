// createDetection: when it does nothing, and what it assembles when the detector is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDetection } from '../src/detect/index.mjs';
import { normalize } from '../src/config.mjs';
import { MODEL_FILE } from '../src/detect/helper-client.mjs';

const ZONE = [[0.5, 0.3], [0.95, 0.3], [0.95, 0.9], [0.5, 0.9]];
const cfg = (detection) => normalize({ cameras: [{ name: 'Out', host: '192.0.2.10' }], detection });
const on = { enabled: true, cameras: { out: { enabled: true, rules: [{ id: 'r1', enabled: true, label: 'mail truck', zone: ZONE, minStopSec: 6, classes: ['truck'] }] } } };
const installed = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'det-idx-'));
  for (const f of ['venv/bin/python', MODEL_FILE]) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), 'x'); }
  return dir;
};

test('detection turned off, or with no enabled rule, does nothing', async () => {
  assert.equal(await createDetection({ config: cfg({}), user: 'u', password: 'p', events: null }), null);
  assert.equal(await createDetection({ config: cfg({ enabled: true }), user: 'u', password: 'p', events: null }), null, 'on, but nothing to watch');
  const noRule = structuredClone(on); noRule.cameras.out.rules[0].enabled = false;
  assert.equal(await createDetection({ config: cfg(noRule), user: 'u', password: 'p', events: null }), null);
});

test('turned on but not installed: says so and does nothing', async () => {
  const logs = [];
  const empty = mkdtempSync(path.join(tmpdir(), 'det-idx-'));
  const r = await createDetection({ config: cfg(on), user: 'u', password: 'p', events: null, log: (m) => logs.push(m), detectorDir: empty });
  assert.equal(r, null);
  assert.deepEqual(logs, ['detection is turned on but the detector is not installed (run: node bin/reolook.mjs detect setup)']);
  rmSync(empty, { recursive: true, force: true });
});

test('installed: starts a service for the watched cameras, logs what it watches, and stops cleanly', async () => {
  const dir = installed(), logs = [];
  let closed = 0;
  const detector = { close: () => closed++, detect: async () => ({ width: 1, height: 1, ms: 1, detections: [] }) };
  const r = await createDetection({ config: cfg(on), user: 'u', password: 'p', events: { record() {} }, log: (m) => logs.push(m), detectorDir: dir, makeDetector: () => detector });
  assert.ok(r.service);
  assert.equal(r.mqtt, null, 'MQTT is only used when it is turned on');
  assert.equal(r.service.status().running, true);
  assert.deepEqual(logs, ['detection: watching out (mail truck)']);
  await r.stop();
  assert.equal(r.service.status().running, false);
  assert.equal(closed, 1, 'the detector process is closed');
  rmSync(dir, { recursive: true, force: true });
});
