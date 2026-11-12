import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listDays, listClips, idOf, relOf } from '../src/library.mjs';

function tree() {
  const root = mkdtempSync(path.join(tmpdir(), 'lib-'));
  const touch = (rel) => {
    const f = path.join(root, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, 'x');
  };
  touch('10102026/Camera 3-00-052558-053058.mp4');
  touch('10102026/Front porch - out-00-235950-000030.mp4');   // crosses midnight
  touch('10102026/Camera 3-00-060000.part.mp4');              // in progress: ignored
  touch('10102026/notes.txt');
  touch('10092026/Camera 3-00-010101-010202.mp4');
  touch('3/2026-10-10/587435/587435-video.h264.mp4');         // not part of this layout: ignored
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('id round-trips paths with spaces', () => {
  const rel = '10102026/Front porch - out-00-235950-000030.mp4';
  assert.equal(relOf(idOf(rel)), rel);
});

test('listDays returns recording days newest first and ignores other folders', async () => {
  const t = tree();
  assert.deepEqual(await listDays(t.root), ['2026-10-10', '2026-10-09']);
  assert.deepEqual(await listDays('/nonexistent/path'), []);
  t.cleanup();
});

test('listClips parses names, handles midnight crossing, skips .part and strangers', async () => {
  const t = tree();
  const clips = await listClips(t.root, '2026-10-10');
  assert.equal(clips.length, 2);
  const cross = clips.find((c) => c.camera === 'Front porch - out');
  assert.equal(new Date(cross.start).getDate(), 10);
  assert.equal(new Date(cross.end).getDate(), 11, 'end rolls to the next day');
  assert.equal(clips[0].camera, 'Front porch - out', 'newest first');
  assert.deepEqual(await listClips(t.root, '2026-01-01'), []);
  t.cleanup();
});
