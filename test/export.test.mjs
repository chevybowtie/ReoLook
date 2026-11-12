import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeName, uniquePath, checkDest, copyFileTo, cutParts } from '../src/export.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'exp-'));
const clip = (file, seconds, color) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=160x120:rate=10`,
  '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '5', '-y', file]);
const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

test('safeName strips path and control characters', () => {
  assert.equal(safeName('Front porch - out'), 'Front porch - out');
  assert.equal(safeName('../etc/passwd'), '.._etc_passwd');
  assert.equal(safeName('a:b*c?"<>|\n'), 'a_b_c______');
  assert.equal(safeName('   '), 'clip');
});

test('uniquePath never returns an existing file', async () => {
  const d = tmp();
  writeFileSync(path.join(d, 'x.mp4'), '1'); writeFileSync(path.join(d, 'x (2).mp4'), '1');
  assert.equal(path.basename(await uniquePath(d, 'x', '.mp4')), 'x (3).mp4');
  assert.equal(path.basename(await uniquePath(d, 'y', '.mp4')), 'y.mp4');
  rmSync(d, { recursive: true, force: true });
});

test('checkDest: relative, inside the library, unwritable and too-small destinations are refused', async () => {
  const root = tmp(), out = tmp();
  await assert.rejects(() => checkDest('relative/dir'), /absolute/);
  await assert.rejects(() => checkDest(''), /choose a folder/);
  await assert.rejects(() => checkDest(path.join(root, 'sub'), { root }), /outside the recordings library/);
  await assert.rejects(() => checkDest(root, { root }), /outside the recordings library/);
  await assert.rejects(() => checkDest(out, { needBytes: 1e18 }), /not enough free space/);
  assert.equal(await checkDest(path.join(out, 'new', 'folder'), { root }), path.join(out, 'new', 'folder'), 'creates it');
  if (process.getuid?.() !== 0) {
    const ro = path.join(out, 'ro'); mkdirSync(ro); chmodSync(ro, 0o500);
    await assert.rejects(() => checkDest(ro), /no write permission/);
    chmodSync(ro, 0o700);
  }
  for (const d of [root, out]) rmSync(d, { recursive: true, force: true });
});

test('copyFileTo copies with progress, never overwrites, and leaves no .part', async () => {
  const src = tmp(), out = tmp();
  const f = path.join(src, 'a.mp4'); writeFileSync(f, Buffer.alloc(300_000, 7));
  const seen = [];
  const r1 = await copyFileTo({ src: f, destDir: out, name: 'Camera 3 clip', onProgress: (p) => seen.push(p) });
  const r2 = await copyFileTo({ src: f, destDir: out, name: 'Camera 3 clip' });
  assert.equal(path.basename(r1.file), 'Camera 3 clip.mp4');
  assert.equal(path.basename(r2.file), 'Camera 3 clip (2).mp4');
  assert.equal(readFileSync(r1.file).length, 300_000);
  assert.ok(seen.length > 0 && seen.at(-1) === 1);
  assert.deepEqual(readdirSync(out).filter((n) => n.endsWith('.part')), []);
  for (const d of [src, out]) rmSync(d, { recursive: true, force: true });
});

test('copyFileTo aborts cleanly and removes the partial file', async () => {
  const src = tmp(), out = tmp();
  const f = path.join(src, 'big.mp4'); writeFileSync(f, Buffer.alloc(20_000_000, 1));
  const ac = new AbortController();
  const p = copyFileTo({ src: f, destDir: out, name: 'big', signal: ac.signal, onProgress: () => ac.abort() });
  await assert.rejects(p);
  assert.deepEqual(readdirSync(out), []);
  for (const d of [src, out]) rmSync(d, { recursive: true, force: true });
});

test('cutParts joins ranges from two clips into one MP4 of the right length', async () => {
  const src = tmp(), out = tmp();
  const a = path.join(src, 'a.mp4'), b = path.join(src, 'b.mp4');
  clip(a, 6, 'red'); clip(b, 6, 'blue');
  const prog = [];
  const r = await cutParts({ destDir: out, name: 'Cam 2026-09-24 000000-000008',
    parts: [{ file: a, seek: 3, duration: 3 }, { file: b, seek: 0, duration: 4 }], onProgress: (p) => prog.push(p) });
  const d = duration(r.file);
  assert.ok(d > 6 && d < 8, `expected about 7 s, got ${d}`);
  assert.equal(path.basename(r.file), 'Cam 2026-09-24 000000-000008.mp4');
  assert.ok(prog.at(-1) === 1 && prog.every((p) => p >= 0 && p <= 1));
  assert.deepEqual(readdirSync(out), ['Cam 2026-09-24 000000-000008.mp4'], 'no temp folders or .part files left');
  for (const d2 of [src, out]) rmSync(d2, { recursive: true, force: true });
});

test('cutParts on a single clip, and a failing input leaves nothing behind', async () => {
  const src = tmp(), out = tmp();
  const a = path.join(src, 'a.mp4'); clip(a, 5, 'green');
  const r = await cutParts({ destDir: out, name: 'one', parts: [{ file: a, seek: 1, duration: 2 }] });
  assert.ok(duration(r.file) > 1.5 && duration(r.file) < 3.5);
  writeFileSync(path.join(src, 'junk.mp4'), 'not a video');
  await assert.rejects(() => cutParts({ destDir: out, name: 'two', parts: [{ file: path.join(src, 'junk.mp4'), seek: 0, duration: 1 }] }), /ffmpeg failed/);
  assert.deepEqual(readdirSync(out), ['one.mp4']);
  await assert.rejects(() => cutParts({ destDir: out, name: 'none', parts: [] }), /nothing to export/);
  for (const d of [src, out]) rmSync(d, { recursive: true, force: true });
});

test('cutParts can be cancelled mid-way and cleans up', async () => {
  const src = tmp(), out = tmp();
  const a = path.join(src, 'a.mp4'); clip(a, 8, 'white');
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => cutParts({ destDir: out, name: 'x', parts: [{ file: a, seek: 0, duration: 5 }], signal: ac.signal }));
  assert.deepEqual(readdirSync(out), []);
  for (const d of [src, out]) rmSync(d, { recursive: true, force: true });
});
