// The Homebridge camera settings ReoLook generates (src/homebridge.mjs) and the `homekit` command that prints
// or merges them. The plugin runs its ffmpeg commands by splitting on spaces, with no shell, so what matters
// most here is that nothing in an address needs quoting.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cameraEntry, buildPlatform, mergePlatform, triggerUrls, writeHomebridgeConfig, enc } from '../src/homebridge.mjs';
import { sandbox } from './support/cli-sandbox.mjs';

const LOGIN = { user: 'view er', password: 'p@ss:w/rd#1&(x)!' };
const CAMS = [{ name: 'Front porch - out', host: '10.5.21.241' }, { name: 'Family Room', host: '10.5.21.243', channel: 2 }];
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'hb-')); dirs.push(d); return d; };

test('addresses are percent-encoded, so no space, quote or shell character is left in them', () => {
  assert.equal(enc("a b'c(d)!*&=/:@#"), 'a%20b%27c%28d%29%21%2A%26%3D%2F%3A%40%23');
  const e = cameraEntry(CAMS[0], LOGIN);
  for (const part of [e.videoConfig.source, e.videoConfig.stillImageSource]) {
    assert.ok(!/["']/.test(part), `no quotes: ${part}`);
  }
  // the plugin splits on whitespace: the address must stay one argument
  assert.deepEqual(e.videoConfig.source.split(/\s+/).slice(-2, -1), ['-i']);
  assert.match(e.videoConfig.source.split(/\s+/).pop(), /^rtsp:\/\/view%20er:p%40ss%3Aw%2Frd%231%26%28x%29%21@10\.5\.21\.241:554\/h264Preview_01_sub$/);
  const still = e.videoConfig.stillImageSource.split(/\s+/);
  assert.equal(still.length, 4);   // -i ADDRESS -frames:v 1
  assert.match(still[1], /^http:\/\/10\.5\.21\.241\/cgi-bin\/api\.cgi\?cmd=Snap&channel=0&rs=reolook&user=view%20er&password=p%40ss/);
});

test('the channel picks the stream path and the snapshot channel; a web port is not used for RTSP', () => {
  const e = cameraEntry({ name: 'N', host: '10.0.0.5:8080', channel: 2 }, { user: 'u', password: 'p' });
  assert.match(e.videoConfig.source, /@10\.0\.0\.5:554\/h264Preview_03_sub$/);
  assert.match(e.videoConfig.stillImageSource, /^-i http:\/\/10\.0\.0\.5:8080\/cgi-bin\/api\.cgi\?cmd=Snap&channel=2&/);
});

test('the platform has the trigger port and one entry per camera, named as ReoLook names them', () => {
  const p = buildPlatform(CAMS, LOGIN, { httpPort: 8123 });
  assert.equal(p.platform, 'Camera-ffmpeg');
  assert.equal(p.porthttp, 8123);
  assert.deepEqual(p.cameras.map((c) => c.name), ['Front porch - out', 'Family Room']);
  assert.ok(p.cameras.every((c) => c.motion && c.doorbell));
});

test('trigger addresses encode the camera name and use the given host and port', () => {
  assert.deepEqual(triggerUrls('Front porch - out', { bridgeHost: '10.5.21.5', httpPort: 8080 }), {
    doorbell: 'http://10.5.21.5:8080/doorbell?Front%20porch%20-%20out',
    motion: 'http://10.5.21.5:8080/motion?Front%20porch%20-%20out',
    reset: 'http://10.5.21.5:8080/motion/reset?Front%20porch%20-%20out',
  });
  assert.match(triggerUrls('A').doorbell, /^http:\/\/<this PC>:8080\/doorbell\?A$/);
});

test('merging adds missing cameras, refreshes only the addresses of existing ones, and keeps the rest', () => {
  const wanted = buildPlatform(CAMS, LOGIN);
  const before = {
    bridge: { name: 'Homebridge' },
    platforms: [
      { platform: 'config', port: 8581 },
      { platform: 'Camera-ffmpeg', porthttp: 9999, cameras: [{ name: 'Family Room', motion: false, videoConfig: { source: '-i old', stillImageSource: '-i old', maxFPS: 5 } }] },
    ],
  };
  const frozen = JSON.stringify(before);
  const r = mergePlatform(before, wanted);
  assert.equal(JSON.stringify(before), frozen, 'the input is not changed');
  assert.deepEqual([r.added, r.updated, r.unchanged], [['Front porch - out'], ['Family Room'], []]);
  const p = r.config.platforms.find((x) => x.platform === 'Camera-ffmpeg');
  assert.equal(p.porthttp, 9999, 'an existing port is kept');
  assert.deepEqual(r.config.platforms[0], { platform: 'config', port: 8581 });
  const fam = p.cameras.find((c) => c.name === 'Family Room');
  assert.equal(fam.motion, false); assert.equal(fam.videoConfig.maxFPS, 5);
  assert.match(fam.videoConfig.source, /h264Preview_03_sub$/);   // channel 2 is stream 03
});

test('merging into a config with no camera platform creates one; merging twice changes nothing', () => {
  const wanted = buildPlatform(CAMS, LOGIN);
  const once = mergePlatform({ platforms: [] }, wanted);
  assert.deepEqual(once.added, ['Front porch - out', 'Family Room']);
  assert.equal(once.config.platforms[0].porthttp, 8080);
  const twice = mergePlatform(once.config, wanted);
  assert.deepEqual([twice.added, twice.updated, twice.unchanged], [[], [], ['Front porch - out', 'Family Room']]);
  assert.deepEqual(mergePlatform({}, wanted).config.platforms.length, 1);
});

test('writing keeps a backup of the original once, keeps the file mode, and skips the write when nothing changes', async () => {
  const d = tmp(), file = path.join(d, 'config.json');
  writeFileSync(file, JSON.stringify({ platforms: [{ platform: 'config' }] }), { mode: 0o640 });
  chmodSync(file, 0o640);
  const wanted = buildPlatform(CAMS, LOGIN);
  const r = await writeHomebridgeConfig(file, wanted);
  assert.equal(r.wrote, true); assert.equal(r.backup, `${file}.bak`);
  assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), { platforms: [{ platform: 'config' }] });
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).platforms[1].cameras.length, 2);
  const again = await writeHomebridgeConfig(file, wanted);
  assert.equal(again.wrote, false);
  assert.ok(!existsSync(`${file}.tmp-${process.pid}`));
  const edited = JSON.parse(readFileSync(file, 'utf8')); edited.platforms[1].cameras[0].videoConfig.source = '-i other';
  writeFileSync(file, JSON.stringify(edited));
  const third = await writeHomebridgeConfig(file, wanted);
  assert.equal(third.backup, null, 'the first backup is not overwritten');
  assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), { platforms: [{ platform: 'config' }] });
});

test('writing refuses a missing file and a file that is not JSON, and leaves both alone', async () => {
  const d = tmp();
  await assert.rejects(writeHomebridgeConfig(path.join(d, 'none.json'), buildPlatform(CAMS, LOGIN)), /does not exist/);
  const bad = path.join(d, 'bad.json'); writeFileSync(bad, '{ not json');
  await assert.rejects(writeHomebridgeConfig(bad, buildPlatform(CAMS, LOGIN)), /not valid JSON/);
  assert.equal(readFileSync(bad, 'utf8'), '{ not json');
});

test('a folder this user cannot write to gives advice instead of a stack trace', { skip: process.getuid?.() === 0 }, async () => {
  const d = tmp(), sub = path.join(d, 'ro'); mkdirSync(sub);
  const file = path.join(sub, 'config.json'); writeFileSync(file, '{"platforms":[]}');
  chmodSync(sub, 0o555);
  try {
    await assert.rejects(writeHomebridgeConfig(file, buildPlatform(CAMS, LOGIN)), /cannot write .*EACCES[\s\S]*Homebridge UI[\s\S]*chown/);
    assert.equal(readFileSync(file, 'utf8'), '{"platforms":[]}');
  } finally { chmodSync(sub, 0o755); }
});

// ---- the command ----

/** A sandbox with a ReoLook config holding two cameras. @returns {{sb: object, config: string}} */
function rig({ cameras = [{ name: 'Front porch - out', host: '10.5.21.241' }, { name: 'Family Room', host: '10.5.21.243' }], signedIn = true } = {}) {
  const sb = sandbox({ signedIn, user: 'viewer', password: 'secret 123' });
  dirs.push(sb.home);
  const config = path.join(sb.home, 'config.json');
  writeFileSync(config, JSON.stringify({ cameras }));
  return { sb, config };
}

test('homekit prints the platform as JSON alone on stdout, with the notes on stderr', () => {
  const { sb, config } = rig();
  const r = sb.cli(['homekit', '--config', config, '--bridge-host', '10.5.21.5']);
  assert.equal(r.code, 0, r.err);
  const p = JSON.parse(r.out);   // stdout is only the JSON
  assert.deepEqual(p.cameras.map((c) => c.name), ['Front porch - out', 'Family Room']);
  assert.match(p.cameras[0].videoConfig.source, /rtsp:\/\/viewer:secret%20123@10\.5\.21\.241:554\//);
  assert.match(r.err, /plain text/);
  assert.match(r.err, /http:\/\/10\.5\.21\.5:8080\/doorbell\?Front%20porch%20-%20out/);
  assert.match(r.err, /http:\/\/10\.5\.21\.5:8080\/motion\/reset\?Family%20Room/);
  assert.ok(!/<this PC>/.test(r.err));
});

test('homekit without --bridge-host says to fill in the address', () => {
  const { sb, config } = rig();
  const r = sb.cli(['homekit', '--config', config, '--http-port', '8123']);
  assert.match(r.err, /<this PC>:8123\/doorbell/);
  assert.match(r.err, /replace <this PC>/);
  assert.equal(JSON.parse(r.out).porthttp, 8123);
});

test('homekit --write merges into the file, says what it did, and a second run changes nothing', () => {
  const { sb, config } = rig();
  const hb = path.join(sb.home, 'hb.json');
  writeFileSync(hb, JSON.stringify({ platforms: [{ platform: 'config' }] }));
  const r = sb.cli(['homekit', '--config', config, '--write', hb]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /updated .*hb\.json/);
  assert.match(r.out, /added: Front porch - out, Family Room/);
  assert.match(r.out, /kept as .*hb\.json\.bak/);
  assert.match(r.out, /restart Homebridge/);
  assert.match(r.out, /doorbell\?Family%20Room/, 'the rule addresses are shown after writing too');
  assert.equal(JSON.parse(readFileSync(hb, 'utf8')).platforms[1].cameras.length, 2);
  assert.ok(!r.out.includes('secret'), 'the password is not echoed to the terminal');
  const again = sb.cli(['homekit', '--config', config, '--write', hb]);
  assert.match(again.out, /already up to date/);
  assert.match(again.out, /unchanged: Front porch - out, Family Room/);
});

test('homekit reports a missing sign-in, no cameras, a bad port and a missing file with exit code 2', () => {
  const noLogin = rig({ signedIn: false });
  assert.match(noLogin.sb.cli(['homekit', '--config', noLogin.config]).err, /reolook init/);
  const none = rig({ cameras: [] });
  const r = none.sb.cli(['homekit', '--config', none.config]);
  assert.equal(r.code, 2); assert.match(r.err, /no cameras/);
  const { sb, config } = rig();
  assert.match(sb.cli(['homekit', '--config', config, '--http-port', 'x']).err, /port number/);
  const w = sb.cli(['homekit', '--config', config, '--write', path.join(sb.home, 'nope.json')]);
  assert.equal(w.code, 2); assert.match(w.err, /does not exist/);
});
