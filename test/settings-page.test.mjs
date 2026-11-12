// GET /api/devices/:id/settings against a fake camera: the entries come back in the registry's order,
// each one reports on its own, and the camera is never asked for more than a few things at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { ProfileCache } from '../src/capabilities.mjs';
import { WriteService } from '../src/safe-write.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { DEVICE_SETTINGS } from '../src/device-settings.mjs';
import { startFakeCamera, fail } from './support/fake-camera.mjs';

async function app(commands, { delayMs = 15 } = {}) {
  const cam = await startFakeCamera({ delayMs, commands: {
    GetDevInfo: () => ({ DevInfo: { name: 'Door', model: 'M', firmVer: 'f', channelNum: 1 } }),
    GetAbility: () => ({ Ability: { devName: { permit: 6 }, ntp: { permit: 6 }, time: { permit: 6 }, abilityChn: [{}] } }),
    GetDevName: () => ({ DevName: { name: 'Door' } }), GetTime: () => ({}), GetNtp: () => ({}),
    ...commands,
  } });
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-'));
  const config = normalize({ cameras: [{ name: 'Door', host: cam.host }] });
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'viewer', password: 'secret123',
    capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }), writes: new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'ch.jsonl') }) }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ user: 'viewer', password: 'secret123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { cam, base, get: () => fetch(`${base}/api/devices/door/settings`, { headers: { cookie } }),
    close: async () => { server.closeAllConnections(); server.close(); await cam.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('every setting is listed in the registry\'s order; usable ones carry their value, the rest say why not', async () => {
  const a = await app();
  const r = await a.get();
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.device, 'door'); assert.equal(j.account, 'administrator');
  assert.deepEqual(j.settings.map((s) => s.id), DEVICE_SETTINGS.map((s) => s.id));
  const byId = Object.fromEntries(j.settings.map((s) => [s.id, s]));
  assert.deepEqual(byId.deviceName.value, { name: 'Door' });
  assert.equal(byId.deviceName.editable, true);
  assert.equal(byId.deviceName.reason, null);
  assert.equal(byId.osd.editable, false);
  assert.equal(byId.osd.reason, 'not available on this device');
  assert.ok(!('value' in byId.osd));
  assert.equal(j.settings.filter((s) => s.value).length, 4, 'name, time zone, clock and NTP are what this camera offers');
  await a.close();
});

test('a setting that cannot be read reports its own error and leaves the others alone', async () => {
  let ntpReads = 0;
  const a = await app({ GetNtp: () => (++ntpReads === 1 ? {} : fail(-1, 'device busy')) });
  const j = await (await a.get()).json();
  const byId = Object.fromEntries(j.settings.map((s) => [s.id, s]));
  assert.equal(byId.ntp.error, 'device busy');
  assert.ok(!('value' in byId.ntp));
  assert.deepEqual(byId.deviceName.value, { name: 'Door' });
  assert.equal(j.settings.length, DEVICE_SETTINGS.length);
  await a.close();
});

test('the camera is asked for a few things at once, not all at once', async () => {
  const a = await app({}, { delayMs: 20 });
  await (await a.get()).json();
  assert.ok(a.cam.peak() > 1, `reads overlapped (peak ${a.cam.peak()})`);
  assert.ok(a.cam.peak() <= 4, `within the cap (peak ${a.cam.peak()})`);
  assert.ok(a.cam.requests.filter((q) => q.cmd === 'Login').length <= 2, 'a couple of sign-ins for the whole page, never one per read');
  await a.close();
});

test('a second request is served from the cached profile, so the camera is asked far less', async () => {
  const a = await app();
  await (await a.get()).json();
  const first = a.cam.requests.length;
  await (await a.get()).json();
  const second = a.cam.requests.length - first;
  assert.ok(second < first / 2, `first ${first} requests, second ${second}`);
  await a.close();
});
