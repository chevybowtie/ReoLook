import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CameraRecorder } from '../src/recorder.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake ffmpeg: writes `bytes` to the output path on spawn, exits on kill. */
function fakeFfmpeg({ bytes = 10_000, grow = false, dieAfterMs = null, dieSays = 'boom' } = {}) {
  const spawned = [];
  const fn = (_cmd, args) => {
    const out = args.at(-1);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    let n = bytes;
    writeFileSync(out, Buffer.alloc(n));
    let t = null;
    if (grow) t = setInterval(() => { n += 5000; writeFileSync(out, Buffer.alloc(n)); }, 10);
    const exit = () => { clearInterval(t); setImmediate(() => child.emit('exit', 0)); };
    child.kill = () => exit();
    if (dieAfterMs != null) setTimeout(() => { child.stderr.emit('data', dieSays); exit(); }, dieAfterMs);
    spawned.push(out);
    return child;
  };
  fn.spawned = spawned;
  return fn;
}

function setup(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'reolook-'));
  let motion = false;
  const client = { motionState: async () => motion, rtspUrl: () => 'rtsp://test/stream' };
  const spawnFn = opts.spawnFn ?? fakeFfmpeg({ grow: true });
  const rec = new CameraRecorder({
    client, name: 'Cam: 1', outDir: dir, pollMs: 10, postRollMs: 60, stallMs: 80, startGraceMs: 0, spawnFn, remux: false, ...opts.rec,
  });
  const events = [];
  for (const e of ['start', 'stop', 'discard', 'mismatch', 'error']) rec.on(e, (x) => events.push([e, x]));
  const files = () => readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.mp4'));
  return { dir, rec, client, events, files, setMotion: (m) => { motion = m; }, spawnFn,
    cleanup: async () => { await rec.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('records on motion, finalizes to MMDDYYYY/<Name>-00-start-end.mp4', async () => {
  const t = setup();
  t.rec.start();
  await sleep(50);
  assert.deepEqual(t.files(), [], 'nothing recorded without motion');
  t.setMotion(true);
  await sleep(60);
  t.setMotion(false);
  await sleep(250);
  const files = t.files();
  assert.equal(files.length, 1, JSON.stringify(t.events));
  assert.match(files[0], /^\d{8}[\\/]Cam_ 1-00-\d{6}-\d{6}\.mp4$/);
  assert.ok(t.events.some(([e]) => e === 'stop'));
  await t.cleanup();
});

test('discards a recording that produced no usable data', async () => {
  const t = setup({ spawnFn: fakeFfmpeg({ bytes: 28 }) });
  t.rec.start();
  t.setMotion(true);
  await sleep(50);
  t.setMotion(false);
  await sleep(250);
  assert.deepEqual(t.files(), []);
  assert.ok(t.events.some(([e]) => e === 'discard'));
  await t.cleanup();
});

test('watchdog gives a recording that has written nothing yet extra time to finish probing', async () => {
  const t = setup({ spawnFn: fakeFfmpeg({ bytes: 0 }), rec: { startGraceMs: 400 } }); // stallMs 80 + grace 400
  t.rec.start();
  t.setMotion(true);
  await sleep(300);
  assert.ok(!t.events.some(([e, x]) => e === 'error' && /no data/.test(x.message)), 'still probing, not stalled: ' + JSON.stringify(t.events));
  await sleep(500);
  assert.ok(t.events.some(([e, x]) => e === 'error' && /no data/.test(x.message)), 'a start that never produces data is still restarted');
  await t.cleanup();
});

test('watchdog restarts a recording whose file stops growing', async () => {
  const t = setup({ spawnFn: fakeFfmpeg({ grow: false }) }); // writes once, never grows
  t.rec.start();
  t.setMotion(true);
  await sleep(500);
  assert.ok(t.events.some(([e, x]) => e === 'error' && /no data/.test(x.message)), JSON.stringify(t.events));
  assert.ok(t.spawnFn.spawned.length >= 2, 'a fresh recording started after the stall');
  await t.cleanup();
});

test('an ffmpeg that dies early is finalized and motion restarts it', async () => {
  const t = setup({ spawnFn: fakeFfmpeg({ grow: true, dieAfterMs: 40 }) });
  t.rec.start();
  t.setMotion(true);
  await sleep(400);
  assert.ok(t.events.some(([e, x]) => e === 'error' && /exited early/.test(x.message)));
  assert.ok(t.spawnFn.spawned.length >= 2);
  assert.ok(t.files().length >= 1, 'partial recording kept');
  await t.cleanup();
});

test('stop() while the motion check is still in flight does not start a recording afterwards', async () => {
  const t = setup();
  t.client.motionState = async () => { await sleep(60); return true; };   // a slow camera: the tick is waiting when stop() arrives
  t.rec.start();
  await sleep(20);
  await t.rec.stop();
  await sleep(200);
  assert.equal(t.spawnFn.spawned.length, 0, 'no ffmpeg was started after stop()');
  assert.equal(t.rec.recording, false);
  assert.deepEqual(t.files(), []);
  rmSync(t.dir, { recursive: true, force: true });
});

test('stop() while a recording is being opened leaves nothing running', async () => {
  const t = setup({ rec: { guard: async () => { await sleep(60); } } });
  t.setMotion(true);
  t.rec.start();
  await sleep(30);                                                          // the guard is still running
  await t.rec.stop();
  assert.equal(t.rec.recording, false, 'no recording is left open');
  const files = t.files();
  await sleep(200);
  assert.deepEqual(t.files(), files, 'and nothing is still being written');
  assert.ok(!t.files().some((f) => f.includes('.part.')), 'no unfinished file is left behind');
  rmSync(t.dir, { recursive: true, force: true });
});

test('stop() finalizes an in-progress recording', async () => {
  const t = setup();
  t.rec.start();
  t.setMotion(true);
  await sleep(60);
  await t.rec.stop();
  assert.equal(t.files().length, 1);
  assert.ok(!t.files()[0].includes('.part.'));
  rmSync(t.dir, { recursive: true, force: true });
});

function sizeSetup(actual, expected = { width: 2560, height: 1920 }) {
  const t = setup({
    rec: { probeFn: async () => actual, stream: 'main' },
  });
  return t;
}

async function recordOnce(t) {
  t.rec.start();
  t.setMotion(true);
  await sleep(50);
  t.setMotion(false);
  await sleep(300);
}

test('reports a clip whose size differs from the configured encoding', async () => {
  const t = sizeSetup({ width: 640, height: 480 });
  t.client.encoding = async () => ({ main: { width: 2560, height: 1920 }, sub: { width: 640, height: 480 } });
  await recordOnce(t);
  const m = t.events.find(([e]) => e === 'mismatch');
  assert.ok(m, JSON.stringify(t.events));
  assert.deepEqual(m[1].expected, { width: 2560, height: 1920 });
  assert.deepEqual(m[1].actual, { width: 640, height: 480 });
  assert.equal(t.files().length, 1, 'the clip is kept');
  await t.cleanup();
});

test('no mismatch when the clip matches the configured encoding', async () => {
  const t = sizeSetup({ width: 2560, height: 1920 });
  t.client.encoding = async () => ({ main: { width: 2560, height: 1920 }, sub: { width: 640, height: 480 } });
  await recordOnce(t);
  assert.ok(!t.events.some(([e]) => e === 'mismatch'));
  await t.cleanup();
});

test('an unreadable configuration or probe never blocks or fails a recording', async () => {
  const t = sizeSetup(null);
  t.client.encoding = async () => { throw new Error('unsupported'); };
  await recordOnce(t);
  assert.equal(t.files().length, 1);
  assert.ok(!t.events.some(([e]) => e === 'mismatch' || e === 'error'));
  await t.cleanup();
});

test('finished clips are remuxed into a regular MP4 with a real duration', async () => {
  const { spawn, execFileSync } = await import('node:child_process');
  // a "camera" that is really ffmpeg writing a live-style fragmented MP4 in real time
  const realSpawn = (_cmd, args) => spawn('ffmpeg', ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '5', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', '-y', args.at(-1)],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const t = setup({ spawnFn: realSpawn, rec: { remux: true, postRollMs: 60, stallMs: 5000 } });
  try {
    t.rec.start();
    t.setMotion(true);
    await sleep(2500);        // ~2 s of real-time video
    t.setMotion(false);
    await sleep(3000);        // post-roll, stop, finalize + remux
    const files = t.files();
    assert.equal(files.length, 1, JSON.stringify(t.events));
    const file = path.join(t.dir, files[0]);
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString();
    assert.ok(Number(out) > 1, `duration should be about 2 s, got ${out.trim()}`);
    assert.ok(readFileSync(file).subarray(0, 4096).toString('latin1').includes('moov'), 'index (moov) is at the front');
    assert.ok(!readdirSync(t.dir, { recursive: true }).some((f) => /remux|\.part\./.test(f)), 'no temporary files left');
  } finally { await t.cleanup(); }
});

test('after the camera stops answering and then answers again, the recorder says so', async () => {
  let fail = true;
  const dir = mkdtempSync(path.join(tmpdir(), 'reolook-'));
  const client = { motionState: async () => { if (fail) throw new Error('fetch failed'); return false; }, rtspUrl: () => 'rtsp://x' };
  const rec = new CameraRecorder({ client, name: 'C', outDir: dir, pollMs: 10, postRollMs: 60, spawnFn: fakeFfmpeg(), remux: false });
  const seen = [];
  rec.on('error', () => seen.push('error')); rec.on('recovered', () => seen.push('recovered'));
  rec.start();
  await sleep(60);
  fail = false;
  await sleep(60);
  await rec.stop(); rmSync(dir, { recursive: true, force: true });
  assert.equal(seen[0], 'error');
  assert.equal(seen.filter((s) => s === 'recovered').length, 1, 'once, not on every good poll');
  assert.ok(seen.indexOf('recovered') > seen.lastIndexOf('error'));
});

test('an ffmpeg that dies reports its error without the camera password', async () => {
  const says = 'Error opening input file rtsp://observer:s3cr%40t@10.0.0.9:554/h264Preview_01_main.\nInvalid data';
  const t = setup({ spawnFn: fakeFfmpeg({ dieAfterMs: 20, dieSays: says }) });
  t.rec.start();
  t.setMotion(true);
  await sleep(300);
  const err = t.events.find(([e, x]) => e === 'error' && /exited early/.test(x.message));
  assert.ok(err, JSON.stringify(t.events));
  assert.ok(!/s3cr/.test(err[1].message), err[1].message);
  assert.match(err[1].message, /rtsp:\/\/observer:\*\*\*@10\.0\.0\.9:554/);
  await t.cleanup();
});
