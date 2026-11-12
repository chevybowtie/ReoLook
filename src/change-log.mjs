// Append-only record of changes made to devices, so any of them can be undone later.
// It never holds credentials; secret settings keep only a redacted copy and are not undoable.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { xdgDir } from './xdg.mjs';

/** Where the history of device changes is kept. */
export const defaultChangeLogPath = () => path.join(xdgDir('state'), 'reolook', 'changes.jsonl');

export class ChangeLog {
  #file; #entries = []; #loaded = false; #max;
  constructor({ file = defaultChangeLogPath(), max = 500 } = {}) { this.#file = file; this.#max = max; }

  /**
   * Reads the history file into memory, once, applying patch lines to the entries they refer to. Damaged lines are skipped.
   */
  async #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const text = await readFile(this.#file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { this.#apply(JSON.parse(line)); } catch { /* skip a damaged line */ }
      }
    } catch { /* no history yet */ }
  }
  // lines are either a full entry or a { patch: id, ... } marker
  #apply(rec) {
    if (rec.patch) { const e = this.#entries.find((x) => x.id === rec.patch); if (e) Object.assign(e, rec.set); return; }
    this.#entries.push(rec);
    if (this.#entries.length > this.#max) this.#entries.shift();
  }
  /** Appends one line to the history file. History that cannot be saved is only less durable. */
  async #write(rec) {
    try {
      await mkdir(path.dirname(this.#file), { recursive: true });
      await appendFile(this.#file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch { /* history that cannot be saved is only less durable */ }
  }

  async append(entry) { await this.#load(); this.#apply(entry); await this.#write(entry); return entry; }
  async get(id) { await this.#load(); return this.#entries.find((e) => e.id === id) ?? null; }
  async patch(id, set) { await this.#load(); this.#apply({ patch: id, set }); await this.#write({ patch: id, set }); }
  /** Newest first. */
  async list({ deviceId = null, limit = 50 } = {}) {
    await this.#load();
    return this.#entries.filter((e) => !deviceId || e.deviceId === deviceId).slice(-limit).reverse();
  }
  /** Rewrite the file compactly (used by tests and maintenance). */
  async compact() { await this.#load(); await writeFile(this.#file, this.#entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 }); }
}
