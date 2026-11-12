// Characterisation tests for bin/reolook.mjs, run as a real subprocess with an isolated HOME so
// nothing of the developer's own configuration is read or written. They pin the exit codes and the
// text a user sees, so the CLI can be restructured without changing either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { sandbox, BIN } from './support/cli-sandbox.mjs';

const put = (root, rel, size = 10) => { const p = path.join(root, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, Buffer.alloc(size)); };

test('no command prints the usage and exits 1; --help with a command prints it and exits 0', () => {
  const s = sandbox();
  const none = s.cli([]);
  assert.equal(none.code, 1);
  assert.match(none.out, /^Usage: reolook <command>/);
  assert.equal(s.cli(['--help']).code, 1, 'help with no command still counts as a missing command');
  const help = s.cli(['repairs', '--help']);
  assert.equal(help.code, 0);
  assert.equal(help.out, none.out, 'the same text either way');
  s.cleanup();
});

test('a command that needs a camera but has no sign-in or host says so and exits 2', () => {
  const s = sandbox({ signedIn: false });
  const r = s.cli(['retention']);
  assert.equal(r.code, 2);
  assert.match(r.err, /^error: /);
  const noHost = sandbox().cli(['info']);
  assert.equal(noHost.code, 2);
  assert.match(noHost.err, /error: need --host/);
  s.cleanup();
});

test('init saves a private sign-in file from a piped password, and refuses to overwrite it', () => {
  const s = sandbox({ signedIn: false });
  const ok = s.cli(['init', '--user', 'viewer'], { input: 'hunter2hunter2\n' });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^saved .*\/reolook\/env \(mode 600\)/);
  const file = path.join(s.home, '.config', 'reolook', 'env');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, 'utf8'), /REOLINK_USER=viewer\nREOLINK_PASS=hunter2hunter2\n/);
  const again = s.cli(['init', '--user', 'viewer'], { input: 'another-password\n' });
  assert.equal(again.code, 2);
  assert.match(again.err, /already exists/);
  const forced = s.cli(['init', '--user', 'viewer', '--force'], { input: 'another-password\n' });
  assert.equal(forced.code, 0);
  s.cleanup();
});

test('init with no terminal needs --user, and exits 2 without it', () => {
  const s = sandbox({ signedIn: false });
  const r = s.cli(['init'], { input: 'pw\n' });
  assert.equal(r.code, 2);
  assert.match(r.err, /give the account name with --user NAME/);
  s.cleanup();
});

test('repairs: an empty log says none recorded; a note is saved and shown; a note with no text is refused', () => {
  const s = sandbox();
  const empty = s.cli(['repairs']);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /live-view repairs in the last 24 h/);
  assert.match(empty.out, /none recorded/);
  assert.match(empty.out, /only seen while a Live page is open/);
  const noText = s.cli(['repairs', 'note']);
  assert.equal(noText.code, 2);
  assert.match(noText.err, /^usage: reolook repairs note/);
  const noted = s.cli(['repairs', 'note', 'moved', 'the', 'cable']);
  assert.equal(noted.code, 0);
  assert.equal(noted.out.trim(), 'noted: moved the cable');
  const shown = s.cli(['repairs']);
  assert.match(shown.out, /\nnotes:\n.*moved the cable/);
  s.cleanup();
});

test('repairs: cameras are listed busiest first with their episodes; --hours narrows the window', () => {
  const s = sandbox();
  const file = path.join(s.home, '.local', 'state', 'reolook', 'live-repairs.jsonl');
  mkdirSync(path.dirname(file), { recursive: true });
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const lines = [
    { key: 'quiet:sub', at: ago(50) },
    { key: 'busy:sub', at: ago(30), recording: true }, { key: 'busy:sub', at: ago(29) }, { key: 'busy:sub', at: ago(28) },
    { key: 'old:sub', at: ago(600) },
  ].map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(file, lines + '\nnot json\n');
  const r = s.cli(['repairs', '--hours', '2']);
  assert.equal(r.code, 0);
  const rows = r.out.split('\n').filter((l) => /repairs in \d+ episode/.test(l));
  assert.equal(rows.length, 2, 'the old one is outside the window');
  assert.match(rows[0], /^ {2}busy +3 repairs in 1 episode\(s\), 1 while that camera was recording$/);
  assert.match(rows[1], /^ {2}quiet +1 repairs in 1 episode\(s\)$/);
  assert.match(r.out, /last 2 h/);
  s.cleanup();
});

/** A recordings root and a config that points at it. */
function library(s) {
  const root = path.join(s.home, 'rec');
  put(root, '01012020/Camera 3-00-010000-010100.mp4', 2000);
  put(root, '01022020/Camera 3-00-010000-010100.mp4', 2000);
  put(root, 'notes/keep.txt');
  const config = path.join(s.home, 'config.json');
  writeFileSync(config, JSON.stringify({ root, cameras: [] }));
  return { root, config };
}

test('retention: needs a root, and needs a rule', () => {
  const s = sandbox();
  const bare = path.join(s.home, 'bare.json');
  writeFileSync(bare, JSON.stringify({ cameras: [] }));
  const noRoot = s.cli(['retention', '--config', bare]);
  assert.equal(noRoot.code, 2);
  assert.match(noRoot.err, /error: set "root" in the config/);
  const { config } = library(s);
  const noRule = s.cli(['retention', '--config', config]);
  assert.equal(noRule.code, 2);
  assert.match(noRule.err, /no retention rule set/);
  s.cleanup();
});

test('retention reports a plan without deleting, and deletes only with --apply', () => {
  const s = sandbox();
  const { root, config } = library(s);
  const plan = s.cli(['retention', '--config', config, '--max-age-days', '30']);
  assert.equal(plan.code, 0);
  assert.match(plan.out, /^library: 2 clips, /);
  assert.match(plan.out, /would delete: 2 of 2 clips/);
  assert.match(plan.out, /range: 2020-01-01 → 2020-01-02/);
  assert.match(plan.out, /2 × older than 30 days/);
  assert.match(plan.out, /plan only; nothing was deleted\. Re-run with --apply to delete\./);
  assert.ok(existsSync(path.join(root, '01012020', 'Camera 3-00-010000-010100.mp4')), 'plan only');

  const done = s.cli(['retention', '--config', config, '--max-age-days', '30', '--apply']);
  assert.equal(done.code, 0);
  assert.match(done.out, /deleted: 2 of 2 clips/);
  assert.ok(!existsSync(path.join(root, '01012020')), 'emptied day folder removed');
  assert.ok(existsSync(path.join(root, 'notes', 'keep.txt')), 'foreign files untouched');
  const after = s.cli(['retention', '--config', config, '--max-age-days', '30']);
  assert.match(after.out, /library: 0 clips/);
  assert.match(after.out, /nothing to delete/);
  s.cleanup();
});

test('an unknown command with a host reports it and exits 1', () => {
  const r = sandbox().cli(['frobnicate', '--host', '127.0.0.1']);
  assert.equal(r.code, 1);
  assert.match(r.err, /error: unknown command "frobnicate"/);
});

// ---- serve: the long-running command, started for real and stopped with a signal

import { spawn } from 'node:child_process';
import net from 'node:net';

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** Starts `reolook serve ...`; resolves once it prints its address. */
function startServe(s, args) {
  const child = spawn(process.execPath, [BIN, 'serve', ...args], { env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const t = setInterval(() => { if (/ReoLook → http/.test(out)) { clearInterval(t); resolve(); } }, 25);
    exited.then((e) => { clearInterval(t); reject(new Error(`exited early: ${JSON.stringify(e)} ${err}`)); });
    setTimeout(() => { clearInterval(t); reject(new Error('did not start')); }, 10_000).unref();
  });
  ready.catch(() => {});   // a test that expects the start to fail only awaits `exited`
  return { child, ready, exited, out: () => out, err: () => err };
}

test('serve: reports its address, answers over HTTP, and stops cleanly on SIGTERM', async () => {
  const s = sandbox();
  const { root, config } = library(s);
  const port = await freePort();
  const p = startServe(s, ['--config', config, '--port', String(port), '--camera', 'Front=192.0.2.10']);
  await p.ready;
  assert.match(p.out(), new RegExp(`ReoLook → http://127\\.0\\.0\\.1:${port}/  \\(1 camera\\(s\\), recordings: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/days`)).json(), { days: ['2020-01-02', '2020-01-01'] });
  const cams = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.ok(JSON.stringify(cams).includes('Front'), '--camera replaces the configured devices');
  p.child.kill('SIGTERM');
  assert.deepEqual(await p.exited, { code: 0, signal: null });
  assert.match(p.out(), /stopping: finalizing recordings…/);
  s.cleanup();
});

test('serve: a port already in use is reported and exits 1', async () => {
  const s = sandbox();
  const { config } = library(s);
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const port = busy.address().port;
  const p = startServe(s, ['--config', config, '--port', String(port)]);
  const e = await p.exited;
  assert.equal(e.code, 1);
  assert.match(p.err(), /error: .*EADDRINUSE/);
  busy.close(); s.cleanup();
});

test('serve: needs a sign-in, a well-formed --camera, and a folder when recording is on', async () => {
  const none = sandbox({ signedIn: false });
  const r1 = none.cli(['serve']);
  assert.equal(r1.code, 2);
  assert.match(r1.err, /error: /);
  const s = sandbox();
  const { config } = library(s);
  const bad = s.cli(['serve', '--config', config, '--camera', 'no-equals-sign', '--port', String(await freePort())]);
  assert.equal(bad.code, 1, 'an unexpected failure while starting');
  assert.match(bad.err, /bad --camera "no-equals-sign", expected Name=IP/);
  const rec = path.join(s.home, 'rec.json');
  writeFileSync(rec, JSON.stringify({ cameras: [], record: { enabled: true } }));
  const noRoot = s.cli(['serve', '--config', rec]);
  assert.equal(noRoot.code, 2);
  assert.match(noRoot.err, /record\.enabled needs "root" in the config/);
  none.cleanup(); s.cleanup();
});
