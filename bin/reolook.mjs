#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { CameraRecorder } from '../src/recorder.mjs';
import { loadConfig, normalize, defaultConfigPath } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { ClientPool } from '../src/client-pool.mjs';
import { createDetection } from '../src/detect/index.mjs';
import { EventLog } from '../src/detect/events.mjs';
import { setupDetector } from '../src/detect/setup.mjs';
import { getProfile } from '../src/capabilities.mjs';
import { runRetention } from '../src/retention.mjs';
import { loadCredentials, writeEnvFile, defaultEnvPath } from '../src/credentials.mjs';
import { xdgDir } from '../src/xdg.mjs';
import * as svc from '../src/service-install.mjs';
import readline from 'node:readline/promises';
import { askLine, askSecret } from '../src/prompt.mjs';
import { findBrowser, appArgs, ensureServer, managedByService } from '../src/launcher.mjs';
import { openSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReolinkClient, ReolinkError, formatReolinkTime, toReolinkTime } from '../src/client.mjs';

const USAGE = `Usage: reolook <command> --host IP [options]

Camera sign-in comes from REOLINK_USER / REOLINK_PASS, or ~/.config/reolook/env
(mode 600). It is never taken from argv.

Commands:
  init [--user NAME] [--force] save the camera sign-in to ~/.config/reolook/env (mode 600);
                               the password is asked for without echo, or read from stdin
  info                         device model, firmware, storage
  capabilities [--refresh] [--json]
                               what this device can do (from its own report plus real reads)
  snapshot [--out FILE]        save a JPEG (default snapshot-<host>.jpg)
  live [--main]                play live view with ffplay (sub stream by default)
  days [--month YYYY-MM]       days with recordings
  search [--date YYYY-MM-DD]   list recordings for a day (default: today)
  download NAME [--dir DIR]    download a recording by its device path
  retention [--config FILE] [--apply] [--max-age-days N] [--max-size-gb N] [--min-free-gb N]
                               show (default) or enforce what retention would delete
  repairs [--hours N] | repairs note "text"
                               how often the live picture had to be repaired, per camera, with notes
                               of what you changed (for finding a bad cable or port)
  detect setup | status | image FILE
  detect replay --camera NAME --date YYYY-MM-DD [--from HH:MM --to HH:MM] [--rule ID] [--all] [--save]
                               run a saved rule over existing recordings: what would it have done?
                               --save stores each would-fire result as a reviewable event
                               install and check the vehicle detector (Python + a 36 MB model,
                               kept under ~/.local/share/reolook/detector)
  service install [--config FILE] [--no-start] [--linger] [--dry-run] [--yes]
  service status | service uninstall
                               start ReoLook automatically (systemd user unit);
                               shows its plan and asks before writing anything
  open [--config FILE] [--port N] [--browser CMD]
                               open the viewer in its own window (Chromium app mode),
                               starting the server first if it is not running
  serve [--config FILE] [--root DIR] [--port N] [--camera "Name=IP" ...]
                               browser UI + recorder service (config record.enabled)
                               (127.0.0.1 only; config default ~/.config/reolook/config.json)
  demo [--port N]              try ReoLook with four simulated cameras (no hardware, nothing real is touched);
                               settings pages: sign in as admin / demo
  record --camera "Name=IP" [--camera ...] --out DIR
         [--stream main|sub] [--post-roll SEC] [--max-minutes N] [--always]
                               record to MMDDYYYY/ folders while the camera
                               reports motion (--always: continuous)

Options: --host IP  --channel N  --https
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: 'string', default: process.env.REOLINK_HOST },
    channel: { type: 'string', default: '0' },
    https: { type: 'boolean', default: false },
    main: { type: 'boolean', default: false },
    out: { type: 'string' },
    dir: { type: 'string', default: 'downloads' },
    date: { type: 'string' },
    month: { type: 'string' },
    camera: { type: 'string', multiple: true },
    stream: { type: 'string', default: 'main' },
    'post-roll': { type: 'string', default: '15' },
    'max-minutes': { type: 'string', default: '30' },
    always: { type: 'boolean', default: false },
    config: { type: 'string' },
    browser: { type: 'string' },
    'no-start': { type: 'boolean', default: false },
    linger: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', short: 'y', default: false },
    apply: { type: 'boolean', default: false },
    'max-age-days': { type: 'string' },
    'max-size-gb': { type: 'string' },
    'min-free-gb': { type: 'string' },
    root: { type: 'string' },
    port: { type: 'string' },
    refresh: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    user: { type: 'string' },
    force: { type: 'boolean', default: false },
    from: { type: 'string' },
    to: { type: 'string' },
    rule: { type: 'string' },
    all: { type: 'boolean', default: false },
    save: { type: 'boolean', default: false },
    hours: { type: 'string' },
  },
});
const [command, ...rest] = positionals;

if (values.help || !command) { console.log(USAGE); process.exit(command ? 0 : 1); }

// First-run helper: before credentials are loaded, since it is what creates them.
if (command === 'init') {
  const file = values.config ? path.join(path.dirname(path.resolve(values.config)), 'env') : defaultEnvPath;
  try {
    // with no terminal, the first line of stdin is the password (so the user name must be --user)
    const name = (values.user ?? (process.stdin.isTTY ? await askLine('Camera account user name (a view-only account is enough): ') : '')).trim();
    if (!name) throw new Error('give the account name with --user NAME');
    const pw = (await askSecret('Password: ')).replace(/\r$/, '');
    const written = await writeEnvFile({ file, user: name, password: pw, force: values.force });
    console.log(`saved ${written} (mode 600)\n\nNext: start it with a camera:\n  node bin/reolook.mjs serve --camera "Front=192.168.1.20" --root ~/ReoLook-recordings\nor open the app window:  node bin/reolook.mjs open`);
  } catch (e) { console.error(`error: ${e.message}`); process.exitCode = 2; }
  process.exit(process.exitCode ?? 0);
}

const creds = await loadCredentials().catch((e) => { console.error(`error: ${e.message}`); process.exit(2); });
const { user, password } = creds;

if (command === 'service') {
  await serviceCommand();
  process.exit(process.exitCode ?? 0);
} else if (command === 'open') {
  await openWindow();
  process.exit(process.exitCode ?? 0);
} else if (command === 'repairs') {
  await repairsCommand();
  process.exit(process.exitCode ?? 0);
} else if (command === 'detect') {
  await detectCommand();
  process.exit(process.exitCode ?? 0);
} else if (command === 'retention') {
  await retention();
  process.exit(process.exitCode ?? 0);
} else if (command === 'serve') {
  await serve();
  await new Promise(() => {}); // serve() exits the process itself on SIGINT/SIGTERM
} else if (command === 'demo') {
  await demo();
  await new Promise(() => {});
} else if (command === 'record') {
  await record();
  process.exit(process.exitCode ?? 0);
}

if (!values.host || !user || !password) {
  console.error('error: need --host (or REOLINK_HOST) and camera sign-in (REOLINK_USER / REOLINK_PASS, or ~/.config/reolook/env)\n');
  console.error(USAGE);
  process.exit(2);
}

const channel = Number(values.channel);
const cam = new ReolinkClient({ host: values.host, user, password, https: values.https });

/**
 * `repairs` [--hours N]: how often each camera's live picture had to be repaired, in bursts, with notes of what was
 * changed. `repairs note TEXT` adds a note to the history. Exit code 2 when the note has no text.
 */
async function repairsCommand() {
  const { readRepairs, addNote, summarise } = await import('../src/repairs.mjs');
  if (rest[0] === 'note') {
    const text = rest.slice(1).join(' ').trim();
    if (!text) { console.error('usage: reolook repairs note "swapped the Driveway cable with the Garage cable"'); process.exitCode = 2; return; }
    await addNote(text); console.log(`noted: ${text}`); return;
  }
  const hours = Number(values.hours ?? 24);
  const sum = summarise(await readRepairs(), { sinceMs: Date.now() - hours * 3600_000 });
  /** Formats a time as weekday and clock time, in the local zone. @param {string} iso */
  const t = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`live-view repairs in the last ${hours} h (a repair = the picture was damaged and the stream was restarted)\n`);
  const ids = Object.keys(sum.cameras);
  if (!ids.length) console.log('  none recorded');
  for (const id of ids.sort((a, b) => sum.cameras[b].repairs - sum.cameras[a].repairs)) {
    const c = sum.cameras[id];
    console.log(`  ${id.padEnd(20)} ${String(c.repairs).padStart(4)} repairs in ${c.episodes.length} episode(s)${c.recording ? `, ${c.recording} while that camera was recording` : ''}`);
    for (const e of c.episodes.slice(-6)) console.log(`      ${t(e.from)}${e.count > 1 ? ` to ${t(e.to)}` : ''}  (${e.count})`);
  }
  if (sum.notes.length) { console.log('\nnotes:'); for (const n of sum.notes) console.log(`  ${t(n.at)}  ${n.note}`); }
  console.log('\nRepairs are only seen while a Live page is open (it is the live view that is repaired).');
}

/** Prints a message with the current date and time in front, for the long-running commands. @param {string} m */
function stampedLog(m) { console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${m}`); }

/** Formats a byte count as kB, MB or GB. @param {number} n @returns {string} */
function fmtBytes(n) { return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} kB`; }
/** Parses YYYY-MM-DD as a local date. @param {string} s @returns {Date} @throws {ReolinkError} when it is not in that form */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new ReolinkError(`bad date "${s}", expected YYYY-MM-DD`);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

/**
 * Runs one of the camera commands (info, capabilities, snapshot, live, days, search, download) against `--host`.
 * @returns {Promise<void>} @throws {ReolinkError} for an unknown command or a refusal by the camera
 */
async function run() {
  switch (command) {
    case 'info': {
      const d = await cam.devInfo();
      console.log(`${d.name} — ${d.model}`);
      console.log(`  firmware ${d.firmVer}  hardware ${d.hardVer}  channels ${d.channelNum}`);
      try {
        const hdd = await cam.storage();
        if (!hdd.length) console.log('  storage: none reported');
        for (const h of hdd) {
          console.log(`  storage: ${h.mount ? 'mounted' : 'not mounted'}  ${h.size} MB total, ${h.capacity ?? '?'} MB`);
        }
      } catch (e) { console.log(`  storage: unavailable (${e.message})`); }
      break;
    }
    case 'capabilities': {
      const p = await getProfile(cam, values.host, { channel, refresh: values.refresh });
      if (values.json) { console.log(JSON.stringify(p, null, 2)); break; }
      console.log(`${p.name} — ${p.model}  (firmware ${p.firmware}, channel ${p.channel}; ${p.cached ? 'cached' : 'read now'}, source: ${p.source})`);
      const mark = { supported: '✓', reported: '✓', unsupported: '–', conflict: '!', unknown: '?' };
      let area = '';
      for (const f of Object.values(p.features)) {
        if (f.area !== area) { area = f.area; console.log(`\n${area}`); }
        const note = f.state === 'conflict' ? 'the device reports it but refuses the read'
          : f.state === 'unsupported' ? (f.limited ? 'not available (this device, or this account may not use it)' : 'not on this device')
            : f.state === 'reported' ? 'reported by the device (no read to confirm)' : f.state === 'unknown' ? 'could not tell' : '';
        console.log(`  ${mark[f.state]} ${f.label}${note ? `  [${note}]` : ''}`);
      }
      break;
    }
    case 'snapshot': {
      const file = values.out ?? `snapshot-${values.host}.jpg`;
      await writeFile(file, await cam.snapshot({ channel }));
      console.log(`wrote ${file}`);
      break;
    }
    case 'live': {
      const url = cam.rtmpUrl({ channel, stream: values.main ? 'main' : 'sub' });
      // URL contains the password: pass it as an argument, never print it.
      const p = spawn('ffplay', ['-hide_banner', '-loglevel', 'warning', '-fflags', 'nobuffer',
        '-window_title', `ReoLook ${values.host}`, url], { stdio: 'inherit' });
      await new Promise((res) => p.on('exit', res));
      break;
    }
    case 'days': {
      const now = new Date();
      const [y, m] = values.month ? values.month.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1];
      const days = await cam.recordingDays({ channel, year: y, month: m });
      console.log(days.length ? `${y}-${String(m).padStart(2, '0')}: days ${days.join(', ')}` : 'no recordings that month');
      break;
    }
    case 'search': {
      const day = values.date ? parseDate(values.date) : new Date(new Date().setHours(0, 0, 0, 0));
      const to = new Date(day); to.setHours(23, 59, 59, 0);
      const files = await cam.search({ channel, from: day, to });
      if (!files.length) { console.log('no recordings'); break; }
      for (const f of files) {
        console.log(`${formatReolinkTime(toReolinkTime(f.start))} → ${formatReolinkTime(toReolinkTime(f.end)).slice(11)}  ${fmtBytes(f.size).padStart(9)}  ${f.name}`);
      }
      break;
    }
    case 'download': {
      const [name] = rest;
      if (!name) throw new ReolinkError('download needs a recording NAME (from `search`)');
      await mkdir(values.dir, { recursive: true });
      const dest = path.join(values.dir, path.basename(name));
      const res = await fetch(await cam.downloadUrl(name));
      if (!res.ok || !res.body) throw new ReolinkError(`download failed: HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      console.log(`wrote ${dest}`);
      break;
    }
    default:
      throw new ReolinkError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

try { await run(); }
catch (e) {
  console.error(`error: ${e instanceof ReolinkError || e.name === 'TimeoutError' ? e.message : e.stack}`);
  process.exitCode = 1;
} finally { await cam.logout(); }

/**
 * `record --camera "Name=IP" ... --out DIR`: records each camera on motion (or continuously) until interrupted.
 * Exit code 2 when the sign-in or the arguments are missing.
 */
async function record() {
  if (!user || !password) { console.error('error: need REOLINK_USER and REOLINK_PASS (or ~/.config/reolook/env)'); process.exitCode = 2; return; }
  if (!values.camera?.length || !values.out) {
    console.error('error: record needs --camera "Name=IP" (repeatable) and --out DIR'); process.exitCode = 2; return;
  }
  const recorders = values.camera.map((spec) => {
    const i = spec.lastIndexOf('=');
    if (i < 1) throw new ReolinkError(`bad --camera "${spec}", expected Name=IP`);
    const name = spec.slice(0, i), host = spec.slice(i + 1);
    const r = new CameraRecorder({
      client: new ReolinkClient({ host, user, password }), name, outDir: values.out,
      stream: values.stream, always: values.always,
      postRollMs: Number(values['post-roll']) * 1000,
      maxSegmentMs: Number(values['max-minutes']) * 60_000,
    });
    /** Prints a message with the time and this camera's name in front. */
    const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)} [${name}] ${m}`);
    r.on('start', ({ file }) => log(`recording → ${path.basename(file)}`));
    r.on('stop', ({ file, bytes }) => log(`saved ${path.basename(file)} (${fmtBytes(bytes)})`));
    r.on('mismatch', ({ file, expected: e, actual: a }) =>
      log(`warning: ${path.basename(file)} is ${a.width}x${a.height}, camera is configured for ${e.width}x${e.height}`));
    r.on('discard', ({ reason }) => log(`discarded: ${reason}`));
    r.on('error', (e) => log(`warning: ${e.message}`));
    return r;
  });
  recorders.forEach((r) => r.start());
  console.log(`watching ${recorders.length} camera(s) → ${values.out}  (${values.always ? 'continuous' : 'on motion'})  Ctrl-C to stop`);
  await new Promise((res) => { process.once('SIGINT', res); process.once('SIGTERM', res); });
  console.log('stopping…');
  await Promise.all(recorders.map((r) => r.stop()));
}

/**
 * `serve`: the web page and API, the recorders and detection, with one camera session per device shared by all of them.
 * Runs until SIGINT or SIGTERM, then finalizes recordings and signs the cameras out.
 */
async function serve() {
  if (!user || !password) {
    console.error('error: no camera sign-in yet.\n\nSave one with:  node bin/reolook.mjs init\n(or set REOLINK_USER / REOLINK_PASS, or create ~/.config/reolook/env with mode 600)');
    process.exit(2);
  }
  const cfg = await loadConfig(values.config);
  if (values.camera?.length) {
    cfg.cameras = normalize({ cameras: values.camera.map((spec) => {
      const i = spec.lastIndexOf('=');
      if (i < 1) throw new ReolinkError(`bad --camera "${spec}", expected Name=IP`);
      return { name: spec.slice(0, i), host: spec.slice(i + 1) };
    }) }).cameras;
  }
  if (values.root) cfg.root = values.root;
  if (values.port) cfg.port = Number(values.port);
  const log = stampedLog;
  if (cfg.record.enabled && !cfg.root) { console.error('error: record.enabled needs "root" in the config'); process.exit(2); }
  const events = new EventLog();
  const clientPool = new ClientPool();   // one session per camera, shared by the recorder, detection and the web page
  const runtime = createRuntime({ config: cfg, user, password, log, events, makeDetection: createDetection, clients: clientPool });
  runtime.start();
  const server = createServer({ config: cfg, configPath: values.config ?? defaultConfigPath, user, password, runtime, clientPool });
  server.on('error', (e) => { console.error(`error: ${e.message}`); process.exit(1); });
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`ReoLook → http://127.0.0.1:${cfg.port}/  (${cfg.cameras.length} camera(s), recordings: ${cfg.root ?? 'none'})`);
  });
  let stopping = false;
  /** Orderly shutdown on SIGINT/SIGTERM: finalize recordings, finish jobs, sign the cameras out, then exit. */
  const stop = async () => {
    if (stopping) return; stopping = true;
    log('stopping: finalizing recordings…');
    server.closeAllConnections();
    await runtime.stop();
    await server.stopManual?.();
    await server.drainJobs?.();
    await clientPool.close();                 // sign out, so a restart does not leave sessions behind on the cameras
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

/**
 * `demo`: the whole interface against four simulated cameras, with its own throwaway configuration; nothing real is read or
 * written. Runs until interrupted, then removes what it made.
 */
async function demo() {
  const { mkdtemp, rm, readdir } = await import('node:fs/promises');
  const { startDemoCameras, makeLibrary, DEMO_USER, DEMO_PASSWORD } = await import('../src/demo.mjs');
  // the demo library is the only thing kept between runs; everything else lives in a throwaway folder
  const library = path.join(xdgDir('cache'), 'reolook-demo', 'recordings');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'reolook-demo-'));
  Object.assign(process.env, { HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_STATE_HOME: path.join(scratch, 'state'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_DATA_HOME: path.join(scratch, 'data') });
  const today = new Date();
  const dayName = `${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}${today.getFullYear()}`;
  for (const d of await readdir(library).catch(() => [])) if (d !== dayName) await rm(path.join(library, d), { recursive: true, force: true });
  const sim = await startDemoCameras();
  console.log('making the demo recordings (first run only, about a minute)…');
  await makeLibrary(library, sim.cameras);
  const port = Number(values.port ?? 8788);
  const cfg = normalize({ port, root: library, cameras: sim.cameras, record: { enabled: false } });
  const log = stampedLog;
  const runtime = createRuntime({ config: cfg, user: DEMO_USER, password: DEMO_PASSWORD, log });
  runtime.start();
  const server = createServer({ config: cfg, configPath: path.join(scratch, 'config.json'), user: DEMO_USER, password: DEMO_PASSWORD, runtime, demo: true });
  server.on('error', (e) => { console.error(`error: ${e.message}`); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`ReoLook demo → http://127.0.0.1:${port}/   (settings: admin / demo)   Ctrl-C to stop`));
  /** Shutdown on SIGINT/SIGTERM: stop everything, remove the demo's scratch folder, exit. */
  const stop = async () => {
    server.closeAllConnections();
    await runtime.stop(); await sim.stop();
    await rm(scratch, { recursive: true, force: true });
    process.exit(0);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

/**
 * `retention`: reports what the retention rules would delete from the recordings folder, and deletes it with `--apply`.
 * Rules come from the configuration, overridden by `--max-age-days`, `--max-size-gb` and `--min-free-gb`.
 */
async function retention() {
  const cfg = await loadConfig(values.config);
  if (!cfg.root) { console.error('error: set "root" in the config'); process.exitCode = 2; return; }
  const policy = { ...cfg.retention };
  /** The numeric value of an option, or undefined when it was not given. */
  const num = (k) => (values[k] == null ? undefined : Number(values[k]));
  if (num('max-age-days') !== undefined) policy.maxAgeDays = num('max-age-days');
  if (num('max-size-gb') !== undefined) policy.maxSizeGB = num('max-size-gb');
  if (num('min-free-gb') !== undefined) policy.minFreeGB = num('min-free-gb');
  const { apply: _a, intervalMin: _i, ...rules } = policy;
  if (Object.values(rules).every((v) => v == null)) {
    console.error('error: no retention rule set (maxAgeDays / maxSizeGB / minFreeGB in config, or --max-age-days etc.)');
    process.exitCode = 2; return;
  }
  const r = await runRetention({ root: cfg.root, policy: rules, apply: values.apply, log: console.error });
  /** Formats bytes as gigabytes. */
  const GB = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  /** The date part of a Date, YYYY-MM-DD (UTC). */
  const day = (d) => d.toISOString().slice(0, 10);
  console.log(`library: ${r.plan.total} clips, ${GB(r.plan.totalBytes)}${r.freeBytes != null ? `, ${GB(r.freeBytes)} free` : ''}`);
  if (!r.plan.delete.length) { console.log('nothing to delete'); return; }
  const first = r.plan.delete[0], last = r.plan.delete.at(-1);
  const byWhy = {};
  for (const f of r.plan.delete) byWhy[f.reason] = (byWhy[f.reason] ?? 0) + 1;
  console.log(`${values.apply ? 'deleted' : 'would delete'}: ${values.apply ? r.deleted : r.plan.delete.length} of ${r.plan.delete.length} clips, ${GB(r.plan.bytes)}`);
  console.log(`  range: ${day(first.end)} → ${day(last.end)}`);
  for (const [why, n] of Object.entries(byWhy)) console.log(`  ${n} × ${why}`);
  if (r.failed) console.log(`  ${r.failed} failed`);
  if (!values.apply) console.log('\nplan only; nothing was deleted. Re-run with --apply to delete.');
}

/**
 * `open`: shows the viewer in its own browser window, starting the server first if nothing is running
 * (unless the systemd service is starting it).
 */
async function openWindow() {
  const cfg = await loadConfig(values.config);
  const port = values.port ? Number(values.port) : cfg.port;
  const url = `http://127.0.0.1:${port}/`;
  const browser = await findBrowser({ preferred: values.browser });
  if (!browser) {
    console.error(values.browser
      ? `error: browser "${values.browser}" was not found on PATH. Open ${url} in any browser instead.`
      : `error: no Chromium-family browser found (tried brave, chromium, google-chrome). Open ${url} in any browser, or pass --browser CMD.`);
    process.exitCode = 1; return;
  }
  if (!user || !password) {
    console.error('error: camera sign-in not found. Run: node bin/reolook.mjs init   (or set REOLINK_USER / REOLINK_PASS, or create ~/.config/reolook/env with mode 600).');
    process.exitCode = 2; return;
  }
  let spawned = false;
  const state = await ensureServer({
    port,
    start: async () => {
      // systemd is running or starting the service: just wait for it, never start a second server
      if (await managedByService(() => svc.status())) { console.log('waiting for the ReoLook service…'); return; }
      const dir = path.join(xdgDir('cache'), 'reolook');
      mkdirSync(dir, { recursive: true });
      const log = openSync(path.join(dir, 'server.log'), 'a');
      const args = [fileURLToPath(import.meta.url), 'serve', ...(values.config ? ['--config', values.config] : []), ...(values.port ? ['--port', String(port)] : [])];
      spawned = true;
      const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: { ...process.env, REOLINK_USER: user, REOLINK_PASS: password } });
      child.unref();
    },
  });
  console.log(state === 'already-running' ? `server already running on port ${port}`
    : spawned ? `started the ReoLook server on port ${port}` : `the ReoLook service is up on port ${port}`);
  const win = spawn(browser, appArgs(url), { detached: true, stdio: 'ignore' });
  win.unref();
  console.log(`opened ${url} in ${path.basename(browser)}`);
}

/**
 * `detect`: install and inspect the vehicle detector, run it on one picture, or replay a rule over recordings.
 * Sets `process.exitCode` itself (1 for a failure, 2 for wrong usage).
 * @returns {Promise<void>}
 */
async function detectCommand() {
  const [sub, arg] = rest;
  const { detectorStatus, DetectorClient } = await import('../src/detect/helper-client.mjs');
  if (sub === 'setup') return detectSetup();
  if (sub === 'status') return detectStatus(detectorStatus);
  if (sub === 'image' && arg) return detectImage(arg, { detectorStatus, DetectorClient });
  if (sub === 'replay') return detectReplay({ detectorStatus, DetectorClient });
  console.error('usage: reolook detect setup | status | image FILE.jpg | replay --camera NAME --date YYYY-MM-DD'); process.exitCode = 2;
}

/**
 * Whether the detector is installed; if not, says how to install it and marks the command as failed.
 * @param {() => Promise<{ready: boolean}>} detectorStatus
 * @returns {Promise<boolean>}
 */
async function detectorReady(detectorStatus) {
  if ((await detectorStatus()).ready) return true;
  console.error('error: the detector is not installed; run: node bin/reolook.mjs detect setup'); process.exitCode = 1;
  return false;
}

/** `detect setup`: installs the Python environment and the models. */
async function detectSetup() {
  try { await setupDetector({ log: (m) => console.log(m) }); }
  catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
}

/** `detect status`: what of the detector is installed. @param {() => Promise<object>} detectorStatus */
async function detectStatus(detectorStatus) {
  const st = await detectorStatus();
  console.log(`detector: ${st.ready ? 'installed' : 'not installed'}\n  environment: ${st.python ? 'yes' : 'no'}\n  model:       ${st.model ? 'yes' : 'no'}\n  appearance:  ${st.embedder ? 'yes' : 'no'}\n  folder:      ${st.dir}`);
  if (!st.ready) console.log('\nInstall it with: node bin/reolook.mjs detect setup');
}

/**
 * `detect image FILE`: what the detector finds in one picture.
 * @param {string} file
 * @param {{detectorStatus: Function, DetectorClient: Function}} detector
 */
async function detectImage(file, { detectorStatus, DetectorClient }) {
  if (!(await detectorReady(detectorStatus))) return;
  const d = new DetectorClient();
  try {
    const r = await d.detect(path.resolve(file), { conf: 0.25 });
    console.log(`${r.width}x${r.height}, ${r.ms} ms`);
    for (const x of r.detections) console.log(`  ${x.label.padEnd(12)} ${(x.score * 100).toFixed(0).padStart(3)}%  box ${x.box.map((n) => n.toFixed(2)).join(' ')}`);
    if (!r.detections.length) console.log('  nothing found');
  } catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; } finally { d.close(); }
}

/**
 * Checks the arguments of `detect replay` against the configuration.
 * @returns {Promise<{cfg: object, cam: object, rules: object[]}|null>} the device, its rules and the configuration; null
 *   (after saying what is wrong and setting the exit code) when the request cannot be carried out
 */
async function replayTarget() {
  const want = values.camera?.[0];
  if (!want || !/^\d{4}-\d{2}-\d{2}$/.test(values.date ?? '')) { console.error('usage: reolook detect replay --camera "Name or id" --date YYYY-MM-DD [--from HH:MM] [--to HH:MM] [--rule r1] [--all]'); process.exitCode = 2; return null; }
  const cfg = await loadConfig(values.config);
  const cam = cfg.cameras.find((c) => c.id === want || c.name.toLowerCase() === want.toLowerCase());
  if (!cam) { console.error(`error: no device "${want}". Known: ${cfg.cameras.map((c) => c.name).join(', ')}`); process.exitCode = 2; return null; }
  const rules = (cfg.detection.cameras[cam.id]?.rules ?? []).filter((r) => !values.rule || r.id === values.rule);
  if (!rules.length) { console.error(`error: ${cam.name} has no detection rule${values.rule ? ` "${values.rule}"` : ''} in the config`); process.exitCode = 2; return null; }
  if (!cfg.root) { console.error('error: no recordings folder is configured'); process.exitCode = 2; return null; }
  return { cfg, cam, rules };
}

/**
 * Keeps the would-fire events of one replayed clip for review, unless the same event is already saved
 * or falls inside the rule's quiet time.
 * @param {object} o
 * @param {EventLog} o.events where they are kept
 * @param {object[]} o.fired the clip's events (with their pictures)
 * @param {{start: number}} o.clip the clip, `start` in seconds since midnight
 * @param {string} o.date the day, YYYY-MM-DD
 * @param {object} o.cam @param {object} o.rule
 * @param {number[]} o.lastAt when this rule last reported (ms), updated here so the quiet time applies across clips
 * @returns {Promise<{saved: number, skipped: number}>}
 */
async function saveReplayedEvents({ events, fired, clip, date, cam, rule, lastAt }) {
  const [yy, mm, dd] = date.split('-').map(Number);
  let saved = 0, skipped = 0;
  for (const ev of fired.filter((e) => e.type !== 'left')) {
    const at = new Date(yy, mm - 1, dd, 0, 0, 0).getTime() + (clip.start + Math.round(ev.at / 1000)) * 1000;
    if (lastAt.some((t) => Math.abs(at - t) < (rule.cooldownSec || 0) * 1000)) { skipped++; continue; }
    // running the same replay twice must not add the same event twice
    const existing = await events.list({ day: `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, camera: cam.id, limit: 500 });
    if (existing.some((e) => e.ruleId === rule.id && Math.abs(new Date(e.at).getTime() - at) < 90_000)) { skipped++; continue; }
    lastAt.push(at);
    const when = new Date(at), p2 = (n) => String(n).padStart(2, '0');
    await events.add({ type: ev.type, camera: cam.id, cameraName: cam.name, rule: rule.label, ruleId: rule.id, vehicle: ev.track.label,
      score: Math.round(ev.track.score * 100) / 100, box: ev.track.box, heightPct: Math.round((ev.track.box[3] - ev.track.box[1]) * 100),
      at: when.toISOString(), tag: `${rule.label} ${p2(when.getHours())}:${p2(when.getMinutes())}`, replayed: true }, ev.jpeg);
    saved++;
  }
  return { saved, skipped };
}

/**
 * The line that introduces a rule in a replay: its kind, types, size, timing and hours.
 * @param {object} rule @param {number} clipCount @returns {string}
 */
function replayHeading(rule, clipCount) {
  return `\nrule "${rule.label}" (${rule.mode}; ${rule.classes.join('/')}; at least ${Math.round(rule.minHeight * 100)}% tall; ${rule.mode === 'stops' ? `still ${rule.minStopSec} s` : `seen ${rule.minPresenceSec} s`}${rule.from ? `; ${rule.from}-${rule.to}` : ''}) on ${clipCount} clip(s):`;
}

/**
 * `detect replay`: runs each rule of a device over its recordings of one day and says what it would have done.
 * With `--save`, keeps each would-fire event for review.
 * @param {{detectorStatus: Function, DetectorClient: Function}} detector
 */
async function detectReplay({ detectorStatus, DetectorClient }) {
  if (!(await detectorReady(detectorStatus))) return;
  const target = await replayTarget();
  if (!target) return;
  const { cfg, cam, rules } = target;
  const { clipsFor, replayClip, clock } = await import('../src/detect/replay.mjs');
  const clips = await clipsFor({ root: cfg.root, day: values.date, camera: cam.name, from: values.from ?? '00:00', to: values.to ?? '23:59' });
  if (!clips.length) { console.log(`no recordings of ${cam.name} on ${values.date} between ${values.from ?? '00:00'} and ${values.to ?? '23:59'}`); return; }
  const d = new DetectorClient();
  const events = values.save ? new EventLog() : null;
  let saved = 0, skipped = 0;
  try {
    for (const rule of rules) {
      const lastAt = [];                       // when this rule last reported, so the quiet time applies across clips
      console.log(replayHeading(rule, clips.length));
      let shown = 0;
      for (const c of clips) {
        const r = await replayClip({ file: c.file, rule, detect: (f) => d.detect(f, { conf: 0.25 }), keepFrames: Boolean(events) });
        if (events) {
          const kept = await saveReplayedEvents({ events, fired: r.events, clip: c, date: values.date, cam, rule, lastAt });
          saved += kept.saved; skipped += kept.skipped;
        }
        const seen = r.best ? `${r.best.label} ${Math.round(r.best.score * 100)}% h${Math.round(r.best.h * 100)}% ${r.best.inZone ? 'in zone' : 'outside'}` : 'nothing wanted';
        if (!values.all && !r.best) continue;
        shown++;
        console.log(`  ${clock(c.start)}-${clock(c.end)}  ${seen.padEnd(34)} ${r.verdict}`);
      }
      if (!shown) console.log('  nothing of a type this rule wants in any of them (use --all to list every clip)');
    }
  } finally { d.close(); }
  if (events) console.log(`\nsaved ${saved} event(s) for review under Settings > Detection${skipped ? ` (${skipped} already there or inside the quiet time)` : ''}`);
}

/**
 * `service install | status | uninstall`: manages the systemd user unit. `install` shows its plan first and asks
 * before writing anything (or takes `--yes`, `--dry-run`).
 */
async function serviceCommand() {
  const [sub] = rest;
  if (sub === 'status') {
    const st = await svc.status();
    console.log(`enabled: ${st.enabled}\nactive:  ${st.active}`);
    return;
  }
  if (sub === 'uninstall') {
    for (const line of await svc.uninstall()) console.log(line);
    console.log('kept: ~/.config/reolook/env and your config');
    return;
  }
  if (sub !== 'install') { console.error('usage: reolook service install | status | uninstall'); process.exitCode = 2; return; }
  const bin = fileURLToPath(import.meta.url);
  const plan = await svc.planInstall({
    bin, workDir: path.dirname(path.dirname(bin)), configFile: values.config ? path.resolve(values.config) : null,
    creds: { user, password }, linger: values.linger, now: !values['no-start'],
  });
  console.log('ReoLook will be started automatically by systemd (user session).\n\nPlanned changes:');
  for (const s of plan.steps) console.log(`  - ${s.text}`);
  console.log('\nNot changed: your config, recording settings, or any camera.');
  if (plan.steps.some((s) => s.blocked)) { process.exitCode = 2; return; }
  if (plan.steps.every((s) => s.action === 'keep')) { console.log('\nNothing to change; already installed.'); return; }
  if (values['dry-run']) { console.log('\n(dry run: nothing written)'); return; }
  if (!values.yes) {
    if (!process.stdin.isTTY) { console.error('\nnot a terminal: re-run with --yes to apply'); process.exitCode = 2; return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question('\nProceed? [y/N] ')).trim().toLowerCase(); rl.close();
    if (a !== 'y' && a !== 'yes') { console.log('cancelled; nothing written'); return; }
  }
  for (const line of await svc.applyInstall(plan, { creds: { user, password }, linger: values.linger, now: !values['no-start'] })) console.log(`done: ${line}`);
  console.log('\nLogs: journalctl --user -u reolook -f');
}
