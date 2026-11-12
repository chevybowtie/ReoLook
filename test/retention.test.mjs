import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planRetention, runRetention } from '../src/retention.mjs';

const GB = 1024 ** 3, DAY = 86_400_000, NOW = Date.UTC(2026, 9, 10, 12);
const f = (rel, daysAgo, gb = 1) => ({ rel, bytes: gb * GB, end: new Date(NOW - daysAgo * DAY) });

test('age rule deletes only clips older than the limit, oldest first', () => {
  const p = planRetention({ now: NOW, maxAgeDays: 30, files: [f('b', 40), f('a', 90), f('keep', 5)] });
  assert.deepEqual(p.delete.map((x) => x.rel), ['a', 'b']);
  assert.equal(p.bytes, 2 * GB);
});

test('size rule trims oldest clips until under the cap', () => {
  const files = [f('d1', 4), f('d2', 3), f('d3', 2), f('d4', 1)];
  const p = planRetention({ now: NOW, maxSizeGB: 2, files });
  assert.deepEqual(p.delete.map((x) => x.rel), ['d1', 'd2']);
  assert.match(p.delete[0].reason, /over 2 GB/);
});

test('free-space rule frees enough to reach the floor', () => {
  const files = [f('d1', 4), f('d2', 3), f('d3', 2)];
  const p = planRetention({ now: NOW, minFreeGB: 10, freeBytes: 8 * GB, files });
  assert.deepEqual(p.delete.map((x) => x.rel), ['d1', 'd2']); // 8 + 2 = 10
});

test('rules combine without double counting', () => {
  const files = [f('old', 100), f('d1', 4), f('d2', 3), f('d3', 2)];
  const p = planRetention({ now: NOW, maxAgeDays: 30, maxSizeGB: 2, files });
  assert.deepEqual(p.delete.map((x) => x.rel), ['old', 'd1']);
});

test('recent clips are protected even if the caps cannot be met', () => {
  const fresh = { rel: 'fresh', bytes: 50 * GB, end: new Date(NOW - 10 * 60_000) };
  const p = planRetention({ now: NOW, maxSizeGB: 1, maxAgeDays: 0, files: [fresh, f('old', 2)] });
  assert.deepEqual(p.delete.map((x) => x.rel), ['old']);
});

test('no rules means no deletions', () => {
  assert.equal(planRetention({ now: NOW, files: [f('a', 999)] }).delete.length, 0);
});

function drive() {
  const root = mkdtempSync(path.join(tmpdir(), 'ret-'));
  const put = (rel, size = 10) => { const p = path.join(root, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, Buffer.alloc(size)); };
  put('01012026/Camera 3-00-010000-010100.mp4');        // old day: candidate
  put('01012026/Camera 3-00-020000-020100.mp4');
  put('01022026/Camera 3-00-010000-010100.mp4');        // old day, will leave an empty dir after delete
  put('10102026/Camera 3-00-110000-110100.mp4');        // "today" in the tests: kept
  put('3/2025-01-01/55/55-video.h264.mp4');             // foreign layout: must survive
  put('01012026/notes.txt');                            // foreign file in a day dir: must survive
  put('System Backup/keep.bin');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const NOW2 = new Date(2026, 9, 10, 12, 0, 0).getTime();

test('plan-only (apply=false) deletes nothing', async () => {
  const d = drive();
  const r = await runRetention({ root: d.root, policy: { maxAgeDays: 30 }, apply: false, now: NOW2 });
  assert.equal(r.plan.delete.length, 3);
  assert.equal(r.deleted, 0);
  assert.ok(existsSync(path.join(d.root, '01012026/Camera 3-00-010000-010100.mp4')));
  d.cleanup();
});

test('apply deletes only layout clips, removes emptied day dirs, leaves everything else', async () => {
  const d = drive();
  const r = await runRetention({ root: d.root, policy: { maxAgeDays: 30 }, apply: true, now: NOW2 });
  assert.equal(r.deleted, 3);
  assert.ok(!existsSync(path.join(d.root, '01012026/Camera 3-00-010000-010100.mp4')));
  assert.ok(!existsSync(path.join(d.root, '01022026')), 'emptied day dir removed');
  assert.ok(existsSync(path.join(d.root, '01012026/notes.txt')), 'foreign file kept, so its dir is kept');
  assert.ok(existsSync(path.join(d.root, '10102026/Camera 3-00-110000-110100.mp4')), 'recent clip kept');
  assert.ok(existsSync(path.join(d.root, '3/2025-01-01/55/55-video.h264.mp4')), 'other layouts untouched');
  assert.ok(existsSync(path.join(d.root, 'System Backup/keep.bin')));
  d.cleanup();
});

test('a missing or empty root plans nothing and does not throw', async () => {
  const r = await runRetention({ root: '/nonexistent/root', policy: { maxAgeDays: 1 }, apply: true });
  assert.equal(r.plan.delete.length, 0);
});
