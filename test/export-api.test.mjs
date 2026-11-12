import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { idOf } from '../src/library.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (file, seconds, color) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=160x120:rate=10`,
  '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '5', '-y', file]);
const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

async function app() {
  const root = mkdtempSync(path.join(tmpdir(), 'lib-'));
  const out = mkdtempSync(path.join(tmpdir(), 'out-'));
  mkdirSync(path.join(root, '10102026'));
  clip(path.join(root, '10102026', 'Cam 3-00-120000-120006.mp4'), 6, 'red');
  clip(path.join(root, '10102026', 'Cam 3-00-120010-120016.mp4'), 6, 'blue');
  const config = normalize({ root, cameras: [] });
  const cfgFile = path.join(root, '..', `cfg-${process.pid}.json`);
  const server = createServer({ config, configPath: cfgFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = { origin: base }) => fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const list = async () => (await (await fetch(`${base}/api/jobs`)).json()).jobs;
  const settle = async (n = 1, ms = 20_000) => { const t = Date.now(); for (;;) { const j = await list(); if (j.length >= n && j.every((x) => !['queued', 'running'].includes(x.state))) return j; if (Date.now() - t > ms) throw new Error('jobs did not finish'); await sleep(50); } };
  return { root, out, base, post, list, settle, server,
    close: async () => { await server.drainJobs(); server.closeAllConnections(); server.close(); for (const d of [root, out]) rmSync(d, { recursive: true, force: true }); } };
}

test('copy: queues one job per clip, copies each, never overwrites, and reports sizes', async () => {
  const a = await app();
  const ids = ['10102026/Cam 3-00-120000-120006.mp4', '10102026/Cam 3-00-120010-120016.mp4'].map(idOf);
  const r = await a.post({ kind: 'copy', ids, dest: a.out });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).jobs.length, 2);
  const done = await a.settle(2);
  assert.ok(done.every((j) => j.state === 'done' && j.bytes > 0));
  assert.deepEqual(readdirSync(a.out).sort(), ['Cam 3-00-120000-120006.mp4', 'Cam 3-00-120010-120016.mp4']);
  await a.post({ kind: 'copy', ids: [ids[0]], dest: a.out });
  await a.settle(3);
  assert.ok(existsSync(path.join(a.out, 'Cam 3-00-120000-120006 (2).mp4')));
  await a.close();
});

test('cut: a range spanning two clips becomes one file of about the requested length', async () => {
  const a = await app();
  // 12:00:03 .. 12:00:13 covers the last 3 s of clip 1 and the first 3 s of clip 2
  const from = (12 * 3600 + 3) * 1000, to = (12 * 3600 + 13) * 1000;
  const r = await a.post({ kind: 'cut', camera: 'Cam 3', day: '2026-10-10', from, to, dest: a.out });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  const [job] = await a.settle();
  assert.equal(job.state, 'done', job.error);
  assert.equal(path.basename(job.file), 'Cam 3 2026-10-10 120003-120013.mp4');
  const d = duration(job.file);
  assert.ok(d > 5 && d < 8, `expected about 6 s (3 + 3), got ${d}`);
  assert.deepEqual(readdirSync(a.out), ['Cam 3 2026-10-10 120003-120013.mp4']);
  await a.close();
});

test('refusals: cross-origin, bad input, destination inside the library, no clips in range', async () => {
  const a = await app();
  const id = idOf('10102026/Cam 3-00-120000-120006.mp4');
  assert.equal((await a.post({ kind: 'copy', ids: [id], dest: a.out }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await a.post({ kind: 'copy', ids: [id], dest: a.out }, {})).status, 403);
  assert.equal((await a.post({ kind: 'copy', ids: [], dest: a.out })).status, 400);
  assert.equal((await a.post({ kind: 'wat', dest: a.out })).status, 400);
  assert.equal((await a.post({ kind: 'copy', ids: [id], dest: 'relative' })).status, 400);
  const inside = await a.post({ kind: 'copy', ids: [id], dest: path.join(a.root, 'exports') });
  assert.equal(inside.status, 400);
  assert.match((await inside.json()).error, /outside the recordings library/);
  assert.equal((await a.post({ kind: 'copy', ids: [idOf('../../etc/passwd')], dest: a.out })).status, 404, 'traversal id resolves to nothing');
  const base = { kind: 'cut', camera: 'Cam 3', day: '2026-10-10', dest: a.out };
  assert.equal((await a.post({ ...base, from: 100, to: 50 })).status, 400);
  assert.equal((await a.post({ ...base, from: 0, to: 13 * 3_600_000 })).status, 400, 'over 12 hours');
  assert.equal((await a.post({ ...base, from: 3_600_000, to: 7_200_000 })).status, 400, 'nothing recorded then');
  assert.equal((await a.post({ ...base, camera: 'Other', from: 43_200_000, to: 43_300_000 })).status, 400);
  assert.deepEqual(readdirSync(a.out), [], 'nothing written for refused requests');
  assert.equal((await a.list()).length, 0);
  await a.close();
});

test('a queued job can be cancelled; unknown job is 404; cross-origin refused', async () => {
  const a = await app();
  const ids = ['10102026/Cam 3-00-120000-120006.mp4', '10102026/Cam 3-00-120010-120016.mp4'].map(idOf);
  await a.post({ kind: 'copy', ids, dest: a.out });
  const jobs = await a.list();
  const last = jobs[0];                       // newest first
  const del = (id, origin = a.base) => fetch(`${a.base}/api/jobs/${id}`, { method: 'DELETE', headers: { origin } });
  assert.equal((await del('9999')).status, 404);
  assert.equal((await del(last.id, 'http://evil.example')).status, 403);
  const r = await del(last.id);
  assert.equal(r.status, 200);
  await a.settle(2);
  await a.close();
});
