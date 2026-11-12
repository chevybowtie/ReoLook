import { EventEmitter } from 'node:events';

/**
 * In-memory job queue. One job runs at a time by default (exports are disk bound).
 * `run(job, { signal, onProgress })` does the work and returns { file, bytes }.
 * Failures keep their message; cancelling a running job aborts its signal.
 */
export class JobQueue extends EventEmitter {
  #jobs = []; #run; #max; #keep; #active = 0; #seq = 0;

  constructor({ run, max = 1, keep = 50 }) {
    super();
    this.#run = run; this.#max = max; this.#keep = keep;
  }

  /** Queues a job. @returns {object} a snapshot of the new job (state 'queued') */
  add({ kind, title, dest, payload }) {
    const job = {
      id: String(++this.#seq), kind, title, dest, state: 'queued', progress: 0,
      file: null, bytes: null, error: null,
      createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
    };
    Object.defineProperty(job, 'payload', { value: payload, enumerable: false });
    Object.defineProperty(job, 'ac', { value: null, writable: true, enumerable: false });
    this.#jobs.push(job);
    this.#trim();
    queueMicrotask(() => this.#pump());
    this.emit('change', job);
    return this.#view(job);
  }

  /** Newest first. */
  list() { return [...this.#jobs].reverse().map((j) => this.#view(j)); }

  get(id) { const j = this.#jobs.find((x) => x.id === id); return j ? this.#view(j) : null; }

  /** Returns 'cancelled' | 'aborting' | 'finished' | null (unknown id). */
  cancel(id) {
    const j = this.#jobs.find((x) => x.id === id);
    if (!j) return null;
    if (j.state === 'queued') { this.#finish(j, 'cancelled'); return 'cancelled'; }
    if (j.state === 'running') { j.ac?.abort(); return 'aborting'; }
    return 'finished';
  }

  /** Abort everything still queued or running (shutdown). */
  async drain() {
    for (const j of this.#jobs) if (j.state === 'queued' || j.state === 'running') this.cancel(j.id);
    while (this.#active > 0) await new Promise((r) => setTimeout(r, 20));
  }

  #view(j) { return { ...j }; }

  /** Marks a job as ended in `state` and announces the change. */
  #finish(j, state, error = null) {
    j.state = state; j.error = error; j.endedAt = new Date().toISOString();
    this.emit('change', j);
  }

  /** Forgets the oldest finished jobs beyond `keep`; unfinished jobs are always kept. */
  #trim() {
    // keep every unfinished job, and only the newest `keep` finished ones
    const finished = this.#jobs.filter((j) => j.state !== 'queued' && j.state !== 'running');
    for (const j of finished.slice(0, Math.max(0, finished.length - this.#keep))) {
      this.#jobs.splice(this.#jobs.indexOf(j), 1);
    }
  }

  /** Starts queued jobs, oldest first, while there are free slots. */
  #pump() {
    while (this.#active < this.#max) {
      const next = this.#jobs.find((j) => j.state === 'queued');
      if (!next) return;
      this.#start(next);
    }
  }

  /** Runs one job to its end, recording its progress, result or failure, then frees its slot and starts the next. */
  async #start(j) {
    this.#active++;
    j.state = 'running'; j.startedAt = new Date().toISOString();
    const ac = new AbortController();
    j.ac = ac;
    this.emit('change', j);
    try {
      const r = await this.#run(j, {
        signal: ac.signal,
        onProgress: (p) => { j.progress = Math.max(0, Math.min(1, p)); },
      });
      if (ac.signal.aborted) this.#finish(j, 'cancelled');
      else { j.progress = 1; j.file = r?.file ?? null; j.bytes = r?.bytes ?? null; this.#finish(j, 'done'); }
    } catch (e) {
      this.#finish(j, ac.signal.aborted ? 'cancelled' : 'failed', ac.signal.aborted ? null : (e?.message ?? String(e)));
    } finally {
      j.ac = null;
      this.#active--;
      this.#trim();
      this.#pump();
    }
  }
}
