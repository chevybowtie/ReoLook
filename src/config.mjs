import { readFile, writeFile, rename, copyFile, mkdir, access } from 'node:fs/promises';
import { xdgDir } from './xdg.mjs';
import path from 'node:path';
import { isSchedule } from './schedule.mjs';
import { normalizeDetection, DetectionConfigError } from './detect/config.mjs';

export const defaultConfigPath = path.join(xdgDir('config'), 'reolook', 'config.json');

/** Lower-case letters and digits with single hyphens between words; used for device ids. */
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Config never holds credentials; they come from REOLINK_USER / REOLINK_PASS.
 * { root, port, cameras: [{ id?, name, host, channel? }],
 *   record:    { enabled, mode: "motion"|"continuous", stream: "main"|"sub", postRollSec, maxSegmentMin, cameras?: [id],
 *                requireMount?: "/mnt/videos" (refuse to record unless it is a mount point),
 *                schedule?: 168 chars of 0/m/c (day-major from Sunday, hour of day): off / motion / continuous; absent = always `mode` },
 *   retention: { maxAgeDays, maxSizeGB, minFreeGB, intervalMin, apply },
 *   exportDir?: "/home/you/Videos/ReoLook" (default folder offered for clip downloads/exports),
 *   snapshotDir?: "/home/you/Pictures/ReoLook" (snapshots are saved here; unset = browser download) }
 * Retention only reports what it would delete unless `apply` is true.
 */
export async function loadConfig(file = defaultConfigPath) {
  let raw = {};
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`cannot read config ${file}: ${e.message}`); }
  return normalize(raw);
}

/**
 * Validates a raw configuration and fills in defaults. @returns {object} @throws {Error} naming the first thing that is wrong
 */
export function normalize(raw) {
  const cameras = (raw.cameras ?? []).map((c) => {
    if (!c.name || !c.host) throw new Error('each camera needs "name" and "host"');
    return { id: c.id ?? slug(c.name), name: c.name, host: c.host, channel: c.channel ?? 0, ...(c.mac ? { mac: c.mac } : {}) };
  });
  const ids = new Set();
  for (const c of cameras) {
    if (ids.has(c.id)) throw new Error(`duplicate camera id "${c.id}"`);
    ids.add(c.id);
  }
  const r = raw.record ?? {};
  const t = raw.retention ?? {};
  /** Checks an optional number is at least `min`; null/undefined gives null unless `allowNull` is false. */
  const num = (v, name, { min = 0, allowNull = true } = {}) => {
    if (v == null) { if (allowNull) return null; throw new Error(`${name} is required`); }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new Error(`${name} must be a number >= ${min}`);
    return v;
  };
  const record = {
    enabled: r.enabled === true,
    mode: r.mode === 'continuous' ? 'continuous' : 'motion',
    stream: r.stream === 'sub' ? 'sub' : 'main',
    postRollSec: num(r.postRollSec ?? 15, 'record.postRollSec', { min: 1 }),
    maxSegmentMin: num(r.maxSegmentMin ?? 30, 'record.maxSegmentMin', { min: 1 }),
    cameras: Array.isArray(r.cameras) ? r.cameras : null,
    requireMount: typeof r.requireMount === 'string' ? r.requireMount : null,
    schedule: r.schedule == null ? null : r.schedule,
  };
  if (record.schedule !== null && !isSchedule(record.schedule)) throw new Error('record.schedule must be 168 characters of 0, m or c (7 days x 24 hours, Sunday first)');
  if (r.mode != null && r.mode !== 'motion' && r.mode !== 'continuous') throw new Error('record.mode must be "motion" or "continuous"');
  for (const id of record.cameras ?? []) if (!ids.has(id)) throw new Error(`record.cameras: unknown camera "${id}"`);
  const retention = {
    maxAgeDays: num(t.maxAgeDays, 'retention.maxAgeDays'),
    maxSizeGB: num(t.maxSizeGB, 'retention.maxSizeGB'),
    minFreeGB: num(t.minFreeGB, 'retention.minFreeGB'),
    intervalMin: num(t.intervalMin ?? 60, 'retention.intervalMin', { min: 1 }),
    apply: t.apply === true,
  };
  const exportDir = typeof raw.exportDir === 'string' && raw.exportDir ? raw.exportDir : null;
  const snapshotDir = typeof raw.snapshotDir === 'string' && raw.snapshotDir ? raw.snapshotDir : null;
  let detection;
  try { detection = normalizeDetection(raw.detection ?? {}); }
  catch (e) { if (e instanceof DetectionConfigError) throw new Error(`detection: ${e.message}`); throw e; }
  // a camera that was removed does not keep a rule
  for (const id of Object.keys(detection.cameras)) if (!ids.has(id)) delete detection.cameras[id];
  return { root: raw.root ?? null, port: raw.port ?? 8787, cameras, record, retention, exportDir, snapshotDir, detection };
}

const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::\d{1,5})?$/;
/** Hostname or IPv4, optionally :port. Rejects URLs, paths, userinfo and whitespace. */
export function isValidHost(h) {
  if (typeof h !== 'string' || !HOST.test(h)) return false;
  const port = h.split(':')[1];
  return port === undefined || (+port >= 1 && +port <= 65535);
}

/** Unique camera id derived from the name. */
export function uniqueId(name, existing) {
  const base = slug(name) || 'camera';
  let id = base;
  for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Persist the camera list. Additive: every other key in the file is preserved,
 * a one-time `.bak` is kept before the first change, and the write is atomic.
 */
let writeChain = Promise.resolve();
/** Serialize every read-modify-write of config.json so concurrent edits cannot lose each other. */
export function withConfigLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/**
 * Writes the device list into the configuration file, keeping everything else in it. One write at a time. @param {string} file @param {object[]} cameras
 */
export async function saveCameras(file, cameras) {
  return withConfigLock(() => saveCamerasUnlocked(file, cameras));
}

/** The body of `saveCameras`, run while holding the configuration lock. */
async function saveCamerasUnlocked(file, cameras) {
  let raw = {};
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`cannot read config ${file}: ${e.message}`); }
  const bak = `${file}.bak`;
  try { await access(file); try { await access(bak); } catch { await copyFile(file, bak); } } catch { /* no file yet */ }
  raw.cameras = cameras.map((c) => ({ name: c.name, host: c.host, ...(c.channel ? { channel: c.channel } : {}), ...(c.mac ? { mac: c.mac } : {}) }));
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}
