import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limiter, mapLimit, memoizeAsync } from '../src/concurrency.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wraps a job so the test can see how many run together. */
function tracker() {
  const t = { now: 0, peak: 0, start: [] };
  t.job = (id, ms) => async () => { t.now++; t.peak = Math.max(t.peak, t.now); t.start.push(id); await sleep(ms); t.now--; return id; };
  return t;
}

test('limiter runs at most n jobs together, starts them in arrival order, and returns each job\'s own result', async () => {
  const t = tracker(), gate = limiter(2);
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => gate(t.job(i, 10))));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(t.peak, 2);
  assert.deepEqual(t.start, [1, 2, 3, 4, 5]);
});

test('limiter passes a failure to its own caller only, and keeps serving the queue', async () => {
  const gate = limiter(1);
  const bad = gate(async () => { throw new Error('nope'); });
  const good = gate(async () => 'fine');
  await assert.rejects(bad, /nope/);
  assert.equal(await good, 'fine');
});

test('mapLimit keeps the order of the input however the calls finish, and never exceeds the limit', async () => {
  const t = tracker();
  const out = await mapLimit([30, 5, 20, 1, 10, 2], 3, (ms, i) => t.job(i, ms)());
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5], 'result i belongs to item i');
  assert.equal(t.peak, 3);
});

test('mapLimit passes the item and its index, handles an empty list, and a limit above the length', async () => {
  assert.deepEqual(await mapLimit(['a', 'b', 'c'], 10, async (x, i) => `${i}${x}`), ['0a', '1b', '2c']);
  assert.deepEqual(await mapLimit([], 4, async () => { throw new Error('never called'); }), []);
});

test('mapLimit with a limit of one is strictly sequential', async () => {
  const t = tracker();
  await mapLimit([5, 5, 5], 1, (ms, i) => t.job(i, ms)());
  assert.equal(t.peak, 1);
  assert.deepEqual(t.start, [0, 1, 2]);
});

test('mapLimit rejects with the first failure', async () => {
  await assert.rejects(mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('two failed'); return x; }), /two failed/);
});

test('memoizeAsync: calls for one key share a run, and the answer is kept', async () => {
  let runs = 0;
  const f = memoizeAsync(async (k) => { runs++; await sleep(10); return k + '!'; });
  assert.deepEqual(await Promise.all([f('a'), f('a'), f('b')]), ['a!', 'a!', 'b!']);
  assert.equal(runs, 2, 'a and b ran once each');
  assert.equal(await f('a'), 'a!');
  assert.equal(runs, 2, 'the kept answer is reused');
});

test('memoizeAsync: keeps at most `max` answers, dropping the oldest', async () => {
  let runs = 0;
  const f = memoizeAsync(async (k) => { runs++; return k; }, { max: 2 });
  await f('a'); await f('b'); await f('c'); // a is dropped
  assert.equal(runs, 3);
  await f('c'); await f('b');
  assert.equal(runs, 3, 'b and c are still kept');
  await f('a');
  assert.equal(runs, 4, 'a had to run again');
});

test('memoizeAsync: a failed run is forgotten so the next call retries', async () => {
  let runs = 0;
  const f = memoizeAsync(async () => { runs++; if (runs === 1) throw new Error('boom'); return 'ok'; });
  await assert.rejects(f('a'), /boom/);
  assert.equal(await f('a'), 'ok');
  assert.equal(runs, 2);
});

test('memoizeAsync with keep:false shares only runs in flight', async () => {
  let runs = 0;
  const f = memoizeAsync(async () => { runs++; await sleep(10); return runs; }, { keep: false });
  await Promise.all([f('a'), f('a')]);
  assert.equal(runs, 1);
  await f('a');
  assert.equal(runs, 2, 'a finished answer is not kept');
});
