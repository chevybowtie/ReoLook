import { spawn } from 'node:child_process';
import { inputArgs } from './ffinput.mjs';
import { maskCredentials } from './format.mjs';

/**
 * One ffmpeg per (camera, stream) shared by every browser viewer, so extra tabs
 * never open extra sessions on cameras with limited concurrent streams.
 * Output is an MJPEG multipart stream (boundary "ffmpeg").
 *
 * Some cameras accept an RTSP session and then send nothing, or send
 * timestamps that make ffmpeg's fps filter duplicate frames to "catch up".
 * Protections:
 *  - input timestamps come from arrival time, so pacing cannot run away;
 *  - a watchdog restarts a stream that produces no data for `stallMs`;
 *  - a rate guard restarts a stream exceeding `maxBytesPerSec`;
 *  - a viewer that cannot keep up has frames dropped instead of buffered;
 *  - a burst of decoder errors restarts the stream. After lost data the picture stays broken, with
 *    smeared bands and garbled blocks, until the decoder starts again from a clean frame; the camera's
 *    own key frames do not always repair it, so the stream is started fresh (rate-limited).
 * Viewers stay attached across restarts.
 */
// what ffmpeg's H.264 decoder prints when data was lost or damaged
const DECODE_ERROR = /error while decoding|concealing|reference picture missing|missing reference|missing picture|decode_slice_header|invalid nal|corrupt|out of range|bytestream|cabac|non-existing pps|no frame|illegal|mmco|number of reference frames/i;

/**
 * Shared live streams, one ffmpeg per (device, stream).
 *
 * `decodeThreads` is how many threads ffmpeg decodes the camera's video with. Its default is one per processor
 * core, which on a 16-core machine roughly doubled the memory of a 4K stream (647 MB against 317 MB with two
 * threads) and delayed the live picture by a few hundred milliseconds, since a frame-threaded decoder holds back
 * about one frame per thread. Two threads still decode a 4K H.265 stream at 20 frames a second well within real time.
 */
export class LiveHub {
  #streams = new Map(); #spawn; #maxStreams; #idleMs; #stallMs; #restartMs; #maxBytesPerSec; #closed = false; #decode; #decodeThreads; #resyncLog = []; #onResync = null;

  constructor({ spawnFn = spawn, maxStreams = 8, idleMs = 5000, stallMs = 8000, restartMs = 1000, maxBytesPerSec = 16 * 1024 * 1024, decodeErrors = {}, decodeThreads = 2 } = {}) {
    this.#decodeThreads = decodeThreads;
    this.#decode = { count: 3, windowMs: 10_000, minGapMs: 20_000, ...decodeErrors };
    this.#spawn = spawnFn; this.#maxStreams = maxStreams; this.#maxBytesPerSec = maxBytesPerSec;
    this.#idleMs = idleMs; this.#stallMs = stallMs; this.#restartMs = restartMs;
  }

  get active() { return this.#streams.size; }

  /** Called with each repair, so it can be written down. */
  onResync(fn) { this.#onResync = fn; }

  /** The last restarts caused by damaged video, newest last, kept after the viewer has gone. */
  resyncLog() { return [...this.#resyncLog]; }

  /** What each running stream has had to recover from, for the status page. */
  stats() {
    return [...this.#streams].map(([key, s]) => ({ key, viewers: s.clients.size, resyncs: s.resyncs, lastResync: s.lastResync ? new Date(s.lastResync).toISOString() : null, lastError: s.lastError }));
  }

  /** Attach `res` (an http.ServerResponse) to the shared stream. Returns false if at capacity. */
  attach(key, url, res, { fps = 10, width = null } = {}) {
    let s = this.#streams.get(key);
    if (!s) {
      if (this.#streams.size >= this.#maxStreams) return false;
      s = { url, opts: { fps, width }, clients: new Set(), child: null, idleTimer: null,
        watchdog: null, restartTimer: null, lastData: 0, winStart: 0, winBytes: 0, errTimes: [], lastResync: 0, resyncs: 0, lastError: null };
      this.#streams.set(key, s);
      this.#run(key, s);
    }
    clearTimeout(s.idleTimer);
    s.clients.add(res);
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=ffmpeg',
      'cache-control': 'no-store', connection: 'close',
    });
    res.flushHeaders?.();
    /** Detaches this viewer, whichever way its connection ends. */
    const leave = () => this.#detach(key, s, res);
    res.on('close', leave);
    res.on('error', leave);
    return true;
  }

  /**
   * Starts the shared ffmpeg for a stream and wires up the protections: stall watchdog, runaway-output guard, damaged-picture detection and restart while viewers remain.
   */
  #run(key, s) {
    if (this.#closed) return;
    const { fps, width } = s.opts;
    const vf = [`fps=${fps}`, ...(width ? [`scale=${width}:-2`] : [])].join(',');
    const child = this.#spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', 'nobuffer', '-threads', String(this.#decodeThreads),
      ...(s.url.startsWith('lavfi:') ? [] : ['-use_wallclock_as_timestamps', '1']), ...inputArgs(s.url), '-an', '-vf', vf,
      '-c:v', 'mjpeg', '-q:v', '5', '-f', 'mpjpeg', '-boundary_tag', 'ffmpeg', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    s.child = child;
    s.lastData = Date.now(); s.winStart = s.lastData; s.winBytes = 0;
    child.stdout.on('data', (chunk) => {
      const now = Date.now();
      s.lastData = now;
      if (now - s.winStart >= 1000) { s.winStart = now; s.winBytes = 0; }
      s.winBytes += chunk.length;
      if (s.winBytes > this.#maxBytesPerSec) { child.kill('SIGKILL'); return; } // runaway output
      for (const c of s.clients) if (!c.writableNeedDrain) c.write(chunk);       // drop for slow viewers
    });
    child.stderr?.on('data', (d) => {
      const now = Date.now();
      for (const line of String(d).split('\n')) if (DECODE_ERROR.test(line)) { s.errTimes.push(now); s.lastError = maskCredentials(line.trim()).slice(0, 160); }
      s.errTimes = s.errTimes.filter((t) => now - t <= this.#decode.windowMs);
      if (s.errTimes.length >= this.#decode.count && now - s.lastResync >= this.#decode.minGapMs) {
        s.errTimes = []; s.lastResync = now; s.resyncs++;
        const entry = { key, at: new Date(now).toISOString(), error: s.lastError };
        this.#resyncLog.push(entry);
        try { this.#onResync?.(entry); } catch { /* a logger must not stop the stream */ }
        if (this.#resyncLog.length > 200) this.#resyncLog.shift();
        child.kill('SIGKILL');                    // viewers stay attached; the restart below starts a clean decode
      }
    });

    clearInterval(s.watchdog);
    s.watchdog = setInterval(() => {
      if (s.child === child && Date.now() - s.lastData >= this.#stallMs) child.kill('SIGKILL');
    }, Math.max(50, Math.floor(this.#stallMs / 4)));

    let ended = false;
    /** Called once when this ffmpeg has ended: restarts it while viewers remain, otherwise forgets the stream. */
    const gone = () => {
      if (ended) return;
      ended = true;
      clearInterval(s.watchdog);
      if (s.child !== child || this.#streams.get(key) !== s) return;
      s.child = null;
      if (s.clients.size > 0 && !this.#closed) {
        s.restartTimer = setTimeout(() => this.#run(key, s), this.#restartMs); // keep viewers attached
      } else {
        this.#streams.delete(key);
      }
    };
    child.on('exit', gone);
    child.on('error', gone);
  }

  /** Removes a viewer; when the last one leaves, stops the stream after a short grace period. */
  #detach(key, s, res) {
    s.clients.delete(res);
    if (s.clients.size > 0) return;
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (s.clients.size > 0 || this.#streams.get(key) !== s) return;
      this.#streams.delete(key);
      clearTimeout(s.restartTimer);
      clearInterval(s.watchdog);
      s.child?.kill('SIGTERM');
    }, this.#idleMs);
  }

  /** Stop every stream whose key starts with `prefix` (a device that moved to another address). */
  drop(prefix) {
    for (const [key, s] of [...this.#streams]) {
      if (!key.startsWith(prefix)) continue;
      this.#streams.delete(key);
      clearTimeout(s.idleTimer); clearTimeout(s.restartTimer); clearInterval(s.watchdog);
      s.child?.kill('SIGTERM');
      for (const c of s.clients) c.end();
    }
  }

  /** Stops every stream and drops every viewer. Called when the server closes. */
  shutdown() {
    this.#closed = true;
    for (const [, s] of this.#streams) {
      clearTimeout(s.idleTimer); clearTimeout(s.restartTimer); clearInterval(s.watchdog);
      s.child?.kill('SIGTERM');
      for (const c of s.clients) c.end();
    }
    this.#streams.clear();
  }
}
