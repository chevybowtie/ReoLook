import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DetectionService } from '../src/detect/service.mjs';
import { EventLog } from '../src/detect/events.mjs';
import { normalizeDetection, DetectionConfigError } from '../src/detect/config.mjs';

const ZONE = [[0.5, 0.3], [0.95, 0.3], [0.95, 0.9], [0.5, 0.9]];
const truckBox = [0.6, 0.4, 0.8, 0.7];

function rig({ motion = true, frames = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'det-'));
  const publishes = [];
  let i = 0, snaps = 0, t = Date.parse('2026-10-12T14:00:00');
  const state = { motion };
  const cfg = normalizeDetection({ enabled: true, intervalMs: 500, mqtt: { enabled: true, url: 'mqtt://x', topic: 'reolook' },
    cameras: { out2: { enabled: true, rules: [{ id: 'r1', enabled: true, label: 'mail truck', zone: ZONE, minStopSec: 6, classes: ['truck'] }] } } });
  const svc = new DetectionService({
    config: cfg, cameras: [{ id: 'out2', name: 'Garden - west 2', channel: 0 }],
    clients: () => ({ motionState: async () => state.motion, snapshot: async () => { snaps++; return Buffer.from('JPEGDATA'); } }),
    detector: { detect: async () => ({ width: 100, height: 100, ms: 5, detections: frames[Math.min(i++, frames.length - 1)] ?? [] }) },
    events: new EventLog({ file: path.join(dir, 'ev.jsonl'), dir: path.join(dir, 'pics') }),
    mqtt: { publish: async (topic, payload, opts) => { publishes.push({ topic, payload, opts }); } },
    now: () => t, autoLoop: false,
  });
  return { svc, publishes, dir, state, advance: (ms) => { t += ms; }, snaps: () => snaps, events: svc, cleanup: async () => { await svc.stop(); rmSync(dir, { recursive: true, force: true }); } };
}
const truck = [{ label: 'truck', score: 0.8, box: truckBox }];
// it drives in from the left over three frames, then stays where `truck` is
const arrival = [0.45, 0.52, 0.58].map((x) => [{ label: 'truck', score: 0.8, box: [x, 0.4, x + 0.2, 0.7] }]);

test('a stopped truck becomes one tagged event, a picture, and MQTT messages', async () => {
  const r = rig({ frames: [...arrival, truck] });
  const seen = [];
  r.svc.onEvent((e) => seen.push(e));
  await r.svc.start();
  for (let s = 0; s < 12; s++) { await r.svc.step(); r.advance(1000); }
  const stopped = seen.filter((e) => e.type === 'stopped');
  assert.equal(stopped.length, 1);
  assert.match(stopped[0].tag, /^mail truck \d\d:\d\d$/);
  assert.ok(existsSync(path.join(r.dir, 'pics', stopped[0].snapshot)), 'the frame it fired on is kept');
  const ev = r.publishes.find((p) => p.topic === 'reolook/out2/event');
  assert.equal(ev.payload.event, 'mail_truck_stopped');
  assert.equal(ev.payload.camera, 'Garden - west 2');
  const state = r.publishes.find((p) => p.topic === 'reolook/out2/mail_truck');
  assert.equal(state.payload, 'ON'); assert.equal(state.opts.retain, true);
  await r.cleanup();
});

test('when it leaves, the state topic goes back to OFF', async () => {
  const r = rig({ frames: [...arrival, truck, truck, truck, truck, truck, truck, truck, truck, [], [], [], [], [], [], [], [], [], [], []] });
  await r.svc.start();
  for (let s = 0; s < 40; s++) { await r.svc.step(); r.advance(1000); }
  const states = r.publishes.filter((p) => p.topic === 'reolook/out2/mail_truck').map((p) => p.payload);
  assert.deepEqual(states, ['ON', 'OFF']);
  await r.cleanup();
});

test('no frames are taken while the camera sees nothing and nothing is being followed', async () => {
  const r = rig({ motion: false, frames: [[]] });
  await r.svc.start();
  for (let s = 0; s < 10; s++) { await r.svc.step(); r.advance(1000); }
  assert.equal(r.snaps(), 0);
  assert.equal(r.svc.status().cameras.out2.state, 'idle');
  await r.cleanup();
});

test('outside the allowed hours nothing is looked at', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'det-'));
  let snaps = 0;
  const cfg = normalizeDetection({ enabled: true, cameras: { out2: { enabled: true, rules: [{ id: 'r1', enabled: true, zone: ZONE, from: '09:00', to: '10:00' }] } } });
  const svc = new DetectionService({ config: cfg, cameras: [{ id: 'out2', name: 'X', channel: 0 }],
    clients: () => ({ motionState: async () => true, snapshot: async () => { snaps++; return Buffer.from('x'); } }),
    detector: { detect: async () => ({ detections: [] }) }, events: new EventLog({ file: path.join(dir, 'e.jsonl'), dir }),
    now: () => Date.parse('2026-10-12T14:00:00'), autoLoop: false });
  await svc.start(); await svc.step();
  assert.equal(snaps, 0);
  assert.equal(svc.status().cameras.out2.state, 'outside hours');
  await svc.stop(); rmSync(dir, { recursive: true, force: true });
});

test('the test look says which detections are in the zone and which would count', async () => {
  const r = rig({ frames: [[{ label: 'truck', score: 0.9, box: truckBox }, { label: 'car', score: 0.9, box: truckBox }, { label: 'truck', score: 0.9, box: [0.05, 0.4, 0.25, 0.7] }]] });
  const out = await r.svc.testNow('out2');
  assert.deepEqual(out.detections.map((d) => [d.label, d.inZone, d.counted]), [['truck', true, true], ['car', true, false], ['truck', false, false]]);
  assert.deepEqual(out.detections[0].rules, ['mail truck']);
  await r.cleanup();
});

test('events keep verdicts for later tuning and can be listed by day and removed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ev-'));
  const log = new EventLog({ file: path.join(dir, 'e.jsonl'), dir: path.join(dir, 'p') });
  const e = await log.add({ type: 'stopped', camera: 'out2', at: '2026-10-12T14:12:00.000Z', rule: 'mail truck', tag: 'mail truck 14:12' }, Buffer.from('J'));
  await log.setVerdict(e.id, 'yes');
  const again = new EventLog({ file: path.join(dir, 'e.jsonl'), dir: path.join(dir, 'p') });   // reload from disk
  const listed = await again.list({ camera: 'out2' });
  assert.equal(listed.length, 1); assert.equal(listed[0].verdict, 'yes');
  await assert.rejects(again.setVerdict(e.id, 'maybe'), /verdict must be/);
  assert.equal(await again.remove(e.id), true);
  assert.deepEqual(await again.list(), []);
  rmSync(dir, { recursive: true, force: true });
});

test('the detection settings are checked in plain language', () => {
  const rule = (o) => ({ cameras: { a: { enabled: true, rules: [{ id: 'r1', enabled: true, zone: ZONE, ...o }] } } });
  const bad = (raw, re) => assert.throws(() => normalizeDetection(raw), (e) => e instanceof DetectionConfigError && re.test(e.message));
  bad(rule({ zone: [] }), /draw the zone/);
  bad(rule({ zone: [[0, 0], [2, 0], [1, 1]] }), /between 0 and 1/);
  bad(rule({ zone: [[0, 0], [1, 1]] }), /at least 3 points/);
  bad(rule({ minStopSec: 1 }), /3 to 600/);
  bad(rule({ classes: ['unicorn'] }), /types must be from/);
  bad(rule({ mode: 'sometimes' }), /"stops" or "appears"/);
  bad(rule({ minHeight: 2 }), /smallest size/);
  bad(rule({ from: '9:00', to: '10:00' }), /09:30/);
  bad(rule({ from: '09:00' }), /both a start and an end/);
  bad(rule({ label: '' }), /event name/);
  bad({ mqtt: { enabled: true } }, /broker address/);
  bad({ mqtt: { enabled: true, url: 'http://x' } }, /must look like/);
  bad({ mqtt: { topic: '/bad/' } }, /topic prefix/);
  assert.equal(normalizeDetection({}).enabled, false);
  assert.equal(normalizeDetection({ mqtt: { enabled: true, url: ' mqtt://h ' } }).mqtt.url, 'mqtt://h');
});

test('an "appears" rule may use the whole picture; the first saved shape (one flat rule) becomes the first of a list', () => {
  const d = normalizeDetection({ cameras: { a: { enabled: true, rules: [{ id: 'p', enabled: true, mode: 'appears', label: 'peacock', classes: ['bird'], minHeight: 0.1 }] } } });
  assert.equal(d.cameras.a.rules[0].zone.length, 0);
  assert.equal(d.cameras.a.rules[0].minHeight, 0.1);
  const old = normalizeDetection({ cameras: { b: { enabled: true, label: 'mail truck', zone: ZONE, classes: ['truck'], minStopSec: 10, from: '13:00', to: '18:00', minScore: 0.4, requireArrival: true } } });
  assert.equal(old.cameras.b.enabled, true);
  assert.deepEqual(old.cameras.b.rules.map((r) => [r.id, r.enabled, r.label, r.mode, r.minStopSec, r.from]), [['r1', true, 'mail truck', 'stops', 10, '13:00']]);
});

test('events written by another process (the replay command) show up without a restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ev2-'));
  const file = path.join(dir, 'e.jsonl'), pics = path.join(dir, 'p');
  const server = new EventLog({ file, dir: pics });
  assert.deepEqual(await server.list(), []);
  const cli = new EventLog({ file, dir: pics });
  const e = await cli.add({ type: 'appeared', camera: 'out2', at: '2025-08-13T21:43:00.000Z', rule: 'mail truck', tag: 'mail truck 16:43', replayed: true }, Buffer.from('J'));
  assert.equal((await server.list()).length, 1);
  await server.setVerdict(e.id, 'yes');
  assert.equal((await cli.get(e.id)).verdict, 'yes');
  rmSync(dir, { recursive: true, force: true });
});
