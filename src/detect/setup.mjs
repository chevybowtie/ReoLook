// One-time install of the detector: a Python virtual environment with onnxruntime, numpy and
// Pillow, and the YOLOX-s model (Apache-2.0) from its release page, checked against a known hash.
// Everything lives under ~/.local/share/reolook/detector; nothing system-wide is touched.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { detectorPaths, MODEL_URL, MODEL_SHA256, EMBED_URL, EMBED_SHA256 } from './helper-client.mjs';

const run = promisify(execFile);
export const PACKAGES = ['onnxruntime==1.22.*', 'numpy', 'pillow'];

/** SHA-256 of some bytes, as hex. */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** Whether a file exists. */
const exists = (f) => access(f).then(() => true, () => false);

/**
 * One-time install of the detector: a Python environment with its packages, and each model, downloaded once and checked
 * against a known hash before it is put in place. Everything goes under the detector folder.
 * @param {{dir?: string, log?: Function, exec?: Function, fetchImpl?: typeof fetch, python?: string}} [o] the last four can be replaced in tests
 * @returns {Promise<object>} the detector's paths @throws {Error} saying what failed and, where known, how to fix it
 */
export async function setupDetector({ dir, log = console.log, exec = run, fetchImpl = fetch, python = 'python3' } = {}) {
  const p = detectorPaths(dir);
  await mkdir(p.dir, { recursive: true });
  if (!(await exists(p.python))) {
    log('creating a Python environment…');
    try { await exec(python, ['-m', 'venv', path.join(p.dir, 'venv')]); }
    catch (e) { throw new Error(`could not create a Python environment (${e.code === 'ENOENT' ? 'python3 is not installed' : String(e.stderr || e.message).trim().split('\n').pop()}). On Debian: sudo apt install python3-venv`); }
  }
  log(`installing ${PACKAGES.join(', ')}…`);
  try { await exec(p.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', ...PACKAGES], { maxBuffer: 20 * 1024 * 1024 }); }
  catch (e) { throw new Error(`installing the Python packages failed: ${String(e.stderr || e.message).trim().split('\n').pop()}`); }

  // each model is fetched once, checked against a known hash, and only then put in place
  for (const [what, file, url, hash, size] of [['detection model', p.model, MODEL_URL, MODEL_SHA256, '36 MB'], ['appearance model', p.embedder, EMBED_URL, EMBED_SHA256, '14 MB']]) {
    if (await exists(file) && sha256(await readFile(file)) === hash) { log(`${what} already present and verified`); continue; }
    log(`downloading the ${what} (about ${size}) from ${new URL(url).host}…`);
    const res = await fetchImpl(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`the ${what} download failed (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== hash) throw new Error(`the downloaded ${what} does not match the expected checksum; it was not installed`);
    const tmp = `${file}.part`;
    await writeFile(tmp, buf);
    await rename(tmp, file);
  }
  const check = await exec(p.python, ['-c', 'import onnxruntime, numpy, PIL; print("ok")']);
  if (!String(check.stdout).includes('ok')) throw new Error('the Python packages did not import');
  log('detector ready');
  return detectorPaths(dir);
}
