// What the detector saw, kept so it can be listed next to the recordings and used as a tag on a
// clip. One JSON line per event; a verdict ("was that really the mail truck?") is a patch line.
// Each event keeps the frame it fired on, so a week of events can be reviewed and used to tune.
import { appendFile, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { xdgDir } from '../xdg.mjs';

/** The date of a Date as YYYY-MM-DD, in the local zone. */
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export class EventLog {
  #file; #dir; #entries = []; #loaded = false; #max; #seenSize = -1;
  constructor({ file = path.join(xdgDir('state'), 'reolook', 'detections.jsonl'), dir = path.join(xdgDir('data'), 'reolook', 'detections'), max = 5000 } = {}) {
    this.#file = file; this.#dir = dir; this.#max = max;
  }
  /**
   * Reads the log file into memory. A line is an event, or a patch to an earlier event (a verdict, an
   * appearance score, or a removal); removed events are dropped and the newest `max` of the rest are kept. Patches find their event through an index, so loading is linear in the file.
   * Does nothing if the file has not changed since the last read (another process, such as the replay
   * command, may have appended to it).
   * @returns {Promise<void>}
   */
  async #load() {
    let size = 0;
    try { size = (await stat(this.#file)).size; } catch { /* no file yet */ }
    if (this.#loaded && size === this.#seenSize) return;
    this.#loaded = true; this.#seenSize = size; this.#entries = [];
    const byId = new Map();
    try {
      for (const line of (await readFile(this.#file, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.patch) { const e = byId.get(r.patch); if (e) Object.assign(e, r.set); }
          else { this.#entries.push(r); if (!byId.has(r.id)) byId.set(r.id, r); }
        } catch { /* skip a damaged line */ }
      }
    } catch { /* no events yet */ }
    this.#entries = this.#entries.filter((e) => !e.removed);   // a removal is a patch line; it must hold after a restart
    if (this.#entries.length > this.#max) this.#entries = this.#entries.slice(-this.#max);
  }
  /** Appends one line (an event or a patch) to the log file. A log that cannot be written is only less durable. */
  async #write(rec) {
    try {
      await mkdir(path.dirname(this.#file), { recursive: true });
      await appendFile(this.#file, JSON.stringify(rec) + '\n', { mode: 0o600 });
      this.#seenSize = (await stat(this.#file)).size;
    } catch { /* less durable only */ }
  }

  /** Add an event; `jpeg` is the frame it fired on. Returns the stored event. */
  async add(event, jpeg = null) {
    await this.#load();
    const at = new Date(event.at);
    const id = `${at.getTime().toString(36)}${randomBytes(3).toString('hex')}`;
    const rec = { ...event, id, day: day(at), verdict: null };
    if (jpeg) {
      const rel = path.join(rec.day, `${id}.jpg`);
      try { await mkdir(path.join(this.#dir, rec.day), { recursive: true }); await writeFile(path.join(this.#dir, rel), jpeg, { mode: 0o600 }); rec.snapshot = rel; } catch { /* no picture, still an event */ }
    }
    this.#entries.push(rec);
    if (this.#entries.length > this.#max) this.#entries.shift();
    await this.#write(rec);
    return rec;
  }
  /** Newest first. */
  async list({ day: d = null, camera = null, limit = 200, kind = null } = {}) {
    await this.#load();
    return this.#entries.filter((e) => (!d || e.day === d) && (!camera || e.camera === camera) && (!kind || e.type === kind)).slice(-limit).reverse();
  }
  async get(id) { await this.#load(); return this.#entries.find((e) => e.id === id) ?? null; }
  snapshotPath(rec) { return rec?.snapshot ? path.join(this.#dir, rec.snapshot) : null; }
  /**
   * Records whether an event was really the thing looked for. @param {string} id @param {'yes'|'no'|null} verdict @returns {Promise<object|null>} the event, or null if unknown @throws {Error} for any other verdict
   */
  async setVerdict(id, verdict) {
    await this.#load();
    const e = this.#entries.find((x) => x.id === id);
    if (!e) return null;
    if (verdict !== null && verdict !== 'yes' && verdict !== 'no') throw new Error('verdict must be yes, no or null');
    e.verdict = verdict;
    await this.#write({ patch: id, set: { verdict } });
    return e;
  }
  /** What the appearance check made of an event (0..1), and whether the event was unseen by it. */
  async setLook(id, look, kind) {
    await this.#load();
    const e = this.#entries.find((x) => x.id === id);
    if (!e) return null;
    e.look = look; e.lookKind = kind;
    await this.#write({ patch: id, set: { look, lookKind: kind } });
    return e;
  }
  /**
   * Deletes an event and its picture; the removal is saved so it holds after a restart. @returns {Promise<boolean>} false if there was no such event
   */
  async remove(id) {
    await this.#load();
    const i = this.#entries.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [e] = this.#entries.splice(i, 1);
    if (e.snapshot) await rm(path.join(this.#dir, e.snapshot), { force: true });
    await this.#write({ patch: id, set: { removed: true } });
    return true;
  }
}
