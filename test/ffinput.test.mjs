import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputArgs } from '../src/ffinput.mjs';

test('a camera address is read over RTSP on TCP', () => {
  assert.deepEqual(inputArgs('rtsp://u:p@10.0.0.5:554/h264Preview_01_sub'), ['-rtsp_transport', 'tcp', '-i', 'rtsp://u:p@10.0.0.5:554/h264Preview_01_sub']);
});

test('a demo address is a generated picture played at real time, with its prefix removed', () => {
  assert.deepEqual(inputArgs('lavfi:testsrc=size=640x360'), ['-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360']);
});

test('anything that is not a demo address is treated as a camera address', () => {
  assert.deepEqual(inputArgs(undefined), ['-rtsp_transport', 'tcp', '-i', undefined]);
  assert.deepEqual(inputArgs('file.mp4'), ['-rtsp_transport', 'tcp', '-i', 'file.mp4']);
});

import { recorderInputArgs, RECORDER_PROBE } from '../src/ffinput.mjs';

test('recording allows a long wait for the first key frame, before the input, for a camera address only', () => {
  const rtsp = recorderInputArgs('rtsp://u:p@10.0.0.5:554/h264Preview_01_main');
  assert.deepEqual(rtsp, ['-analyzeduration', '15000000', '-probesize', '32000000', '-timeout', '10000000', '-rtsp_transport', 'tcp', '-i', 'rtsp://u:p@10.0.0.5:554/h264Preview_01_main']);
  assert.ok(['-analyzeduration', '-probesize', '-timeout'].every((o) => rtsp.indexOf(o) < rtsp.indexOf('-i')), 'input options: they apply to the input that follows');
  assert.deepEqual(recorderInputArgs('lavfi:testsrc'), inputArgs('lavfi:testsrc'), 'a generated demo picture has no key-frame wait');
  assert.deepEqual([RECORDER_PROBE.analyzeduration, RECORDER_PROBE.probesize], [15_000_000, 32_000_000]);
});
