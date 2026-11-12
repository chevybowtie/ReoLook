// A stream joined part-way through a group of pictures has no picture size until the next key frame. With ffmpeg's
// default probe window a long wait for it made the recording fail ("dimensions not set") and be discarded. These tests
// run real ffmpeg on such a stream, and check the recorder asks for the longer window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CameraRecorder } from '../src/recorder.mjs';
import { RECORDER_PROBE, RECORDER_SILENCE_TIMEOUT_US } from '../src/ffinput.mjs';
import net from 'node:net';

const MUX = ['-map', '0:v', '-c', 'copy', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', '-y'];

/** A raw H.264 stream of 30 s at 15 fps with a key frame every 10 s, cut to start 2 s in: 8 s of pictures with no SPS/PPS before the next one. */
function midGopStream(dir) {
  const full = path.join(dir, 'full.h264');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-t', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '0',
    '-x264-params', 'keyint=150:min-keyint=150:scenecut=0', '-pix_fmt', 'yuv420p', '-f', 'h264', '-y', full]);
  const data = readFileSync(full);
  const starts = []; for (let i = 0; i + 2 < data.length; i++) if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) starts.push(i);
  const nals = starts.map((s, i) => ({ at: s > 0 && data[s - 1] === 0 ? s - 1 : s, type: data[s + 3] & 0x1f }));
  const slices = nals.filter((n) => n.type === 1 || n.type === 5);
  const cut = path.join(dir, 'midgop.h264');
  writeFileSync(cut, data.subarray(slices[30].at));       // from frame 30: a P frame
  return cut;
}
const record = (file, probe, out) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...probe, '-f', 'h264', '-framerate', '15', '-i', file, ...MUX, out], { encoding: 'utf8' });

test('with the default probe window a stream that joins mid-group fails to record; with the recorder\'s window it records', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'probe-'));
  const stream = midGopStream(dir);
  const short = record(stream, [], path.join(dir, 'short.mp4'));
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /dimensions not set/);
  const long = record(stream, ['-analyzeduration', String(RECORDER_PROBE.analyzeduration), '-probesize', String(RECORDER_PROBE.probesize)], path.join(dir, 'long.mp4'));
  assert.equal(long.status, 0, long.stderr);
  const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(dir, 'long.mp4')], { encoding: 'utf8' });
  assert.equal(info.trim(), '640,360');
  assert.ok(statSync(path.join(dir, 'long.mp4')).size > 1_000_000, 'the whole stream was kept');
  rmSync(dir, { recursive: true, force: true });
});

test('the recorder starts ffmpeg with the longer probe window, before the input', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'probe-'));
  let args = null;
  const spawnFn = (_cmd, a) => { args = a; const c = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => setImmediate(() => c.emit('exit', 0)); return c; };
  const rec = new CameraRecorder({ client: { motionState: async () => true, rtspUrl: () => 'rtsp://test/stream' }, name: 'Cam', outDir: dir, pollMs: 10, spawnFn, remux: false, always: true });
  rec.start();
  await new Promise((r) => setTimeout(r, 80));
  await rec.stop();
  assert.ok(args, 'ffmpeg was started');
  const i = args.indexOf('-i');
  assert.deepEqual(args.slice(args.indexOf('-analyzeduration'), args.indexOf('-analyzeduration') + 4), ['-analyzeduration', '15000000', '-probesize', '32000000']);
  assert.ok(args.indexOf('-analyzeduration') < i && args.indexOf('-probesize') < i);
  assert.deepEqual(args.slice(args.indexOf('-timeout'), args.indexOf('-timeout') + 2), ['-timeout', '10000000']);
  assert.ok(args.indexOf('-timeout') < i, 'an input option');
  assert.equal(args[i + 1], 'rtsp://test/stream');
  rmSync(dir, { recursive: true, force: true });
});

test('a camera that goes silent ends the recording by itself after the timeout, keeping what was recorded; without one ffmpeg stays blocked', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'silence-'));
  const stream = path.join(dir, 'full.h264');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-t', '10', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p', '-f', 'h264', '-y', stream]);
  const data = readFileSync(stream);
  // a "camera" on a TCP port: sends video for 3 seconds, then stays connected and silent
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock); sock.on('error', () => {});
    let i = 0; const t = setInterval(() => { if (i < data.length) { sock.write(data.subarray(i, i + 6000)); i += 6000; } }, 40);
    setTimeout(() => clearInterval(t), 3000);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `tcp://127.0.0.1:${server.address().port}`;
  /** Records from the camera until ffmpeg ends by itself or `giveUpMs` pass, when it is killed. */
  const run = (timeoutUs, out, giveUpMs) => new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(timeoutUs ? ['-timeout', String(timeoutUs)] : []), '-f', 'h264', '-framerate', '15', '-i', url, '-map', '0:v', '-c', 'copy',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', '-y', out];
    const p = spawn('ffmpeg', args, { stdio: 'ignore' }); const t0 = Date.now();
    const watchdog = setTimeout(() => p.kill('SIGKILL'), giveUpMs);
    p.on('exit', (code, signal) => { clearTimeout(watchdog); resolve({ ms: Date.now() - t0, killed: signal === 'SIGKILL' }); });
  });
  const [withTimeout, without] = await Promise.all([run(2_000_000, path.join(dir, 'with.mp4'), 8000), run(0, path.join(dir, 'without.mp4'), 6500)]);
  assert.equal(withTimeout.killed, false, 'it ended by itself');
  assert.ok(withTimeout.ms < 8000, `about 3 s of video plus the 2 s of silence (took ${withTimeout.ms} ms)`);
  assert.ok(statSync(path.join(dir, 'with.mp4')).size > 100_000, 'and kept what it had recorded');
  assert.equal(without.killed, true, 'with no timeout it was still waiting when it was stopped');
  assert.equal(RECORDER_SILENCE_TIMEOUT_US, 10_000_000);
  for (const s of sockets) s.destroy();
  server.close(); rmSync(dir, { recursive: true, force: true });
});
