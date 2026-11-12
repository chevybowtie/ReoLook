// Small helpers for bounded concurrency. A camera is a small device: several reads at once are fine,
// dozens are not, so callers always say how many may run together.

/**
 * A gate that lets at most `n` jobs run at once; the rest wait their turn in arrival order.
 * @param {number} n maximum jobs running together
 * @returns {<T>(job: () => Promise<T>) => Promise<T>} runs `job` when a slot is free; settles as the job does
 */
export function limiter(n) {
  let active = 0; const q = [];
  /** Starts the next waiting job if there is a free slot. */
  const next = () => { if (active < n && q.length) { active++; q.shift()(); } };
  return (fn) => new Promise((res, rej) => {
    q.push(() => fn().then(res, rej).finally(() => { active--; next(); }));
    next();
  });
}

/**
 * Like `Promise.all(items.map(fn))`, but with at most `n` calls in flight. Results are in the order of
 * `items`, whatever order the calls finish in. If a call rejects, the returned promise rejects with its
 * error; calls already started still run to completion.
 * @template T, R
 * @param {T[]} items
 * @param {number} n maximum calls running together
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  /** Takes items one at a time until none are left, storing each result in its place. */
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Wraps an async function so that calls with the same key share one run, and (optionally) remember the answer.
 * Concurrent calls for a key join the run already in flight instead of starting another. A run that fails is
 * forgotten at once, so the next call tries again.
 * @template R
 * @param {(key: string) => Promise<R>} fn the work, given the key
 * @param {{max?: number, keep?: boolean}} [opts] `keep`: keep finished answers (default true), at most `max`
 *   of them, dropping the oldest first; with `keep: false` only runs in flight are shared
 * @returns {(key: string) => Promise<R>} the same work, shared by key
 */
export function memoizeAsync(fn, { max = 500, keep = true } = {}) {
  const runs = new Map();
  return (key) => {
    const hit = runs.get(key);
    if (hit) return hit;
    const run = fn(key).then(
      (v) => { if (!keep) runs.delete(key); return v; },
      (e) => { runs.delete(key); throw e; });
    runs.set(key, run);
    if (keep && runs.size > max) runs.delete(runs.keys().next().value); // Map keeps insertion order: the oldest goes
    return run;
  };
}
