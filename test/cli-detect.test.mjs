// The `detect` command (status, image, replay) run for real, with a stand-in for the Python detector:
// a small script that speaks the helper's one-JSON-line protocol and returns a truck parked in the zone.
// These pin what a person sees and what is saved, so the command can be restructured safely.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox as makeSandbox } from './support/cli-sandbox.mjs';

const ZONE = [[0.5, 0.3], [0.95, 0.3], [0.95, 0.9], [0.5, 0.9]];
const TRUCK = [{ label: 'truck', score: 0.9, box: [0.55, 0.4, 0.8, 0.7] }];   // its foot is inside ZONE
const boxes = new Set();
after(() => { for (const b of boxes) b.cleanup(); });

// FAKE_DETECTIONS is what every frame shows. With FAKE_ARRIVAL set, a truck instead drives in over the first
// three frames and then stays where it stopped, which is what a "stops" rule waits for.
const FAKE_PYTHON = `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
console.log(JSON.stringify({ ready: true }));
let frames = 0;
const detections = () => {
  if (!process.env.FAKE_ARRIVAL) return JSON.parse(process.env.FAKE_DETECTIONS || '[]');
  const x = [0.45, 0.52, 0.58][frames++] ?? 0.6;
  return [{ label: 'truck', score: 0.9, box: [x, 0.4, x + 0.2, 0.7] }];
};
rl.on('line', (l) => {
  const m = JSON.parse(l);
  console.log(JSON.stringify(m.op === 'embed' ? { id: m.id, features: [], colour: '' }
    : { id: m.id, width: 1280, height: 720, ms: 3, detections: detections() }));
});
`;

/**
 * A sandbox with an installed fake detector, a configured device with one rule, and (optionally) a clip.
 * @param {{installed?: boolean, detections?: object[], arrival?: boolean, clipSeconds?: number}} [o]   `arrival`: a truck drives in, then stops
 */
function rig({ installed = true, detections = TRUCK, arrival = false, clipSeconds = 30 } = {}) {
  const sb = makeSandbox({ env: { FAKE_DETECTIONS: JSON.stringify(detections), ...(arrival ? { FAKE_ARRIVAL: '1' } : {}) } });
  boxes.add(sb);
  const det = path.join(sb.home, '.local', 'share', 'reolook', 'detector');
  if (installed) {
    mkdirSync(path.join(det, 'venv', 'bin'), { recursive: true });
    writeFileSync(path.join(det, 'venv', 'bin', 'python'), FAKE_PYTHON); chmodSync(path.join(det, 'venv', 'bin', 'python'), 0o755);
    writeFileSync(path.join(det, 'yolox_s.onnx'), 'x');
  }
  const root = path.join(sb.home, 'rec'); mkdirSync(path.join(root, '10102026'), { recursive: true });
  if (clipSeconds) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:size=160x120:rate=5', '-t', String(clipSeconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y',
    path.join(root, '10102026', 'Out-00-120000-120030.mp4')]);
  const config = path.join(sb.home, 'config.json');
  writeFileSync(config, JSON.stringify({ root, cameras: [{ name: 'Out', host: '192.0.2.1' }], detection: { enabled: true, cameras: { out: { enabled: true,
    rules: [{ id: 'r1', enabled: true, label: 'mail truck', zone: ZONE, minStopSec: 6, classes: ['truck'] }] } } } }));
  const replay = (...extra) => sb.run(['detect', 'replay', '--config', config, '--camera', 'Out', '--date', '2026-10-10', ...extra]);
  return { sb, root, config, det, replay, eventsFile: path.join(sb.home, '.local', 'state', 'reolook', 'detections.jsonl') };
}

test('detect: an unknown subcommand prints the usage and exits 2', async () => {
  const r = await rig({ clipSeconds: 0 }).sb.run(['detect', 'bogus']);
  assert.equal(r.code, 2);
  assert.equal(r.err, 'usage: reolook detect setup | status | image FILE.jpg | replay --camera NAME --date YYYY-MM-DD\n');
  assert.equal((await rig({ clipSeconds: 0 }).sb.run(['detect'])).code, 2);
});

test('detect status: says what is installed, and how to install it when it is not', async () => {
  const some = await rig({ clipSeconds: 0 }).sb.run(['detect', 'status']);
  assert.equal(some.code, 0);
  assert.match(some.out, /^detector: installed\n  environment: yes\n  model:       yes\n  appearance:  no\n  folder:      .*\/\.local\/share\/reolook\/detector\n$/);
  const none = await rig({ installed: false, clipSeconds: 0 }).sb.run(['detect', 'status']);
  assert.equal(none.code, 0);
  assert.match(none.out, /^detector: not installed\n  environment: no\n  model:       no\n/);
  assert.match(none.out, /\nInstall it with: node bin\/reolook\.mjs detect setup\n$/);
});

test('detect image: lists what was found with its score and box, or says nothing was found', async () => {
  const r = rig({ clipSeconds: 0 });
  const img = path.join(r.sb.home, 'f.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=64x48', '-frames:v', '1', '-y', img]);
  const found = await r.sb.run(['detect', 'image', img]);
  assert.equal(found.code, 0);
  assert.equal(found.out, '1280x720, 3 ms\n  truck         90%  box 0.55 0.40 0.80 0.70\n');
  const empty = rig({ detections: [], clipSeconds: 0 });
  assert.equal((await empty.sb.run(['detect', 'image', img])).out, '1280x720, 3 ms\n  nothing found\n');
});

test('detect image and replay refuse to run when the detector is not installed, and image needs a file', async () => {
  const r = rig({ installed: false });
  const msg = 'error: the detector is not installed; run: node bin/reolook.mjs detect setup\n';
  const image = await r.sb.run(['detect', 'image', '/nowhere.jpg']);
  assert.deepEqual([image.code, image.err], [1, msg]);
  const replay = await r.replay();
  assert.deepEqual([replay.code, replay.err], [1, msg]);
  assert.equal((await rig({ clipSeconds: 0 }).sb.run(['detect', 'image'])).code, 2, 'no file given: the usage');
});

test('detect replay: asks for a camera and a date, and says what is wrong with a name, a rule or a folder', async () => {
  const r = rig();
  const usage = await r.sb.run(['detect', 'replay', '--config', r.config, '--camera', 'Out', '--date', 'yesterday']);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /^usage: reolook detect replay --camera "Name or id" --date YYYY-MM-DD/);
  assert.equal((await r.sb.run(['detect', 'replay', '--config', r.config, '--date', '2026-10-10'])).code, 2, 'no camera');
  const nameless = await r.sb.run(['detect', 'replay', '--config', r.config, '--camera', 'Nope', '--date', '2026-10-10']);
  assert.deepEqual([nameless.code, nameless.err], [2, 'error: no device "Nope". Known: Out\n']);
  const rule = await r.replay('--rule', 'zz');
  assert.deepEqual([rule.code, rule.err], [2, 'error: Out has no detection rule "zz" in the config\n']);
  const byId = await r.sb.run(['detect', 'replay', '--config', r.config, '--camera', 'OUT', '--date', '2026-10-11']);
  assert.equal(byId.code, 0, 'the name is matched without regard to case');
  const noRoot = path.join(r.sb.home, 'noroot.json');
  writeFileSync(noRoot, JSON.stringify({ cameras: [{ name: 'Out', host: '192.0.2.1' }], detection: { enabled: true, cameras: { out: { enabled: true, rules: [{ id: 'r1', enabled: true, label: 'x', zone: ZONE, classes: ['truck'] }] } } } }));
  const none = await r.sb.run(['detect', 'replay', '--config', noRoot, '--camera', 'Out', '--date', '2026-10-10']);
  assert.deepEqual([none.code, none.err], [2, 'error: no recordings folder is configured\n']);
});

test('detect replay: a day or a time window with no recordings says so', async () => {
  const r = rig();
  const day = await r.sb.run(['detect', 'replay', '--config', r.config, '--camera', 'Out', '--date', '2026-10-11']);
  assert.equal(day.out, 'no recordings of Out on 2026-10-11 between 00:00 and 23:59\n');
  const window = await r.replay('--from', '13:00', '--to', '14:00');
  assert.equal(window.out, 'no recordings of Out on 2026-10-10 between 13:00 and 14:00\n');
});

test('detect replay: a vehicle that arrives and stays long enough WOULD FIRE, and the clip is listed with its times', async () => {
  const r = rig({ arrival: true });
  const out = await r.replay();
  assert.equal(out.code, 0);
  assert.match(out.out, /\nrule "mail truck" \(stops; truck; at least \d+% tall; still 6 s\) on 1 clip\(s\):\n/);
  assert.match(out.out, /\n  12:00:00-12:00:30  truck 90% h30% in zone +WOULD FIRE\n$/);
  assert.ok(!existsSync(r.eventsFile), 'nothing is saved without --save');
});

test('detect replay: a vehicle that was already there when the clip began is not a stop', async () => {
  const r = rig();
  const out = await r.replay();
  assert.match(out.out, /\n  12:00:00-12:00:30  truck 90% h30% in zone +NO EVENT: it was in the zone and big enough for 20 samples \(28\.5 s\), which is less than the rule needs\n$/);
});

test('detect replay: a vehicle that is not there is not listed unless --all, and the reason is given', async () => {
  const r = rig({ detections: [] });
  const quiet = await r.replay();
  assert.match(quiet.out, /\n  nothing of a type this rule wants in any of them \(use --all to list every clip\)\n$/);
  const all = await r.replay('--all');
  assert.match(all.out, /\n  12:00:00-12:00:30  nothing wanted +NO EVENT: nothing of a type this rule wants was seen\n$/);
});

test('detect replay --save: keeps each would-fire event once, with its picture, and a second run adds nothing', async () => {
  const r = rig({ arrival: true });
  const first = await r.replay('--save');
  assert.match(first.out, /\nsaved 1 event\(s\) for review under Settings > Detection\n$/);
  const lines = readFileSync(r.eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].type, lines[0].camera, lines[0].cameraName, lines[0].rule, lines[0].ruleId, lines[0].vehicle, lines[0].replayed],
    ['stopped', 'out', 'Out', 'mail truck', 'r1', 'truck', true]);
  assert.match(lines[0].tag, /^mail truck 12:0\d$/);
  assert.match(lines[0].at, /^2026-10-10T/);
  assert.ok(lines[0].snapshot, 'the frame it fired on is kept');
  const second = await r.replay('--save');
  assert.match(second.out, /\nsaved 0 event\(s\) for review under Settings > Detection \(1 already there or inside the quiet time\)\n$/);
  assert.equal(readFileSync(r.eventsFile, 'utf8').trim().split('\n').length, 1);
});

test('detect replay: the rule heading shows its kind, types, size, timing and hours', async () => {
  const r = rig({ arrival: true });
  const cfg = path.join(r.sb.home, 'appears.json');
  writeFileSync(cfg, JSON.stringify({ root: r.root, cameras: [{ name: 'Out', host: '192.0.2.1' }], detection: { enabled: true, cameras: { out: { enabled: true, rules: [
    { id: 'r2', enabled: true, label: 'any truck', mode: 'appears', zone: [], classes: ['truck', 'car'], minPresenceSec: 2, minHeight: 0.2, from: '06:00', to: '22:00' },
    { id: 'r3', enabled: true, label: 'parked', mode: 'stops', zone: ZONE, classes: ['truck'], minStopSec: 8 }] } } } }));
  const all = await r.sb.run(['detect', 'replay', '--config', cfg, '--camera', 'Out', '--date', '2026-10-10', '--rule', 'r2']);
  assert.equal(all.code, 0);
  assert.match(all.out, /\nrule "any truck" \(appears; truck\/car; at least 20% tall; seen 2 s; 06:00-22:00\) on 1 clip\(s\):\n/);
  const two = await r.sb.run(['detect', 'replay', '--config', cfg, '--camera', 'Out', '--date', '2026-10-10']);
  assert.ok(two.out.indexOf('rule "any truck"') < two.out.indexOf('rule "parked" (stops; truck; at least 0% tall; still 8 s) on 1 clip(s):'), 'every rule is replayed, in order');
});
