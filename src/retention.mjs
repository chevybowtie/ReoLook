// Disk retention for the MMDDYYYY/<Camera>-00-HHMMSS-HHMMSS.mp4 layout.
// Only files that match that layout, directly inside MMDDYYYY folders under the
// root, are ever candidates. Anything else on the drive is never touched.
import { readdir, stat, unlink, rmdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { listDays, listClips, relOf } from './library.mjs';

const GB = 1024 ** 3;
const DAY = 86_400_000;

/** Sums the byte sizes of `files`. @param {{bytes:number}[]} files @returns {number} */
const sumBytes = (files) => files.reduce((n, f) => n + f.bytes, 0);

/**
 * Rule 1: select every file older than `maxAgeDays`.
 * @param {object[]} sorted files, oldest first
 * @param {number} now epoch ms
 * @param {number} maxAgeDays
 * @param {(f: object, reason: string) => void} take records a file for deletion
 */
function selectOlderThan(sorted, now, maxAgeDays, take) {
  for (const f of sorted) if (now - f.end.getTime() > maxAgeDays * DAY) take(f, `older than ${maxAgeDays} days`);
}

/**
 * Rule 2: select oldest files until what remains fits in `maxSizeGB`.
 * Keeps a running total, so it is linear in the number of files.
 * @param {object[]} sorted files, oldest first
 * @param {Map<string, object>} doomed files already selected (read only here)
 * @param {number} maxSizeGB
 * @param {(f: object, reason: string) => void} take records a file for deletion
 */
function selectOverSize(sorted, doomed, maxSizeGB, take) {
  let remaining = sumBytes(sorted.filter((f) => !doomed.has(f.rel)));
  for (const f of sorted) {
    if (remaining <= maxSizeGB * GB) break;
    if (!doomed.has(f.rel)) {
      take(f, `total over ${maxSizeGB} GB`);
      if (doomed.has(f.rel)) remaining -= f.bytes;   // a protected (recent) file is not taken and stays counted
    }
  }
}

/**
 * Rule 3: select oldest files until free space reaches `minFreeGB`.
 * @param {object[]} sorted files, oldest first
 * @param {Map<string, object>} doomed files already selected
 * @param {{minFreeGB: number, freeBytes: number, eligible: (f: object) => boolean}} limits
 * @param {(f: object, reason: string) => void} take records a file for deletion
 */
function selectForFreeSpace(sorted, doomed, { minFreeGB, freeBytes, eligible }, take) {
  let freed = sumBytes([...doomed.values()]);
  for (const f of sorted) {
    if (freeBytes + freed >= minFreeGB * GB) break;
    if (doomed.has(f.rel) || !eligible(f)) continue;
    take(f, `free space under ${minFreeGB} GB`);
    freed += f.bytes;
  }
}

/**
 * Pure planner. `files`: [{ rel, bytes, end: Date }] (any order).
 * Returns the files to delete, oldest first, plus the reason for each.
 *
 * Rules, in order:
 *  1. older than maxAgeDays
 *  2. oldest first until total size <= maxSizeGB
 *  3. oldest first until free space >= minFreeGB
 * Files that ended within `protectMs` are never selected.
 * @returns {{delete: object[], bytes: number, total: number, totalBytes: number}}
 */
export function planRetention({ files, now = Date.now(), maxAgeDays = null, maxSizeGB = null,
  minFreeGB = null, freeBytes = null, protectMs = 60 * 60_000 }) {
  const sorted = [...files].sort((a, b) => a.end - b.end);
  /** Whether a clip is old enough to be deleted: it ended at least `protectMs` ago. */
  const eligible = (f) => now - f.end.getTime() >= protectMs;
  const doomed = new Map();
  /** Marks a clip for deletion, once, if it is eligible. */
  const take = (f, reason) => { if (eligible(f) && !doomed.has(f.rel)) doomed.set(f.rel, { ...f, reason }); };

  if (maxAgeDays != null) selectOlderThan(sorted, now, maxAgeDays, take);
  if (maxSizeGB != null) selectOverSize(sorted, doomed, maxSizeGB, take);
  if (minFreeGB != null && freeBytes != null) selectForFreeSpace(sorted, doomed, { minFreeGB, freeBytes, eligible }, take);
  const list = [...doomed.values()].sort((a, b) => a.end - b.end);
  return { delete: list, bytes: sumBytes(list), total: sorted.length, totalBytes: sumBytes(sorted) };
}

/**
 * Describes the clips of one day with their sizes. Files that vanish while being measured are left out.
 * @param {string} root recordings root
 * @param {string} iso day, YYYY-MM-DD
 * @returns {Promise<{rel: string, bytes: number, end: Date, camera: string}[]>} in listClips order
 */
async function scanDay(root, iso) {
  const sized = await Promise.all((await listClips(root, iso)).map(async (c) => {
    const rel = relOf(c.id);
    try { return { rel, bytes: (await stat(path.join(root, rel))).size, end: new Date(c.end), camera: c.camera }; }
    catch { return null; /* vanished while scanning */ }
  }));
  return sized.filter(Boolean);
}

/**
 * Collects every clip in the layout with its size. Days are read in turn (newest first, as before);
 * the files of one day are measured together, so a day costs one round trip rather than one per file.
 * @param {string} root recordings root
 * @returns {Promise<{rel: string, bytes: number, end: Date, camera: string}[]>}
 */
export async function scanLibrary(root) {
  const files = [];
  for (const iso of await listDays(root)) files.push(...await scanDay(root, iso));
  return files;
}

/**
 * Free bytes available to unprivileged users on the filesystem holding `root`.
 * @param {string} root
 * @returns {Promise<number|null>} null when it cannot be read
 */
async function freeBytesOf(root) {
  try { const s = await statfs(root); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

/**
 * Defence in depth: whether `rel` is an .mp4 directly inside <root>/MMDDYYYY/.
 * @param {string} root
 * @param {string} rootAbs resolved root with a trailing separator
 * @param {string} abs resolved candidate path
 * @returns {boolean}
 */
function isDeletableClip(root, rootAbs, abs) {
  const parts = path.relative(root, abs).split(path.sep);
  return abs.startsWith(rootAbs) && parts.length === 2 && /^\d{8}$/.test(parts[0]) && abs.endsWith('.mp4');
}

/**
 * Deletes the planned files, refusing any path that is not a clip in the layout.
 * @param {string} root
 * @param {object[]} planned files from the plan
 * @param {(msg: string) => void} log
 * @returns {Promise<{deleted: number, failed: number, dirs: Set<string>}>} dirs are those that lost a file
 */
async function deleteClips(root, planned, log) {
  const rootAbs = path.resolve(root) + path.sep;
  const out = { deleted: 0, failed: 0, dirs: new Set() };
  for (const f of planned) {
    const abs = path.resolve(root, f.rel);
    if (!isDeletableClip(root, rootAbs, abs)) { log(`retention: refusing to delete unexpected path ${f.rel}`); out.failed++; continue; }
    try { await unlink(abs); out.deleted++; out.dirs.add(path.dirname(abs)); }
    catch (e) { out.failed++; log(`retention: could not delete ${f.rel}: ${e.message}`); }
  }
  return out;
}

/** Removes each directory in `dirs` that is now empty. @param {Iterable<string>} dirs */
async function removeEmptyDirs(dirs) {
  for (const d of dirs) {
    try { if ((await readdir(d)).length === 0) await rmdir(d); } catch { /* not empty / gone */ }
  }
}

/**
 * Plan and (optionally) apply retention.
 * apply=false only reports.
 * @param {{root: string, policy: object, apply?: boolean, now?: number, log?: (msg: string) => void}} opts
 * @returns {Promise<{plan: object, deleted: number, failed: number, freeBytes: number|null}>}
 */
export async function runRetention({ root, policy, apply = false, now = Date.now(), log = () => {} }) {
  const files = await scanLibrary(root);
  const freeBytes = await freeBytesOf(root);
  const plan = planRetention({ files, now, freeBytes, ...policy });
  const out = { plan, deleted: 0, failed: 0, freeBytes };
  if (!apply || !plan.delete.length) return out;

  const { deleted, failed, dirs } = await deleteClips(root, plan.delete, log);
  await removeEmptyDirs(dirs);
  return { ...out, deleted, failed };
}
