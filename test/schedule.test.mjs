import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { modeAt, isSchedule, fullWeek, summary } from '../src/schedule.mjs';
import { normalize } from '../src/config.mjs';
import { checkPatch, SettingsError } from '../src/settings.mjs';
import { CameraRecorder } from '../src/recorder.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const week = (fn) => Array.from({ length: 168 }, (_, i) => fn(Math.floor(i / 24), i % 24)).join('');

test('modeAt reads the cell for the local day and hour, Sunday first', () => {
  const s = week((d, h) => (d === 1 && h === 9 ? 'c' : d === 1 && h === 10 ? 'm' : '0'));
  assert.equal(modeAt(s, new Date(2026, 9, 12, 9, 30)), 'continuous'); // Monday 12 Oct 2026
  assert.equal(modeAt(s, new Date(2026, 9, 12, 10, 0)), 'motion');
  assert.equal(modeAt(s, new Date(2026, 9, 12, 11, 59)), 'off');
  assert.equal(modeAt(s, new Date(2026, 9, 11, 9, 30)), 'off'); // Sunday
});

test('only 168 characters of 0, m, c are a schedule', () => {
  assert.equal(isSchedule(fullWeek('motion')), true);
  assert.equal(isSchedule(fullWeek('continuous')), true);
  for (const bad of ['', 'm'.repeat(167), 'm'.repeat(169), 'x'.repeat(168), null, 7, 'M'.repeat(168)]) assert.equal(isSchedule(bad), false, String(bad));
  assert.deepEqual(summary('0'.repeat(100) + 'm'.repeat(60) + 'c'.repeat(8)), { off: 100, motion: 60, continuous: 8 });
});

test('config and settings refuse a malformed schedule and accept null', () => {
  assert.equal(normalize({ record: {} }).record.schedule, null);
  assert.equal(normalize({ record: { schedule: fullWeek() } }).record.schedule, fullWeek());
  assert.throws(() => normalize({ record: { schedule: 'mmm' } }), /record\.schedule/);
  assert.doesNotThrow(() => checkPatch({ record: { schedule: null } }));
  assert.doesNotThrow(() => checkPatch({ record: { schedule: fullWeek() } }));
  assert.throws(() => checkPatch({ record: { schedule: 'nope' } }), SettingsError);
});

function fakeFfmpeg() {
  return (_c, args) => {
    const out = args.at(-1), child = new EventEmitter();
    child.stderr = new EventEmitter();
    let n = 10_000; writeFileSync(out, Buffer.alloc(n));
    const t = setInterval(() => { n += 5000; writeFileSync(out, Buffer.alloc(n)); }, 10);
    child.kill = () => { clearInterval(t); setImmediate(() => child.emit('exit', 0)); };
    return child;
  };
}

test('the recorder follows the schedule: off asks nothing and records nothing, continuous records without motion, leaving ends the clip', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sch-'));
  let mode = 'off', polls = 0;
  const client = { motionState: async () => { polls++; return false; }, rtspUrl: () => 'rtsp://x' };
  const rec = new CameraRecorder({ client, name: 'C', outDir: dir, pollMs: 10, postRollMs: 60, stallMs: 500, startGraceMs: 0, spawnFn: fakeFfmpeg(), remux: false, modeAt: () => mode });
  const events = [];
  for (const e of ['start', 'stop', 'discard', 'error']) rec.on(e, () => events.push(e));
  const files = () => readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.mp4'));
  rec.start();
  await sleep(80);
  assert.equal(polls, 0, 'no motion polling while the schedule is off');
  assert.deepEqual(files(), []);
  mode = 'continuous';
  await sleep(120);
  assert.ok(rec.recording, 'continuous hours record with no motion');
  mode = 'off';
  await sleep(120);
  assert.equal(rec.recording, false, 'the clip is closed as soon as the hour ends');
  assert.equal(files().length, 1);
  mode = 'motion';
  await sleep(60);
  assert.ok(polls > 0, 'motion hours ask the camera');
  assert.equal(rec.recording, false, 'and record nothing without motion');
  await rec.stop();
  rmSync(dir, { recursive: true, force: true });
});
