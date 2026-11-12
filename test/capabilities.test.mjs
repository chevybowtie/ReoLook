import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FEATURES, abilityPermit, classify, buildProfile, getProfile, ProfileCache } from '../src/capabilities.mjs';
import { ReolinkClient } from '../src/client.mjs';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

const P = (n, ver = 1) => ({ permit: n, ver });

test('abilityPermit reads device and channel keys, takes the highest, and is undefined when absent', () => {
  const report = { devName: P(4), ledControl: P(0), abilityChn: [{ osd: P(4), isp: P(2), image: P(4), ptzCtrl: P(0) }] };
  assert.equal(abilityPermit(report, ['dev.devName']), 4);
  assert.equal(abilityPermit(report, ['chn.isp', 'chn.image']), 4, 'highest wins');
  assert.equal(abilityPermit(report, ['chn.ptzCtrl']), 0);
  assert.equal(abilityPermit(report, ['chn.nothing', 'dev.nothing']), undefined);
  assert.equal(abilityPermit(report, ['chn.osd'], 1), undefined, 'channel that does not exist');
  assert.equal(abilityPermit(null, ['dev.devName']), undefined);
  assert.equal(abilityPermit({ weird: 'x' }, ['dev.weird']), undefined);
});

const ok = { ok: true, kind: 'ok' }, no = { ok: false, kind: 'unsupported', detail: 'not support' };
const bad = { ok: false, kind: 'error', detail: 'timeout' }, param = { ok: false, kind: 'param', detail: 'param error' };

test('classify reconciles the report with real reads', () => {
  assert.deepEqual(classify({ permit: 4, probes: [ok] }), { state: 'supported', limited: false });
  assert.deepEqual(classify({ permit: undefined, probes: [ok] }), { state: 'supported', limited: false }, 'a working read is enough');
  assert.deepEqual(classify({ permit: 0, probes: [ok] }), { state: 'supported', limited: false }, 'a read beats a pessimistic report');
  assert.equal(classify({ permit: 4, probes: [no] }).state, 'conflict');
  assert.deepEqual(classify({ permit: 0, probes: [no] }), { state: 'unsupported', limited: true });
  assert.deepEqual(classify({ permit: undefined, probes: [no] }), { state: 'unsupported', limited: false });
  assert.equal(classify({ permit: 4, probes: [no, ok] }).state, 'supported', 'any read that works');
  assert.equal(classify({ permit: 4, probes: [] }).state, 'reported');
  assert.deepEqual(classify({ permit: 0, probes: [] }), { state: 'unsupported', limited: true });
  assert.equal(classify({ permit: undefined, probes: [] }).state, 'unknown');
  assert.equal(classify({ permit: 4, probes: [bad] }).state, 'unknown', 'a network failure proves nothing');
  assert.equal(classify({ permit: undefined, probes: [param] }).state, 'unknown', 'wrong parameter shape proves nothing');
});

/** Fake client answering from tables; counts calls. */
function fakeClient({ model = 'X', firmware = '1', report = null, reads = {}, abilityFails = false } = {}) {
  const calls = [];
  return {
    calls,
    devInfo: async () => ({ model, name: 'Cam', firmVer: firmware, hardVer: 'h', channelNum: 1 }),
    ability: async () => { if (abilityFails) throw new Error('not exist'); return report; },
    probe: async (cmd) => { calls.push(cmd); return reads[cmd] ?? no; },
  };
}

test('buildProfile: supported, conflict, reported, limited and unknown all appear with evidence', async () => {
  const report = { reboot: P(4), abilityChn: [{ osd: P(4), floodLight: P(4), ptzCtrl: P(0), enc: P(4) }] };
  const c = fakeClient({ report, reads: { GetOsd: ok, GetEnc: bad } });
  const p = await buildProfile(c);
  assert.equal(p.features.osd.state, 'supported');
  assert.equal(p.features.floodlight.state, 'conflict');
  assert.equal(p.features.reboot.state, 'reported', 'no read exists for reboot');
  assert.equal(p.features.ptz.state, 'unsupported'); assert.equal(p.features.ptz.limited, true);
  assert.equal(p.features.encoding.state, 'unknown');
  assert.match(p.features.floodlight.evidence.join(), /GetWhiteLed: unsupported \(not support\)/);
  assert.equal(p.source, 'ability+reads');
  assert.equal(p.features.osd.usable, true); assert.equal(p.features.floodlight.usable, false);
  assert.equal(Object.keys(p.features).length, FEATURES.length);
});

test('buildProfile still works when the camera has no ability report (reads only)', async () => {
  const p = await buildProfile(fakeClient({ abilityFails: true, reads: { GetOsd: ok } }));
  assert.equal(p.source, 'reads-only');
  assert.match(p.abilityError, /not exist/);
  assert.equal(p.features.osd.state, 'supported');
  assert.equal(p.features.reboot.state, 'unknown', 'no report and no read: honestly unknown');
});

test('nothing is keyed on the model: a more capable camera simply reports more', async () => {
  const modern = { reboot: P(7), abilityChn: [{ ptzCtrl: P(4), ptzPreset: P(4), ptzPatrol: P(4), floodLight: P(4), alarmAudio: P(4), supportAi: P(1) }] };
  const reads = { GetPtzCheckState: ok, GetPtzPreset: ok, GetPtzPatrol: ok, GetWhiteLed: ok, GetAudioAlarm: ok, GetAiAlarm: ok };
  const a = await buildProfile(fakeClient({ model: 'RLC-410-5MP', report: modern, reads }));
  const b = await buildProfile(fakeClient({ model: 'SOME-FUTURE-MODEL', report: modern, reads }));
  for (const id of ['ptz', 'ptzPreset', 'ptzPatrol', 'floodlight', 'siren', 'ai']) {
    assert.equal(a.features[id].state, 'supported', id);
    assert.equal(a.features[id].state, b.features[id].state, `${id} must not depend on the model`);
  }
  assert.equal(a.features.reboot.state, 'reported');
  const old = await buildProfile(fakeClient({ model: 'RLC-410-5MP', report: { abilityChn: [{}] }, reads: {} }));
  assert.equal(old.features.ptz.usable, false, 'the same model without the ability does not get PTZ');
});

test('cache: keyed by firmware, honours the TTL, persists, and survives an unwritable file', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cap-'));
  const file = path.join(d, 'c', 'capabilities.json');
  const cache = new ProfileCache({ file, ttlMs: 1000 });
  const c = fakeClient({ report: { abilityChn: [{ osd: P(4) }] }, reads: { GetOsd: ok } });
  const t0 = 1_000_000;
  const first = await getProfile(c, '1.1.1.1', { cache, now: () => t0 });
  assert.equal(first.cached, false);
  const probesAfterFirst = c.calls.length;
  const second = await getProfile(c, '1.1.1.1', { cache, now: () => Date.now() });
  assert.equal(second.cached, true);
  assert.equal(c.calls.length, probesAfterFirst, 'cached: no extra probes');
  assert.equal((await getProfile(c, '1.1.1.1', { cache, refresh: true })).cached, false);
  assert.ok(existsSync(file));
  assert.ok(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).length >= 1);
  const reloaded = new ProfileCache({ file, ttlMs: 60_000 });
  assert.equal((await getProfile(c, '1.1.1.1', { cache: reloaded })).cached, true, 'survives a restart');
  const upgraded = fakeClient({ firmware: '2', report: { abilityChn: [{ osd: P(4) }] }, reads: { GetOsd: ok } });
  assert.equal((await getProfile(upgraded, '1.1.1.1', { cache: reloaded })).cached, false, 'new firmware re-probes');
  writeFileSync(path.join(d, 'afile'), 'x');                                   // a file where a folder is needed: ENOTDIR
  const blocked = new ProfileCache({ file: path.join(d, 'afile', 'capabilities.json') });
  await assert.doesNotReject(() => getProfile(c, '2.2.2.2', { cache: blocked }));
  rmSync(d, { recursive: true, force: true });
});

function fakeCameraHttp({ errors = {}, abilityReport } = {}) {
  const srv = http.createServer((req, res) => {
    const cmd = new URL(req.url, 'http://x').searchParams.get('cmd');
    res.setHeader('content-type', 'application/json');
    if (cmd === 'Login') return res.end(JSON.stringify([{ cmd, code: 0, value: { Token: { name: 't' } } }]));
    if (errors[cmd]) return res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode: errors[cmd][0], detail: errors[cmd][1] } }]));
    if (cmd === 'GetDevInfo') return res.end(JSON.stringify([{ cmd, code: 0, value: { DevInfo: { model: 'M', name: 'N', firmVer: 'f1', channelNum: 1 } } }]));
    if (cmd === 'GetAbility') return res.end(JSON.stringify([{ cmd, code: 0, value: { Ability: abilityReport ?? { abilityChn: [{ osd: { permit: 4, ver: 1 } }] } } }]));
    res.end(JSON.stringify([{ cmd, code: 0, value: {} }]));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('client.probe classifies real error replies and connection failures', async () => {
  const srv = await fakeCameraHttp({ errors: { GetWhiteLed: [-9, 'not support'], GetAiAlarm: [-4, 'param error'], GetPtzPreset: [-26, 'ability error'], GetUser: [-1, 'weird'] } });
  const c = new ReolinkClient({ host: `127.0.0.1:${srv.address().port}`, user: 'u', password: 'p', timeoutMs: 2000 });
  assert.equal((await c.probe('GetOsd', { channel: 0 })).kind, 'ok');
  assert.equal((await c.probe('GetWhiteLed')).kind, 'unsupported');
  assert.equal((await c.probe('GetPtzPreset')).kind, 'unsupported');
  assert.equal((await c.probe('GetAiAlarm')).kind, 'param');
  assert.equal((await c.probe('GetUser')).kind, 'error', 'an unrecognised refusal is not claimed as "unsupported"');
  const dead = new ReolinkClient({ host: '127.0.0.1:1', user: 'u', password: 'p', timeoutMs: 1000 });
  assert.equal((await dead.probe('GetOsd')).kind, 'error');
  srv.closeAllConnections(); srv.close();
});

test('GET /api/devices/:id/capabilities: shape, cache flag, refresh, unknown device, unreachable device', async () => {
  const srv = await fakeCameraHttp({ errors: { GetWhiteLed: [-9, 'not support'] } });
  const dir = mkdtempSync(path.join(tmpdir(), 'api-'));
  const config = normalize({ cameras: [{ name: 'Cam', host: `127.0.0.1:${srv.address().port}` }, { name: 'Dead', host: '127.0.0.1:1' }] });
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'u', password: 'p',
    capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return [r.status, await r.json()]; };
  const [s1, p1] = await get('/api/devices/cam/capabilities');
  assert.equal(s1, 200); assert.equal(p1.cached, false);
  assert.equal(p1.model, 'M'); assert.equal(p1.features.osd.state, 'supported');
  assert.ok(!JSON.stringify(p1).includes('"p"'), 'no credentials in the profile');
  assert.equal((await get('/api/devices/cam/capabilities'))[1].cached, true);
  assert.equal((await get('/api/devices/cam/capabilities?refresh=1'))[1].cached, false);
  assert.equal((await get('/api/devices/nope/capabilities'))[0], 404);
  assert.equal((await get('/api/devices/dead/capabilities'))[0], 502);
  server.closeAllConnections(); server.close(); srv.closeAllConnections(); srv.close();
  rmSync(dir, { recursive: true, force: true });
});

test('classify: "unsupported" needs every read to say so; a mix with other failures stays unknown', () => {
  const unsupported = { ok: false, kind: 'unsupported' }, broken = { ok: false, kind: 'error' }, ok = { ok: true, kind: 'ok' };
  assert.equal(classify({ permit: 4, probes: [unsupported, broken] }).state, 'unknown', 'one refusal and one network error proves nothing');
  assert.equal(classify({ permit: 0, probes: [unsupported, broken] }).state, 'unsupported', 'but a report of 0 settles it');
  assert.equal(classify({ permit: 4, probes: [unsupported, unsupported] }).state, 'conflict');
  assert.equal(classify({ permit: 4, probes: [unsupported, ok] }).state, 'supported', 'any working read wins');
});
