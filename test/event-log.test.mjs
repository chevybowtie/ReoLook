// EventLog keeps detector events in a JSON-lines file: an event is a line, a verdict or appearance score
// is a patch line. These tests pin how the file is replayed, since loading is what grows with age.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventLog } from '../src/detect/events.mjs';

function rig(max = 5000) {
  const dir = mkdtempSync(path.join(tmpdir(), 'evlog-'));
  const file = path.join(dir, 'detections.jsonl'), pics = path.join(dir, 'pics');
  return { dir, file, pics, open: (m = max) => new EventLog({ file, dir: pics, max: m }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const ev = (n, o = {}) => ({ at: `2026-11-0${1 + (n % 9)}T10:00:00`, camera: `cam${n % 2}`, type: n % 3 === 0 ? 'left' : 'stopped', ruleId: 'r1', ...o });

test('events come back newest first, filtered by day, camera and kind, and limited', async () => {
  const r = rig(); const log = r.open();
  const added = [];
  for (let i = 0; i < 6; i++) added.push(await log.add(ev(i)));
  const all = await log.list();
  assert.deepEqual(all.map((e) => e.id), added.map((e) => e.id).reverse());
  assert.deepEqual((await log.list({ camera: 'cam1' })).map((e) => e.camera), ['cam1', 'cam1', 'cam1']);
  assert.deepEqual((await log.list({ kind: 'left' })).map((e) => e.type), ['left', 'left']);
  assert.deepEqual((await log.list({ day: '2026-11-02' })).map((e) => e.id), [added[1].id]);
  assert.equal((await log.list({ limit: 2 })).length, 2);
  assert.deepEqual((await log.list({ limit: 2 })).map((e) => e.id), [added[5].id, added[4].id], 'the newest two');
  r.cleanup();
});

test('an added event gets an id, its day and no verdict, and a picture is stored beside it', async () => {
  const r = rig(); const log = r.open();
  const e = await log.add(ev(1), Buffer.from('JPEG'));
  assert.match(e.id, /^[0-9a-z]+$/);
  assert.equal(e.day, '2026-11-02');
  assert.equal(e.verdict, null);
  assert.deepEqual(readFileSync(log.snapshotPath(e)), Buffer.from('JPEG'));
  assert.equal(log.snapshotPath(await log.add(ev(2))), null, 'no picture, no path');
  assert.equal((await log.get(e.id)).id, e.id);
  assert.equal(await log.get('nope'), null);
  r.cleanup();
});

test('verdicts and appearance scores are patches that a new reader sees applied', async () => {
  const r = rig(); const log = r.open();
  const a = await log.add(ev(1)), b = await log.add(ev(2));
  await log.setVerdict(a.id, 'yes');
  await log.setLook(b.id, 0.83, 'unseen');
  await log.setVerdict(a.id, 'no');
  const again = r.open();
  const byId = Object.fromEntries((await again.list()).map((e) => [e.id, e]));
  assert.equal(byId[a.id].verdict, 'no', 'the last patch wins');
  assert.equal(byId[b.id].look, 0.83);
  assert.equal(byId[b.id].lookKind, 'unseen');
  assert.equal(byId[b.id].verdict, null);
  assert.equal(readFileSync(r.file, 'utf8').trim().split('\n').length, 5, 'two events and three patch lines');
  r.cleanup();
});

test('setVerdict accepts yes, no or null only, and says null for an unknown event', async () => {
  const r = rig(); const log = r.open();
  const a = await log.add(ev(1));
  await assert.rejects(log.setVerdict(a.id, 'maybe'), /verdict must be yes, no or null/);
  assert.equal((await log.setVerdict(a.id, null)).verdict, null);
  assert.equal(await log.setVerdict('nope', 'yes'), null);
  assert.equal(await log.setLook('nope', 1, 'seen'), null);
  r.cleanup();
});

test('replay skips damaged lines and patches for events that are not there', async () => {
  const r = rig();
  writeFileSync(r.file, [
    JSON.stringify({ id: 'a', at: '2026-11-01T10:00:00', day: '2026-11-01', camera: 'c', type: 'stopped', verdict: null }),
    'this is not json',
    JSON.stringify({ patch: 'ghost', set: { verdict: 'yes' } }),
    '',
    JSON.stringify({ patch: 'a', set: { verdict: 'yes' } }),
    '{"id":"b","at":"2026-11-01T11:00:00","day":"2026-11-01","camera":"c","type":"stopped","verdict":null}',
  ].join('\n') + '\n');
  const out = await r.open().list();
  assert.deepEqual(out.map((e) => [e.id, e.verdict]), [['b', null], ['a', 'yes']]);
  r.cleanup();
});

test('only the newest `max` events are kept, and a patch for one that was dropped is ignored', async () => {
  const r = rig();
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ id: `e${i}`, at: '2026-11-01T10:00:00', day: '2026-11-01', camera: 'c', type: 'stopped', verdict: null }));
  lines.push(JSON.stringify({ patch: 'e1', set: { verdict: 'yes' } }), JSON.stringify({ patch: 'e8', set: { verdict: 'no' } }));
  writeFileSync(r.file, lines.join('\n') + '\n');
  const out = await r.open(3).list();
  assert.deepEqual(out.map((e) => [e.id, e.verdict]), [['e9', null], ['e8', 'no'], ['e7', null]]);
  r.cleanup();
});

test('lines another process appends are picked up on the next read', async () => {
  const r = rig(); const log = r.open();
  await log.add(ev(1));
  assert.equal((await log.list()).length, 1);
  appendFileSync(r.file, JSON.stringify({ id: 'from-replay', at: '2026-11-01T12:00:00', day: '2026-11-01', camera: 'c', type: 'stopped', verdict: null }) + '\n');
  assert.deepEqual((await log.list()).map((e) => e.id).includes('from-replay'), true);
  r.cleanup();
});

test('remove drops the event and its picture, and a later reader of the same session no longer sees it', async () => {
  const r = rig(); const log = r.open();
  const e = await log.add(ev(1), Buffer.from('JPEG'));
  const pic = log.snapshotPath(e);
  assert.ok(existsSync(pic));
  assert.equal(await log.remove(e.id), true);
  assert.equal(await log.remove(e.id), false);
  assert.ok(!existsSync(pic));
  assert.equal(await log.get(e.id), null);
  r.cleanup();
});

test('a removed event stays removed after a restart, and does not take up one of the kept slots', async () => {
  const r = rig(3); const log = r.open();
  const [a, b, c] = [await log.add(ev(1), Buffer.from('JPEG')), await log.add(ev(2)), await log.add(ev(3))];
  await log.remove(b.id);
  const reopened = r.open();
  assert.deepEqual((await reopened.list()).map((e) => e.id), [c.id, a.id]);
  assert.equal(await reopened.get(b.id), null);
  assert.equal(await reopened.remove(b.id), false, 'already gone');
  // events added afterwards must not push out older kept ones just because a removed line is in the file
  const d = await reopened.add(ev(4));
  assert.deepEqual((await r.open().list()).map((e) => e.id), [d.id, c.id, a.id]);
  r.cleanup();
});

test('a removal written by an earlier version of the file is honoured when it is read', async () => {
  const r = rig();
  writeFileSync(r.file, [
    JSON.stringify({ id: 'a', at: '2026-11-01T10:00:00', day: '2026-11-01', camera: 'c', type: 'stopped', verdict: null }),
    JSON.stringify({ id: 'b', at: '2026-11-01T11:00:00', day: '2026-11-01', camera: 'c', type: 'stopped', verdict: null }),
    JSON.stringify({ patch: 'a', set: { removed: true } }),
  ].join('\n') + '\n');
  assert.deepEqual((await r.open().list()).map((e) => e.id), ['b']);
  r.cleanup();
});

test('a large history loads correctly, with patches landing on the right events', async () => {
  const r = rig();
  const N = 4000, lines = [];
  for (let i = 0; i < N; i++) lines.push(JSON.stringify({ id: `e${i}`, at: '2026-11-01T10:00:00', day: '2026-11-01', camera: 'c', type: 'stopped', verdict: null }));
  for (let i = 0; i < N; i += 2) lines.push(JSON.stringify({ patch: `e${i}`, set: { verdict: i % 4 === 0 ? 'yes' : 'no' } }));
  writeFileSync(r.file, lines.join('\n') + '\n');
  const out = await r.open().list({ limit: N });
  assert.equal(out.length, N);
  for (const e of out) {
    const i = Number(e.id.slice(1));
    assert.equal(e.verdict, i % 2 ? null : i % 4 === 0 ? 'yes' : 'no', e.id);
  }
  r.cleanup();
});
