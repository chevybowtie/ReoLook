// The read-only HTTP surface of the server: the page, the recording index, media with byte ranges,
// thumbnails, clip information, status, and what is refused. A recording is a real short MP4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { idOf } from '../src/library.mjs';
import { VERSION, LICENSE } from '../src/version.mjs';

const REL = '10102026/Cam 3-00-120000-120004.mp4';

async function app({ withRoot = true } = {}) {
  const base0 = mkdtempSync(path.join(tmpdir(), 'http-'));
  const root = path.join(base0, 'rec'), cacheDir = path.join(base0, 'cache');
  mkdirSync(path.join(root, '10102026'), { recursive: true });
  const file = path.join(root, REL);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:size=160x120:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '5', '-y', file]);
  writeFileSync(path.join(root, '10102026', 'Cam 3-00-130000-130004.part.mp4'), 'partial');
  const config = normalize({ root: withRoot ? root : undefined, cameras: [] });
  const server = createServer({ config, configPath: path.join(base0, 'config.json'), cacheDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, root, file, cacheDir, size: statSync(file).size,
    close: async () => { await server.drainJobs(); server.closeAllConnections(); server.close(); rmSync(base0, { recursive: true, force: true }); } };
}

test('the page and unknown routes', async () => {
  const a = await app();
  const page = await fetch(`${a.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<title>[^<]*ReoLook/i);
  const missing = await fetch(`${a.base}/api/nothing-here`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not found' });
  await a.close();
});

test('days and clips list what is on disk, and refuse a malformed date', async () => {
  const a = await app();
  assert.deepEqual(await (await fetch(`${a.base}/api/days`)).json(), { days: ['2026-10-10'] });
  const { clips } = await (await fetch(`${a.base}/api/clips?date=2026-10-10`)).json();
  assert.equal(clips.length, 1, 'the unfinished .part file is not listed');
  assert.equal(clips[0].camera, 'Cam 3');
  assert.equal(clips[0].id, idOf(REL));
  assert.deepEqual(await (await fetch(`${a.base}/api/clips?date=2026-10-11`)).json(), { clips: [] });
  const bad = await fetch(`${a.base}/api/clips?date=yesterday`);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'date must be YYYY-MM-DD' });
  assert.equal((await fetch(`${a.base}/api/clips`)).status, 400);
  await a.close();
});

test('with no recordings folder there are no days or clips, not an error', async () => {
  const a = await app({ withRoot: false });
  assert.deepEqual(await (await fetch(`${a.base}/api/days`)).json(), { days: [] });
  assert.deepEqual(await (await fetch(`${a.base}/api/clips?date=2026-10-10`)).json(), { clips: [] });
  await a.close();
});

test('media is served whole, and by byte range as the player asks', async () => {
  const a = await app();
  const url = `${a.base}/media/${idOf(REL)}`;
  const whole = await fetch(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  const body = Buffer.from(await whole.arrayBuffer());
  assert.equal(body.length, a.size);

  const head = await fetch(url, { headers: { range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), `bytes 0-9/${a.size}`);
  assert.equal(head.headers.get('content-length'), '10');
  assert.deepEqual(Buffer.from(await head.arrayBuffer()), body.subarray(0, 10));

  const tail = await fetch(url, { headers: { range: 'bytes=-5' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), `bytes ${a.size - 5}-${a.size - 1}/${a.size}`);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), body.subarray(-5));

  const open = await fetch(url, { headers: { range: `bytes=${a.size - 3}-` } });
  assert.equal(open.headers.get('content-range'), `bytes ${a.size - 3}-${a.size - 1}/${a.size}`);
  await open.arrayBuffer();

  const clamped = await fetch(url, { headers: { range: `bytes=0-${a.size * 10}` } });
  assert.equal(clamped.headers.get('content-range'), `bytes 0-${a.size - 1}/${a.size}`);
  await clamped.arrayBuffer();

  const past = await fetch(url, { headers: { range: `bytes=${a.size + 5}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${a.size}`);
  await a.close();
});

test('media, thumbnails and clip info refuse unknown ids and paths that leave the library', async () => {
  const a = await app();
  const enc = (rel) => Buffer.from(rel).toString('base64url');
  for (const route of ['media', 'thumb', 'api/clipinfo']) {
    assert.equal((await fetch(`${a.base}/${route}/${enc('10102026/missing.mp4')}`)).status, 404, `${route}: missing file`);
    assert.equal((await fetch(`${a.base}/${route}/${enc('../outside.mp4')}`)).status, 404, `${route}: outside the library`);
    assert.equal((await fetch(`${a.base}/${route}/${enc('10102026/../../etc/passwd')}`)).status, 404, `${route}: traversal`);
    assert.equal((await fetch(`${a.base}/${route}/not*valid`)).status, 404, `${route}: not an id`);
  }
  await a.close();
});

test('a thumbnail is a JPEG, made once and then reused from the cache', async () => {
  const a = await app();
  const r = await fetch(`${a.base}/thumb/${idOf(REL)}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  const jpg = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8], 'JPEG signature');
  const cached = readdirSync(path.join(a.cacheDir, 'thumbs'));
  assert.equal(cached.length, 1);
  const again = Buffer.from(await (await fetch(`${a.base}/thumb/${idOf(REL)}`)).arrayBuffer());
  assert.deepEqual(again, jpg);
  assert.equal(readdirSync(path.join(a.cacheDir, 'thumbs')).length, 1, 'no second file');
  await a.close();
});

test('clip info reports where the playable content starts on the file\'s own timeline', async () => {
  const a = await app();
  const info = await (await fetch(`${a.base}/api/clipinfo/${idOf(REL)}`)).json();
  assert.equal(info.jumped, false, 'a clip that starts at its beginning has no jump');
  assert.equal(info.base, 0);
  assert.equal(info.packets, 40, '4 s at 10 fps');
  assert.ok(Math.abs(info.end - 3.9) < 0.2, `last packet near 3.9 s, got ${info.end}`);
  assert.deepEqual(await (await fetch(`${a.base}/api/clipinfo/${idOf(REL)}`)).json(), info, 'same answer when asked again');
  await a.close();
});

test('requests addressed to any name other than this machine\'s own loopback are refused', async () => {
  const a = await app();
  const port = new URL(a.base).port;
  const get = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/days', headers: { host } }, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, body: t })); }).on('error', reject);
  });
  assert.deepEqual(await get('evil.example'), { status: 403, body: 'forbidden' });
  assert.deepEqual(await get(`evil.example:${port}`), { status: 403, body: 'forbidden' });
  assert.equal((await get(`localhost:${port}`)).status, 200);
  assert.equal((await get(`[::1]:${port}`)).status, 200);
  await a.close();
});

test('about reports this build: name, version, license and the Node.js it runs on', async () => {
  const a = await app();
  const r = await fetch(`${a.base}/api/about`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'ReoLook', version: VERSION, license: LICENSE, node: process.versions.node });
  assert.equal((await fetch(`${a.base}/api/about`, { method: 'POST', headers: { origin: a.base } })).status, 405, 'read only');
  await a.close();
});

test('status reports which tools are installed and the live streams in use', async () => {
  const a = await app();
  const s = await (await fetch(`${a.base}/api/status`)).json();
  assert.equal(typeof s.tools.ffmpeg, 'boolean');
  assert.equal(typeof s.tools.ffprobe, 'boolean');
  assert.ok(Array.isArray(s.live));
  await a.close();
});

test('storage reports the folder, whether it can be written, and the library totals', async () => {
  const a = await app();
  const r = await fetch(`${a.base}/api/storage`);
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.root, a.root);
  assert.deepEqual(s.writable, { ok: true });
  assert.equal(s.library.clips, 1);
  assert.equal(s.library.bytes, a.size);
  assert.match(s.library.oldest, /^2026-10-10T/);
  assert.equal(typeof s.total, 'number'); assert.equal(typeof s.free, 'number');
  assert.equal(s.low, false);
  await a.close();
});
