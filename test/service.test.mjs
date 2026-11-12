import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { startRecorders, startRetention, assertMounted } from '../src/service.mjs';

const cams = [{ name: 'Camera 3', host: '10.0.0.3' }, { name: 'Porch', host: '10.0.0.2' }];

test('config defaults: recorder off, main stream, retention unset and plan-only', () => {
  const c = normalize({ cameras: cams });
  assert.equal(c.record.enabled, false);
  assert.equal(c.record.stream, 'main');
  assert.equal(c.record.mode, 'motion');
  assert.equal(c.retention.apply, false);
  assert.equal(c.retention.maxAgeDays, null);
});

test('config rejects bad numbers and unknown camera ids', () => {
  assert.throws(() => normalize({ cameras: cams, retention: { maxAgeDays: -1 } }), /maxAgeDays/);
  assert.throws(() => normalize({ cameras: cams, retention: { maxSizeGB: 'lots' } }), /maxSizeGB/);
  assert.throws(() => normalize({ cameras: cams, record: { cameras: ['nope'] } }), /unknown camera/);
  assert.equal(normalize({ cameras: cams, record: { cameras: ['porch'] } }).record.cameras[0], 'porch');
});

test('record.mode accepts continuous and rejects unknown values', () => {
  assert.equal(normalize({ cameras: cams, record: { mode: 'continuous' } }).record.mode, 'continuous');
  assert.throws(() => normalize({ cameras: cams, record: { mode: 'always' } }), /record.mode/);
});

test('apply is only true when explicitly set', () => {
  assert.equal(normalize({ cameras: cams, retention: { apply: 'yes' } }).retention.apply, false);
  assert.equal(normalize({ cameras: cams, retention: { apply: true } }).retention.apply, true);
});

test('startRecorders: one recorder per selected camera, status tracks events, no credentials in status', () => {
  const made = [];
  const logs = [];
  const config = normalize({ root: '/r', cameras: cams, record: { enabled: true, cameras: ['camera-3'] } });
  const svc = startRecorders({ config, user: 'u', password: 'secret-pw', log: (m) => logs.push(m),
    makeRecorder: (o) => { const r = new EventEmitter(); r.start = () => {}; r.stop = async () => {}; r.opts = o; made.push(r); return r; } });
  assert.equal(made.length, 1);
  assert.equal(made[0].opts.stream, 'main');
  assert.equal(made[0].opts.always, false);
  made[0].emit('start', { file: '/r/10102026/x.part.mp4' });
  assert.equal(svc.status()[0].recording, true);
  made[0].emit('stop', { file: '/r/10102026/Camera 3-00-1-2.mp4', bytes: 5 });
  const st = svc.status()[0];
  assert.equal(st.recording, false);
  assert.equal(st.clips, 1);
  assert.ok(!JSON.stringify(svc.status()).includes('secret-pw'));
});

test('repeated identical errors are logged once', () => {
  let rec;
  const logs = [];
  const config = normalize({ root: '/r', cameras: cams, record: { enabled: true } });
  startRecorders({ config, user: 'u', password: 'p', log: (m) => logs.push(m),
    makeRecorder: (o) => { const r = new EventEmitter(); r.start = () => {}; r.stop = async () => {}; if (o.name === 'Camera 3') rec = r; return r; } });
  for (let i = 0; i < 50; i++) rec.emit('error', new Error('fetch failed'));
  assert.equal(logs.filter((l) => l.includes('fetch failed')).length, 1);
});

test('a past error stops being shown once the camera answers again', () => {
  let rec;
  const logs = [];
  const config = normalize({ root: '/r', cameras: cams, record: { enabled: true } });
  const svc = startRecorders({ config, user: 'u', password: 'p', log: (m) => logs.push(m),
    makeRecorder: (o) => { const r = new EventEmitter(); r.start = () => {}; r.stop = async () => {}; if (o.name === 'Camera 3') rec = r; return r; } });
  rec.emit('error', new Error('fetch failed'));
  assert.equal(svc.status().find((s) => s.name === 'Camera 3').lastError.message, 'fetch failed');
  rec.emit('recovered');
  assert.equal(svc.status().find((s) => s.name === 'Camera 3').lastError, null);
  assert.ok(logs.some((l) => /reachable again/.test(l)));
  rec.emit('recovered');                                     // nothing to clear: no second message
  assert.equal(logs.filter((l) => /reachable again/.test(l)).length, 1);
});

test('retention service reports only unless apply is set', async () => {
  const calls = [];
  const run = async (o) => { calls.push(o.apply); return { plan: { delete: [{ rel: 'a', bytes: 1 }], bytes: 1, total: 5, totalBytes: 9 }, deleted: 0, failed: 0 }; };
  const logs = [];
  const plan = startRetention({ config: normalize({ root: '/r', cameras: cams, retention: { maxAgeDays: 30 } }), log: (m) => logs.push(m), run });
  await plan.runNow(); plan.stop();
  assert.deepEqual(calls, [false]);
  assert.match(logs.at(-1), /plan only/);
  const on = startRetention({ config: normalize({ root: '/r', cameras: cams, retention: { maxAgeDays: 30, apply: true } }), log: () => {}, run });
  await on.runNow(); on.stop();
  assert.deepEqual(calls, [false, true]);
});

test('retention with no rules never schedules', () => {
  const s = startRetention({ config: normalize({ root: '/r', cameras: cams }), log: () => {}, run: async () => { throw new Error('should not run'); } });
  assert.equal(s.status().configured, false);
  s.stop();
});

test('assertMounted refuses a plain directory on the same device as its parent', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'mnt-'));
  await assert.rejects(() => assertMounted(d), /not mounted/);
  await assert.doesNotReject(() => assertMounted('/proc'), '/proc is a real mount point');
  await assert.rejects(() => assertMounted('/nonexistent/mount'), /ENOENT/);
  rmSync(d, { recursive: true, force: true });
});
