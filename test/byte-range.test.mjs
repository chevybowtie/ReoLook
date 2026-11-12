import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byteRange } from '../src/byte-range.mjs';

test('a closed range, an open-ended range and a suffix range', () => {
  assert.deepEqual(byteRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(byteRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(byteRange('bytes=-5', 100), { start: 95, end: 99 });
  assert.deepEqual(byteRange('bytes=0-0', 100), { start: 0, end: 0 }, 'a single byte');
});

test('an end beyond the file is clamped; a suffix longer than the file starts at the beginning', () => {
  assert.deepEqual(byteRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange('bytes=-500', 100), { start: 0, end: 99 });
});

test('a range outside the file is unsatisfiable', () => {
  assert.equal(byteRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(byteRange('bytes=150-200', 100), 'unsatisfiable');
  assert.equal(byteRange('bytes=50-10', 100), 'unsatisfiable', 'ends before it starts');
  assert.equal(byteRange('bytes=-0', 100), 'unsatisfiable', 'the last zero bytes');
  assert.equal(byteRange('bytes=0-', 0), 'unsatisfiable', 'an empty file has no bytes to give');
});

test('anything that is not a single bytes range means "send everything"', () => {
  for (const h of [undefined, '', 'bytes=', 'bytes=-', 'items=0-5', 'bytes=0-5,10-20', 'bytes 0-5', 'bytes=a-b', 'BYTES=0-5']) assert.equal(byteRange(h, 100), null, String(h));
});
