import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../src/jobs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(5); } };

test('jobs run one at a time, in order, and finish with their result', async () => {
  const order = []; let running = 0, peak = 0;
  const q = new JobQueue({ run: async (j) => { running++; peak = Math.max(peak, running); order.push(j.title); await sleep(20); running--; return { file: `/x/${j.title}`, bytes: 5 }; } });
  q.add({ kind: 'copy', title: 'a', dest: '/x' }); q.add({ kind: 'copy', title: 'b', dest: '/x' }); q.add({ kind: 'copy', title: 'c', dest: '/x' });
  await until(() => q.list().every((j) => j.state === 'done'));
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(peak, 1);
  assert.deepEqual(q.list().map((j) => j.title), ['c', 'b', 'a'], 'newest first');
  assert.equal(q.list()[0].file, '/x/c');
  assert.equal(q.list()[0].progress, 1);
});

test('progress is reported and clamped', async () => {
  let report;
  const q = new JobQueue({ run: async (j, { onProgress }) => { report = onProgress; await sleep(60); return {}; } });
  q.add({ kind: 'cut', title: 'p' });
  await until(() => q.list()[0].state === 'running');
  report(0.4); assert.equal(q.list()[0].progress, 0.4);
  report(7); assert.equal(q.list()[0].progress, 1);
  report(-3); assert.equal(q.list()[0].progress, 0);
  await until(() => q.list()[0].state === 'done');
});

test('a failure keeps its message and does not stop the queue', async () => {
  const q = new JobQueue({ run: async (j) => { if (j.title === 'bad') throw new Error('disk full'); return { file: 'ok' }; } });
  q.add({ kind: 'copy', title: 'bad' }); q.add({ kind: 'copy', title: 'good' });
  await until(() => q.list().every((j) => j.state !== 'queued' && j.state !== 'running'));
  const byTitle = Object.fromEntries(q.list().map((j) => [j.title, j]));
  assert.equal(byTitle.bad.state, 'failed'); assert.equal(byTitle.bad.error, 'disk full');
  assert.equal(byTitle.good.state, 'done');
});

test('cancel: a queued job never runs, a running job is aborted', async () => {
  const ran = [];
  const q = new JobQueue({ run: async (j, { signal }) => {
    ran.push(j.title);
    await new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); setTimeout(res, 5000); });
    return {};
  } });
  const a = q.add({ kind: 'cut', title: 'a' }); const b = q.add({ kind: 'cut', title: 'b' });
  await until(() => q.get(a.id).state === 'running');
  assert.equal(q.cancel(b.id), 'cancelled');
  assert.equal(q.cancel(a.id), 'aborting');
  await until(() => q.get(a.id).state === 'cancelled');
  assert.deepEqual(ran, ['a'], 'b never started');
  assert.equal(q.get(a.id).error, null, 'a cancel is not reported as an error');
  assert.equal(q.cancel('nope'), null);
  assert.equal(q.cancel(a.id), 'finished');
});

test('drain aborts queued and running work and waits for it', async () => {
  const q = new JobQueue({ run: async (j, { signal }) => { await new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Error('x'))); }); } });
  q.add({ kind: 'cut', title: 'a' }); q.add({ kind: 'cut', title: 'b' });
  await until(() => q.list().some((j) => j.state === 'running'));
  await q.drain();
  assert.ok(q.list().every((j) => j.state === 'cancelled'));
});

test('only the newest finished jobs are kept; unfinished ones never dropped', async () => {
  const q = new JobQueue({ keep: 3, run: async () => ({}) });
  for (let i = 0; i < 8; i++) q.add({ kind: 'copy', title: String(i) });
  await until(() => q.list().every((j) => j.state === 'done'));
  assert.equal(q.list().length, 3);
  assert.deepEqual(q.list().map((j) => j.title), ['7', '6', '5']);
});

test('payload is available to the runner but not exposed in listings', async () => {
  let seen;
  const q = new JobQueue({ run: async (j) => { seen = j.payload; return {}; } });
  q.add({ kind: 'copy', title: 't', payload: { secret: 1 } });
  await until(() => q.list()[0].state === 'done');
  assert.deepEqual(seen, { secret: 1 });
  assert.ok(!JSON.stringify(q.list()).includes('secret'));
});
