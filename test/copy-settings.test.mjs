import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { ProfileCache } from '../src/capabilities.mjs';
import { WriteService } from '../src/safe-write.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { copyIntent, settingById } from '../src/device-settings.mjs';

/** A camera with a name, an IR mode and an on-screen display, and an ability report that allows writing them. */
function camera({ name, ir = 'Auto', irRange = ['Auto', 'Off'], osdName = 'x', namePos = 'Upper Left', noIr = false } = {}) {
  const st = { name, ir, osd: { enable: 1, name: osdName, pos: namePos }, writes: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), cmd = u.searchParams.get('cmd'), token = u.searchParams.get('token') ?? '';
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const ok = (value, extra = {}) => res.end(JSON.stringify([{ cmd, code: 0, value, ...extra }]));
      const err = (rspCode, detail) => res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode, detail } }]));
      const who = token.replace(/^tok-/, '');
      const parsed = body ? JSON.parse(body)[0] : {};
      if (cmd === 'Login') { const { userName, password } = parsed.param.User; return { adm: 'good', viewer: 'v' }[userName] === password ? ok({ Token: { name: `tok-${userName}` } }) : err(-7, 'login failed'); }
      if (cmd === 'GetDevInfo') return ok({ DevInfo: { model: 'M', name: st.name, firmVer: 'f1', channelNum: 1 } });
      if (cmd === 'GetAbility') {
        const p = who === 'adm' ? 7 : 4;
        return ok({ Ability: { abilityChn: [{ ...(noIr ? {} : { ledControl: { permit: p, ver: 1 } }), osd: { permit: p, ver: 1 } }] } });
      }
      if (cmd === 'GetIrLights') return noIr ? err(-9, 'not support') : ok({ IrLights: { channel: 0, state: st.ir } }, parsed.action === 1 ? { range: { IrLights: { state: irRange } } } : {});
      if (cmd === 'SetIrLights') { st.writes.push(['SetIrLights', parsed.param.IrLights.state]); st.ir = parsed.param.IrLights.state; return ok({ rspCode: 200 }); }
      if (cmd === 'GetOsd') return ok({ Osd: { channel: 0, osdChannel: { enable: st.osd.enable, name: st.osd.name, pos: st.osd.pos }, osdTime: { enable: 1, pos: 'Lower Right' }, watermark: 0 } });
      if (cmd === 'SetOsd') { const o = parsed.param.Osd; st.writes.push(['SetOsd', o.osdChannel.name]); st.osd = { enable: o.osdChannel.enable, name: o.osdChannel.name, pos: o.osdChannel.pos }; return ok({ rspCode: 200 }); }
      return ok({});
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { st }))));
}

async function app(cams) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cp-'));
  const config = normalize({ cameras: cams.map((c, i) => ({ name: `Cam${i}`, host: `127.0.0.1:${c.address().port}` })) });
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'viewer', password: 'v',
    capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }),
    writes: new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'changes.jsonl') }) }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body, origin = base) => {
    const headers = { 'content-type': 'application/json', origin };
    if (cookie) headers.cookie = cookie;
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
  };
  return { call, close: () => { server.closeAllConnections(); server.close(); for (const c of cams) c.closeAllConnections(); rmSync(dir, { recursive: true, force: true }); } };
}
const signIn = (call) => call('POST', '/api/admin/login', { user: 'adm', password: 'good' });

test('which settings can be copied, and how a value becomes an input', () => {
  assert.equal(settingById('deviceName').copy, null);
  assert.equal(settingById('clock').copy, null);
  assert.equal(settingById('motionZones').copy, null);
  assert.deepEqual(copyIntent(settingById('osd'), { showName: true, name: 'Porch', namePosition: 'Upper Left' }), { showName: true, namePosition: 'Upper Left' });
  assert.deepEqual(copyIntent(settingById('emailAlerts'), { enabled: false, interval: '5 Minutes', configured: true }), { enabled: false, interval: '5 Minutes' });
  const mode = { dayNight: 'Auto', antiFlicker: 'Off', backLight: 'Off', blc: 100, drc: 90, nr3d: true };
  assert.deepEqual(copyIntent(settingById('imageMode'), mode), { dayNight: 'Auto', antiFlicker: 'Off', backLight: 'Off', nr3d: true });
  assert.deepEqual(copyIntent(settingById('imageMode'), { ...mode, backLight: 'BackLightControl' }).blc, 100);
});

test('copy needs the administrator session and a same-origin request', async () => {
  const a = await camera({ name: 'A' }); const b = await camera({ name: 'B' }); const app1 = await app([a, b]);
  assert.equal((await app1.call('POST', '/api/copy/plan', { source: 'cam0', settings: ['irLights'], targets: ['cam1'] })).status, 401);
  await signIn(app1.call);
  assert.equal((await app1.call('POST', '/api/copy/plan', { source: 'cam0', settings: ['irLights'], targets: ['cam1'] }, 'http://evil.example')).status, 403);
  assert.equal((await app1.call('POST', '/api/copy/plan', { source: 'cam0', settings: ['deviceName'], targets: ['cam1'] })).status, 400, 'a device name is not copyable');
  assert.equal((await app1.call('POST', '/api/copy/plan', { source: 'cam0', settings: ['irLights'], targets: ['cam0'] })).status, 400, 'the source is not a target');
  app1.close(); a.close(); b.close();
});

test('copy plans per target, writes nothing, then each plan applies and verifies', async () => {
  const src = await camera({ name: 'Src', ir: 'Off', osdName: 'Source', namePos: 'Top Center' });
  const t1 = await camera({ name: 'T1', ir: 'Auto', osdName: 'Target one', namePos: 'Upper Left' });
  const t2 = await camera({ name: 'T2', ir: 'Off', osdName: 'Target two', namePos: 'Top Center' });
  const x = await app([src, t1, t2]);
  await signIn(x.call);
  const r = await x.call('POST', '/api/copy/plan', { source: 'cam0', settings: ['irLights', 'osd'], targets: ['cam1', 'cam2'] });
  assert.equal(r.status, 200, r.text);
  const by = (t, s) => r.json.items.find((i) => i.targetId === t && i.settingId === s);
  assert.equal(by('cam1', 'irLights').status, 'plan');
  assert.deepEqual(by('cam1', 'irLights').diff.map((d) => [d.path, d.from, d.to]), [['state', 'Auto', 'Off']]);
  assert.equal(by('cam2', 'irLights').status, 'same');
  assert.deepEqual(by('cam1', 'osd').diff.map((d) => d.path), ['namePosition'], 'the on-screen name stays the target\'s own');
  assert.equal(by('cam2', 'osd').status, 'same');
  assert.deepEqual([t1.st.writes, t2.st.writes], [[], []], 'planning wrote nothing');

  const applied = await x.call('POST', `/api/changes/${by('cam1', 'irLights').planId}/apply`);
  assert.equal(applied.status, 200); assert.equal(applied.json.verified, true);
  assert.equal(t1.st.ir, 'Off');
  assert.equal(t1.st.osd.name, 'Target one');
  x.close(); src.close(); t1.close(); t2.close();
});

test('a target that lacks the feature or whose list differs is reported, not forced', async () => {
  const src = await camera({ name: 'Src', ir: 'On', irRange: ['Auto', 'On', 'Off'] });
  const odd = await camera({ name: 'NoIr', noIr: true });
  const strict = await camera({ name: 'Strict', ir: 'Auto', irRange: ['Auto', 'Off'] });
  const x = await app([src, odd, strict]);
  await signIn(x.call);
  const r = await x.call('POST', '/api/copy/plan', { source: 'cam0', settings: ['irLights'], targets: ['cam1', 'cam2'] });
  assert.equal(r.status, 200, r.text);
  const noIr = r.json.items.find((i) => i.targetId === 'cam1'), st = r.json.items.find((i) => i.targetId === 'cam2');
  assert.equal(noIr.status, 'unavailable');
  assert.equal(st.status, 'error');
  assert.match(st.error, /offers only: Auto, Off/);
  assert.deepEqual([odd.st.writes, strict.st.writes], [[], []]);
  x.close(); src.close(); odd.close(); strict.close();
});
