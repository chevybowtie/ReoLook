import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { MotionGate } from './gate.mjs';
import { recorderInputArgs, RECORDER_PROBE } from './ffinput.mjs';
import { pad2, hhmmss, maskCredentials } from './format.mjs';

const execFileP = promisify(execFile);

/** Width/height of the first video stream in `file`, or null if unreadable. */
export async function probeSize(file) {
  try {
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { timeout: 15_000 });
    const [width, height] = stdout.trim().split(',').map(Number);
    return width && height ? { width, height } : null;
  } catch { return null; }
}

const dayDir = (d) => `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${d.getFullYear()}`; // MMDDYYYY
/** Makes a camera name safe to use in a file name by replacing characters that paths forbid. */
const safe = (s) => s.replace(/[\\/:*?"<>|]/g, '_');

/**
 * Records one camera to `<outDir>/MMDDYYYY/<Name>-00-HHMMSS-HHMMSS.mp4` while the
 * camera reports motion. Streams are copied, never re-encoded. Files are
 * fragmented MP4 written as `.part` and renamed on close, so a crash leaves a
 * playable partial file rather than a corrupt one.
 *
 * A watchdog ends and finalizes a recording whose file stops growing for
 * `stallMs`; the next motion sample then starts a fresh one.
 *
 * After a clip is saved its size is checked against the camera's configured
 * encoding; a difference is reported as 'mismatch' (the clip is kept).
 *
 * Events: 'start' {file}, 'stop' {file,bytes}, 'discard' {reason},
 *         'mismatch' {file,expected,actual}, 'error' Error, 'recovered' (the camera answers again).
 */
export class CameraRecorder extends EventEmitter {
  #client; #name; #outDir; #gate; #pollMs; #stream; #channel;
  #stallMs; #startGraceMs; #probe; #guard; #modeAt; #failing = false; #remux_on; #always; #spawn; #now; #timer = null; #tickRun = Promise.resolve(); #stopped = true; #job = null;

  constructor({ client, name, outDir, channel = 0, stream = 'main', pollMs = 1000,
    postRollMs, maxSegmentMs, stallMs = 20_000, startGraceMs = RECORDER_PROBE.analyzeduration / 1000, always = false, modeAt = null, guard = null, remux = true, probeFn = probeSize, spawnFn = spawn, now = () => new Date() }) {
    super();
    this.#client = client; this.#name = safe(name); this.#outDir = outDir;
    this.#channel = channel; this.#stream = stream; this.#pollMs = pollMs;
    this.#gate = new MotionGate({ postRollMs, maxSegmentMs });
    this.#spawn = spawnFn; this.#now = now; this.#always = always; this.#modeAt = modeAt; this.#stallMs = stallMs; this.#startGraceMs = startGraceMs; this.#probe = probeFn; this.#guard = guard; this.#remux_on = remux;
  }

  get name() { return this.#name; }
  get recording() { return this.#job !== null; }

  /** Begins watching the camera; does nothing if already started. */
  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  /**
   * Stops watching the camera and finalizes any recording in progress. Waits for a poll that is already
   * under way, so that it cannot start a recording after this has returned.
   * @returns {Promise<void>}
   */
  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#tickRun;
    await this.#closeJob();
  }

  /** Runs the next poll after `ms`, unless stopped; remembers it so stop() can wait for it. */
  #schedule(ms) {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => { this.#tickRun = this.#tick(); }, ms);
  }

  /**
   * One poll: checks for a stalled recording, reads the camera's motion state, and starts, stops or rolls the recording as the motion gate decides. Errors are reported and the next poll still happens.
   */
  async #tick() {
    try {
      await this.#checkStall();
      // a schedule decides, hour by hour, between off / motion / continuous; without one the fixed mode applies
      const mode = this.#modeAt ? this.#modeAt(this.#now()) : (this.#always ? 'continuous' : 'motion');
      if (mode === 'off') {
        if (this.#job) { this.#gate.reset(); await this.#closeJob(); } // leaving a scheduled hour ends the clip now
        this.#schedule(this.#pollMs);
        return;
      }
      const motion = mode === 'continuous' || await this.#client.motionState({ channel: this.#channel });
      if (this.#stopped) return;                  // stop() came while the camera was being asked: do nothing more
      if (this.#failing) { this.#failing = false; this.emit('recovered'); }   // the camera answered again
      const action = this.#gate.update(motion, this.#now().getTime());
      if (action === 'start') {
        try { await this.#openJob(); } catch (e) { this.#gate.reset(); throw e; }
      }
      else if (action === 'stop') await this.#closeJob();
      else if (action === 'roll') { await this.#closeJob(); this.#gate.update(true, this.#now().getTime()); await this.#openJob(); }
    } catch (e) {
      this.#failing = true;
      this.emit('error', e); // camera unreachable / auth lost: keep current job, retry next tick
    }
    this.#schedule(this.#pollMs);
  }

  /**
   * Ends a recording whose file has stopped growing for `stallMs`, so the next motion starts a fresh one.
   * ffmpeg writes nothing until it has probed the stream (up to the recorder's analyze duration), so a recording that has
   * not produced its first byte gets `startGraceMs` extra before the silence counts as a stall.
   */
  async #checkStall() {
    const job = this.#job;
    if (!job) return;
    const t = this.#now().getTime();
    let size = job.lastSize;
    try { size = (await stat(job.part)).size; } catch { /* not created yet */ }
    if (size > job.lastSize) { job.lastSize = size; job.lastGrowthAt = t; return; }
    const silentMs = t - job.lastGrowthAt;
    if (silentMs >= this.#stallMs + (job.lastSize === 0 ? this.#startGraceMs : 0)) {
      this.emit('error', new Error(`no data for ${Math.round(silentMs / 1000)}s, restarting`));
      this.#gate.reset();
      await this.#closeJob();
    }
  }

  /**
   * Starts an ffmpeg that copies the camera's stream to a `.part` file. Does nothing if the recorder was stopped while a guard was running.
   */
  async #openJob() {
    if (this.#guard) await this.#guard(); // throws when it is not safe to write (e.g. drive not mounted)
    if (this.#stopped) { this.#gate.reset(); return; }   // stopped while the guard was running: start nothing
    const started = this.#now();
    const dir = path.join(this.#outDir, dayDir(started));
    await mkdir(dir, { recursive: true });
    const part = path.join(dir, `${this.#name}-00-${hhmmss(started)}.part.mp4`);
    const url = this.#client.rtspUrl({ channel: this.#channel, stream: this.#stream });
    const child = this.#spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...recorderInputArgs(url),
      '-map', '0:v', '-map', '0:a?', '-c', 'copy',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', '-y', part,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const job = { child, part, dir, started, closing: false, lastSize: 0, lastGrowthAt: started.getTime(),
      expected: this.#expectedSize() };
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr = maskCredentials(stderr + d).slice(-2000); }); // ffmpeg echoes the camera's address, password and all
    job.exited = new Promise((resolve) => {
      child.on('error', (e) => { this.emit('error', e); resolve(); });
      child.on('exit', () => resolve());
    });
    job.exited.then(async () => {
      if (!job.closing && this.#job === job) {
        // died on its own: finalize what we have and let the gate start fresh
        this.emit('error', new Error(`ffmpeg exited early: ${stderr.trim() || 'no output'}`));
        this.#gate.reset();
        await this.#finalize(job);
        this.#job = null;
      }
    });
    this.#job = job;
    this.emit('start', { file: part });
  }

  /** Configured size for this stream, fetched without delaying the recording. */
  async #expectedSize() {
    try {
      const enc = await this.#client.encoding?.({ channel: this.#channel });
      return enc?.[this.#stream === 'main' ? 'main' : 'sub'] ?? null;
    } catch { return null; }
  }

  /**
   * Stops the current ffmpeg (letting it finalize the file) and finalizes the recording. Safe to call with nothing recording.
   */
  async #closeJob() {
    const job = this.#job;
    if (!job) return;
    job.closing = true;
    this.#job = null;
    job.child.kill('SIGINT'); // ffmpeg finalizes the muxer on SIGINT
    const killer = setTimeout(() => job.child.kill('SIGKILL'), 5000);
    await job.exited;
    clearTimeout(killer);
    await this.#finalize(job);
  }

  /**
   * Turns a finished `.part` file into the final recording (or discards an empty one), then checks its size against the camera's configuration.
   */
  async #finalize(job) {
    const ended = this.#now();
    let size = 0;
    try { size = (await stat(job.part)).size; } catch { /* never created */ }
    if (size < 4096) {
      await rm(job.part, { force: true });
      this.emit('discard', { reason: 'empty recording' });
      return;
    }
    const final = path.join(job.dir, `${this.#name}-00-${hhmmss(job.started)}-${hhmmss(ended)}.mp4`);
    // Live files are fragmented (crash-safe) but have no duration or index; players cannot
    // seek them. Rewrite as a regular MP4 with the index up front. Falls back to the
    // fragmented file if that fails, so a clip is never lost to the remux.
    if (!this.#remux_on || !(await this.#remux(job.part, final))) await rename(job.part, final);
    else if (this.#remux_on) await rm(job.part, { force: true });
    try { size = (await stat(final)).size; } catch { /* keep the earlier size */ }
    this.emit('stop', { file: final, bytes: size });
    await this.#verifySize(job, final);
  }

  /**
   * Rewrites a fragmented recording as a regular MP4 with the index up front so players can seek. @returns {Promise<boolean>} false if it failed, in which case the original is kept
   */
  async #remux(src, dest) {
    const tmp = `${dest}.remux.mp4`;
    try {
      await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src,
        '-map', '0', '-c', 'copy', '-movflags', '+faststart', tmp], { timeout: 10 * 60_000 });
      if ((await stat(tmp)).size < 4096) throw new Error('empty remux');
      await rename(tmp, dest);
      return true;
    } catch { await rm(tmp, { force: true }); return false; }
  }

  /**
   * Compares a saved clip's picture size with the camera's configured encoding and reports a 'mismatch' if they differ. Says nothing if either is unknown.
   */
  async #verifySize(job, file) {
    const expected = await job.expected;
    if (!expected || !(expected.width > 0 && expected.height > 0)) return;   // the camera did not say: nothing to compare
    const actual = await this.#probe(file);
    if (actual && (actual.width !== expected.width || actual.height !== expected.height)) {
      this.emit('mismatch', { file, expected, actual });
    }
  }
}
