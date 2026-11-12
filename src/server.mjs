import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat, mkdir, statfs, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { listDays, listClips, relOf } from './library.mjs';
import { limiter, mapLimit, memoizeAsync } from './concurrency.mjs';
import { byteRange } from './byte-range.mjs';
import { LiveHub } from './live.mjs';
import { ReolinkClient, ReolinkError, SHARED_MOTION_MS } from './client.mjs';
import { ClientPool } from './client-pool.mjs';
import { VERSION, LICENSE } from './version.mjs';
import { isValidHost, uniqueId, saveCameras, defaultConfigPath } from './config.mjs';
import { CameraRecorder } from './recorder.mjs';
import { JobQueue } from './jobs.mjs';
import { checkDest, copyFileTo, cutParts, safeName } from './export.mjs';
import { assertMounted, assertWritable } from './service.mjs';
import { discover, identify, normMac } from './discovery.mjs';
import { copyIntent } from './device-settings.mjs';
import { resolutionOptions, changeResolution } from './resolution.mjs';
import { tcpProbe } from './net-probe.mjs';
import { checkTools } from './system.mjs';
import { appendFile } from 'node:fs/promises';
import { detectorStatus, DetectorClient, detectorPaths } from './detect/helper-client.mjs';
import { trainRule, MIN_EACH } from './detect/training.mjs';
import { Classifiers } from './detect/classifier.mjs';
import { EventLog } from './detect/events.mjs';
import { loadEnvVars } from './credentials.mjs';
import { DetectionService } from './detect/service.mjs';
import { normalizeCamera, normalizeDetection, normalizeRule, DetectionConfigError } from './detect/config.mjs';
import { Notifier } from './detect/notify.mjs';
import { MqttPublisher } from './mqtt.mjs';
import { hhmm } from './detect/service.mjs';
import { ptzRequest, ptz, listPresets, savePreset, siren, reboot, batteryInfo } from './controls.mjs';
import { listUsers, userConstraints, checkOperation, applyOperation, userRules } from './users.mjs';
import { saveSettings, publicSettings, SettingsError } from './settings.mjs';
import { createSystem } from './system.mjs';
import { getProfile, ProfileCache } from './capabilities.mjs';
import { parseMotion } from './motion.mjs';
import { AdminSessions, LoginThrottle, parseCookies } from './admin.mjs';
import { WriteService } from './safe-write.mjs';
import { ChangeLog } from './change-log.mjs';
import { WriteError } from './device-settings.mjs';
import { scanLibrary, runRetention } from './retention.mjs';
import { uniquePath } from './export.mjs';

const execFileP = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname);

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Returned by a route group that did not recognise the request, so the next group is tried. */
const NEXT = Symbol('next route group');

/**
 * Builds ReoLook's local HTTP server: the page, the JSON API behind it, recordings and live pictures.
 * Nothing is listening until the caller calls `listen()`; the returned server also has `stopManual()` and
 * `drainJobs()` for an orderly shutdown.
 * @param {object} o
 * @param {object} o.config normalised configuration (devices, recordings folder, retention, detection)
 * @param {string} o.user @param {string} o.password the viewer account for the cameras
 * @param {object} [o.runtime] the recorders, retention loop and detection; absent when only the page is wanted
 * @param {ClientPool} [o.clientPool] where the viewer clients come from; share one with the runtime so each camera has one session
 * @returns {import('node:http').Server}
 */
export function createServer({ config, configPath = defaultConfigPath, user, password, getStatus = () => ({}),
  makeRecorder = (o) => new CameraRecorder(o), runtime = null, clientPool = new ClientPool(), system = createSystem(), capabilityCache = new ProfileCache(), discoverFn = discover, admin = new AdminSessions(), loginThrottle = new LoginThrottle(),
  writes = new WriteService({ changeLog: new ChangeLog(), probe: tcpProbe }), cacheDir = path.join(os.homedir(), '.cache', 'reolook'), hub = new LiveHub(), demo = false }) {
  let root = config.root;
  const limit = limiter(6);
  const clients = new Map(config.cameras.map((c) => [c.id, clientPool.viewer({ host: c.host, user, password })]));

  /** Resolve a media id to a file strictly inside `root`. */
  async function resolveMedia(id) {
    if (!root) return null;
    let rel;
    try { rel = relOf(id); } catch { return null; }
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
    if (path.extname(abs).toLowerCase() !== '.mp4') return null;
    try { return (await stat(abs)).isFile() ? abs : null; } catch { return null; }
  }

  /**
   * Reads a request body as JSON. An empty body is `{}`.
   * @param {object} req
   * @param {number} [max] largest body accepted, in bytes
   * @returns {Promise<object>} @throws an error with `status` 413 (too large) or 400 (not JSON)
   */
  async function readJson(req, max = 4096) {
    let n = 0; const chunks = [];
    for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  }

  /** State-changing requests must come from our own page (CSRF / cross-site guard). */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  /** Answers with a JSON body that must not be cached. @param {object} res @param {number} code @param {unknown} body */
  function json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  /**
   * Streams a file, honouring a single byte range so a player can seek.
   * @param {object} req
   * @param {object} res
   * @param {string} abs file path
   * @param {{size: number}} st its stat
   * @param {string} type content type
   */
  function sendFile(req, res, abs, st, type) {
    const range = byteRange(req.headers.range, st.size);
    if (range === 'unsatisfiable') { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    if (range) {
      const { start, end } = range;
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      return createReadStream(abs, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': st.size });
    createReadStream(abs).pipe(res);
  }

  /**
   * A small JPEG of a recording, made with ffmpeg on first use and cached by the file's name, size and time.
   * @param {string} abs recording path @returns {Promise<string>} path of the cached picture
   */
  async function thumbnail(abs) {
    const st = await stat(abs);
    const key = createHash('sha1').update(`${abs}:${st.size}:${st.mtimeMs}`).digest('hex');
    const out = path.join(cacheDir, 'thumbs', `${key}.jpg`);
    try { await stat(out); return out; } catch { /* generate */ }
    return makeThumb(`${abs}\0${out}`);
  }
  // Two requests for the same missing picture share one ffmpeg run instead of writing the same file twice.
  const makeThumb = memoizeAsync(async (key) => {
    const [abs, out] = key.split('\0');
    await mkdir(path.dirname(out), { recursive: true });
    await limit(() => execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', '1', '-i', abs, '-frames:v', '1', '-vf', 'scale=320:-2', '-y', out], { timeout: 20_000 }));
    return out;
  }, { keep: false });

  const manual = new Map(); // camera id -> { rec, since, last, error }
  const defaultExportDir = path.join(os.homedir(), 'Videos', 'ReoLook');
  /** The folder offered for downloads and exports: the configured one, else ~/Videos/ReoLook. */
  const exportDirNow = () => config.exportDir ?? defaultExportDir;
  const jobs = new JobQueue({
    run: async (job, ctx) => {
      // checked again at run time: the disk may have filled while the job waited
      const dest = await checkDest(job.dest, { root, needBytes: job.payload.needBytes });
      if (job.kind === 'copy') return copyFileTo({ src: job.payload.src, destDir: dest, name: job.payload.name, ...ctx });
      return cutParts({ parts: job.payload.parts, destDir: dest, name: job.payload.name, ...ctx });
    },
  });
  /** Formats milliseconds into the HHMMSS used in recording file names. @param {number} ms @returns {string} */
  const hms = (ms) => { const t = Math.floor(ms / 1000); return `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}${String(Math.floor(t / 60) % 60).padStart(2, '0')}${String(t % 60).padStart(2, '0')}`; };

  // ---- administrator session: credentials live in server memory only; the page gets an opaque,
  // HttpOnly, SameSite=Strict, session-only cookie it cannot read
  const COOKIE = 'reolook_admin';
  /** The administrator session a request belongs to (from its cookie), or undefined. */
  const sessionOf = (req) => admin.get(parseCookies(req.headers.cookie)[COOKIE]);
  /** Sets the administrator cookie: HttpOnly, same-site only, limited to the API, gone when the browser closes. */
  const setCookie = (res, value, extra = '') => res.setHeader('set-cookie', `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api${extra}`);
  const adminClients = new WeakMap();
  /**
   * The signed-in client for one device under an administrator session, made on first use and replaced if the device moved.
   * @param {object} session @param {{id: string, host: string}} cam @returns {ReolinkClient}
   */
  function adminClientFor(session, cam) {
    let byDevice = adminClients.get(session);
    if (!byDevice) { byDevice = new Map(); adminClients.set(session, byDevice); }
    if (byDevice.get(cam.id)?.host !== cam.host) byDevice.delete(cam.id); // the device moved
    if (!byDevice.has(cam.id)) {
      const { user: u, password: pw } = session.credentials();
      byDevice.set(cam.id, new ReolinkClient({ host: cam.host, user: u, password: pw }));
    }
    return byDevice.get(cam.id);
  }
  /**
   * Checks an account against one device with a single sign-in.
   * @returns {Promise<'accepted'|'denied'|'unreachable'>} denied: the device refused the account; unreachable: it did not answer
   */
  async function tryLogin(cam, user, password) {
    const c = new ReolinkClient({ host: cam.host, user, password, timeoutMs: 8000 });
    try { await c.devInfo(); return 'accepted'; }
    catch (e) { return e instanceof ReolinkError && e.code !== undefined ? 'denied' : 'unreachable'; }
    finally { c.logout().catch(() => {}); }
  }
  /** The administrator client for a device, or an error reply. Never falls back to the viewer. */
  function adminAccess(req, res, cam) {
    const sess = sessionOf(req);
    if (!sess) { json(res, 401, { error: 'administrator sign-in required' }); return null; }
    if (sess.accepted[cam.id] !== 'accepted') { json(res, 403, { error: 'this device did not accept the administrator account' }); return null; }
    return { sess, client: adminClientFor(sess, cam) };
  }
  /** Answers a failed write with the status and message the pipeline chose; anything else is rethrown. */
  const writeFailure = (res, e) => {
    if (e instanceof WriteError) return json(res, e.status, { error: e.message, ...(e.current ? { current: e.current } : {}), ...(e.changeId ? { changeId: e.changeId } : {}) });
    throw e;
  };
  /** What the page is told about an administrator session (never the credentials). */
  const adminView = (sess) => ({ active: true, user: sess.user, devices: sess.accepted, expiresAt: new Date(admin.expiresAt(sess)).toISOString() });

  let scanning = false;
  const userLocks = new Map();
  // Every repair of a broken live picture is written down with what else was going on, because the
  // in-memory list is lost on restart and the cause is not obvious.
  const repairsFile = path.join(os.homedir(), '.local', 'state', 'reolook', 'live-repairs.jsonl');
  hub.onResync(async (entry) => {
    const id = entry.key.split(':')[0];
    const rec = runtime?.status().recording.cameras.find((c) => c.id === id);
    const line = { ...entry, recording: Boolean(rec?.recording) || manual.has(id), detecting: runtime?.detection()?.service.status().cameras[id]?.state ?? null };
    try { await mkdir(path.dirname(repairsFile), { recursive: true }); await appendFile(repairsFile, JSON.stringify(line) + '\n', { mode: 0o600 }); } catch { /* history only */ }
  });
  const eventLog = runtime?.events ?? new EventLog();
  const classifiers = new Classifiers(detectorPaths().dir);
  const training = new Set();
  let sharedDetector = null;
  /** The detector used for one-off test runs, started on first use. */
  const testDetector = () => (sharedDetector ??= new DetectorClient());
  // ffmpeg does the live view, recording, thumbnails and export; without it those fail quietly, so
  // say so (checked at start and again every few minutes in case it gets installed)
  let tools = { ffmpeg: true, ffprobe: true, at: 0 };
  /** Re-checks which of ffmpeg and ffprobe are installed. */
  const refreshTools = async () => { tools = { ...(await checkTools()), at: Date.now() }; };
  refreshTools();
  /** Which tools are installed, re-checked in the background every 5 minutes. */
  const toolsNow = () => { if (Date.now() - tools.at > 5 * 60_000) refreshTools(); return tools; };
  const ptzStops = new Map();
  /** Point a configured device at a new address and restart what depends on it. */
  async function repoint(cam, host, mac) {
    const oldHost = cam.host;
    cam.host = host;
    if (mac) cam.mac = normMac(mac);
    await saveCameras(configPath, config.cameras);
    if (!config.cameras.some((c) => c.host === oldHost)) clientPool.forget(oldHost);   // another channel of the same device may still use it
    clients.set(cam.id, clientPool.viewer({ host, user, password }));
    hub.drop(`${cam.id}:`);
    capabilityCache.invalidate?.(cam.id);
    if (runtime) await runtime.reload();
  }
  const following = new Set();
  /**
   * After an address change on the device, find it again and update ReoLook. With a known new
   * address that is one place to look; with DHCP the network is scanned for the same hardware address.
   */
  async function followAddress(cam, expectedIp) {
    if (following.has(cam.id) || !user || !password) return;
    following.add(cam.id);
    /** Waits `ms` milliseconds. */
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      for (let i = 0; i < 24; i++) {
        await wait(5000);
        try {
          if (expectedIp) {
            const f = await identify(expectedIp, { user, password });
            if (!cam.mac || normMac(f.mac) === cam.mac) { if (cam.host !== expectedIp) await repoint(cam, expectedIp, f.mac); return; }
          } else {
            const f = await identify(cam.host, { user, password }).catch(() => null);
            if (f && (!cam.mac || normMac(f.mac) === cam.mac)) return;       // still there: nothing moved
            if (i % 3 === 2) {
              const r = await discoverFn({ configured: config.cameras, user, password });
              const hit = r.devices.find((d) => cam.mac && d.mac && normMac(d.mac) === cam.mac);
              if (hit) { if (hit.host !== cam.host) await repoint(cam, hit.host, hit.mac); return; }
            }
          }
        } catch { /* not back yet */ }
      }
    } finally { following.delete(cam.id); }
  }
  const resolutionBusy = new Set();
  // The camera's own motion decision per device, read on request and shared between viewers for a
  // second so several open pages do not multiply the polling.
  let motionNow = { at: 0, pending: null, value: null };
  /** @returns {Promise<{at: string, devices: Record<string, {motion: boolean|null, error?: string}>}>} each device's motion state, shared for a second */
  function motionStates() {
    if (motionNow.value && Date.now() - motionNow.at < 1000) return Promise.resolve(motionNow.value);
    if (motionNow.pending) return motionNow.pending;
    motionNow.pending = (async () => {
      const entries = await Promise.all(config.cameras.map(async (cam) => {
        try {
          // a device that does not answer must not hold up the others
          const motion = await Promise.race([clients.get(cam.id).motionState({ channel: cam.channel, maxAgeMs: SHARED_MOTION_MS }),
            new Promise((_, no) => setTimeout(() => no(new Error('no answer')), 3000))]);
          return [cam.id, { motion }];
        }
        catch (e) { return [cam.id, { motion: null, error: String(e.message ?? e).slice(0, 120) }]; }
      }));
      motionNow = { at: Date.now(), pending: null, value: { at: new Date().toISOString(), devices: Object.fromEntries(entries) } };
      return motionNow.value;
    })();
    return motionNow.pending;
  }
  /** How many settings of one device are read at once for the settings page (the device's own lock still orders the value reads). */
  const SETTINGS_READ_CONCURRENCY = 3;
  /**
   * One entry of the settings page: what the setting is, whether this account may change it, its
   * current value (or why it could not be read) and, for an editable one, the options it offers.
   * @param {object} s the setting from the registry
   * @param {object} profile the device's capability profile
   * @param {object} client the signed-in administrator client
   * @param {{id: string, channel: number}} cam the device
   * @returns {Promise<object>}
   */
  async function settingItem(s, profile, client, cam) {
    const feat = profile.features[s.feature];
    const editable = Boolean(feat?.usable && feat.access?.[s.needs ?? 'write']);
    const item = { id: s.id, label: s.label, area: s.area, risk: s.risk, restartRequired: s.restartRequired, editable,
      reason: editable ? null : (!feat ? 'unknown feature' : feat.usable ? 'this account may not change it' : 'not available on this device') };
    if (feat?.usable) { try { item.value = await writes.current({ client, deviceId: cam.id, settingId: s.id, channel: cam.channel }); } catch (e) { item.error = String(e.detail ?? e.message); } }
    if (editable && s.constraints) { try { item.options = await s.constraints(client, cam.channel); } catch { /* optional */ } }
    return item;
  }
  let libraryCache = null;
  /**
   * Totals for the status page. Single pass, with no argument spreading, so a very large library cannot overflow the call stack.
   * @param {{bytes: number, end: Date}[]} files from scanLibrary
   * @returns {{clips: number, bytes: number, oldest: string|null}} `oldest` is the earliest clip end, ISO
   */
  function librarySummary(files) {
    let bytes = 0, oldest = Infinity;
    for (const f of files) { bytes += f.bytes; if (+f.end < oldest) oldest = +f.end; }
    return { clips: files.length, bytes, oldest: files.length ? new Date(oldest).toISOString() : null };
  }
  /**
   * The recordings folder's space, whether it can be written, and library totals (rescanned at most every 5 minutes unless `force`).
   * @param {boolean} [force] @returns {Promise<object>}
   */
  async function storageInfo(force = false) {
    if (!root) return { root: null };
    const fsStat = await statfs(root);
    const total = Number(fsStat.blocks) * Number(fsStat.bsize), free = Number(fsStat.bavail) * Number(fsStat.bsize);
    if (force || !libraryCache || libraryCache.root !== root || Date.now() - libraryCache.at > 5 * 60_000) {
      const files = await scanLibrary(root);
      libraryCache = { root, at: Date.now(), ...librarySummary(files) };
    }
    const warnBelowGB = config.retention.minFreeGB;
    // can ReoLook create files here? (a mounted drive can still belong to another user)
    const writable = await assertWritable(root).then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
    return { root, writable, total, free, library: { clips: libraryCache.clips, bytes: libraryCache.bytes, oldest: libraryCache.oldest, scannedAt: new Date(libraryCache.at).toISOString() },
      warnBelowGB, low: warnBelowGB != null && free < warnBelowGB * 1024 ** 3 };
  }

  /** Validate a job request and turn it into queue entries. Throws {status,message} on bad input. */
  async function planJobs(body) {
    /** An error carrying the HTTP status to answer with. */
    const bad = (m, status = 400) => Object.assign(new Error(m), { status });
    if (!root) throw bad('no recordings folder is configured');
    const destRaw = body.dest;
    if (body.kind === 'copy') {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length || ids.length > 200 || ids.some((i) => typeof i !== 'string')) throw bad('select between 1 and 200 clips');
      const items = [];
      for (const id of ids) {
        const abs = await resolveMedia(id);
        if (!abs) throw bad('one of the selected clips no longer exists', 404);
        items.push({ src: abs, name: path.basename(abs, '.mp4'), needBytes: (await stat(abs)).size });
      }
      const dest = await checkDest(destRaw, { root, needBytes: items.reduce((n, i) => n + i.needBytes, 0) }).catch((e) => { throw bad(e.message); });
      return items.map((i) => ({ kind: 'copy', title: i.name, dest, payload: i }));
    }
    if (body.kind === 'cut') {
      const { camera, day, from, to } = body;
      if (typeof camera !== 'string' || !camera || !ISO.test(day ?? '')) throw bad('camera and day are required');
      if (![from, to].every((n) => Number.isFinite(n)) || from < 0 || to <= from || to > 172_800_000) throw bad('invalid time range');
      if (to - from > 12 * 3_600_000) throw bad('a single export is limited to 12 hours');
      const [y, mo, d] = day.split('-').map(Number);
      const dayStart = new Date(y, mo - 1, d).getTime();
      const lo = dayStart + from, hi = dayStart + to;
      const clips = (await listClips(root, day)).filter((c) => c.camera === camera)
        .map((c) => ({ c, s: new Date(c.start).getTime(), e: new Date(c.end).getTime() }))
        .filter((x) => x.e > lo && x.s < hi).sort((a, b) => a.s - b.s);
      if (!clips.length) throw bad('there is no recording in that range');
      const parts = []; let needBytes = 0;
      for (const { c, s: cs, e: ce } of clips) {
        const abs = await resolveMedia(c.id);
        if (!abs) continue;
        const segStart = Math.max(lo, cs), segEnd = Math.min(hi, ce);
        const info = await clipInfo(abs);
        parts.push({ file: abs, seek: (info.base || 0) + (segStart - cs) / 1000, duration: (segEnd - segStart) / 1000 });
        needBytes += Math.ceil((await stat(abs)).size * ((segEnd - segStart) / Math.max(1, ce - cs)));
      }
      if (!parts.length) throw bad('there is no recording in that range');
      const dest = await checkDest(destRaw, { root, needBytes: needBytes * 2 }).catch((e) => { throw bad(e.message); }); // cut pieces + joined file
      const name = `${safeName(camera)} ${day} ${hms(from)}-${hms(to)}`;
      return [{ kind: 'cut', title: name, dest, payload: { parts, name, needBytes } }];
    }
    throw bad('kind must be "copy" or "cut"');
  }
  /**
   * Reads a recording's packet times with ffprobe (index only) and works out where its playable content starts.
   * @param {string} abs recording path @returns {Promise<{base: number, end: number|null, packets: number, jumped: boolean}>}
   */
  const probeClip = (abs) => limit(async () => {
    try {
      const { stdout } = await execFileP('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', abs], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
      let first = null, base = null, prev = null, last = null, n = 0;
      for (const line of stdout.split('\n')) {
        const t = Number(line);
        if (!Number.isFinite(t) || line === '') continue;
        n++;
        if (first === null) { first = t; base = t; }
        if (prev !== null && t - prev > 5) base = t; // the last big forward jump marks the real start
        prev = t; last = t;
      }
      return n ? { base, end: last, packets: n, jumped: base !== first } : { base: 0, end: null, packets: 0, jumped: false };
    } catch { return { base: 0, end: null, packets: 0, jumped: false }; }
  });
  // Keyed by path, size and time, so a changed file is probed again; at most 500 answers are kept and
  // two requests for the same clip share one ffprobe.
  const clipInfoCached = memoizeAsync((key) => probeClip(key.slice(0, key.indexOf('\0'))));
  /**
   * Where the playable content really starts on the file's own timeline.
   * Some clips begin with a few packets near 0 s and then jump far ahead; a browser
   * then needs `currentTime = base + offset`.
   * @param {string} abs recording path @returns {Promise<{base: number, end: number|null, packets: number, jumped: boolean}>}
   */
  async function clipInfo(abs) {
    const st = await stat(abs);
    return clipInfoCached(`${abs}\0${st.size}:${st.mtimeMs}`);
  }

  /**
   * Manual start and stop of a recording for one device.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function recordingRoutes(req, res, url, p) {
    let m;
    if ((m = /^\/api\/record\/([a-z0-9-]+)$/.exec(p)) && (req.method === 'POST' || req.method === 'DELETE')) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      if (req.method === 'POST') {
        if (!root) return json(res, 400, { error: 'no recordings folder is configured' });
        if (manual.has(cam.id)) return json(res, 409, { error: 'already recording' });
        const entry = { rec: null, since: new Date().toISOString(), last: null, error: null };
        entry.rec = makeRecorder({ client: clients.get(cam.id), name: cam.name, outDir: root, channel: cam.channel,
          stream: 'main', always: true,
          guard: config.record?.requireMount ? () => assertMounted(config.record.requireMount) : null });
        entry.rec.on('stop', ({ file }) => { entry.last = path.basename(file); });
        entry.rec.on('error', (e) => { entry.error = e.message; });
        manual.set(cam.id, entry);
        entry.rec.start();
        return json(res, 201, { recording: true, since: entry.since });
      }
      const entry = manual.get(cam.id);
      if (!entry) return json(res, 404, { error: 'not recording' });
      manual.delete(cam.id);
      await entry.rec.stop();
      return json(res, 200, { recording: false, file: entry.last });
    }
    return NEXT;
  }

  /**
   * Administrator sign-in status, sign-in and sign-out.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function adminRoutes(req, res, url, p) {
    if (p === '/api/admin/status' && req.method === 'GET') {
      const sess = sessionOf(req);
      return json(res, 200, sess ? adminView(sess) : { active: false });
    }
    if (p === '/api/admin/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const wait = loginThrottle.waitSeconds();
      if (wait) { res.setHeader('retry-after', String(wait)); return json(res, 429, { error: `too many failed attempts; wait ${wait} s`, retryAfter: wait }); }
      const body = await readJson(req, 2048);
      const u = typeof body.user === 'string' ? body.user.trim() : '', pw = typeof body.password === 'string' ? body.password : '';
      if (!u || !pw || u.length > 128 || pw.length > 256) return json(res, 400, { error: 'enter the administrator user name and password' });
      if (!config.cameras.length) return json(res, 400, { error: 'add a device first' });
      const results = {};
      // One device first: a wrong password then costs the camera one failed attempt, not one per device.
      for (const cam of config.cameras) {
        results[cam.id] = await tryLogin(cam, u, pw);
        if (results[cam.id] === 'denied') { loginThrottle.fail(); return json(res, 401, { error: 'the device refused this user name or password', devices: results }); }
        if (results[cam.id] === 'accepted') break;
      }
      if (!Object.values(results).includes('accepted')) return json(res, 502, { error: 'no device could be reached', devices: results });
      const rest = config.cameras.filter((c) => !(c.id in results));
      await Promise.all(rest.map(async (c) => { results[c.id] = await tryLogin(c, u, pw); }));
      loginThrottle.success();
      const sess = admin.create({ user: u, password: pw, accepted: results });
      setCookie(res, sess.id);
      return json(res, 200, adminView(sess));
    }
    if (p === '/api/admin/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const id = parseCookies(req.headers.cookie)[COOKIE];
      if (id) admin.destroy(id);
      setCookie(res, '', '; Max-Age=0');
      return json(res, 200, { active: false });
    }
    return NEXT;
  }

  /**
   * Reading all of a device's settings, with what this account may change.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function settingsReadRoutes(req, res, url, p) {
    let m;
    if ((m = /^\/api\/devices\/([a-z0-9-]+)\/settings$/.exec(p)) && req.method === 'GET') {
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      let profile = null;
      try { profile = await getProfile(acc.client, cam.host, { channel: cam.channel, cache: capabilityCache, account: 'administrator' }); }
      catch (e) { return json(res, 502, { error: `could not read the device: ${e.message}` }); }
      const items = await mapLimit(writes.list(), SETTINGS_READ_CONCURRENCY, (s) => settingItem(s, profile, acc.client, cam));
      return json(res, 200, { device: cam.id, account: 'administrator', settings: items });
    }
    return NEXT;
  }

  /**
   * Planning, applying and undoing a change to a device setting, and the history of changes.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function settingsChangeRoutes(req, res, url, p) {
    let m;
    if ((m = /^\/api\/devices\/([a-z0-9-]+)\/settings\/([A-Za-z0-9]+)\/plan$/.exec(p)) && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      const body = await readJson(req, 8 * 1024);
      try {
        const setting = writes.list().find((s) => s.id === m[2]);
        if (!setting) return json(res, 404, { error: 'unknown setting' });
        const profile = await getProfile(acc.client, cam.host, { channel: cam.channel, cache: capabilityCache, account: 'administrator' });
        const feat = profile.features[setting.feature];
        if (!feat?.usable) return json(res, 409, { error: `${setting.label} is not available on this device` });
        if (!feat.access?.[setting.needs ?? 'write']) return json(res, 403, { error: `this account may not change ${setting.label.toLowerCase()} on this device` });
        return json(res, 200, await writes.plan({ client: acc.client, deviceId: cam.id, settingId: m[2], input: body.value, channel: cam.channel, owner: acc.sess.id }));
      } catch (e) { return writeFailure(res, e); }
    }
    if ((m = /^\/api\/changes\/([A-Za-z0-9_-]+)\/(apply|undo)$/.exec(p)) && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const sess = sessionOf(req);
      if (!sess) return json(res, 401, { error: 'administrator sign-in required' });
      const info = m[2] === 'apply' ? writes.planInfo(m[1]) : await writes.changeInfo(m[1]);
      if (!info) return json(res, 404, { error: m[2] === 'apply' ? 'this change was not found or has already been applied' : 'that change was not found' });
      const cam = config.cameras.find((c) => c.id === info.deviceId);
      if (!cam) return json(res, 404, { error: 'that device is no longer configured' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      const body = m[2] === 'apply' ? await readJson(req, 1024).catch(() => ({})) : {};
      // some settings must be confirmed by typing what they will do (a new address, for example)
      const setting = writes.list().find((s) => s.id === info.settingId);
      if (m[2] === 'apply' && setting?.confirmText) {
        const need = setting.confirmText({ proposed: info.proposed });
        if (body.confirm !== need) return json(res, 400, { error: `type ${need} to confirm`, needsConfirm: need });
      }
      const moves = info.settingId === 'ipConfig';
      const oldHost = cam.host;
      try {
        const r = m[2] === 'apply'
          ? await writes.apply({ client: acc.client, planId: m[1], owner: sess.id, by: sess.user })
          : await writes.undo({ client: acc.client, changeId: m[1], by: sess.user, channel: cam.channel });
        if (moves) followAddress(cam, r.proposed?.mode === 'Static' ? r.proposed.ip : null);
        return json(res, 200, r);
      } catch (e) {
        // the read-back goes to the old address, so a changed address shows up as an error here
        if (moves) followAddress(cam, info.proposed?.mode === 'Static' ? info.proposed.ip : null);
        return writeFailure(res, e);
      }
    }
    if (p === '/api/changes' && req.method === 'GET') {
      if (!sessionOf(req)) return json(res, 401, { error: 'administrator sign-in required' });
      const lim = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const list = await writes.history({ deviceId: url.searchParams.get('device') || null, limit: lim });
      return json(res, 200, { changes: list.map(({ rawBefore, rawAfter, zonesSaved, ...pub }) => pub) });
    }
    return NEXT;
  }

  /**
   * A device's motion zones and its capability report.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function deviceInfoRoutes(req, res, url, p) {
    let m;
    if ((m = /^\/api\/devices\/([a-z0-9-]+)\/motion$/.exec(p)) && req.method === 'GET') {
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const client = clients.get(cam.id);
      try {
        const profile = await getProfile(client, cam.host, { channel: cam.channel, cache: capabilityCache });
        const feat = profile.features.motion;
        if (!feat?.usable) return json(res, 409, { error: 'this device does not report motion detection settings' });
        const alarm = (await client.command('GetAlarm', { Alarm: { channel: cam.channel, type: 'md' } })).Alarm;
        let md = null;
        try { md = (await client.command('GetMdAlarm', { channel: cam.channel })).MdAlarm; } catch { /* optional second source */ }
        return json(res, 200, { device: cam.id, channel: cam.channel, ...parseMotion(alarm, md) });
      } catch (e) { return json(res, 502, { error: `could not read the device: ${e.message}` }); }
    }
    if ((m = /^\/api\/devices\/([a-z0-9-]+)\/capabilities$/.exec(p)) && req.method === 'GET') {
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const asAdmin = url.searchParams.get('as') === 'admin';
      let client = clients.get(cam.id);
      if (asAdmin) {
        const sess = sessionOf(req);
        if (!sess) return json(res, 401, { error: 'administrator sign-in required' });
        if (sess.accepted[cam.id] !== 'accepted') return json(res, 403, { error: 'this device did not accept the administrator account' });
        client = adminClientFor(sess, cam);
      }
      try {
        const profile = await getProfile(client, cam.host, {
          channel: cam.channel, refresh: url.searchParams.get('refresh') === '1', cache: capabilityCache,
          account: asAdmin ? 'administrator' : 'viewer' });
        return json(res, 200, profile);
      } catch (e) { return json(res, 502, { error: `could not read the device: ${e.message}` }); }
    }
    return NEXT;
  }

  /**
   * ReoLook's own settings, the storage report, the retention preview and the system (service) controls.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function serverSettingsRoutes(req, res, url, p) {
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, publicSettings(config, { defaultExportDir }));
    if (p === '/api/settings' && req.method === 'PUT') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const patch = await readJson(req, 16 * 1024);
      if (patch && patch.root !== undefined && patch.root !== config.root && manual.size) {
        return json(res, 409, { error: 'stop the running manual recordings before changing the recordings folder' });
      }
      try {
        const mount = patch?.record?.requireMount;
        if (typeof mount === 'string') await assertMounted(mount).catch((e) => { throw new SettingsError(e.message); });
        const { config: next } = await saveSettings(configPath, patch, { currentRoot: root });
        for (const k of ['root', 'exportDir', 'snapshotDir', 'record', 'retention', 'detection']) config[k] = next[k];
        root = config.root; libraryCache = null;
      } catch (e) {
        if (e instanceof SettingsError) return json(res, e.status, { error: e.message });
        throw e;
      }
      if (runtime) await runtime.reload();
      return json(res, 200, publicSettings(config, { defaultExportDir }));
    }
    if (p === '/api/storage') return json(res, 200, await storageInfo(url.searchParams.get('refresh') === '1'));
    if (p === '/api/retention/preview') {
      if (!root) return json(res, 400, { error: 'no recordings folder is configured' });
      const policy = {};
      for (const k of ['maxAgeDays', 'maxSizeGB', 'minFreeGB']) {
        const raw = url.searchParams.get(k);
        if (raw === null || raw === '') { policy[k] = null; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return json(res, 400, { error: `${k} must be a number of at least 0` });
        policy[k] = n;
      }
      const r = await runRetention({ root, policy, apply: false });
      const reasons = {};
      for (const f of r.plan.delete) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
      return json(res, 200, { total: r.plan.total, totalBytes: r.plan.totalBytes, freeBytes: r.freeBytes,
        candidates: r.plan.delete.length, bytes: r.plan.bytes, reasons,
        from: r.plan.delete[0]?.end ?? null, to: r.plan.delete.at(-1)?.end ?? null });
    }
    if (p === '/api/system' && req.method === 'GET') {
      return json(res, 200, { service: await system.service(), linger: await system.linger(), user: system.user,
        configPath, port: config.port });
    }
    if (p === '/api/system/linger' && req.method === 'PUT') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be true or false' });
      try { return json(res, 200, { linger: await system.setLinger(body.enabled) }); }
      catch (e) { return json(res, 502, { error: `could not change the setting: ${(e.stderr || e.message).toString().trim().split('\n')[0]}` }); }
    }
    return NEXT;
  }

  /**
   * Snapshots saved to disk, and the queue of copy and export jobs.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function exportRoutes(req, res, url, p) {
    let m;
    if ((m = /^\/api\/snapshot\/([a-z0-9-]+)$/.exec(p)) && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      if (!config.snapshotDir) return json(res, 409, { error: 'no snapshot folder is configured' });
      const dir = await checkDest(config.snapshotDir, { root }).catch((e) => { throw Object.assign(e, { status: 400 }); });
      const d = new Date(), pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const file = await uniquePath(dir, `${safeName(cam.name)} ${stamp}`, '.jpg');
      await writeFile(file, await clients.get(cam.id).snapshot({ channel: cam.channel }), { flag: 'wx' });
      return json(res, 201, { file });
    }
    if (p === '/api/jobs' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const planned = await planJobs(await readJson(req, 64 * 1024));
      return json(res, 201, { jobs: planned.map((j) => jobs.add(j)) });
    }
    if ((m = /^\/api\/jobs\/([0-9]+)$/.exec(p)) && req.method === 'DELETE') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const r = jobs.cancel(m[1]);
      return r ? json(res, 200, { result: r }) : json(res, 404, { error: 'unknown job' });
    }
    return NEXT;
  }

  /**
   * Adding a device, and finding devices on the network.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function deviceAddRoutes(req, res, url, p) {
    if (req.method === 'POST' && p === '/api/cameras') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const body = await readJson(req);
      const host = typeof body.host === 'string' ? body.host.trim() : '';
      if (!isValidHost(host)) return json(res, 400, { error: 'enter an IP address or host name (optionally :port)' });
      if (config.cameras.some((c) => c.host === host)) return json(res, 409, { error: 'this device is already added' });
      if (!user || !password) return json(res, 400, { error: 'REOLINK_USER / REOLINK_PASS are not set' });
      let info;
      try { info = await identify(host, { user, password }); }
      catch (e) { return json(res, 502, { error: `could not reach the device: ${e.message}` }); }
      const name = (typeof body.name === 'string' && body.name.trim()) || info.name || host;
      const cam = { id: uniqueId(name, new Set(config.cameras.map((c) => c.id))), name: name.slice(0, 64), host, channel: 0, ...(info.mac ? { mac: info.mac } : {}) };
      const next = [...config.cameras, cam];
      await saveCameras(configPath, next);
      config.cameras.push(cam);
      clients.set(cam.id, clientPool.viewer({ host, user, password }));
      return json(res, 201, { camera: { id: cam.id, name: cam.name, host: cam.host }, model: info.model ?? null });
    }
    if (req.method === 'POST' && p === '/api/discovery') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      if (scanning) return json(res, 409, { error: 'a scan is already running' });
      scanning = true;
      try {
        const r = await discoverFn({ configured: config.cameras, user, password });
        // learn each device's hardware address the first time it is seen at its configured address
        let learned = false;
        for (const d of r.devices) {
          const cam = config.cameras.find((c) => c.host === d.host);
          if (cam && d.mac && !cam.mac) { cam.mac = d.mac; learned = true; }
        }
        if (learned) await saveCameras(configPath, config.cameras);
        const known = new Set(config.cameras.map((c) => c.host));
        return json(res, 200, {
          scanned: r.scanned, credentials: r.credentials,
          devices: r.devices.map((d) => ({ ...d, added: known.has(d.host) })),
          moved: r.matches.filter((m) => m.changed).map((m) => ({ id: m.id, from: config.cameras.find((c) => c.id === m.id)?.host, to: m.host, by: m.by, name: m.found?.name, model: m.found?.model })),
        });
      } finally { scanning = false; }
    }
    return NEXT;
  }

  /**
   * Pointing a device at a new address, and removing a device.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function deviceEditRoutes(req, res, url, p) {
    let m;
    if (req.method === 'POST' && (m = /^\/api\/cameras\/([a-z0-9-]+)\/host$/.exec(p))) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const body = await readJson(req);
      const host = typeof body.host === 'string' ? body.host.trim() : '';
      if (!isValidHost(host)) return json(res, 400, { error: 'enter an IP address or host name (optionally :port)' });
      if (config.cameras.some((c) => c.host === host && c.id !== cam.id)) return json(res, 409, { error: 'another device already uses this address' });
      if (!user || !password) return json(res, 400, { error: 'REOLINK_USER / REOLINK_PASS are not set' });
      let found;
      try { found = await identify(host, { user, password }); }
      catch (e) { return json(res, 502, { error: `could not reach a device at ${host}: ${e.message}` }); }
      // never silently point a camera at a different device
      const same = cam.mac ? found.mac === cam.mac : found.name === cam.name;
      if (!same && body.confirm !== true) {
        return json(res, 409, { error: `the device at ${host} does not look like ${cam.name}`, found: { name: found.name, model: found.model, mac: found.mac }, expected: { mac: cam.mac ?? null, name: cam.name } });
      }
      await repoint(cam, host, found.mac);
      return json(res, 200, { camera: { id: cam.id, name: cam.name, host }, model: found.model });
    }
    if (req.method === 'DELETE' && (m = /^\/api\/cameras\/([a-z0-9-]+)$/.exec(p))) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const i = config.cameras.findIndex((c) => c.id === m[1]);
      if (i < 0) return json(res, 404, { error: 'unknown device' });
      const next = config.cameras.filter((_, k) => k !== i);
      await saveCameras(configPath, next);
      config.cameras.splice(i, 1);
      clients.delete(m[1]);
      return json(res, 200, { removed: m[1] });
    }
    return NEXT;
  }

  /**
   * Copying settings from one device to others (planning only; each plan is applied like any other change).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function copyRoutes(req, res, url, p) {
    // Copy: read each chosen setting from the source device and plan it on every target. Nothing is
    // written here; each returned plan is applied (and can be undone) like any other change.
    if (req.method === 'POST' && p === '/api/copy/plan') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const sess = sessionOf(req);
      if (!sess) return json(res, 401, { error: 'administrator sign-in required' });
      const body = await readJson(req, 8 * 1024);
      const source = config.cameras.find((c) => c.id === body.source);
      if (!source) return json(res, 404, { error: 'unknown source device' });
      const ids = Array.isArray(body.settings) ? [...new Set(body.settings)] : [];
      const targetIds = Array.isArray(body.targets) ? [...new Set(body.targets)].filter((t) => t !== source.id) : [];
      if (!ids.length || ids.length > 16) return json(res, 400, { error: 'choose between 1 and 16 settings to copy' });
      if (!targetIds.length || targetIds.length > 8) return json(res, 400, { error: 'choose between 1 and 8 target devices' });
      const settings = ids.map((id) => writes.list().find((s) => s.id === id));
      if (settings.some((s) => !s?.copy)) return json(res, 400, { error: 'one of the chosen settings cannot be copied' });
      const targets = targetIds.map((id) => config.cameras.find((c) => c.id === id));
      if (targets.some((t) => !t)) return json(res, 404, { error: 'unknown target device' });
      if (sess.accepted[source.id] !== 'accepted') return json(res, 403, { error: `${source.name} did not accept the administrator account` });
      const srcClient = adminClientFor(sess, source);
      const values = {}, items = [];
      for (const s of settings) {
        try { values[s.id] = await writes.current({ client: srcClient, deviceId: source.id, settingId: s.id, channel: source.channel }); }
        catch (e) { values[s.id] = null; items.push({ settingId: s.id, label: s.label, targetId: null, status: 'error', error: `could not read it from ${source.name}: ${String(e.detail ?? e.message)}` }); }
      }
      for (const t of targets) {
        for (const s of settings) {
          const base = { settingId: s.id, label: s.label, targetId: t.id, targetName: t.name };
          if (values[s.id] === null) continue;
          if (sess.accepted[t.id] !== 'accepted') { items.push({ ...base, status: 'error', error: 'this device did not accept the administrator account' }); continue; }
          try {
            const acc = { client: adminClientFor(sess, t) };
            const profile = await getProfile(acc.client, t.host, { channel: t.channel, cache: capabilityCache, account: 'administrator' });
            const feat = profile.features[s.feature];
            if (!feat?.usable) { items.push({ ...base, status: 'unavailable', error: 'not available on this device' }); continue; }
            if (!feat.access?.[s.needs ?? 'write']) { items.push({ ...base, status: 'error', error: 'this account may not change it on this device' }); continue; }
            const plan = await writes.plan({ client: acc.client, deviceId: t.id, settingId: s.id, input: copyIntent(s, values[s.id]), channel: t.channel, owner: sess.id });
            items.push(plan.noop ? { ...base, status: 'same' } : { ...base, status: 'plan', planId: plan.planId, diff: plan.diff, risk: plan.risk, expiresAt: plan.expiresAt });
          } catch (e) {
            items.push({ ...base, status: 'error', error: e instanceof WriteError ? e.message : `could not read the device: ${String(e.message ?? e).slice(0, 160)}` });
          }
        }
      }
      return json(res, 200, { source: { id: source.id, name: source.name }, items });
    }
    return NEXT;
  }

  /**
   * Changing a device's user accounts.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function accountRoutes(req, res, url, p) {
    let m;
    if (req.method === 'POST' && (m = /^\/api\/devices\/([a-z0-9-]+)\/users$/.exec(p))) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      const body = await readJson(req, 4 * 1024);
      try {
        const profile = await getProfile(acc.client, cam.host, { channel: cam.channel, cache: capabilityCache, account: 'administrator' });
        const feat = profile.features.users;
        if (!feat?.usable) return json(res, 409, { error: 'account management is not available on this device' });
        if (!feat.access?.write) return json(res, 403, { error: 'this account may not manage accounts on this device' });
      } catch (e) { return json(res, 502, { error: `could not read the device: ${String(e.message).slice(0, 120)}` }); }
      const prev = userLocks.get(cam.id) ?? Promise.resolve();
      const run = prev.then(async () => {
        let users, constraints;
        try { users = await listUsers(acc.client); constraints = await userConstraints(acc.client); }
        catch (e) { return json(res, 502, { error: `could not read the accounts: ${String(e.detail ?? e.message)}` }); }
        let checked;
        try { checked = checkOperation(body, { users, viewerName: user, sessionUser: acc.sess.user, constraints }); }
        catch (e) { return writeFailure(res, e); }
        const entry = { deviceId: cam.id, settingId: 'users', label: 'User accounts', by: acc.sess.user, summary: checked.summary };
        try {
          const r = await applyOperation(acc.client, checked, {
            check: async (name, password) => {
              const t = new ReolinkClient({ host: cam.host, user: name, password, timeoutMs: 8000 });
              try { await t.devInfo(); return true; } catch { return false; } finally { t.logout().catch(() => {}); }
            },
          });
          await writes.record({ ...entry, state: r.verified ? 'applied' : 'unverified', verified: r.verified, before: {}, proposed: {}, error: r.verified ? null : 'the device does not show the expected result' });
          return json(res, 200, { verified: r.verified, summary: checked.summary, users: r.users });
        } catch (e) {
          await writes.record({ ...entry, state: 'failed', verified: false, before: {}, proposed: {}, error: String(e.detail ?? e.message).slice(0, 200) });
          return json(res, 502, { error: `the device refused: ${String(e.detail ?? e.message)}` });
        }
      });
      userLocks.set(cam.id, run.catch(() => {}));
      return run;
    }
    return NEXT;
  }

  /**
   * Changing a device's main stream resolution.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function resolutionRoutes(req, res, url, p) {
    let m;
    if (req.method === 'POST' && (m = /^\/api\/devices\/([a-z0-9-]+)\/resolution$/.exec(p))) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      const body = await readJson(req, 2 * 1024);
      const size = typeof body.size === 'string' ? body.size : '';
      if (body.confirm !== size || !size) return json(res, 400, { error: `type the new size (${size || 'for example 2560*1440'}) to confirm`, needsConfirm: size });
      try {
        const profile = await getProfile(acc.client, cam.host, { channel: cam.channel, cache: capabilityCache, account: 'administrator' });
        const feat = profile.features.encoding;
        if (!feat?.usable) return json(res, 409, { error: 'encoding is not available on this device' });
        if (!feat.access?.write) return json(res, 403, { error: 'this account may not change encoding on this device' });
      } catch (e) { return json(res, 502, { error: `could not read the device: ${String(e.message).slice(0, 120)}` }); }
      if (resolutionBusy.has(cam.id)) return json(res, 409, { error: 'a resolution change is already running on this device' });
      resolutionBusy.add(cam.id);
      const { user: au, password: ap } = acc.sess.credentials();
      const entry = { deviceId: cam.id, settingId: 'resolution', label: 'Main stream resolution', by: acc.sess.user };
      try {
        // areas saved by earlier changes, so going back to a picture shape restores what it had
        const past = (await writes.history({ deviceId: cam.id, limit: 100 })).filter((e) => e.settingId === 'resolution' && e.zonesSaved);
        const remembered = past.map((e) => e.zonesSaved);
        const r = await changeResolution({ makeClient: () => new ReolinkClient({ host: cam.host, user: au, password: ap, timeoutMs: 8000 }), channel: cam.channel, size, remembered });
        const ent = { ...entry, state: r.verified ? 'applied' : 'unverified', verified: r.verified, before: { size: r.from }, proposed: { size: r.to },
          summary: `${r.from} → ${r.to}; motion area ${r.zones}`, error: r.error ?? null, zonesSaved: r.saved ?? null };
        await writes.record(ent);
        return json(res, 200, { verified: r.verified, from: r.from, to: r.to, zones: r.zones, error: r.error ?? null });
      } catch (e) {
        if (e instanceof WriteError) return writeFailure(res, e);
        await writes.record({ ...entry, state: 'failed', verified: false, before: {}, proposed: { size }, error: String(e.detail ?? e.message).slice(0, 200) });
        return json(res, 502, { error: `the device refused: ${String(e.detail ?? e.message)}` });
      } finally { resolutionBusy.delete(cam.id); }
    }
    return NEXT;
  }

  /**
   * Live controls: pan/tilt/zoom, presets, siren and floodlight.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function controlRoutes(req, res, url, p) {
    let m;
    // ---- live controls: pan/tilt/zoom, presets, siren, floodlight. Administrator session, and the
    // device must report the feature. Not exercised on real hardware (see src/controls.mjs).
    if (req.method === 'POST' && (m = /^\/api\/devices\/([a-z0-9-]+)\/(ptz|ptz\/preset|siren|floodlight|reboot)$/.exec(p))) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      const kind = m[2];
      const featureId = { siren: 'siren', floodlight: 'floodlight', reboot: 'reboot', 'ptz/preset': 'ptzPreset' }[kind] ?? 'ptz';
      try {
        const profile = await getProfile(acc.client, cam.host, { channel: cam.channel, cache: capabilityCache, account: 'administrator' });
        const feat = profile.features[featureId];
        if (!feat?.usable) return json(res, 409, { error: `${feat?.label ?? featureId} is not available on this device` });
        if (!feat.access?.write && !feat.access?.execute) return json(res, 403, { error: 'this account may not use that on this device' });
      } catch (e) { return json(res, 502, { error: `could not read the device: ${String(e.message).slice(0, 120)}` }); }
      const body = await readJson(req, 2 * 1024);
      try {
        if (kind === 'ptz') {
          const req2 = ptzRequest(body);
          const prev = ptzStops.get(cam.id); if (prev) { clearTimeout(prev); ptzStops.delete(cam.id); }
          await ptz(acc.client, cam.channel, req2);
          // a move never runs on: the device is told to stop shortly after, whatever the page does
          if (req2.op !== 'Stop' && req2.op !== 'ToPos') {
            const ms = Math.min(3000, Math.max(200, Number.isInteger(body.duration) ? body.duration : 800));
            ptzStops.set(cam.id, setTimeout(() => { ptzStops.delete(cam.id); ptz(acc.client, cam.channel, { op: 'Stop' }).catch(() => {}); }, ms));
          }
          return json(res, 200, { ok: true });
        }
        if (kind === 'ptz/preset') {
          await savePreset(acc.client, cam.channel, { id: body.id, name: body.name });
          return json(res, 200, { ok: true, presets: await listPresets(acc.client, cam.channel).catch(() => []) });
        }
        if (kind === 'reboot') {
          if (body.confirm !== true) return json(res, 400, { error: 'a reboot interrupts the camera for about a minute: confirm to restart it' });
          await reboot(acc.client);
          return json(res, 200, { ok: true });
        }
        if (kind === 'siren') {
          if (body.action === 'start' && body.confirm !== true) return json(res, 400, { error: 'the siren is loud: confirm to sound it' });
          await siren(acc.client, cam.channel, body.action);
          return json(res, 200, { ok: true });
        }
        // floodlight goes through the same plan / verify path as any setting
        const plan = await writes.plan({ client: acc.client, deviceId: cam.id, settingId: 'floodlight', channel: cam.channel, owner: acc.sess.id,
          input: { ...(typeof body.on === 'boolean' ? { on: body.on } : {}), ...(Number.isInteger(body.brightness) ? { brightness: body.brightness } : {}) } });
        if (plan.noop) return json(res, 200, { verified: true, unchanged: true });
        const r = await writes.apply({ client: acc.client, planId: plan.planId, owner: acc.sess.id, by: acc.sess.user });
        return json(res, 200, { verified: r.verified, after: r.after });
      } catch (e) {
        if (e instanceof WriteError) return writeFailure(res, e);
        return json(res, 502, { error: `the device refused: ${String(e.detail ?? e.message).slice(0, 160)}` });
      }
    }
    return NEXT;
  }

  /**
   * Vehicle detection: a test run, verdicts on events, and removing events.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function detectionEventRoutes(req, res, url, p) {
    let m;
    if (req.method === 'POST' && p === '/api/detection/test') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const body = await readJson(req, 16 * 1024);
      const cam = config.cameras.find((c) => c.id === body.camera);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      if (!(await detectorStatus()).ready) return json(res, 409, { error: 'the detector is not installed; run: node bin/reolook.mjs detect setup' });
      // a one-off look with the same rules, whether or not detection is running
      // rules are the ones as typed on the page (saved or not), checked the same way as when saved
      let typed = null;
      if (Array.isArray(body.rules)) {
        try { typed = normalizeCamera({ enabled: true, rules: body.rules.map((r) => ({ ...r, enabled: false })) }, cam.id).rules; }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      const svc = runtime?.detection()?.service ?? new DetectionService({ config: config.detection, cameras: config.cameras, clients: (id) => clients.get(id), detector: testDetector(), events: eventLog });
      try {
        const r = await svc.testNow(cam.id, typed);
        return json(res, 200, { width: r.width, height: r.height, ms: r.ms, detections: r.detections, image: `data:image/jpeg;base64,${r.jpeg.toString('base64')}` });
      } catch (e) { return json(res, 502, { error: `the test failed: ${String(e.message).slice(0, 160)}` }); }
    }
    if (req.method === 'POST' && (m = /^\/api\/detection\/events\/([a-z0-9]+)\/verdict$/.exec(p))) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const body = await readJson(req, 256);
      try {
        const e = await eventLog.setVerdict(m[1], body.verdict ?? null);
        return e ? json(res, 200, { id: e.id, verdict: e.verdict }) : json(res, 404, { error: 'unknown event' });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'DELETE' && (m = /^\/api\/detection\/events\/([a-z0-9]+)$/.exec(p))) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      return (await eventLog.remove(m[1])) ? json(res, 200, { removed: m[1] }) : json(res, 404, { error: 'unknown event' });
    }
    return NEXT;
  }

  /**
   * Sending a made-up detection event down the real notification path.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function testEventRoutes(req, res, url, p) {
    // Send a made-up event down exactly the path a real one takes (MQTT and the rule's web address),
    // using the settings as typed on the page, so the whole chain can be tried without waiting.
    if (req.method === 'POST' && p === '/api/detection/test-event') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const body = await readJson(req, 16 * 1024);
      const cam = config.cameras.find((c) => c.id === body.camera);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      let rule, d;
      try {
        rule = normalizeRule({ ...(body.rule ?? {}), enabled: false }, cam.id);
        d = normalizeDetection({ mqtt: body.mqtt ?? config.detection.mqtt });
      } catch (e) { return json(res, e instanceof DetectionConfigError ? 400 : 500, { error: e.message }); }
      let pub = null;
      if (d.mqtt.enabled && d.mqtt.url) {
        const vars = await loadEnvVars().catch(() => ({}));
        pub = new MqttPublisher({ url: d.mqtt.url, username: vars.REOLOOK_MQTT_USER || undefined, password: vars.REOLOOK_MQTT_PASS || undefined,
          statusTopic: `${d.mqtt.topic}/status`, clientId: `reolook-test-${process.pid}` });
        let connectError = null;
        pub.on('error', (e) => { connectError = e; });
        pub.start();
        const t0 = Date.now();
        while (!pub.connected && !connectError && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 50));
        if (!pub.connected) {
          const why = connectError?.message ?? 'the broker did not answer within 6 seconds';
          await pub.end().catch(() => {});
          pub = null;
          body.mqttFailed = why;
        }
      }
      const notifier = new Notifier({ config: { mqtt: d.mqtt, cameras: {} }, mqtt: pub });
      const now = new Date();
      /** A test event of the given type for this device and rule. @param {'stopped'|'left'} type */
      const mk = (type) => ({ type, camera: cam.id, cameraName: cam.name, rule: rule.label, ruleId: rule.id, vehicle: rule.classes[0], score: 1,
        at: now.toISOString(), tag: `${rule.label} ${hhmm(now)}`, id: `test${Date.now().toString(36)}`, test: true });
      const kind = rule.mode === 'appears' ? 'appeared' : 'stopped';
      const out = { sent: kind, ...(await notifier.notify(mk(kind), rule)) };
      if (body.leave === true) { await new Promise((r) => setTimeout(r, 1500)); out.left = await notifier.notify(mk('left'), rule); }
      if (body.mqttFailed) out.mqtt = { ok: false, error: body.mqttFailed };
      if (!d.mqtt.enabled) out.mqtt = null;
      await pub?.end().catch(() => {});
      return json(res, 200, out);
    }
    return NEXT;
  }

  /**
   * Training the appearance check for a detection rule.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function trainingRoutes(req, res, url, p) {
    if (req.method === 'POST' && p === '/api/detection/classifier/train') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      const body = await readJson(req, 512);
      const cam = config.cameras.find((c) => c.id === body.camera);
      const rule = config.detection.cameras[body.camera]?.rules.find((r) => r.id === body.rule);
      if (!cam || !rule) return json(res, 404, { error: 'unknown device or rule (save the rule first)' });
      const st = await detectorStatus();
      if (!st.canLook) return json(res, 409, { error: 'the appearance model is not installed; run: node bin/reolook.mjs detect setup' });
      if (training.has(`${body.camera}/${body.rule}`)) return json(res, 409, { error: 'training is already running for this rule' });
      training.add(`${body.camera}/${body.rule}`);
      try { return json(res, 200, await trainRule({ events: eventLog, detector: testDetector(), dir: detectorPaths().dir, camera: body.camera, rule: body.rule })); }
      catch (e) { return json(res, 502, { error: `training failed: ${String(e.message).slice(0, 160)}` }); }
      finally { training.delete(`${body.camera}/${body.rule}`); }
    }
    return NEXT;
  }

  /**
   * Everything after this only reads, so any other method is refused.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function rejectOtherMethods(req, res, url, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return NEXT;
  }

  /**
   * The page itself, its configuration, what this build is (`/api/about`), the job list and the copy options.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function pageRoutes(req, res, url, p) {
    if (p === '/' || p === '/index.html') {
      const html = await readFile(path.join(here, '..', 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; img-src 'self' data: http://localhost:* http://127.0.0.1:*; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" });
      return res.end(html);
    }
    if (p === '/api/about') return json(res, 200, { name: 'ReoLook', version: VERSION, license: LICENSE, node: process.versions.node });
    if (p === '/api/config') {
      return json(res, 200, { cameras: config.cameras.map(({ id, name, host }) => ({ id, name, host })),
        hasRoot: Boolean(root), demo, exportDir: exportDirNow(), hasSnapshotDir: Boolean(config.snapshotDir) });
    }
    if (p === '/api/jobs') return json(res, 200, { jobs: jobs.list(), exportDir: exportDirNow() });
    if (p === '/api/copy/options') {
      return json(res, 200, { settings: writes.list().filter((s) => s.copy).map((s) => ({ id: s.id, label: s.label, area: s.area, risk: s.risk, defaultOn: s.copy.defaultOn === true, note: s.copy.note ?? null })) });
    }
    return NEXT;
  }

  /**
   * Reading a device's accounts, live controls, network and resolution.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function deviceReadRoutes(req, res, url, p) {
    let m;
    if ((m = /^\/api\/devices\/([a-z0-9-]+)\/users$/.exec(p))) {
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      try {
        const users = await listUsers(acc.client);
        return json(res, 200, { device: cam.id, users: users.map((u) => ({ ...u, viewer: u.userName === user, signedIn: u.userName === acc.sess.user })),
          constraints: await userConstraints(acc.client), rules: userRules });
      } catch (e) { return json(res, 502, { error: `could not read the accounts: ${String(e.detail ?? e.message)}` }); }
    }
    if ((m = /^\/api\/devices\/([a-z0-9-]+)\/controls$/.exec(p))) {
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      let profile;
      try { profile = await getProfile(acc.client, cam.host, { channel: cam.channel, cache: capabilityCache, account: 'administrator' }); }
      catch (e) { return json(res, 502, { error: `could not read the device: ${String(e.message).slice(0, 120)}` }); }
      /** Whether the device reports this feature as usable. @param {string} id feature id */
      const on = (id) => Boolean(profile.features[id]?.usable);
      const out = { device: cam.id, ptz: on('ptz'), presets: null, floodlight: null, siren: on('siren'), battery: null };
      if (on('ptzPreset')) out.presets = await listPresets(acc.client, cam.channel).catch(() => []);
      if (on('floodlight')) out.floodlight = await writes.current({ client: acc.client, deviceId: cam.id, settingId: 'floodlight', channel: cam.channel }).catch(() => null);
      if (on('battery')) out.battery = await batteryInfo(acc.client, cam.channel).catch(() => null);
      return json(res, 200, out);
    }
    if ((m = /^\/api\/devices\/([a-z0-9-]+)\/network$/.exec(p))) {
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      /** Reads one command from the device, or null if it will not answer. @param {string} cmd */
      const get = async (cmd) => { try { return await acc.client.command(cmd, {}); } catch { return null; } };
      const [link, ports, ddns, p2p, wifi, upnp] = await Promise.all(['GetLocalLink', 'GetNetPort', 'GetDdns', 'GetP2p', 'GetWifi', 'GetUpnp'].map(get));
      const l = link?.LocalLink;
      return json(res, 200, {
        device: cam.id,
        link: l ? { mode: l.type, activeLink: l.activeLink, ip: l.static?.ip, mask: l.static?.mask, gateway: l.static?.gateway, mac: l.mac,
          dnsAuto: l.dns?.auto === 1, dns: [l.dns?.dns1, l.dns?.dns2].filter(Boolean) } : null,
        ports: ports?.NetPort ?? null,
        upnp: upnp?.Upnp ? upnp.Upnp.enable === 1 : null,
        ddns: ddns?.Ddns ? { enabled: ddns.Ddns.enable === 1, type: ddns.Ddns.type, domain: ddns.Ddns.domain || null } : null,
        p2p: p2p?.P2p ? { enabled: p2p.P2p.enable === 1, uid: p2p.P2p.uid ?? null } : null,
        wifi: wifi?.Wifi ? { ssid: wifi.Wifi.ssid || null } : null,
      });
    }
    if ((m = /^\/api\/devices\/([a-z0-9-]+)\/resolution$/.exec(p))) {
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown device' });
      const acc = adminAccess(req, res, cam); if (!acc) return;
      try { return json(res, 200, await resolutionOptions(acc.client, cam.channel)); }
      catch (e) { return json(res, 502, { error: `could not read the resolutions: ${String(e.detail ?? e.message)}` }); }
    }
    return NEXT;
  }

  /**
   * Reading vehicle detection: status, events, event pictures and the classifier.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function detectionReadRoutes(req, res, url, p) {
    let m;
    if (p === '/api/detection') {
      const vars = await loadEnvVars().catch(() => ({}));
      return json(res, 200, { detection: config.detection, installed: await detectorStatus(),
        status: runtime?.detection()?.service.status() ?? { running: false, frames: 0, cameras: {} },
        mqttAccount: { user: Boolean(vars.REOLOOK_MQTT_USER), password: Boolean(vars.REOLOOK_MQTT_PASS) } });
    }
    if (p === '/api/detection/events') {
      const lim = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const list = await eventLog.list({ day: url.searchParams.get('day') || null, camera: url.searchParams.get('camera') || null, limit: lim, kind: url.searchParams.get('type') || null });
      return json(res, 200, { events: list.map(({ box, ...e }) => ({ ...e, hasSnapshot: Boolean(e.snapshot), box })) });
    }
    if ((m = /^\/api\/detection\/events\/([a-z0-9]+)\.jpg$/.exec(p))) {
      const e = await eventLog.get(m[1]);
      const file = e && eventLog.snapshotPath(e);
      if (!file) return json(res, 404, { error: 'no picture for this event' });
      try { const data = await readFile(file); res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' }); return res.end(data); }
      catch { return json(res, 404, { error: 'the picture is gone' }); }
    }
    if (p === '/api/detection/classifier') {
      const camera = url.searchParams.get('camera') ?? '', ruleId = url.searchParams.get('rule') ?? '';
      const saved = await classifiers.get(camera, ruleId);
      const evs = (await eventLog.list({ camera, limit: 5000 })).filter((e) => e.ruleId === ruleId && e.type !== 'left');
      const marks = { yes: evs.filter((e) => e.verdict === 'yes' && e.snapshot).length, no: evs.filter((e) => e.verdict === 'no' && e.snapshot).length };
      return json(res, 200, { installed: (await detectorStatus()).canLook, minEach: MIN_EACH, marks,
        trained: saved ? { at: saved.trainedAt, yes: saved.yes, no: saved.no, loo: saved.loo, threshold: saved.threshold } : null });
    }
    return NEXT;
  }

  /**
   * Motion state, status, recordings (days, clips, media, thumbnails, clip info) and live pictures.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url the request address
   * @param {string} p the path of `url`
   * @returns {Promise<unknown>} `NEXT` when the request is not one of these routes; anything else means it was answered
   */
  async function mediaRoutes(req, res, url, p) {
    let m;
    if (p === '/api/motion-state') return json(res, 200, await motionStates());
    if (p === '/api/status') {
      const t = toolsNow();
      return json(res, 200, { ...(runtime ? runtime.status() : getStatus()), tools: { ffmpeg: t.ffmpeg, ffprobe: t.ffprobe }, live: hub.stats(), liveRestarts: hub.resyncLog().slice(-30), manual: [...manual].map(([id, e]) => ({ id, since: e.since, error: e.error })) });
    }
    if (p === '/api/days') {
      return json(res, 200, { days: root ? await listDays(root) : [] });
    }
    if (p === '/api/clips') {
      const date = url.searchParams.get('date') ?? '';
      if (!ISO.test(date)) return json(res, 400, { error: 'date must be YYYY-MM-DD' });
      return json(res, 200, { clips: root ? await listClips(root, date) : [] });
    }
    if ((m = /^\/media\/([A-Za-z0-9_-]+)$/.exec(p))) {
      const abs = await resolveMedia(m[1]);
      if (!abs) return json(res, 404, { error: 'not found' });
      return sendFile(req, res, abs, await stat(abs), 'video/mp4');
    }
    if ((m = /^\/api\/clipinfo\/([A-Za-z0-9_-]+)$/.exec(p))) {
      const abs = await resolveMedia(m[1]);
      if (!abs) return json(res, 404, { error: 'not found' });
      return json(res, 200, await clipInfo(abs));
    }
    if ((m = /^\/thumb\/([A-Za-z0-9_-]+)$/.exec(p))) {
      const abs = await resolveMedia(m[1]);
      if (!abs) return json(res, 404, { error: 'not found' });
      const jpg = await thumbnail(abs);
      return sendFile(req, res, jpg, await stat(jpg), 'image/jpeg');
    }
    if ((m = /^\/live\/([a-z0-9-]+)\.mjpg$/.exec(p))) {
      if (toolsNow().ffmpeg === false) return json(res, 503, { error: 'ffmpeg is not installed, so live view cannot run' });
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown camera' });
      const main = url.searchParams.get('stream') === 'main';
      const client = clients.get(cam.id);
      const key = `${cam.id}:${main ? 'main' : 'sub'}`;
      const ok = hub.attach(key, client.rtspUrl({ channel: cam.channel, stream: main ? 'main' : 'sub' }), res,
        { fps: main ? 8 : 10, width: main ? 1280 : null });
      if (!ok) return json(res, 503, { error: 'too many live streams' });
      return;
    }
    if ((m = /^\/api\/snapshot\/([a-z0-9-]+)\.jpg$/.exec(p))) {
      const cam = config.cameras.find((c) => c.id === m[1]);
      if (!cam) return json(res, 404, { error: 'unknown camera' });
      const jpg = await clients.get(cam.id).snapshot({ channel: cam.channel });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
      return res.end(jpg);
    }
    return NEXT;
  }

  /** The route groups, in the order they are tried: the first that answers the request wins. */
  const ROUTES = [
    recordingRoutes, adminRoutes, settingsReadRoutes,
    settingsChangeRoutes, deviceInfoRoutes, serverSettingsRoutes,
    exportRoutes, deviceAddRoutes, deviceEditRoutes,
    copyRoutes, accountRoutes, resolutionRoutes,
    controlRoutes, detectionEventRoutes, testEventRoutes,
    trainingRoutes, rejectOtherMethods, pageRoutes,
    deviceReadRoutes, detectionReadRoutes, mediaRoutes,
  ];

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only answer to our own loopback name.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { res.writeHead(403); return res.end('forbidden'); }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      for (const route of ROUTES) if (await route(req, res, url, p) !== NEXT) return;
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, e.status ?? 500, { error: e.message });
      else res.end();
    }
  });
  server.stopManual = async () => { const all = [...manual.values()]; manual.clear(); await Promise.all(all.map((e) => e.rec.stop())); };
  server.drainJobs = () => jobs.drain();
  server.on('close', () => { sharedDetector?.close(); hub.shutdown(); admin.clear(); for (const t of ptzStops.values()) clearTimeout(t); });
  return server;
}
