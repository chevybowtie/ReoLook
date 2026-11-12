import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MotionGate } from '../src/gate.mjs';

const S = 1000;

test('idle until motion, then starts', () => {
  const g = new MotionGate({ postRollMs: 15 * S });
  assert.equal(g.update(false, 0), null);
  assert.equal(g.update(true, 1 * S), 'start');
  assert.equal(g.recording, true);
});

test('keeps recording through post-roll, stops after it', () => {
  const g = new MotionGate({ postRollMs: 15 * S });
  g.update(true, 0);
  assert.equal(g.update(false, 14 * S), null);
  assert.equal(g.update(false, 15 * S), 'stop');
  assert.equal(g.recording, false);
});

test('new motion inside post-roll extends the recording', () => {
  const g = new MotionGate({ postRollMs: 15 * S });
  g.update(true, 0);
  g.update(true, 10 * S);
  assert.equal(g.update(false, 24 * S), null);
  assert.equal(g.update(false, 25 * S), 'stop');
});

test('rolls to a new segment at the maximum length while motion continues', () => {
  const g = new MotionGate({ postRollMs: 15 * S, maxSegmentMs: 60 * S });
  g.update(true, 0);
  assert.equal(g.update(true, 59 * S), null);
  assert.equal(g.update(true, 60 * S), 'roll');
  assert.equal(g.update(true, 61 * S), null);
});

test('reset lets motion start a fresh recording', () => {
  const g = new MotionGate();
  g.update(true, 0);
  g.reset();
  assert.equal(g.update(true, 1 * S), 'start');
});
