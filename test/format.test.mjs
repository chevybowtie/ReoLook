import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pad2, hhmmss, maskCredentials } from '../src/format.mjs';
import { formatReolinkTime, toReolinkTime } from '../src/client.mjs';

test('pad2 gives at least two digits', () => {
  assert.deepEqual([0, 7, 10, 59, 123].map(pad2), ['00', '07', '10', '59', '123']);
});

test('hhmmss is the local time of day with no separators', () => {
  assert.equal(hhmmss(new Date(2026, 9, 10, 7, 5, 3)), '070503');
  assert.equal(hhmmss(new Date(2026, 9, 10, 23, 59, 59)), '235959');
  assert.equal(hhmmss(new Date(2026, 0, 1, 0, 0, 0)), '000000');
});

test('a Reolink time shown as text is the same for a Date and for its fields', () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(formatReolinkTime(toReolinkTime(d)), '2026-01-02 03:04:05');
  assert.equal(formatReolinkTime({ year: 2026, mon: 11, day: 30, hour: 23, min: 9, sec: 0 }), '2026-11-30 23:09:00');
});

test('maskCredentials hides the password in addresses and leaves everything else alone', () => {
  assert.equal(maskCredentials('Error opening rtsp://observer:hunter2@10.0.0.9:554/h264Preview_01_main.'),
    'Error opening rtsp://observer:***@10.0.0.9:554/h264Preview_01_main.');
  assert.equal(maskCredentials('a rtmp://u:p%40ss@h/x and http://admin:pw@cam/y'), 'a rtmp://u:***@h/x and http://admin:***@cam/y');
  assert.equal(maskCredentials('rtsp://10.0.0.9:554/stream'), 'rtsp://10.0.0.9:554/stream', 'no user:password, nothing to hide');
  assert.equal(maskCredentials('rtsp://user@10.0.0.9/stream'), 'rtsp://user@10.0.0.9/stream');
  assert.equal(maskCredentials('plain text: with colon @ sign'), 'plain text: with colon @ sign');
});
