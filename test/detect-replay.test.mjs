import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseClipName, clipsFor, judge, clock, STEP_MS } from '../src/detect/replay.mjs';

const ZONE = [[0.6, 0.1], [0.95, 0.1], [0.95, 0.5], [0.6, 0.5]];
const rule = { mode: 'appears', zone: ZONE, classes: ['truck', 'bus'], minScore: 0.4, minHeight: 0.2, minPresenceSec: 4, lostAfterSec: 6 };
const truck = (x, h = 0.23, score = 0.8) => ({ label: 'truck', score, box: [x, 0.45 - h, x + 0.12, 0.45] });
const frames = (xs, mk = truck) => xs.map((x, i) => ({ t: i * STEP_MS, detections: x === null ? [] : [mk(x)] }));

test('clip names are parsed and the day\'s clips are picked by camera and time', async () => {
  assert.deepEqual(parseClipName('Garden - west 2-00-154440-154508.mp4'), { camera: 'Garden - west 2', start: 56680, end: 56708 });
  assert.equal(parseClipName('nonsense.mp4'), null);
  assert.equal(clock(56680), '15:44:40');
  const root = mkdtempSync(path.join(tmpdir(), 'rp-'));
  mkdirSync(path.join(root, '10152026'));
  for (const n of ['Garden - west 2-00-150300-150330.mp4', 'Garden - west 2-00-143000-143020.mp4', 'Living room-00-150310-150340.mp4', 'Garden - west 2-00-150330.part.mp4']) writeFileSync(path.join(root, '10152026', n), '');
  const got = await clipsFor({ root, day: '2026-10-15', camera: 'Garden - west 2', from: '14:50', to: '15:20' });
  assert.deepEqual(got.map((c) => c.name), ['Garden - west 2-00-150300-150330.mp4']);
  assert.deepEqual(await clipsFor({ root, day: '2026-10-16', camera: 'x' }), []);
  rmSync(root, { recursive: true, force: true });
});

test('a truck that stays in the zone long enough would fire', () => {
  const r = judge(rule, frames([0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.82]));
  assert.equal(r.verdict, 'WOULD FIRE');
  assert.ok(r.events.some((e) => e.type === 'appeared'));
});

test('the reason for a miss is named: too brief, too small, outside, too faint, or not seen at all', () => {
  assert.match(judge(rule, frames([0.7, 0.72, 0.74, null, null])).verdict, /in the zone and big enough for 3 samples \(3\.0 s\), which is less than the rule needs/);
  assert.match(judge(rule, frames([0.7, 0.72, 0.74, 0.76, 0.78], (x) => truck(x, 0.12))).verdict, /too small/);
  assert.match(judge(rule, frames([0.1, 0.12, 0.14, 0.16, 0.18])).verdict, /outside the zone/);
  assert.match(judge(rule, frames([0.7, 0.72, 0.74, 0.76, 0.78], (x) => truck(x, 0.23, 0.3))).verdict, /too faint/);
  assert.match(judge(rule, [{ t: 0, detections: [{ label: 'person', score: 0.9, box: [0.7, 0.2, 0.75, 0.5] }] }]).verdict, /nothing of a type this rule wants/);
  assert.equal(judge(rule, frames([0.7, 0.72, 0.74, 0.76, 0.78])).best.why, 'counts');
});
