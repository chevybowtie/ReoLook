// Validated, additive edits of config.json from the settings page.
import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalize, withConfigLock } from './config.mjs';
import { isSchedule } from './schedule.mjs';
import { normalizeDetection, DetectionConfigError } from './detect/config.mjs';

export class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'SettingsError'; this.status = status; }
}

/** A check for a finite number of at least `min`. */
const num = (min) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min;
/** A check for null or a finite number of at least `min`. */
const numOrNull = (min) => (v) => v === null || num(min)(v);
/** Checks for null or an absolute path with no NUL character. */
const absOrNull = (v) => v === null || (typeof v === 'string' && v.trim() !== '' && path.isAbsolute(v) && !v.includes('\0'));
/** A check for one of the listed values. */
const oneOf = (...opts) => (v) => opts.includes(v);

const RULES = {
  root: { check: (v) => typeof v === 'string' && v.trim() !== '' && path.isAbsolute(v) && !v.includes('\0'), msg: 'root must be an absolute folder path' },
  exportDir: { check: absOrNull, msg: 'exportDir must be an absolute folder path or null' },
  snapshotDir: { check: absOrNull, msg: 'snapshotDir must be an absolute folder path or null' },
  record: {
    enabled: { check: (v) => typeof v === 'boolean', msg: 'record.enabled must be true or false' },
    mode: { check: oneOf('motion', 'continuous'), msg: 'record.mode must be "motion" or "continuous"' },
    stream: { check: oneOf('main', 'sub'), msg: 'record.stream must be "main" or "sub"' },
    postRollSec: { check: num(1), msg: 'record.postRollSec must be a number of at least 1' },
    maxSegmentMin: { check: num(1), msg: 'record.maxSegmentMin must be a number of at least 1' },
    cameras: { check: (v) => v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string')), msg: 'record.cameras must be a list of device ids or null' },
    schedule: { check: (v) => v === null || isSchedule(v), msg: 'record.schedule must be null or 168 characters of 0, m or c' },
    requireMount: { check: absOrNull, msg: 'record.requireMount must be an absolute path or null' },
  },
  retention: {
    maxAgeDays: { check: numOrNull(0), msg: 'retention.maxAgeDays must be a number of at least 0, or null' },
    maxSizeGB: { check: numOrNull(0), msg: 'retention.maxSizeGB must be a number of at least 0, or null' },
    minFreeGB: { check: numOrNull(0), msg: 'retention.minFreeGB must be a number of at least 0, or null' },
    intervalMin: { check: num(1), msg: 'retention.intervalMin must be a number of at least 1' },
    apply: { check: (v) => typeof v === 'boolean', msg: 'retention.apply must be true or false' },
  },
};

/** Strictly check a patch's shape. Unknown keys are rejected, never ignored. */
export function checkPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('settings must be an object');
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'detection') {
      try { normalizeDetection(v); } catch (e) { if (e instanceof DetectionConfigError) throw new SettingsError(e.message); throw e; }
      continue;
    }
    const rule = RULES[k];
    if (!rule) throw new SettingsError(`unknown setting "${k}"`);
    if (k === 'record' || k === 'retention') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SettingsError(`${k} must be an object`);
      for (const [kk, vv] of Object.entries(v)) {
        const r = rule[kk];
        if (!r) throw new SettingsError(`unknown setting "${k}.${kk}"`);
        if (!r.check(vv)) throw new SettingsError(r.msg);
      }
    } else if (!rule.check(v)) throw new SettingsError(rule.msg);
  }
}

/** Whether `child` is `parent` or lies within it (both resolved to absolute paths). */
const inside = (child, parent) => { const c = path.resolve(child), p = path.resolve(parent); return c === p || c.startsWith(p + path.sep); };

/** Merge a checked patch into the raw config object; `null` removes an optional key. */
export function mergePatch(raw, patch) {
  const next = structuredClone(raw);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'record' || k === 'retention') {
      next[k] = { ...(next[k] ?? {}) };
      for (const [kk, vv] of Object.entries(v)) { if (vv === null && !['intervalMin'].includes(kk)) delete next[k][kk]; else next[k][kk] = vv; }
    } else if (k === 'detection') next.detection = v;
    else if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

/**
 * Validate a patch against the current config and persist it.
 * Returns { raw, config }, where config is the normalized result. Throws SettingsError.
 */
export function saveSettings(file, patch, { currentRoot = null } = {}) {
  return withConfigLock(async () => {
    checkPatch(patch);
    let raw = {};
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new SettingsError(`cannot read ${file}: ${e.message}`, 500); }
    const next = mergePatch(raw, patch);
    let config;
    try { config = normalize(next); } catch (e) { throw new SettingsError(e.message); }

    if (patch.root !== undefined) {
      let st; try { st = await stat(config.root); } catch { throw new SettingsError(`the recordings folder does not exist: ${config.root}`); }
      if (!st.isDirectory()) throw new SettingsError(`not a folder: ${config.root}`);
    }
    const root = config.root ?? currentRoot;
    for (const key of ['exportDir', 'snapshotDir']) {
      if (config[key] && root && inside(config[key], root)) throw new SettingsError(`${key} must be outside the recordings library`);
    }
    if (config.record.enabled && !config.root) throw new SettingsError('choose a recordings folder before turning recording on');

    const bak = `${file}.bak`;
    try { await access(file); try { await access(bak); } catch { await copyFile(file, bak); } } catch { /* new file */ }
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, file);
    return { raw: next, config };
  });
}

/** What the page may see: no credentials exist in the config, but keep the shape explicit. */
export function publicSettings(config, { defaultExportDir }) {
  return {
    root: config.root, exportDir: config.exportDir, snapshotDir: config.snapshotDir, defaultExportDir,
    record: { ...config.record }, retention: { ...config.retention }, detection: config.detection,
    devices: config.cameras.map((c) => ({ id: c.id, name: c.name })), port: config.port,
  };
}
