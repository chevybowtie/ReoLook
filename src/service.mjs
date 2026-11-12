import { CameraRecorder } from './recorder.mjs';
import { ClientPool } from './client-pool.mjs';
import { runRetention } from './retention.mjs';
import { modeAt } from './schedule.mjs';
import { stat, mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Throws a plain-language error unless files can be created inside `dir`. A drive can be mounted and
 * still belong to another user, which is what a mount check cannot see.
 */
export async function assertWritable(dir) {
  const probe = path.join(dir, `.reolook-write-test-${process.pid}`);
  try {
    await mkdir(probe);
    await rmdir(probe);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
      let who = '';
      try { const st = await stat(dir); who = ` The folder belongs to uid ${st.uid} (mode ${(st.mode & 0o777).toString(8)}); ReoLook runs as uid ${process.getuid?.()}.`; } catch { /* ignore */ }
      throw new Error(`cannot write to ${dir}: ${e.code === 'EROFS' ? 'the drive is read-only' : 'permission denied'}.${who}`);
    }
    throw e;
  }
}

/** Throws unless `p` exists and is a mount point (different device than its parent). */
export async function assertMounted(p) {
  const [a, b] = await Promise.all([stat(p), stat(path.dirname(path.resolve(p)))]);
  if (!a.isDirectory() || a.dev === b.dev) throw new Error(`${p} is not mounted; refusing to record onto the local disk`);
}

/** A size as GB, MB or kB, for the log. */
const fmtGB = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.round(b / 1024)} kB`);

/**
 * What kind of message this is, with the parts that change between occurrences removed: memory addresses
 * (ffmpeg prints a different one each run) and numbers (seconds, ports). Two messages of one kind get one key.
 * @param {string} message
 * @returns {string}
 */
export function messageKind(message) {
  return String(message).replace(/0x[0-9a-f]+/gi, '0x#').replace(/\d+/g, '#');
}

/**
 * A logger that says each kind of message at most once per `windowMs`, however often it happens. It remembers
 * only recent kinds, so a camera that fails in a new way every second cannot make it grow without limit.
 * @param {(msg: string) => void} log where messages go
 * @param {{windowMs?: number, now?: () => number, maxKinds?: number}} [o] `maxKinds`: how many kinds to keep before dropping the expired ones
 * @returns {(key: string, msg: string) => void} `key` says whose message it is (the device); the kind comes from `msg`
 */
export function createLogOnce(log, { windowMs = 60_000, now = Date.now, maxKinds = 200 } = {}) {
  const lastLogged = new Map();
  const logOnce = (key, msg) => {
    const k = `${key}:${messageKind(msg)}`, t = now();
    if (t - (lastLogged.get(k) ?? -Infinity) < windowMs) return;
    lastLogged.set(k, t); log(msg);
    if (lastLogged.size > maxKinds) for (const [kk, tt] of lastLogged) if (t - tt >= windowMs) lastLogged.delete(kk);
  };
  Object.defineProperty(logOnce, 'size', { get: () => lastLogged.size });   // how many kinds are remembered, for tests
  return logOnce;
}

/**
 * Runs one CameraRecorder per configured camera.
 * `status()` is safe to expose over the local API (no credentials).
 * @param {object} o
 * @param {ClientPool} [o.clients] where the cameras' clients come from; pass the pool the rest of the process uses so
 *   the recorder shares one session per camera with it. Without one, the recorders get clients of their own.
 */
export function startRecorders({ config, user, password, log = console.log, makeRecorder = null, clients = new ClientPool() }) {
  const rc = config.record;
  const wanted = rc.cameras ? config.cameras.filter((c) => rc.cameras.includes(c.id)) : config.cameras;
  const state = new Map();
  // An unreachable camera errors every poll; log each distinct message at most once a minute.
  const logOnce = createLogOnce(log);

  const recorders = wanted.map((cam) => {
    const st = { id: cam.id, name: cam.name, recording: false, lastClip: null, lastError: null, clips: 0 };
    state.set(cam.id, st);
    const opts = {
      client: clients.viewer({ host: cam.host, user, password }), name: cam.name, outDir: config.root,
      channel: cam.channel, stream: rc.stream, always: rc.mode === 'continuous',
      modeAt: rc.schedule ? (d) => modeAt(rc.schedule, d) : null,
      // mounted is not enough: it must also be writable by this user
      guard: async () => { if (rc.requireMount) await assertMounted(rc.requireMount); await assertWritable(config.root); }, postRollMs: rc.postRollSec * 1000, maxSegmentMs: rc.maxSegmentMin * 60_000,
    };
    const r = makeRecorder ? makeRecorder(opts) : new CameraRecorder(opts);
    r.on('start', () => { st.recording = true; log(`[${cam.name}] recording started`); });
    r.on('stop', ({ file, bytes }) => {
      st.recording = false; st.clips++; st.lastClip = { file: file.split('/').slice(-2).join('/'), bytes, at: new Date().toISOString() };
      log(`[${cam.name}] saved ${st.lastClip.file} (${fmtGB(bytes)})`);
    });
    r.on('discard', ({ reason }) => { st.recording = false; log(`[${cam.name}] discarded: ${reason}`); });
    r.on('mismatch', ({ expected: e, actual: a }) =>
      log(`[${cam.name}] warning: clip is ${a.width}x${a.height}, camera configured for ${e.width}x${e.height}`));
    // an error is a fact about now: once the camera answers again it is no longer shown
    r.on('recovered', () => { if (st.lastError) { log(`[${cam.name}] reachable again`); st.lastError = null; } });
    r.on('error', (e) => { st.lastError = { message: e.message, at: new Date().toISOString() }; logOnce(cam.id, `[${cam.name}] ${e.message}`); });
    return r;
  });
  recorders.forEach((r) => r.start());
  log(`recording ${wanted.length} camera(s) ${rc.schedule ? 'on a weekly schedule' : rc.mode === 'continuous' ? 'continuously' : 'on motion'} → ${config.root} (${rc.stream} stream)`);

  return {
    status: () => [...state.values()].map((s) => ({ ...s, scheduled: rc.schedule ? modeAt(rc.schedule, new Date()) : null })),
    stop: () => Promise.all(recorders.map((r) => r.stop())),
  };
}

/** Periodic retention. Reports only unless policy.apply is true. */
export function startRetention({ config, log = console.log, run = runRetention }) {
  const { apply, intervalMin, ...policy } = config.retention;
  const state = { lastRun: null, last: null, running: false };

  /**
   * One retention pass: plans (and, if `apply`, performs) deletion and logs the outcome. Skips if one is already running or there is no folder.
   */
  async function once() {
    if (state.running || !config.root) return;
    state.running = true;
    try {
      const r = await run({ root: config.root, policy, apply, log });
      const n = r.plan.delete.length;
      state.lastRun = new Date().toISOString();
      state.last = { total: r.plan.total, totalBytes: r.plan.totalBytes, candidates: n, candidateBytes: r.plan.bytes,
        deleted: r.deleted, failed: r.failed, applied: apply };
      log(n === 0
        ? `retention: nothing to delete (${r.plan.total} clips, ${fmtGB(r.plan.totalBytes)})`
        : apply
          ? `retention: deleted ${r.deleted}/${n} clips (${fmtGB(r.plan.bytes)})${r.failed ? `, ${r.failed} failed` : ''}`
          : `retention: would delete ${n} clips (${fmtGB(r.plan.bytes)}) — plan only; set retention.apply=true to enforce`);
    } catch (e) { log(`retention: failed: ${e.message}`); }
    finally { state.running = false; }
  }

  const hasPolicy = Object.values(policy).some((v) => v != null);
  let timer = null;
  if (hasPolicy) {
    timer = setInterval(once, intervalMin * 60_000);
    setTimeout(once, 5_000);
  }
  return { status: () => ({ configured: hasPolicy, apply, ...state }), runNow: once, stop: () => clearInterval(timer) };
}
