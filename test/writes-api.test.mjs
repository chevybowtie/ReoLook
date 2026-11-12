import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { ProfileCache } from '../src/capabilities.mjs';
import { WriteService } from '../src/safe-write.mjs';
import { ChangeLog } from '../src/change-log.mjs';

/** A camera with state: GetDevName / SetDevName work for real. */
function camera({ adminPermit = 6, refuse = null, name = 'Front Porch' } = {}) {
  const state = { name, writes: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), cmd = u.searchParams.get('cmd'), token = u.searchParams.get('token') ?? '';
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const ok = (value) => res.end(JSON.stringify([{ cmd, code: 0, value }]));
      const err = (rspCode, detail) => res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode, detail } }]));
      const who = token.replace(/^tok-/, '');
      if (cmd === 'Login') {
        const { userName, password } = JSON.parse(body)[0].param.User;
        return { adm: 'good', viewer: 'v' }[userName] === password ? ok({ Token: { name: `tok-${userName}` } }) : err(-7, 'login failed');
      }
      if (cmd === 'GetDevInfo') return ok({ DevInfo: { model: 'M', name: state.name, firmVer: 'f1', channelNum: 1 } });
      if (cmd === 'GetAbility') return ok({ Ability: { devName: { permit: who === 'adm' ? adminPermit : 4, ver: 1 }, abilityChn: [{}] } });
      if (cmd === 'GetDevName') return ok({ DevName: { name: state.name } });
      if (cmd === 'SetDevName') {
        if (refuse) return err(-13, refuse);
        const next = JSON.parse(body)[0].param.DevName.name;
        state.writes.push({ by: who, name: next });
        state.name = next;
        return ok({ rspCode: 200 });
      }
      return ok({});
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { state }))));
}

async function app(cams) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wr-'));
  const config = normalize({ cameras: cams.map((c, i) => ({ name: `Cam${i}`, host: `127.0.0.1:${c.address().port}` })) });
  const logFile = path.join(dir, 'changes.jsonl');
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'viewer', password: 'v',
    capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }),
    writes: new WriteService({ changeLog: new ChangeLog({ file: logFile }) }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, p, body, { origin = base } = {}) => {
      const headers = { 'content-type': 'application/json' };
      if (origin) headers.origin = origin;
      if (cookie) headers.cookie = cookie;
      const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await r.text();
      return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
    };
  };
  return { client, dir, logFile, close: () => { server.closeAllConnections(); server.close(); for (const c of cams) c.closeAllConnections(); rmSync(dir, { recursive: true, force: true }); } };
}
const signIn = (call) => call('POST', '/api/admin/login', { user: 'adm', password: 'good' });

test('everything about changing a device needs an administrator session', async () => {
  const cam = await camera(); const a = await app([cam]); const call = a.client();
  for (const [m, p, b] of [['GET', '/api/devices/cam0/settings'], ['POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: 'X' } }],
    ['POST', '/api/changes/abc/apply'], ['POST', '/api/changes/abc/undo'], ['GET', '/api/changes']]) {
    assert.equal((await call(m, p, b)).status, 401, `${m} ${p}`);
  }
  assert.deepEqual(cam.state.writes, []);
  a.close(); cam.close();
});

test('full round trip: list, plan, apply (verified), history, undo (restored)', async () => {
  const cam = await camera(); const a = await app([cam]); const call = a.client();
  await signIn(call);
  const list = await call('GET', '/api/devices/cam0/settings');
  assert.equal(list.status, 200);
  const dn = list.json.settings.find((s) => s.id === 'deviceName');
  assert.equal(dn.editable, true); assert.deepEqual(dn.value, { name: 'Front Porch' }); assert.equal(dn.risk, 'low');

  const same = await call('POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: 'Front Porch' } });
  assert.equal(same.json.noop, true);
  const plan = await call('POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: 'Front Porch (north)' } });
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.json.diff, [{ path: 'name', from: 'Front Porch', to: 'Front Porch (north)', secret: false }]);
  assert.deepEqual(cam.state.writes, [], 'planning wrote nothing');

  const applied = await call('POST', `/api/changes/${plan.json.planId}/apply`);
  assert.equal(applied.status, 200);
  assert.equal(applied.json.verified, true); assert.equal(applied.json.by, 'adm');
  assert.equal(cam.state.name, 'Front Porch (north)');
  assert.deepEqual(cam.state.writes, [{ by: 'adm', name: 'Front Porch (north)' }], 'written with the administrator account');
  assert.ok(!applied.text.includes('rawBefore'));

  const hist = await call('GET', '/api/changes?device=cam0');
  assert.equal(hist.json.changes.length, 1); assert.equal(hist.json.changes[0].label, 'Device name');
  assert.ok(!hist.text.includes('rawBefore') && !hist.text.includes('rawAfter'));

  const undone = await call('POST', `/api/changes/${applied.json.id}/undo`);
  assert.equal(undone.status, 200); assert.equal(undone.json.verified, true);
  assert.equal(cam.state.name, 'Front Porch');
  assert.equal((await call('POST', `/api/changes/${applied.json.id}/undo`)).status, 409, 'cannot undo twice');
  a.close(); cam.close();
});

test('a plan is single-use and bound to the session that made it', async () => {
  const cam = await camera(); const a = await app([cam]);
  const one = a.client(), two = a.client();
  await signIn(one); await signIn(two);
  const plan = await one('POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: 'Mine' } });
  assert.equal((await two('POST', `/api/changes/${plan.json.planId}/apply`)).status, 403, 'another session cannot apply it');
  assert.deepEqual(cam.state.writes, []);
  assert.equal((await one('POST', `/api/changes/${plan.json.planId}/apply`)).status, 200);
  assert.equal((await one('POST', `/api/changes/${plan.json.planId}/apply`)).status, 404);
  assert.equal(cam.state.writes.length, 1);
  a.close(); cam.close();
});

test('cross-origin requests are refused for plan, apply and undo', async () => {
  const cam = await camera(); const a = await app([cam]); const call = a.client();
  await signIn(call);
  const evil = { origin: 'http://evil.example' };
  assert.equal((await call('POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: 'X' } }, evil)).status, 403);
  assert.equal((await call('POST', '/api/changes/abc/apply', undefined, evil)).status, 403);
  assert.equal((await call('POST', '/api/changes/abc/undo', undefined, evil)).status, 403);
  a.close(); cam.close();
});

test('an account without the write bit is told so, and nothing is written', async () => {
  const cam = await camera({ adminPermit: 4 }); const a = await app([cam]); const call = a.client();
  await signIn(call);
  const dn = (await call('GET', '/api/devices/cam0/settings')).json.settings.find((s) => s.id === 'deviceName');
  assert.equal(dn.editable, false); assert.match(dn.reason, /may not change/);
  const plan = await call('POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: 'X' } });
  assert.equal(plan.status, 403);
  assert.deepEqual(cam.state.writes, []);
  a.close(); cam.close();
});

test('bad input, unknown settings, a refusing device, and a device that changed after the plan', async () => {
  const cam = await camera(); const a = await app([cam]); const call = a.client();
  await signIn(call);
  const bad = await call('POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: '' } });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /cannot be empty/);
  assert.equal((await call('POST', '/api/devices/cam0/settings/nothing/plan', { value: {} })).status, 404);
  assert.equal((await call('POST', '/api/devices/nope/settings/deviceName/plan', { value: { name: 'x' } })).status, 404);

  const plan = await call('POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: 'Mine' } });
  cam.state.name = 'Changed elsewhere';
  const stale = await call('POST', `/api/changes/${plan.json.planId}/apply`);
  assert.equal(stale.status, 409); assert.equal(stale.json.current.name, 'Changed elsewhere');
  assert.deepEqual(cam.state.writes, []);
  a.close(); cam.close();

  const refusing = await camera({ refuse: 'permission denied' }); const b = await app([refusing]); const call2 = b.client();
  await signIn(call2);
  const p = await call2('POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: 'X' } });
  const failed = await call2('POST', `/api/changes/${p.json.planId}/apply`);
  assert.equal(failed.status, 502); assert.match(failed.json.error, /permission denied/); assert.ok(failed.json.changeId);
  const h = await call2('GET', '/api/changes');
  assert.equal(h.json.changes[0].state, 'failed');
  b.close(); refusing.close();
});

test('the administrator password appears in no response and not in the change log file', async () => {
  const cam = await camera(); const a = await app([cam]); const call = a.client();
  const login = await signIn(call);
  const plan = await call('POST', '/api/devices/cam0/settings/deviceName/plan', { value: { name: 'Logged' } });
  const applied = await call('POST', `/api/changes/${plan.json.planId}/apply`);
  const everything = [login.text, plan.text, applied.text, (await call('GET', '/api/changes')).text, (await call('GET', '/api/devices/cam0/settings')).text, readFileSync(a.logFile, 'utf8')].join('\n');
  assert.ok(!everything.includes('good'), 'no password anywhere');
  a.close(); cam.close();
});
