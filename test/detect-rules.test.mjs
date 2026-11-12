import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInPolygon, footOf, iou, inWindow, StopTracker } from '../src/detect/rules.mjs';

const ZONE = [[0.6, 0.4], [0.95, 0.4], [0.95, 0.8], [0.6, 0.8]];
const truck = (x, y = 0.45, w = 0.2, h = 0.3, label = 'truck', score = 0.8) => ({ label, score, box: [x, y, x + w, y + h] });

test('geometry: polygon, foot point, overlap and the time window', () => {
  assert.equal(pointInPolygon([0.7, 0.5], ZONE), true);
  assert.equal(pointInPolygon([0.3, 0.5], ZONE), false);
  assert.deepEqual(footOf([0.6, 0.4, 0.8, 0.7]), [0.7, 0.7]);
  assert.equal(iou([0, 0, 1, 1], [0, 0, 1, 1]), 1);
  assert.equal(iou([0, 0, 0.4, 0.4], [0.6, 0.6, 1, 1]), 0);
  const at = (h, m) => new Date(2026, 9, 12, h, m);
  assert.equal(inWindow(at(14, 12), '10:00', '17:00'), true);
  assert.equal(inWindow(at(18, 0), '10:00', '17:00'), false);
  assert.equal(inWindow(at(23, 30), '22:00', '06:00'), true, 'a window may wrap midnight');
  assert.equal(inWindow(at(3, 0), null, null), true);
});

test('a vehicle that arrives and stays put in the zone is reported once, after the minimum time', () => {
  const t = new StopTracker({ zone: ZONE, minStopSec: 20 });
  const events = [];
  for (let s = 0; s < 6; s += 2) events.push(...t.update([truck(0.55 + s * 0.04)], s * 1000));   // drives in
  for (let s = 6; s <= 46; s += 2) events.push(...t.update([truck(0.7)], s * 1000));              // then stops
  const stopped = events.filter((e) => e.type === 'stopped');
  assert.equal(stopped.length, 1, 'once, not on every frame');
  assert.equal(stopped[0].at, 24_000, 'the moment it had been still for the minimum, counted from when it stopped moving');
  assert.equal(stopped[0].track.label, 'truck');
});

test('a vehicle driving through never counts as stopped', () => {
  const t = new StopTracker({ zone: ZONE, minStopSec: 10 });
  const events = [];
  for (let s = 0; s < 30; s += 1) events.push(...t.update([truck(0.3 + s * 0.02)], s * 1000));   // moves 2% of the frame per second
  assert.deepEqual(events, []);
});

test('a vehicle stopped outside the zone is not reported', () => {
  const t = new StopTracker({ zone: ZONE, minStopSec: 5 });
  const events = [];
  for (let s = 0; s <= 30; s += 2) events.push(...t.update([truck(0.05)], s * 1000));
  assert.deepEqual(events, []);
});

test('only the chosen classes and confident detections are followed', () => {
  const t = new StopTracker({ zone: ZONE, minStopSec: 5, classes: ['truck'] });
  const ev = [];
  for (let s = 0; s <= 20; s += 2) ev.push(...t.update([truck(0.7, 0.45, 0.2, 0.3, 'car'), truck(0.7, 0.45, 0.2, 0.3, 'person'), truck(0.65, 0.45, 0.2, 0.3, 'truck', 0.2)], s * 1000));
  assert.deepEqual(ev, []);
});

test('it reports when the stopped vehicle leaves, and a new arrival is a new event', () => {
  const t = new StopTracker({ zone: ZONE, minStopSec: 6, lostAfterSec: 4 });
  const ev = [];
  for (let s = 0; s < 4; s += 2) ev.push(...t.update([truck(0.6 + s * 0.05)], s * 1000));
  for (let s = 4; s <= 12; s += 2) ev.push(...t.update([truck(0.7)], s * 1000));
  for (let s = 14; s <= 22; s += 2) ev.push(...t.update([], s * 1000));
  for (let s = 30; s < 34; s += 2) ev.push(...t.update([truck(0.6 + (s - 30) * 0.05)], s * 1000));
  for (let s = 34; s <= 46; s += 2) ev.push(...t.update([truck(0.72)], s * 1000));
  assert.deepEqual(ev.map((e) => e.type), ['stopped', 'left', 'stopped']);
});

test('small jitter in the box does not restart the stop timer', () => {
  const t = new StopTracker({ zone: ZONE, minStopSec: 10 });
  const ev = [];
  for (let s = 0; s < 3; s += 1) ev.push(...t.update([truck(0.6 + s * 0.05)], s * 1000));            // arrives
  for (let s = 3; s <= 17; s += 1) ev.push(...t.update([truck(0.7 + (s % 2) * 0.005)], s * 1000));
  assert.equal(ev.filter((e) => e.type === 'stopped').length, 1);
});

test('a vehicle already parked when first seen is not an arrival, unless that is turned off', () => {
  const parked = (opts) => { const t = new StopTracker({ zone: ZONE, minStopSec: 6, ...opts }); const ev = []; for (let s = 0; s <= 20; s += 2) ev.push(...t.update([truck(0.7)], s * 1000)); return ev.filter((e) => e.type === 'stopped').length; };
  assert.equal(parked({}), 0, 'a car in the driveway');
  assert.equal(parked({ requireArrival: false }), 1);
});

const bird = (x, y, h = 0.25, label = 'bird', score = 0.7) => ({ label, score, box: [x, y, x + h * 0.6, y + h] });

test('an "appears" rule fires once after the animal has been seen long enough, anywhere in the picture', () => {
  const t = new StopTracker({ mode: 'appears', zone: [], classes: ['bird'], minPresenceSec: 3, minScore: 0.4 });
  const ev = [];
  for (let s = 0; s <= 12; s += 1) ev.push(...t.update([bird(0.1 + s * 0.05, 0.5)], s * 1000));   // walks across, never still
  assert.deepEqual(ev.map((e) => e.type), ['appeared'], 'moving is fine, and it is reported once');
  assert.equal(ev[0].at, 3000);
});

test('small animals are left out by size, and other classes are ignored', () => {
  const t = new StopTracker({ mode: 'appears', classes: ['bird'], minPresenceSec: 2, minHeight: 0.12 });
  const ev = [];
  for (let s = 0; s <= 10; s += 1) ev.push(...t.update([bird(0.2, 0.6, 0.06), bird(0.5, 0.6, 0.3, 'dog')], s * 1000));   // a squirrel-sized bird, and a dog
  assert.deepEqual(ev, []);
  for (let s = 11; s <= 16; s += 1) ev.push(...t.update([bird(0.2, 0.5, 0.2)], s * 1000));
  assert.deepEqual(ev.map((e) => e.type), ['appeared']);
});

test('a zone still narrows an "appears" rule, and it reports when the animal has gone', () => {
  const t = new StopTracker({ mode: 'appears', zone: [[0, 0.5], [0.5, 0.5], [0.5, 1], [0, 1]], classes: ['bird'], minPresenceSec: 1, lostAfterSec: 3 });
  const ev = [];
  for (let s = 0; s <= 5; s += 1) ev.push(...t.update([bird(0.7, 0.5)], s * 1000));   // right half: outside
  assert.deepEqual(ev, []);
  for (let s = 6; s <= 9; s += 1) ev.push(...t.update([bird(0.1, 0.5)], s * 1000));
  for (let s = 10; s <= 16; s += 1) ev.push(...t.update([], s * 1000));
  assert.deepEqual(ev.map((e) => e.type), ['appeared', 'left']);
});

test('an animal that moves a body length between samples is still one visit, not many', () => {
  const t = new StopTracker({ mode: 'appears', classes: ['bird'], minPresenceSec: 6, minScore: 0.4, lostAfterSec: 4 });
  const ev = [];
  // 1.5 s between frames, 0.14 of the picture per step with a 0.12-wide box: the boxes do not overlap at all
  for (let k = 0; k < 8; k++) ev.push(...t.update([{ label: 'bird', score: 0.7, box: [0.1 + k * 0.14, 0.5, 0.22 + k * 0.14, 0.75] }], k * 1500));
  assert.deepEqual(ev.map((e) => e.type), ['appeared']);
  assert.equal(ev[0].track.id, 1);
});

test('a different class is never matched to an existing track, and a device is watched when any rule is on', async () => {
  const t = new StopTracker({ mode: 'appears', classes: ['bird', 'dog'], minPresenceSec: 2 });
  t.update([{ label: 'bird', score: 0.8, box: [0.4, 0.4, 0.5, 0.6] }], 0);
  t.update([{ label: 'dog', score: 0.8, box: [0.41, 0.4, 0.51, 0.6] }], 1000);
  assert.equal(t.tracks.length, 2);
  const { normalizeDetection } = await import('../src/detect/config.mjs');
  const d = normalizeDetection({ cameras: { a: { enabled: false, rules: [{ id: 'r1', enabled: true, mode: 'appears', label: 'peacock', classes: ['bird'] }] } } });
  assert.equal(d.cameras.a.enabled, true);
});

test('a largest size leaves out a bigger vehicle than the one wanted', () => {
  const big = (x) => ({ label: 'truck', score: 0.9, box: [x, 0.2, x + 0.2, 0.5] });     // 30% tall, like a garbage truck
  const mail = (x) => ({ label: 'truck', score: 0.9, box: [x, 0.27, x + 0.2, 0.5] });  // 23% tall
  const rule = { mode: 'appears', zone: [], classes: ['truck'], minPresenceSec: 3, minHeight: 0.2, maxHeight: 0.27 };
  const seen = (mk) => { const t = new StopTracker(rule); const ev = []; for (let k = 0; k < 6; k++) ev.push(...t.update([mk(0.5 + k * 0.01)], k * 1500)); return ev.filter((e) => e.type === 'appeared').length; };
  assert.equal(seen(big), 0);
  assert.equal(seen(mail), 1);
});

test('a quiet time folds a second sighting of the same visit into the first, and "left" follows only counted ones', () => {
  const mk = (cool) => new StopTracker({ mode: 'appears', zone: [], classes: ['truck'], minPresenceSec: 3, lostAfterSec: 4, cooldownSec: cool });
  const visit = (t, start) => { const out = []; for (let k = 0; k < 6; k++) out.push(...t.update([{ label: 'truck', score: 0.9, box: [0.5 + k * 0.01, 0.2, 0.7 + k * 0.01, 0.5] }], start + k * 1500)); return out; };
  const gone = (t, from, to) => { const out = []; for (let s = from; s <= to; s += 1500) out.push(...t.update([], s)); return out; };
  for (const [cool, expected] of [[0, 2], [180, 1]]) {
    const t = mk(cool), ev = [];
    ev.push(...visit(t, 0), ...gone(t, 9000, 30000), ...visit(t, 90_000), ...gone(t, 99_000, 120_000));
    assert.equal(ev.filter((e) => e.type === 'appeared').length, expected, `cooldown ${cool}`);
    assert.equal(ev.filter((e) => e.type === 'left').length, expected);
  }
});
