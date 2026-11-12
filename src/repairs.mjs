// Reading the live-view repair log (~/.local/state/reolook/live-repairs.jsonl): how often a camera's
// picture had to be repaired, in bursts ("episodes"), with notes of what was changed in between.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Where the live-view repair log is kept. */
export const repairsFile = () => path.join(os.homedir(), '.local', 'state', 'reolook', 'live-repairs.jsonl');

/**
 * Reads the repair log. @returns {Promise<object[]>} its entries in order; a missing file is empty and damaged lines are skipped
 */
export async function readRepairs(file = repairsFile()) {
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Adds a note (at most 200 characters) to the repair log, to say what was changed between repairs. */
export async function addNote(text, file = repairsFile(), now = new Date()) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ at: now.toISOString(), note: String(text).slice(0, 200) }) + '\n', { mode: 0o600 });
}

/**
 * Group repairs of each camera into episodes: repairs less than `gapMin` apart belong together.
 * Returns { cameras: { id: { repairs, episodes: [{ from, to, count }] } }, notes: [{ at, note }] }.
 */
export function summarise(entries, { sinceMs = 0, gapMin = 5 } = {}) {
  const cams = {}, notes = [];
  for (const e of entries) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    if (e.note) { notes.push({ at: e.at, note: e.note }); continue; }
    const id = String(e.key).split(':')[0];
    const c = (cams[id] ??= { repairs: 0, episodes: [], recording: 0 });
    c.repairs++;
    if (e.recording) c.recording++;
    const last = c.episodes.at(-1);
    if (last && t - Date.parse(last.to) <= gapMin * 60_000) { last.to = e.at; last.count++; }
    else c.episodes.push({ from: e.at, to: e.at, count: 1 });
  }
  return { cameras: cams, notes };
}
