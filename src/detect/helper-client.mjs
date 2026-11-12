// Talks to detector/helper.py, one JSON line each way. The helper loads the model once and is
// restarted if it dies. One frame at a time: a second request waits for the first.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xdgDir } from '../xdg.mjs';

/** Where the detector is installed: under the user's data folder. */
export const detectorDir = () => path.join(xdgDir('data'), 'reolook', 'detector');
/** The Python program that loads the model and answers requests. */
export const helperScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'detector', 'helper.py');
export const MODEL_FILE = 'yolox_s.onnx';
export const MODEL_SHA256 = 'c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063';
export const EMBED_FILE = 'mobilenetv2-12.onnx';
export const EMBED_SHA256 = 'c0c3f76d93fa3fd6580652a45618618a220fced18babf65774ed169de0432ad5';
export const EMBED_URL = 'https://github.com/onnx/models/raw/main/validated/vision/classification/mobilenet/model/mobilenetv2-12.onnx';
export const MODEL_URL = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx';

/**
 * Where each part of the detector lives under `dir`. @returns {{dir: string, python: string, model: string, embedder: string, helper: string}}
 */
export function detectorPaths(dir = detectorDir()) {
  return { dir, python: path.join(dir, 'venv', 'bin', 'python'), model: path.join(dir, MODEL_FILE), embedder: path.join(dir, EMBED_FILE), helper: helperScript };
}

/** What is installed: { python, model, ready }. */
export async function detectorStatus(dir) {
  const p = detectorPaths(dir);
  /** Whether a file exists. */
  const has = (f) => access(f).then(() => true, () => false);
  const [python, model, embedder] = await Promise.all([has(p.python), has(p.model), has(p.embedder)]);
  return { python, model, embedder, ready: python && model, canLook: python && model && embedder, dir: p.dir };
}

export class DetectorClient {
  #paths; #threads; #child = null; #starting = null; #pending = new Map(); #id = 1; #buf = ''; #chain = Promise.resolve(); #spawn; #timeoutMs;
  constructor({ dir, threads = 4, spawnFn = spawn, timeoutMs = 20_000 } = {}) {
    this.#paths = detectorPaths(dir); this.#paths.hasEmbedder = existsSync(this.#paths.embedder); this.#threads = threads; this.#spawn = spawnFn; this.#timeoutMs = timeoutMs;
  }

  /**
   * Starts the helper process, once, and resolves when it reports it is ready. Rejects with its last message if it dies first.
   */
  #start() {
    if (this.#starting) return this.#starting;
    this.#starting = new Promise((resolve, reject) => {
      const child = this.#spawn(this.#paths.python, [this.#paths.helper, this.#paths.model, String(this.#threads), ...(this.#paths.hasEmbedder ? [this.#paths.embedder] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.#child = child; this.#buf = '';
      let ready = false, err = '';
      child.stderr.on('data', (d) => { err = (err + d).slice(-600); });
      child.stdout.on('data', (d) => {
        this.#buf += d;
        let i;
        while ((i = this.#buf.indexOf('\n')) >= 0) {
          const line = this.#buf.slice(0, i); this.#buf = this.#buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.ready) { ready = true; resolve(); continue; }
          const p = this.#pending.get(m.id);
          if (p) { this.#pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m); }
        }
      });
      /** Called when the helper ends or fails: lets a later request start it again, and rejects everything waiting on it. */
      const gone = (e) => {
        this.#child = null; this.#starting = null;
        const why = e ?? new Error(`the detector stopped${err ? `: ${err.trim().split('\n').pop()}` : ''}`);
        if (!ready) reject(why);
        for (const [, p] of this.#pending) { clearTimeout(p.timer); p.reject(why); }
        this.#pending.clear();
      };
      child.on('error', gone);
      child.on('exit', () => gone());
    });
    return this.#starting;
  }

  /** What the part of a picture inside `box` looks like: { features, colour }. */
  embed(file, box) { return this.#request({ op: 'embed', file, box }); }

  /** Detect objects in a JPEG file. Resolves { width, height, ms, detections }. */
  detect(file, { conf = 0.3 } = {}) { return this.#request({ file, conf }); }

  /**
   * Sends one request to the helper. Requests wait their turn, so only one picture is processed at a time. @returns {Promise<object>} the helper's answer
   */
  #request(body) {
    /**
     * Starts the helper if needed, sends the request and waits for its answer; a helper that does not answer in time is stopped.
     */
    const run = async () => {
      await this.#start();
      const id = this.#id++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('the detector did not answer in time')); this.close(); }, this.#timeoutMs);
        this.#pending.set(id, { resolve, reject, timer });
        this.#child.stdin.write(JSON.stringify({ id, ...body }) + '\n');
      });
    };
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => {});
    return next;
  }

  close() { const c = this.#child; this.#child = null; this.#starting = null; if (c) { c.stdin.end(); c.kill('SIGTERM'); } }
}
