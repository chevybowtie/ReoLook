// DetectorClient talks JSON lines to a helper process. These tests use a fake process, so no Python,
// model or camera is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DetectorClient, detectorPaths, detectorStatus, MODEL_FILE, EMBED_FILE } from '../src/detect/helper-client.mjs';

/** A stand-in helper. `onRequest(msg, reply)` answers each line the client writes. */
function fakeHelper({ onRequest = () => {}, announce = true } = {}) {
  const spawns = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', null); };
    child.say = (obj) => child.stdout.write(JSON.stringify(obj) + '\n');
    let buf = '';
    child.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onRequest(JSON.parse(line), (o) => child.say(o), child); }
    });
    spawns.push({ cmd, args, child });
    if (announce) setImmediate(() => child.say({ ready: true }));
    return child;
  };
  return { spawnFn, spawns };
}

const dirWith = (...files) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'det-client-'));
  for (const f of files) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), 'x'); }
  return dir;
};

test('detectorPaths lays out the python, model and embedder under one folder', () => {
  const p = detectorPaths('/d');
  assert.equal(p.dir, '/d');
  assert.equal(p.python, '/d/venv/bin/python');
  assert.equal(p.model, `/d/${MODEL_FILE}`);
  assert.equal(p.embedder, `/d/${EMBED_FILE}`);
  assert.match(p.helper, /detector\/helper\.py$/);
});

test('detectorStatus: nothing installed, detection only, then with the appearance model', async () => {
  const none = dirWith();
  assert.deepEqual(await detectorStatus(none), { python: false, model: false, embedder: false, ready: false, canLook: false, dir: none });
  const some = dirWith('venv/bin/python', MODEL_FILE);
  assert.deepEqual(await detectorStatus(some), { python: true, model: true, embedder: false, ready: true, canLook: false, dir: some });
  const all = dirWith('venv/bin/python', MODEL_FILE, EMBED_FILE);
  const st = await detectorStatus(all);
  assert.equal(st.ready, true); assert.equal(st.canLook, true);
  const noModel = dirWith('venv/bin/python');
  assert.equal((await detectorStatus(noModel)).ready, false, 'python alone is not ready');
  for (const d of [none, some, all, noModel]) rmSync(d, { recursive: true, force: true });
});

test('detect sends the file and confidence and resolves with the helper\'s answer; the helper starts once', async () => {
  const h = fakeHelper({ onRequest: (m, reply) => reply({ id: m.id, width: 10, height: 10, ms: 4, detections: [{ label: 'truck', echo: m.file, conf: m.conf }] }) });
  const c = new DetectorClient({ dir: dirWith(), spawnFn: h.spawnFn, threads: 2 });
  const a = await c.detect('/f1.jpg', { conf: 0.5 });
  const b = await c.detect('/f2.jpg');
  assert.deepEqual(a.detections, [{ label: 'truck', echo: '/f1.jpg', conf: 0.5 }]);
  assert.equal(b.detections[0].conf, 0.3, 'default confidence');
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].args[2], '2', 'thread count is passed through');
  c.close();
});

test('the helper is given the embedder only when it is installed', async () => {
  const withEmb = dirWith(EMBED_FILE), without = dirWith();
  const h1 = fakeHelper({ onRequest: (m, r) => r({ id: m.id }) }), h2 = fakeHelper({ onRequest: (m, r) => r({ id: m.id }) });
  const c1 = new DetectorClient({ dir: withEmb, spawnFn: h1.spawnFn }), c2 = new DetectorClient({ dir: without, spawnFn: h2.spawnFn });
  await c1.detect('/f'); await c2.detect('/f');
  assert.equal(h1.spawns[0].args.length, 4);
  assert.equal(h2.spawns[0].args.length, 3);
  c1.close(); c2.close();
});

test('embed sends the box and op; requests are answered one at a time in order', async () => {
  const seen = [];
  const h = fakeHelper({ onRequest: (m, reply) => { seen.push(m); setTimeout(() => reply({ id: m.id, features: [m.id], colour: 'red' }), 5); } });
  const c = new DetectorClient({ dir: dirWith(), spawnFn: h.spawnFn });
  const [x, y] = await Promise.all([c.embed('/a.jpg', [0, 0, 1, 1]), c.embed('/b.jpg', [0.1, 0.1, 0.2, 0.2])]);
  assert.deepEqual(seen.map((m) => [m.op, m.file]), [['embed', '/a.jpg'], ['embed', '/b.jpg']]);
  assert.deepEqual(seen[0].box, [0, 0, 1, 1]);
  assert.equal(x.colour, 'red'); assert.notEqual(x.features[0], y.features[0]);
  c.close();
});

test('an error reply rejects that request only; later requests still work', async () => {
  const h = fakeHelper({ onRequest: (m, reply) => reply(m.file === '/bad' ? { id: m.id, error: 'unreadable picture' } : { id: m.id, ok: true }) });
  const c = new DetectorClient({ dir: dirWith(), spawnFn: h.spawnFn });
  await assert.rejects(c.detect('/bad'), /unreadable picture/);
  assert.equal((await c.detect('/good')).ok, true);
  c.close();
});

test('a request the helper never answers times out and the helper is restarted for the next one', async () => {
  let n = 0;
  const h = fakeHelper({ onRequest: (m, reply) => { if (++n > 1) reply({ id: m.id, ok: true }); } });
  const c = new DetectorClient({ dir: dirWith(), spawnFn: h.spawnFn, timeoutMs: 40 });
  await assert.rejects(c.detect('/slow'), /did not answer in time/);
  assert.equal((await c.detect('/next')).ok, true);
  assert.equal(h.spawns.length, 2);
  assert.equal(h.spawns[0].child.killed, true);
  c.close();
});

test('a helper that dies before it is ready rejects with its last message', async () => {
  const h = fakeHelper({ announce: false });
  const c = new DetectorClient({ dir: dirWith(), spawnFn: (...a) => { const ch = h.spawnFn(...a); setImmediate(() => { ch.stderr.write('Traceback\nImportError: no onnxruntime\n'); ch.emit('exit', 1); }); return ch; } });
  await assert.rejects(c.detect('/f'), /the detector stopped: ImportError: no onnxruntime/);
});

test('a helper that cannot be started rejects with the spawn error, and noise on stdout is ignored', async () => {
  const bad = new DetectorClient({ dir: dirWith(), spawnFn: () => { const ch = new EventEmitter(); ch.stdout = new PassThrough(); ch.stderr = new PassThrough(); ch.stdin = new PassThrough(); setImmediate(() => ch.emit('error', new Error('spawn ENOENT'))); return ch; } });
  await assert.rejects(bad.detect('/f'), /spawn ENOENT/);
  const h = fakeHelper({ onRequest: (m, reply, child) => { child.stdout.write('not json\n'); reply({ id: 999, stray: true }); reply({ id: m.id, ok: true }); } });
  const c = new DetectorClient({ dir: dirWith(), spawnFn: h.spawnFn });
  assert.equal((await c.detect('/f')).ok, true);
  c.close();
});

test('close stops the helper, and the client can be used again afterwards', async () => {
  const h = fakeHelper({ onRequest: (m, r) => r({ id: m.id, ok: true }) });
  const c = new DetectorClient({ dir: dirWith(), spawnFn: h.spawnFn });
  await c.detect('/f');
  c.close();
  assert.equal(h.spawns[0].child.killed, true);
  await c.detect('/g');
  assert.equal(h.spawns.length, 2);
  c.close();
  c.close();
});
