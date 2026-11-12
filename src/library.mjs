// Indexes recordings in the Reolink-app / ReoLook layout:
//   <root>/MMDDYYYY/<Camera name>-00-HHMMSS-HHMMSS.mp4
// Reads one day at a time; never walks the whole tree.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const DAY_DIR = /^(\d{2})(\d{2})(\d{4})$/;   // MMDDYYYY
const FILE = /^(.*)-(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mp4$/;

/** Opaque clip id for a path relative to the root. @param {string} relPath @returns {string} base64url */
export const idOf = (relPath) => Buffer.from(relPath, 'utf8').toString('base64url');
/** Inverse of idOf. @param {string} id @returns {string} the relative path */
export const relOf = (id) => Buffer.from(id, 'base64url').toString('utf8');

/** Directory entries of `dir`, or [] when it cannot be read. @param {string} dir @returns {Promise<import('node:fs').Dirent[]>} */
async function ls(dir) { try { return await readdir(dir, { withFileTypes: true }); } catch { return []; } }

/** Local Date for day `iso` (YYYY-MM-DD) at h:mi:s (strings or numbers). @returns {Date} */
const at = (iso, h, mi, s) => {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d, +h, +mi, +s);
};

/**
 * Days (YYYY-MM-DD) that have a recordings folder, newest first.
 * @param {string} root recordings root
 * @returns {Promise<string[]>}
 */
export async function listDays(root) {
  const days = [];
  for (const e of await ls(root)) {
    const m = e.isDirectory() && DAY_DIR.exec(e.name);
    if (m) days.push(`${m[3]}-${m[1]}-${m[2]}`);
  }
  return days.sort().reverse();
}

/**
 * Clips for one day, newest first. In-progress `.part.mp4` files are skipped.
 * @param {string} root recordings root
 * @param {string} iso day, YYYY-MM-DD
 * @returns {Promise<{id: string, camera: string, channel: number, start: string, end: string}[]>}
 */
export async function listClips(root, iso) {
  const [y, m, d] = iso.split('-');
  const dir = `${m}${d}${y}`;
  const clips = [];
  for (const f of await ls(path.join(root, dir))) {
    const w = f.isFile() && !f.name.endsWith('.part.mp4') && FILE.exec(f.name);
    if (!w) continue;
    const start = at(iso, w[3], w[4], w[5]);
    let end = at(iso, w[6], w[7], w[8]);
    if (end < start) end = new Date(end.getTime() + 86_400_000); // crossed midnight
    clips.push({
      id: idOf(`${dir}/${f.name}`), camera: w[1], channel: Number(w[2]),
      start: start.toISOString(), end: end.toISOString(),
    });
  }
  return clips.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
}
