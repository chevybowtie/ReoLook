// Copy and cut recordings into a user-chosen folder. Stream copy only: nothing is re-encoded.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, stat, statfs, writeFile, constants } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';

/**
 * Turns text into a safe file name: forbidden characters become `_`, whitespace collapses, at most 120 characters, never empty.
 */
export const safeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'clip';

/** Whether a path exists. */
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/** `<dir>/<base><ext>`, or `<base> (2)<ext>` etc. Never returns an existing path. */
export async function uniquePath(dir, base, ext = '.mp4') {
  for (let n = 1; ; n++) {
    const p = path.join(dir, n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`);
    if (!(await exists(p))) return p;
  }
}

/** A size in bytes as GB or MB, for messages. */
const human = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);

/**
 * Validate an export folder: absolute, outside the recordings library, creatable,
 * writable, and with room for `needBytes`. Returns the resolved path.
 */
export async function checkDest(dir, { root = null, needBytes = 0 } = {}) {
  if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0')) throw new Error('choose a folder to save to');
  if (!path.isAbsolute(dir)) throw new Error('the folder must be an absolute path, e.g. /home/you/Videos/ReoLook');
  const resolved = path.resolve(dir);
  if (root) {
    const r = path.resolve(root);
    if (resolved === r || resolved.startsWith(r + path.sep)) throw new Error('choose a folder outside the recordings library');
  }
  try { await mkdir(resolved, { recursive: true }); }
  catch (e) { throw new Error(`cannot create ${resolved}: ${e.code ?? e.message}`); }
  try { await access(resolved, constants.W_OK); }
  catch { throw new Error(`no write permission to ${resolved}`); }
  if (needBytes > 0) {
    const s = await statfs(resolved);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < needBytes * 1.05) throw new Error(`not enough free space: need ${human(needBytes)}, ${human(free)} available`);
  }
  return resolved;
}

/** Copy one file, never overwriting; writes `.part` first. Returns { file, bytes }. */
export async function copyFileTo({ src, destDir, name, signal, onProgress }) {
  const total = (await stat(src)).size;
  const dest = await uniquePath(destDir, name, path.extname(src) || '.mp4');
  const part = `${dest}.part`;
  let seen = 0;
  const counter = new Transform({ transform(chunk, _e, cb) { seen += chunk.length; onProgress?.(total ? seen / total : 1); cb(null, chunk); } });
  try {
    await pipeline(createReadStream(src), counter, createWriteStream(part, { flags: 'wx' }), { signal });
    await rename(part, dest);
  } catch (e) { await rm(part, { force: true }); throw e; }
  return { file: dest, bytes: total };
}

/**
 * Runs ffmpeg with `args`, reporting how many seconds of output it has produced. Rejects with an AbortError when `signal` aborts (the process is killed) and with ffmpeg's last message when it fails.
 */
function runFfmpeg(args, { signal, onSeconds }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', buf = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m) onSeconds?.(Number(m[1]) / 1e6);
      }
    });
    /** Kills ffmpeg when the job is cancelled. */
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().split('\n').pop() || `exit ${code}`}`));
    });
  });
}

/**
 * Cut `parts` ([{ file, seek, duration }]) and join them into one MP4.
 * Stream copy, so the start snaps to the nearest earlier keyframe.
 */
export async function cutParts({ parts, destDir, name, signal, onProgress }) {
  if (!parts.length) throw new Error('nothing to export in that range');
  const dest = await uniquePath(destDir, name, '.mp4');
  const part = `${dest}.part`;
  const tmp = await mkdtemp(path.join(destDir, '.reolook-cut-'));
  const total = parts.reduce((n, p) => n + p.duration, 0) || 1;
  try {
    const pieces = [];
    let done = 0;
    for (const [i, p] of parts.entries()) {
      const out = path.join(tmp, `${i}.mp4`);
      await runFfmpeg(['-v', 'error', '-nostdin', '-progress', 'pipe:1', '-ss', String(p.seek), '-i', p.file,
        '-t', String(p.duration), '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-y', out],
      { signal, onSeconds: (t) => onProgress?.(((done + Math.min(t, p.duration)) / total) * 0.95) });
      done += p.duration; pieces.push(out);
    }
    if (pieces.length === 1) {
      await runFfmpeg(['-v', 'error', '-nostdin', '-i', pieces[0], '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-y', part], { signal });
    } else {
      const list = path.join(tmp, 'list.txt');
      await writeFile(list, pieces.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
      await runFfmpeg(['-v', 'error', '-nostdin', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-y', part], { signal });
    }
    if (await exists(dest)) throw new Error('destination appeared while exporting; try again');
    await rename(part, dest);
    onProgress?.(1);
    return { file: dest, bytes: (await stat(dest)).size };
  } catch (e) { await rm(part, { force: true }); throw e; }
  finally { await rm(tmp, { recursive: true, force: true }); }
}
