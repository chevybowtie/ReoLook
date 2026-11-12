import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError, settingById } from '../src/device-settings.mjs';
import { ptzRequest } from '../src/controls.mjs';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { ProfileCache } from '../src/capabilities.mjs';
import { WriteService } from '../src/safe-write.mjs';
import { ChangeLog } from '../src/change-log.mjs';

test('PTZ requests are whitelisted and bounded before anything is sent', () => {
  assert.deepEqual(ptzRequest({ op: 'Left' }), { op: 'Left', speed: 32 });
  assert.deepEqual(ptzRequest({ op: 'ZoomInc', speed: 5 }), { op: 'ZoomInc', speed: 5 });
  assert.deepEqual(ptzRequest({ op: 'Stop' }), { op: 'Stop' });
  assert.deepEqual(ptzRequest({ op: 'ToPos', id: 3 }), { op: 'ToPos', id: 3, speed: 32 });
  for (const bad of [{ op: 'Reboot' }, { op: 'Left', speed: 0 }, { op: 'Left', speed: 65 }, { op: 'Left', speed: '9' }, { op: 'ToPos' }, { op: 'ToPos', id: -1 }, {}, null]) {
    assert.throws(() => ptzRequest(bad), WriteError, JSON.stringify(bad));
  }
});

/** A camera that has PTZ, presets, a siren and a floodlight, recording the exact commands it receives. */
function camera({ has = ['ptz', 'ptzPreset', 'siren', 'floodlight', 'reboot'] } = {}) {
  const st = { calls: [], presets: [{ id: 1, name: 'door', enable: 1 }, { id: 2, name: '', enable: 0 }], led: { channel: 0, state: 0, mode: 1, bright: 60 } };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), cmd = u.searchParams.get('cmd');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const ok = (value) => res.end(JSON.stringify([{ cmd, code: 0, value }]));
      const err = (rspCode, detail) => res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode, detail } }]));
      const parsed = body ? JSON.parse(body)[0] : {};
      if (cmd === 'Login') { const { userName, password } = parsed.param.User; return { adm: 'good', viewer: 'v' }[userName] === password ? ok({ Token: { name: `tok-${userName}` } }) : err(-7, 'bad'); }
      if (cmd === 'GetDevInfo') return ok({ DevInfo: { model: 'PTZ-1', name: 'Cam', firmVer: 'f', channelNum: 1 } });
      if (cmd === 'GetAbility') {
        const chn = {};
        if (has.includes('ptz')) chn.ptzCtrl = { permit: 7, ver: 1 };
        if (has.includes('ptzPreset')) chn.ptzPreset = { permit: 7, ver: 1 };
        if (has.includes('floodlight')) chn.floodLight = { permit: 7, ver: 1 };
        return ok({ Ability: { abilityChn: [chn], ...(has.includes('siren') ? { alarmAudio: { permit: 7, ver: 1 } } : {}), ...(has.includes('reboot') ? { reboot: { permit: 1, ver: 1 } } : {}) } });
      }
      if (cmd === 'GetPtzCheckState') return has.includes('ptz') ? ok({ PtzCheckState: { state: 2 } }) : err(-9, 'not support');
      if (cmd === 'GetPtzPreset') return has.includes('ptzPreset') ? ok({ PtzPreset: { channel: 0, table: st.presets } }) : err(-9, 'not support');
      if (cmd === 'GetWhiteLed') return has.includes('floodlight') ? ok({ WhiteLed: { ...st.led } }) : err(-9, 'not support');
      if (cmd === 'SetWhiteLed') { st.calls.push([cmd, parsed.param]); Object.assign(st.led, parsed.param.WhiteLed); return ok({ rspCode: 200 }); }
      if (cmd === 'PtzCtrl' || cmd === 'SetPtzPreset' || cmd === 'AudioAlarmPlay' || cmd === 'Reboot') { st.calls.push([cmd, parsed.param]); return ok({ rspCode: 200 }); }
      if (cmd === 'GetAudioAlarm') return has.includes('siren') ? ok({ Audio: { enable: 1 } }) : err(-9, 'not support');
      return err(-9, 'not support');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { st }))));
}

async function app(cam) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ctl-'));
  const config = normalize({ cameras: [{ name: 'Cam', host: `127.0.0.1:${cam.address().port}` }] });
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'viewer', password: 'v',
    capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }),
    writes: new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }) }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body, origin = base) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); return { status: r.status, json: (() => { try { return JSON.parse(t); } catch { return null; } })() };
  };
  return { call, close: () => { server.closeAllConnections(); server.close(); cam.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('controls need an administrator session and a same-origin request, and say what the device has', async () => {
  const cam = await camera(); const a = await app(cam);
  assert.equal((await a.call('POST', '/api/devices/cam/ptz', { op: 'Left' })).status, 401);
  await a.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  assert.equal((await a.call('POST', '/api/devices/cam/ptz', { op: 'Left' }, 'http://evil.example')).status, 403);
  const c = await a.call('GET', '/api/devices/cam/controls');
  assert.equal(c.status, 200);
  assert.equal(c.json.ptz, true); assert.equal(c.json.siren, true);
  assert.deepEqual(c.json.presets, [{ id: 1, name: 'door' }], 'only saved presets');
  assert.deepEqual(c.json.floodlight, { on: false, brightness: 60 });
  assert.deepEqual(cam.st.calls, []);
  a.close();
});

test('PTZ: the documented PtzCtrl shape, an automatic stop, and presets', async () => {
  const cam = await camera(); const a = await app(cam);
  await a.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  assert.equal((await a.call('POST', '/api/devices/cam/ptz', { op: 'Left', speed: 10, duration: 200 })).status, 200);
  assert.deepEqual(cam.st.calls[0], ['PtzCtrl', { channel: 0, op: 'Left', speed: 10 }]);
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(cam.st.calls[1], ['PtzCtrl', { channel: 0, op: 'Stop' }], 'the device is told to stop by itself');
  assert.equal((await a.call('POST', '/api/devices/cam/ptz', { op: 'ToPos', id: 1 })).status, 200);
  assert.deepEqual(cam.st.calls[2], ['PtzCtrl', { channel: 0, op: 'ToPos', id: 1, speed: 32 }]);
  assert.equal((await a.call('POST', '/api/devices/cam/ptz', { op: 'Format' })).status, 400);
  const saved = await a.call('POST', '/api/devices/cam/ptz/preset', { id: 3, name: 'gate' });
  assert.equal(saved.status, 200);
  assert.deepEqual(cam.st.calls.at(-1), ['SetPtzPreset', { PtzPreset: { channel: 0, enable: 1, id: 3, name: 'gate' } }]);
  a.close();
});

test('siren needs an explicit confirmation to start; stop never does', async () => {
  const cam = await camera(); const a = await app(cam);
  await a.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  assert.equal((await a.call('POST', '/api/devices/cam/siren', { action: 'start' })).status, 400);
  assert.deepEqual(cam.st.calls, []);
  assert.equal((await a.call('POST', '/api/devices/cam/siren', { action: 'start', confirm: true })).status, 200);
  assert.deepEqual(cam.st.calls[0], ['AudioAlarmPlay', { alarm_mode: 'manul', manual_switch: 1, times: 1, channel: 0 }]);
  assert.equal((await a.call('POST', '/api/devices/cam/siren', { action: 'stop' })).status, 200);
  assert.deepEqual(cam.st.calls[1], ['AudioAlarmPlay', { alarm_mode: 'manul', manual_switch: 0, times: 1, channel: 0 }]);
  a.close();
});

test('reboot needs an administrator, a same-origin request and an explicit confirmation', async () => {
  const cam = await camera(); const a = await app(cam);
  assert.equal((await a.call('POST', '/api/devices/cam/reboot', { confirm: true })).status, 401);
  await a.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  assert.equal((await a.call('POST', '/api/devices/cam/reboot', { confirm: true }, 'http://evil.example')).status, 403);
  assert.equal((await a.call('POST', '/api/devices/cam/reboot', {})).status, 400);
  assert.equal((await a.call('POST', '/api/devices/cam/reboot', { confirm: 'yes' })).status, 400);
  assert.deepEqual(cam.st.calls, [], 'nothing reached the camera yet');
  assert.equal((await a.call('POST', '/api/devices/cam/reboot', { confirm: true })).status, 200);
  assert.deepEqual(cam.st.calls, [['Reboot', {}]]);
  a.close();
});

test('reboot is refused on a camera that does not offer it', async () => {
  const cam = await camera({ has: ['ptz'] }); const a = await app(cam);
  await a.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  const r = await a.call('POST', '/api/devices/cam/reboot', { confirm: true });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.deepEqual(cam.st.calls, []);
  a.close();
});

test('floodlight goes through the verified setting path and sends only what changed', async () => {
  const cam = await camera(); const a = await app(cam);
  await a.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  const r = await a.call('POST', '/api/devices/cam/floodlight', { on: true });
  assert.equal(r.status, 200); assert.equal(r.json.verified, true);
  assert.deepEqual(cam.st.calls[0], ['SetWhiteLed', { WhiteLed: { channel: 0, state: 1 } }]);
  assert.equal((await a.call('POST', '/api/devices/cam/floodlight', { on: true })).json.unchanged, true);
  assert.equal((await a.call('POST', '/api/devices/cam/floodlight', { brightness: 500 })).status, 400);
  a.close();
});

test('a camera without those features is not sent anything', async () => {
  const cam = await camera({ has: [] }); const a = await app(cam);
  await a.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  for (const [p, b] of [['ptz', { op: 'Left' }], ['siren', { action: 'start', confirm: true }], ['floodlight', { on: true }]]) {
    assert.equal((await a.call('POST', `/api/devices/cam/${p}`, b)).status, 409, p);
  }
  assert.deepEqual(cam.st.calls, []);
  const c = await a.call('GET', '/api/devices/cam/controls');
  assert.deepEqual([c.json.ptz, c.json.siren, c.json.presets, c.json.floodlight], [false, false, null, null]);
  a.close();
});

test('AI sensitivity reads the classes the device has and writes the object as read', async () => {
  const objs = { people: { channel: 0, ai_type: 'people', sensitivity: 50, stay_time: 0 }, vehicle: { channel: 0, ai_type: 'vehicle', sensitivity: 40, stay_time: 0 } };
  const sent = [];
  const client = { command: async (cmd, p) => {
    if (cmd === 'GetAiAlarm') { if (!objs[p.ai_type]) throw new Error('not support'); return { AiAlarm: structuredClone(objs[p.ai_type]) }; }
    if (cmd === 'SetAiAlarm') { sent.push(structuredClone(p)); objs[p.AiAlarm.ai_type] = p.AiAlarm; return {}; }
    throw new Error(cmd);
  } };
  const s = settingById('aiSensitivity');
  assert.deepEqual(await s.read(client, 0), { people: 50, vehicle: 40 });
  await s.write(client, 0, { people: 70, vehicle: 40 });
  assert.deepEqual(sent, [{ AiAlarm: { channel: 0, ai_type: 'people', sensitivity: 70, stay_time: 0 } }]);
  assert.throws(() => s.target({ animal: 10 }, { people: 50 }), /does not report animal/);
});
