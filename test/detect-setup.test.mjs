// setupDetector with fake commands and a fake download: the failure messages a person would see,
// and the guarantee that a download that fails its checksum is never put in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupDetector, PACKAGES } from '../src/detect/setup.mjs';
import { detectorPaths } from '../src/detect/helper-client.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'det-setup-'));
const withPython = (dir) => { const p = detectorPaths(dir).python; mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, ''); };

test('a missing python3 is reported with the apt hint', async () => {
  const dir = tmp();
  const exec = async () => { throw Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }); };
  await assert.rejects(setupDetector({ dir, log: () => {}, exec }), /python3 is not installed.*apt install python3-venv/s);
  rmSync(dir, { recursive: true, force: true });
});

test('venv creation that fails shows the last line of its error', async () => {
  const dir = tmp();
  const exec = async () => { throw Object.assign(new Error('x'), { stderr: 'line one\nensurepip is not available\n' }); };
  await assert.rejects(setupDetector({ dir, log: () => {}, exec }), /could not create a Python environment \(ensurepip is not available\)/);
  rmSync(dir, { recursive: true, force: true });
});

test('an existing environment is reused; the packages are installed with the pinned names', async () => {
  const dir = tmp(); withPython(dir);
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); if (args.includes('pip')) throw Object.assign(new Error('x'), { stderr: 'no network\n' }); return { stdout: 'ok' }; };
  await assert.rejects(setupDetector({ dir, log: () => {}, exec }), /installing the Python packages failed: no network/);
  assert.equal(calls.length, 1, 'no venv was created');
  assert.deepEqual(calls[0].slice(-PACKAGES.length), PACKAGES);
  rmSync(dir, { recursive: true, force: true });
});

test('a failed download is reported with its status and nothing is installed', async () => {
  const dir = tmp(); withPython(dir);
  const logs = [];
  await assert.rejects(setupDetector({ dir, log: (m) => logs.push(m), exec: async () => ({ stdout: 'ok' }), fetchImpl: async () => ({ ok: false, status: 503 }) }), /detection model download failed \(HTTP 503\)/);
  assert.ok(logs.some((l) => /downloading the detection model \(about 36 MB\) from github\.com/.test(l)));
  assert.ok(!existsSync(detectorPaths(dir).model));
  rmSync(dir, { recursive: true, force: true });
});

test('a download that does not match the checksum is refused and leaves no file behind', async () => {
  const dir = tmp(); withPython(dir);
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('not the model').buffer });
  await assert.rejects(setupDetector({ dir, log: () => {}, exec: async () => ({ stdout: 'ok' }), fetchImpl }), /does not match the expected checksum; it was not installed/);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== 'venv'), []);
  rmSync(dir, { recursive: true, force: true });
});
