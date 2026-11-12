// scanLibrary: what it returns, in what order, and how it treats files that disappear or do not belong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanLibrary } from '../src/retention.mjs';

const put = (root, rel, size) => { const p = path.join(root, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, Buffer.alloc(size)); };

test('every clip comes back with its size, camera and end time, newest day first and newest clip first within a day', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scan-'));
  put(root, '01012026/Porch-00-010000-010100.mp4', 100);
  put(root, '01012026/Porch-00-020000-020100.mp4', 200);
  put(root, '01022026/Garage-01-030000-030100.mp4', 300);
  const files = await scanLibrary(root);
  assert.deepEqual(files.map((f) => [f.rel, f.bytes, f.camera]), [
    ['01022026/Garage-01-030000-030100.mp4', 300, 'Garage'],
    ['01012026/Porch-00-020000-020100.mp4', 200, 'Porch'],
    ['01012026/Porch-00-010000-010100.mp4', 100, 'Porch'],
  ]);
  assert.ok(files.every((f) => f.end instanceof Date));
  assert.equal(files[0].end.getHours(), 3); assert.equal(files[0].end.getMinutes(), 1);
  rmSync(root, { recursive: true, force: true });
});

test('in-progress recordings, other layouts and other files are not part of the library', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scan-'));
  put(root, '01012026/Porch-00-010000-010100.mp4', 100);
  put(root, '01012026/Porch-00-020000-020100.part.mp4', 100);
  put(root, '01012026/readme.txt', 5);
  put(root, 'System Backup/x.mp4', 5);
  put(root, '3/2025-01-01/a.mp4', 5);
  assert.deepEqual((await scanLibrary(root)).map((f) => f.rel), ['01012026/Porch-00-010000-010100.mp4']);
  rmSync(root, { recursive: true, force: true });
});

test('a missing root, an empty root and a clip crossing midnight', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scan-'));
  assert.deepEqual(await scanLibrary(path.join(root, 'nope')), []);
  assert.deepEqual(await scanLibrary(root), []);
  put(root, '01012026/Porch-00-235900-000100.mp4', 1);
  const [f] = await scanLibrary(root);
  assert.equal(f.end.getDate(), 2, 'ends the next day');
  rmSync(root, { recursive: true, force: true });
});

test('a large day is measured completely', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scan-'));
  for (let i = 0; i < 300; i++) put(root, `01012026/Cam-00-${String(Math.floor(i / 60) + 1).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00-${String(Math.floor(i / 60) + 1).padStart(2, '0')}${String(i % 60).padStart(2, '0')}30.mp4`, i + 1);
  const files = await scanLibrary(root);
  assert.equal(files.length, 300);
  assert.equal(files.reduce((n, f) => n + f.bytes, 0), (300 * 301) / 2);
  rmSync(root, { recursive: true, force: true });
});
