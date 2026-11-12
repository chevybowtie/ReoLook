import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRepairs, addNote, summarise } from '../src/repairs.mjs';

const at = (m) => new Date(Date.UTC(2026, 9, 21, 12, m, 0)).toISOString();

test('repairs are grouped into episodes per camera, with notes kept in order', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rep-'));
  const file = path.join(dir, 'r.jsonl');
  assert.deepEqual(await readRepairs(file), []);
  const entries = [
    { key: 'front-porch:sub', at: at(0), recording: false }, { key: 'front-porch:sub', at: at(2) }, { key: 'front-porch:sub', at: at(4) },
    { key: 'living-room:sub', at: at(3), recording: true },
    { key: 'front-porch:sub', at: at(30) },
  ];
  const s = summarise([...entries, { at: at(10), note: 'swapped the cable' }]);
  assert.equal(s.cameras['front-porch'].repairs, 4);
  assert.deepEqual(s.cameras['front-porch'].episodes.map((e) => e.count), [3, 1], 'two minutes apart is one episode; half an hour later is another');
  assert.equal(s.cameras['living-room'].recording, 1);
  assert.deepEqual(s.notes.map((n) => n.note), ['swapped the cable']);
  assert.equal(summarise(entries, { sinceMs: Date.parse(at(20)) }).cameras['front-porch'].repairs, 1, 'only the window asked for');
  await addNote('moved Front Porch to port 5', file, new Date(at(40)));
  assert.equal((await readRepairs(file))[0].note, 'moved Front Porch to port 5');
  rmSync(dir, { recursive: true, force: true });
});
