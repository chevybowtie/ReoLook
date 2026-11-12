// The CLI's camera commands (info, capabilities, snapshot, days, search, download, live) run for real
// against a fake camera on the loopback interface. They pin what a person sees, the exit codes, what is
// written to disk, and what is asked of the camera, so the commands can be restructured safely.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sandbox as makeSandbox } from './support/cli-sandbox.mjs';
import { startFakeCamera as makeCamera, fail, dayStatus, recording, JPEG } from './support/fake-camera.mjs';

// Everything a test starts is also closed when the file ends, so a failed assertion cannot leave a
// fake camera listening (which would keep the test process alive).
const cameras = new Set(), boxes = new Set(), folders = new Set();
const startFakeCamera = async (o) => { const c = await makeCamera(o); cameras.add(c); return c; };
const sandbox = (o) => { const b = makeSandbox(o); boxes.add(b); return b; };
const tmpDir = (prefix) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); folders.add(d); return d; };
after(async () => {
  for (const c of cameras) await c.stop().catch(() => {});
  for (const b of boxes) b.cleanup();
  for (const d of folders) rmSync(d, { recursive: true, force: true });
});

const PASSWORD = 'secret123';
const devInfo = { DevInfo: { name: 'Front door', model: 'RLC-410-5MP', firmVer: 'v3.0.0.100', hardVer: 'IPC_H3', channelNum: 1 } };

/** A fake camera plus a signed-in sandbox; `done()` tears both down. */
async function rig(cameraOptions = {}) {
  const cam = await startFakeCamera({ password: PASSWORD, ...cameraOptions });
  const sb = sandbox({ password: PASSWORD });
  return { cam, sb, run: (args, o) => sb.run([...args, '--host', cam.host], o), done: async () => { await cam.stop(); sb.cleanup(); } };
}

/** The commands seen by the camera, in order, without the Login and Logout around them. */
const asked = (cam) => cam.requests.map((r) => r.cmd);

test('info: name, model, firmware and the storage that is mounted', async () => {
  const r = await rig({ commands: { GetDevInfo: () => devInfo, GetHddInfo: () => ({ HddInfo: [{ mount: 1, size: 59640, capacity: 31000 }] }) } });
  const out = await r.run(['info']);
  assert.equal(out.code, 0);
  assert.equal(out.out, 'Front door — RLC-410-5MP\n  firmware v3.0.0.100  hardware IPC_H3  channels 1\n  storage: mounted  59640 MB total, 31000 MB\n');
  assert.deepEqual(asked(r.cam), ['Login', 'GetDevInfo', 'GetHddInfo', 'Logout'], 'it signs in, reads, and signs out');
  await r.done();
});

test('info: no storage, an unmounted card, and storage the account may not read', async () => {
  const none = await rig({ commands: { GetDevInfo: () => devInfo, GetHddInfo: () => ({ HddInfo: [] }) } });
  assert.match((await none.run(['info'])).out, /  storage: none reported\n$/);
  await none.done();
  const unmounted = await rig({ commands: { GetDevInfo: () => devInfo, GetHddInfo: () => ({ HddInfo: [{ mount: 0, size: 100 }] }) } });
  assert.match((await unmounted.run(['info'])).out, /  storage: not mounted  100 MB total, \? MB\n$/);
  await unmounted.done();
  const refused = await rig({ commands: { GetDevInfo: () => devInfo, GetHddInfo: () => fail(-1, 'permission denied') } });
  const out = await refused.run(['info']);
  assert.equal(out.code, 0, 'a storage problem does not fail the command');
  assert.match(out.out, /  storage: unavailable \(GetHddInfo: permission denied\)\n$/);
  await refused.done();
});

test('a wrong password is reported, the exit code is 1, and the password is never printed', async () => {
  const cam = await startFakeCamera({ password: 'the-real-one' });
  const sb = sandbox({ password: 'not-the-real-one' });
  const out = await sb.run(['info', '--host', cam.host]);
  assert.equal(out.code, 1);
  assert.equal(out.err, 'error: Login: login failed\n');
  assert.ok(!(out.out + out.err).includes('not-the-real-one') && !(out.out + out.err).includes('the-real-one'));
  await cam.stop(); sb.cleanup();
});

test('an unreachable camera is an error with exit code 1, not a hang or a stack trace', async () => {
  const sb = sandbox();
  const cam = await startFakeCamera();
  const host = cam.host; await cam.stop();
  const out = await sb.run(['info', '--host', host]);
  assert.equal(out.code, 1);
  assert.match(out.err, /^error: /);
  assert.ok(!/\n\s+at /.test(out.err) || /fetch failed/.test(out.err), out.err);
  sb.cleanup();
});

test('snapshot: writes the JPEG to --out, or to a name made from the host', async () => {
  const r = await rig();
  const dir = tmpDir('snap-');
  const file = path.join(dir, 'front.jpg');
  const out = await r.run(['snapshot', '--out', file]);
  assert.equal(out.code, 0);
  assert.equal(out.out, `wrote ${file}\n`);
  assert.deepEqual(readFileSync(file), JPEG);
  const snap = r.cam.requests.find((q) => q.cmd === 'Snap');
  assert.ok(snap && snap.token, 'a snapshot is requested with the session token');
  const dflt = await r.run(['snapshot', '--channel', '2'], { cwd: dir });
  assert.equal(dflt.out, `wrote snapshot-${r.cam.host}.jpg\n`);
  assert.ok(existsSync(path.join(dir, `snapshot-${r.cam.host}.jpg`)), 'written to the working directory');
  await r.done(); rmSync(dir, { recursive: true, force: true });
});

test('snapshot: something that is not a JPEG is refused and nothing is written', async () => {
  const r = await rig({ snapshot: Buffer.from('<html>busy</html>') });
  const dir = tmpDir('snap-');
  const file = path.join(dir, 'x.jpg');
  const out = await r.run(['snapshot', '--out', file]);
  assert.equal(out.code, 1);
  assert.equal(out.err, 'error: Snap did not return a JPEG\n');
  assert.ok(!existsSync(file));
  await r.done(); rmSync(dir, { recursive: true, force: true });
});

test('days: lists the days of the month with recordings, for the month asked or none', async () => {
  const r = await rig({ commands: { Search: (p) => (p.Search.StartTime.mon === 10 ? dayStatus(2026, 10, [3, 10, 31]) : { SearchResult: { Status: [] } }) } });
  const out = await r.run(['days', '--month', '2026-10']);
  assert.equal(out.out, '2026-10: days 3, 10, 31\n');
  const q = r.cam.requests.find((x) => x.cmd === 'Search');
  assert.equal(q.action, 1);
  assert.deepEqual([q.param.Search.channel, q.param.Search.onlyStatus, q.param.Search.streamType], [0, 1, 'main']);
  assert.deepEqual(q.param.Search.StartTime, { year: 2026, mon: 10, day: 1, hour: 0, min: 0, sec: 0 });
  assert.equal((await r.run(['days', '--month', '2026-09'])).out, 'no recordings that month\n');
  const now = new Date();
  assert.equal((await r.run(['days'])).out.startsWith(now.getMonth() + 1 === 10 && now.getFullYear() === 2026 ? '2026-10' : 'no recordings'), true, 'defaults to the current month');
  await r.done();
});

test('search: lists the day\'s recordings with times, sizes and device names', async () => {
  const files = [
    recording('Mp4Record/2026-10-10/RecM01_20261010_120000_120410.mp4', [12, 0, 0], [12, 4, 10], 3_500_000),
    recording('Mp4Record/2026-10-10/RecM01_20261010_130000_130020.mp4', [13, 0, 0], [13, 0, 20], 1_250_000_000),
    recording('Mp4Record/2026-10-10/RecM01_20261010_140000_140001.mp4', [14, 0, 0], [14, 0, 1], 9_000),
  ];
  const r = await rig({ commands: { Search: () => ({ SearchResult: { File: files } }) } });
  const out = await r.run(['search', '--date', '2026-10-10', '--channel', '1']);
  assert.equal(out.code, 0);
  assert.deepEqual(out.out.trim().split('\n'), [
    '2026-10-10 12:00:00 → 12:04:10     3.5 MB  Mp4Record/2026-10-10/RecM01_20261010_120000_120410.mp4',
    '2026-10-10 13:00:00 → 13:00:20    1.25 GB  Mp4Record/2026-10-10/RecM01_20261010_130000_130020.mp4',
    '2026-10-10 14:00:00 → 14:00:01       9 kB  Mp4Record/2026-10-10/RecM01_20261010_140000_140001.mp4',
  ]);
  const q = r.cam.requests.find((x) => x.cmd === 'Search');
  assert.deepEqual([q.param.Search.channel, q.param.Search.onlyStatus], [1, 0]);
  assert.deepEqual(q.param.Search.StartTime, { year: 2026, mon: 10, day: 10, hour: 0, min: 0, sec: 0 });
  assert.deepEqual(q.param.Search.EndTime, { year: 2026, mon: 10, day: 10, hour: 23, min: 59, sec: 59 }, 'the whole day');
  await r.done();
});

test('search: an empty day, and a malformed date that never reaches the camera', async () => {
  const r = await rig({ commands: { Search: () => ({ SearchResult: {} }) } });
  assert.equal((await r.run(['search', '--date', '2026-10-11'])).out, 'no recordings\n');
  assert.equal((await r.run(['search'])).out, 'no recordings\n', 'defaults to today');
  const before = r.cam.requests.length;
  const bad = await r.run(['search', '--date', '10/11/2026']);
  assert.equal(bad.code, 1);
  assert.equal(bad.err, 'error: bad date "10/11/2026", expected YYYY-MM-DD\n');
  assert.ok(r.cam.requests.length - before <= 2, 'at most the sign-out');
  await r.done();
});

test('download: saves the recording under its own file name in --dir', async () => {
  const name = 'Mp4Record/2026-10-10/RecM01_20261010_120000_120410.mp4';
  const r = await rig({ downloads: { [name]: Buffer.from('FAKE-MP4-BYTES') } });
  const dir = path.join(tmpDir('dl-'), 'nested', 'out');
  const out = await r.run(['download', name, '--dir', dir]);
  assert.equal(out.code, 0);
  const dest = path.join(dir, 'RecM01_20261010_120000_120410.mp4');
  assert.equal(out.out, `wrote ${dest}\n`);
  assert.equal(readFileSync(dest, 'utf8'), 'FAKE-MP4-BYTES', 'the folder is created');
  const dl = r.cam.requests.find((q) => q.method === 'GET' && q.cmd === 'Download');
  assert.ok(dl.token);
  assert.ok(!(out.out + out.err).includes(dl.token), 'the session token is not printed');
  await r.done(); rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
});

test('download: needs a name, and a recording the camera does not have is a clear error', async () => {
  const r = await rig();
  const none = await r.run(['download']);
  assert.equal(none.code, 1);
  assert.equal(none.err, 'error: download needs a recording NAME (from `search`)\n');
  const dir = tmpDir('dl-');
  const missing = await r.run(['download', 'Mp4Record/none.mp4', '--dir', dir]);
  assert.equal(missing.code, 1);
  assert.equal(missing.err, 'error: download failed: HTTP 404\n');
  assert.ok(!existsSync(path.join(dir, 'none.mp4')));
  await r.done(); rmSync(dir, { recursive: true, force: true });
});

// ---- capabilities: a device that reports some things, answers some reads, and lacks the rest

const abilityReply = () => ({ Ability: { devInfo: { permit: 4 }, devName: { permit: 6 }, push: { permit: 0 }, abilityChn: [{ enc: { permit: 6 }, ptzCtrl: { permit: 4 } }] } });
const capCommands = () => ({
  GetDevInfo: () => devInfo, GetAbility: abilityReply,
  GetDevName: () => ({ DevName: { name: 'Front door' } }),
  GetEnc: () => ({ Enc: { mainStream: { size: '2560*1440' }, subStream: { size: '640*480' } } }),
  GetPtzCheckState: () => fail(-9, 'ability error'),
});

test('capabilities: a readable list grouped by area, with a mark for each state', async () => {
  const r = await rig({ commands: capCommands() });
  const out = await r.run(['capabilities']);
  assert.equal(out.code, 0);
  const lines = out.out.split('\n');
  assert.equal(lines[0], 'Front door — RLC-410-5MP  (firmware v3.0.0.100, channel 0; read now, source: ability+reads)');
  assert.ok(out.out.includes('\nGeneral\n  ✓ Device info\n  ✓ Device name\n'), 'working reads are ticked, under their area');
  assert.ok(out.out.includes('  ✓ Stream encoding\n'));
  assert.ok(out.out.includes('  ! Pan, tilt, zoom  [the device reports it but refuses the read]\n'), 'reported but refused is a conflict');
  assert.ok(out.out.includes('  – Push notifications  [not available (this device, or this account may not use it)]\n'), 'a permit of 0 may be this account');
  assert.ok(out.out.includes('  – NTP  [not on this device]\n'), 'not reported and refused is simply absent');
  await r.done();
});

test('capabilities --json is the same profile as data, and the second run is served from the cache until --refresh', async () => {
  const r = await rig({ commands: capCommands() });
  const first = JSON.parse((await r.run(['capabilities', '--json'])).out);
  assert.equal(first.cached, false);
  assert.equal(first.model, 'RLC-410-5MP');
  assert.equal(first.features.general.state, 'supported');
  assert.equal(first.features.ptz.state, 'conflict');
  assert.equal(first.features.push.state, 'unsupported');
  assert.deepEqual(first.features.encoding.access, { read: true, write: true, execute: false });
  const probesAfterFirst = r.cam.requests.length;
  const second = JSON.parse((await r.run(['capabilities', '--json'])).out);
  assert.equal(second.cached, true);
  assert.ok(r.cam.requests.length - probesAfterFirst <= 4, 'only the device-info read, plus sign-in and sign-out');
  assert.equal(JSON.parse((await r.run(['capabilities', '--json', '--refresh'])).out).cached, false);
  const text = await r.run(['capabilities']);
  assert.match(text.out.split('\n')[0], /cached, source: ability\+reads/);
  await r.done();
});

test('capabilities still works for a device that will not give its own report', async () => {
  const r = await rig({ commands: { ...capCommands(), GetAbility: () => fail(-1, 'permission denied') } });
  const p = JSON.parse((await r.run(['capabilities', '--json'])).out);
  assert.equal(p.source, 'reads-only');
  assert.match(p.abilityError, /permission denied/);
  assert.equal(p.features.general.state, 'supported');
  await r.done();
});

// ---- live: plays with ffplay; a stand-in ffplay on PATH records how it was called

function fakeFfplay() {
  const dir = tmpDir('ffplay-');
  const log = path.join(dir, 'args.json');
  const exe = path.join(dir, 'ffplay');
  writeFileSync(exe, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(exe, 0o755);
  return { dir, args: () => JSON.parse(readFileSync(log, 'utf8')) };
}

test('live: hands ffplay the sub stream address by default and the main stream with --main', async () => {
  const f = fakeFfplay();
  const cam = await startFakeCamera({ password: PASSWORD });
  const sb = sandbox({ password: PASSWORD, env: { PATH: `${f.dir}:${process.env.PATH}` } });
  const host = cam.host, hostname = host.split(':')[0];
  assert.equal((await sb.run(['live', '--host', host])).code, 0);
  let a = f.args();
  assert.deepEqual(a.slice(0, 5), ['-hide_banner', '-loglevel', 'warning', '-fflags', 'nobuffer']);
  assert.deepEqual(a.slice(5, 7), ['-window_title', `ReoLook ${host}`]);
  const url = new URL(a.at(-1));
  assert.equal(url.protocol, 'rtmp:'); assert.equal(url.hostname, hostname);
  assert.equal(url.pathname, '/bcs/channel0_sub.bcs');
  assert.deepEqual([url.searchParams.get('channel'), url.searchParams.get('stream'), url.searchParams.get('user')], ['0', '1', 'viewer']);
  await sb.run(['live', '--host', host, '--main', '--channel', '2']);
  a = f.args();
  assert.match(a.at(-1), /\/bcs\/channel2_main\.bcs\?/);
  assert.equal(new URL(a.at(-1)).searchParams.get('stream'), '0');
  await cam.stop(); sb.cleanup(); rmSync(f.dir, { recursive: true, force: true });
});

// ---- serve against a camera: how many sessions and how much polling the camera has to put up with

import { spawn } from 'node:child_process';
import net from 'node:net';
import { BIN } from './support/cli-sandbox.mjs';

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('serve: the recorder and the web page share one session on the camera, which is signed out on shutdown', async () => {
  const cam = await startFakeCamera({ password: PASSWORD, commands: { GetMdState: () => ({ state: 0 }) } });
  const sb = sandbox({ password: PASSWORD });
  const root = tmpDir('serve-root-');
  const port = await freePort();
  const config = path.join(sb.home, 'config.json');
  writeFileSync(config, JSON.stringify({ root, port, cameras: [{ name: 'Door', host: cam.host }], record: { enabled: true } }));
  const child = spawn(process.execPath, [BIN, 'serve', '--config', config], { env: sb.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  for (let i = 0; i < 100 && !/ReoLook → http/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /ReoLook → http/, err);
  await new Promise((r) => setTimeout(r, 2500));                          // the recorder polls once a second
  await (await fetch(`http://127.0.0.1:${port}/api/motion-state`)).json(); // and the page asks too
  const asked = (c) => cam.requests.filter((r) => r.cmd === c).length;
  assert.equal(asked('Login'), 1, 'one session for everything in the process');
  assert.ok(asked('GetMdState') >= 2, 'the recorder polled');
  assert.ok(asked('GetMdState') <= 5, `and the page\'s request did not add a poll of its own beyond the recorder\'s rhythm (${asked('GetMdState')})`);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(asked('Logout'), 1, 'signed out on the way down, so a restart leaves no session behind');
  await cam.stop();
});
