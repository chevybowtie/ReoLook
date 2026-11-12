import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveHub } from '../src/live.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSpawn({ behaviour }) {
  const children = [];
  const fn = () => {
    const n = children.length;
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.killed = null;
    c.kill = (sig) => { c.killed = sig; setImmediate(() => c.emit('exit', null, sig)); };
    children.push(c);
    setImmediate(() => behaviour(c, n)); // a real process delivers output after spawn returns
    return c;
  };
  fn.children = children;
  return fn;
}

function fakeRes() {
  const r = new EventEmitter();
  r.chunks = []; r.ended = false; r.head = null;
  r.writeHead = (code, h) => { r.head = [code, h]; };
  r.flushHeaders = () => {};
  r.write = (c) => { r.chunks.push(c); return true; };
  r.end = () => { r.ended = true; };
  return r;
}

test('one ffmpeg is shared by many viewers and stopped after the last leaves', async () => {
  const spawnFn = fakeSpawn({ behaviour: (c) => c.stdout.emit('data', Buffer.from('frame')) });
  const hub = new LiveHub({ spawnFn, idleMs: 30, stallMs: 5000 });
  const a = fakeRes(), b = fakeRes();
  assert.equal(hub.attach('cam:sub', 'rtsp://x', a), true);
  assert.equal(hub.attach('cam:sub', 'rtsp://x', b), true);
  assert.equal(spawnFn.children.length, 1);
  a.emit('close'); await sleep(60);
  assert.equal(spawnFn.children[0].killed, null, 'still one viewer');
  b.emit('close'); await sleep(80);
  assert.equal(spawnFn.children[0].killed, 'SIGTERM');
  assert.equal(hub.active, 0);
  hub.shutdown();
});

test('a stream that sends no data is restarted and viewers stay attached', async () => {
  const spawnFn = fakeSpawn({ behaviour: (c, n) => { if (n >= 1) c.stdout.emit('data', Buffer.from('ok')); } });
  const hub = new LiveHub({ spawnFn, stallMs: 80, restartMs: 10 });
  const v = fakeRes();
  hub.attach('cam:sub', 'rtsp://x', v);
  await sleep(400);
  assert.ok(spawnFn.children.length >= 2, 'restarted');
  assert.equal(spawnFn.children[0].killed, 'SIGKILL');
  assert.equal(v.ended, false, 'viewer not dropped');
  assert.ok(v.chunks.length > 0, 'viewer got frames after the restart');
  hub.shutdown();
});

test('an ffmpeg that exits is restarted while viewers remain', async () => {
  const spawnFn = fakeSpawn({ behaviour: (c, n) => {
    if (n === 0) setTimeout(() => c.emit('exit', 1), 10); else c.stdout.emit('data', Buffer.from('ok'));
  } });
  const hub = new LiveHub({ spawnFn, stallMs: 5000, restartMs: 10 });
  const v = fakeRes();
  hub.attach('cam:sub', 'rtsp://x', v);
  await sleep(150);
  assert.ok(spawnFn.children.length >= 2);
  assert.ok(v.chunks.length > 0);
  hub.shutdown();
});

test('refuses new streams beyond the capacity', () => {
  const hub = new LiveHub({ spawnFn: fakeSpawn({ behaviour: () => {} }), maxStreams: 1, stallMs: 5000 });
  assert.equal(hub.attach('a', 'rtsp://x', fakeRes()), true);
  assert.equal(hub.attach('b', 'rtsp://y', fakeRes()), false);
  assert.equal(hub.attach('a', 'rtsp://x', fakeRes()), true, 'joining an existing stream is allowed');
  hub.shutdown();
});

test('a stream flooding output beyond the rate ceiling is killed and restarted', async () => {
  const big = Buffer.alloc(200_000);
  const spawnFn = fakeSpawn({ behaviour: (c, n) => {
    if (n === 0) for (let i = 0; i < 50; i++) c.stdout.emit('data', big); // 10 MB in one burst
    else c.stdout.emit('data', Buffer.from('ok'));
  } });
  const hub = new LiveHub({ spawnFn, stallMs: 5000, restartMs: 10, maxBytesPerSec: 1_000_000 });
  const v = fakeRes();
  hub.attach('cam:sub', 'rtsp://x', v);
  await sleep(200);
  assert.equal(spawnFn.children[0].killed, 'SIGKILL');
  assert.ok(spawnFn.children.length >= 2, 'restarted after the flood');
  assert.ok(v.chunks.reduce((n, c) => n + c.length, 0) < 3_000_000, 'flood was cut off, not forwarded');
  hub.shutdown();
});

test('frames are dropped, not buffered, for a viewer that cannot keep up', async () => {
  const spawnFn = fakeSpawn({ behaviour: (c) => { for (let i = 0; i < 5; i++) c.stdout.emit('data', Buffer.from('frame')); } });
  const hub = new LiveHub({ spawnFn, stallMs: 5000 });
  const slow = fakeRes(); slow.writableNeedDrain = true;
  const fast = fakeRes();
  hub.attach('cam:sub', 'rtsp://x', slow);
  hub.attach('cam:sub', 'rtsp://x', fast);
  await sleep(50);
  assert.equal(slow.chunks.length, 0);
  assert.equal(fast.chunks.length, 5);
  hub.shutdown();
});

test('the decoder is limited to two threads, before the input, and the limit can be changed', () => {
  const argsFor = (opts) => {
    let args;
    const hub = new LiveHub({ ...opts, spawnFn: (_c, a) => { args = a; const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => {}; return c; } });
    hub.attach('k', 'rtsp://x', fakeRes());
    hub.shutdown();
    return args;
  };
  const dflt = argsFor({});
  assert.deepEqual(dflt.slice(dflt.indexOf('-threads'), dflt.indexOf('-threads') + 2), ['-threads', '2']);
  assert.ok(dflt.indexOf('-threads') < dflt.indexOf('-i'), 'an input option: it applies to the decoder of the stream that follows');
  assert.equal(dflt.filter((a) => a === '-threads').length, 1);
  assert.equal(argsFor({ decodeThreads: 1 })[argsFor({ decodeThreads: 1 }).indexOf('-threads') + 1], '1');
});

test('input uses arrival-time timestamps', () => {
  let args;
  const hub = new LiveHub({ spawnFn: (_c, a) => { args = a; const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => {}; return c; }, stallMs: 5000 });
  hub.attach('k', 'rtsp://x', fakeRes());
  assert.ok(args.join(' ').includes('-use_wallclock_as_timestamps 1'));
  hub.shutdown();
});

test('a burst of decoder errors restarts the stream with viewers attached, and cannot loop', async () => {
  const spawnFn = fakeSpawn({ behaviour: (c) => c.stdout.emit('data', Buffer.from('frame')) });
  const hub = new LiveHub({ spawnFn, stallMs: 5000, restartMs: 10, decodeErrors: { count: 3, windowMs: 1000, minGapMs: 400 } });
  const v = fakeRes();
  hub.attach('cam:sub', 'rtsp://x', v);
  await sleep(30);
  spawnFn.children[0].stderr.emit('data', Buffer.from('[h264 @ 0x1] error while decoding MB 12 7, bytestream -5\n[h264 @ 0x1] concealing 30 DC, 30 AC, 30 MV errors in P frame\n'));
  assert.equal(spawnFn.children[0].killed, null, 'two messages are not a burst');
  spawnFn.children[0].stderr.emit('data', Buffer.from('[h264 @ 0x1] error while decoding MB 3 3\n'));
  await sleep(80);
  assert.equal(spawnFn.children[0].killed, 'SIGKILL');
  assert.equal(spawnFn.children.length, 2, 'started again');
  assert.equal(v.ended, false);
  // a second burst right away is counted but does not restart again before the gap
  spawnFn.children[1].stderr.emit('data', Buffer.from('error while decoding MB 1 1\nerror while decoding MB 2 2\nerror while decoding MB 3 3\n'));
  await sleep(50);
  assert.equal(spawnFn.children[1].killed, null);
  await sleep(450);
  spawnFn.children[1].stderr.emit('data', Buffer.from('error while decoding MB 1 1\nerror while decoding MB 2 2\nerror while decoding MB 3 3\n'));
  await sleep(80);
  assert.equal(spawnFn.children[1].killed, 'SIGKILL');
  const st = hub.stats()[0];
  assert.equal(st.resyncs, 2); assert.match(st.lastError, /error while decoding/);
  hub.shutdown();
});

test('ordinary messages are not mistaken for damage', async () => {
  const spawnFn = fakeSpawn({ behaviour: (c) => c.stdout.emit('data', Buffer.from('frame')) });
  const hub = new LiveHub({ spawnFn, stallMs: 5000, decodeErrors: { count: 2, windowMs: 1000, minGapMs: 0 } });
  hub.attach('cam:sub', 'rtsp://x', fakeRes());
  await sleep(30);
  for (let i = 0; i < 5; i++) spawnFn.children[0].stderr.emit('data', Buffer.from('Stream #0:0: Video: h264 (High), yuv420p, 640x480\n'));
  await sleep(40);
  assert.equal(spawnFn.children[0].killed, null);
  hub.shutdown();
});

test('restarts caused by damaged video are remembered after the viewer leaves', async () => {
  const spawnFn = fakeSpawn({ behaviour: (c) => c.stdout.emit('data', Buffer.from('frame')) });
  const hub = new LiveHub({ spawnFn, idleMs: 20, stallMs: 5000, restartMs: 10, decodeErrors: { count: 2, windowMs: 1000, minGapMs: 0 } });
  const v = fakeRes();
  hub.attach('cam:sub', 'rtsp://x', v);
  await sleep(30);
  spawnFn.children[0].stderr.emit('data', Buffer.from('error while decoding MB 1 1\nerror while decoding MB 2 2\n'));
  await sleep(60);
  v.emit('close'); await sleep(80);
  assert.equal(hub.active, 0);
  assert.equal(hub.resyncLog().length, 1);
  assert.equal(hub.resyncLog()[0].key, 'cam:sub');
  hub.shutdown();
});
