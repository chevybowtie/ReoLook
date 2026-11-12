import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError, settingById } from '../src/device-settings.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { WriteService } from '../src/safe-write.mjs';
import { ReolinkClient } from '../src/client.mjs';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { ProfileCache } from '../src/capabilities.mjs';

/** In-memory camera: GetIrLights (with a range when asked), SetIrLights. */
function device({ state = 'Auto', range = ['Auto', 'Off'], ignore = false, refuse = null } = {}) {
  const d = { state, sent: [], describeCalls: 0 };
  d.client = {
    command: async (cmd, param) => {
      if (cmd === 'GetIrLights') return { IrLights: { state: d.state } };
      if (cmd === 'SetIrLights') {
        if (refuse) throw Object.assign(new Error('refused'), { detail: refuse, code: -13 });
        d.sent.push(structuredClone(param));
        if (!ignore) d.state = param.IrLights.state;
        return { rspCode: 200 };
      }
      throw new Error(`unexpected ${cmd}`);
    },
    describe: async (cmd) => { d.describeCalls++; return { value: { IrLights: { state: d.state } }, range: { IrLights: { state: range } }, initial: { IrLights: { state: 'Auto' } } }; },
  };
  return d;
}
function setup(opts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ir-'));
  const dev = device(opts);
  const svc = new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }) });
  const plan = (input) => svc.plan({ client: dev.client, deviceId: 'cam', settingId: 'irLights', input, owner: 's' });
  const apply = (id) => svc.apply({ client: dev.client, planId: id, owner: 's', by: 'adm' });
  return { dev, svc, plan, apply, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const bad = (fn, re) => assert.throws(fn, (e) => e instanceof WriteError && re.test(e.message));

test('IR lights: read and write use the real shapes, and the descriptor asks for the execute bit', async () => {
  const s = settingById('irLights');
  assert.equal(s.needs, 'execute');
  const c = setup();
  assert.deepEqual(await s.read(c.dev.client), { state: 'Auto' });
  await s.write(c.dev.client, 0, { state: 'Off' });
  assert.deepEqual(c.dev.sent, [{ IrLights: { channel: 0, state: 'Off' } }]);
  c.done();
});

test('the allowed states come from the device, so a state it does not list is refused at planning', async () => {
  const c = setup({ range: ['Auto', 'Off'] });
  await assert.rejects(c.plan({ state: 'On' }), (e) => e instanceof WriteError && /offers only: Auto, Off/.test(e.message));
  assert.deepEqual(c.dev.sent, []);
  // a device that does offer "On" (a different model) is simply accepted: nothing is hard-coded
  const other = setup({ range: ['Auto', 'On', 'Off'] });
  const p = await other.plan({ state: 'On' });
  assert.equal(p.noop, false);
  c.done(); other.done();
});

test('validation: empty, control characters and overlong values are rejected', () => {
  const v = settingById('irLights').validate;
  assert.deepEqual(v({ state: ' Off ' }), { state: 'Off' });
  bad(() => v({}), /choose a night-vision mode/);
  bad(() => v({ state: '' }), /choose a night-vision mode/);
  bad(() => v({ state: 'a\nb' }), /not a valid/);
  bad(() => v({ state: 'x'.repeat(40) }), /not a valid/);
});

test('plan, apply (verified) and undo through the pipeline; same value is a no-op', async () => {
  const c = setup({ state: 'Auto' });
  assert.equal((await c.plan({ state: 'Auto' })).noop, true);
  const p = await c.plan({ state: 'Off' });
  assert.deepEqual(p.diff, [{ path: 'state', from: 'Auto', to: 'Off', secret: false }]);
  assert.deepEqual(c.dev.sent, []);
  const r = await c.apply(p.planId);
  assert.equal(r.verified, true); assert.equal(c.dev.state, 'Off');
  const u = await c.svc.undo({ client: c.dev.client, changeId: r.id, by: 'adm' });
  assert.equal(u.verified, true); assert.equal(c.dev.state, 'Auto');
  c.done();
});

test('a device that ignores the write, or refuses it, is reported as such', async () => {
  const ignored = setup({ ignore: true });
  const r = await ignored.apply((await ignored.plan({ state: 'Off' })).planId);
  assert.equal(r.verified, false); assert.equal(r.state, 'unverified');
  const refusing = setup({ refuse: 'permission denied' });
  await assert.rejects(refusing.apply((await refusing.plan({ state: 'Off' })).planId), (e) => e.status === 502 && /permission denied/.test(e.message));
  ignored.done(); refusing.done();
});

test('client.describe returns the value with the device range and initial', async () => {
  const srv = await new Promise((r) => { const s = http.createServer((q, res) => {
    let b = ''; q.on('data', (d) => { b += d; });
    q.on('end', () => {
      const j = b ? JSON.parse(b)[0] : {};
      res.setHeader('content-type', 'application/json');
      if (j.cmd === 'Login') return res.end(JSON.stringify([{ cmd: 'Login', code: 0, value: { Token: { name: 't' } } }]));
      res.end(JSON.stringify([{ cmd: j.cmd, code: 0, value: { IrLights: { state: 'Off' } }, range: { IrLights: { state: ['Auto', 'Off'] } }, initial: { IrLights: { state: 'Auto' } }, _action: j.action }]));
    });
  }); s.listen(0, '127.0.0.1', () => r(s)); });
  const c = new ReolinkClient({ host: `127.0.0.1:${srv.address().port}`, user: 'u', password: 'p' });
  const d = await c.describe('GetIrLights', { channel: 0 });
  assert.deepEqual(d.range, { IrLights: { state: ['Auto', 'Off'] } });
  assert.deepEqual(d.initial, { IrLights: { state: 'Auto' } });
  srv.closeAllConnections(); srv.close();
});

/** HTTP camera whose ability report gives the administrator permit 5 (read + execute) for the LEDs. */
function httpCamera({ adminPermit = 5, viewerPermit = 4 } = {}) {
  const st = { state: 'Auto', writes: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), who = (u.searchParams.get('token') ?? '').replace(/^tok-/, '');
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const j = b ? JSON.parse(b)[0] : {}, cmd = j.cmd ?? u.searchParams.get('cmd');
      const ok = (value, extra = {}) => res.end(JSON.stringify([{ cmd, code: 0, value, ...extra }]));
      const P = () => ({ permit: who === 'adm' ? adminPermit : viewerPermit, ver: 2 });
      switch (cmd) {
        case 'Login': return ({ adm: 'good', viewer: 'v' })[j.param.User.userName] === j.param.User.password ? ok({ Token: { name: `tok-${j.param.User.userName}` } }) : res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode: -7, detail: 'login failed' } }]));
        case 'GetDevInfo': return ok({ DevInfo: { model: 'M', name: 'N', firmVer: 'f', channelNum: 1 } });
        case 'GetAbility': return ok({ Ability: { abilityChn: [{ ledControl: P() }] } });
        case 'GetIrLights': return j.action === 1 ? ok({ IrLights: { state: st.state } }, { range: { IrLights: { state: ['Auto', 'Off'] } }, initial: { IrLights: { state: 'Auto' } } }) : ok({ IrLights: { state: st.state } });
        case 'SetIrLights': st.writes.push({ by: who, ...j.param.IrLights }); st.state = j.param.IrLights.state; return ok({ rspCode: 200 });
        default: return ok({});
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { st }))));
}
async function app(cam) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ira-'));
  const config = normalize({ cameras: [{ name: 'Cam', host: `127.0.0.1:${cam.address().port}` }] });
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'viewer', password: 'v',
    capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }),
    writes: new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'ch.jsonl') }) }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (m, p, body) => {
    const r = await fetch(base + p, { method: m, headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { call, close: () => { server.closeAllConnections(); server.close(); cam.closeAllConnections(); cam.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('API: an administrator holding only read + execute (permit 5) can change IR lights, and sees the device options', async () => {
  const cam = await httpCamera({ adminPermit: 5 }); const a = await app(cam);
  await a.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  const list = await a.call('GET', '/api/devices/cam/settings');
  const ir = list.json.settings.find((s) => s.id === 'irLights');
  assert.equal(ir.editable, true, 'execute is enough for a setting that declares it');
  assert.deepEqual(ir.value, { state: 'Auto' });
  assert.deepEqual(ir.options, { states: ['Auto', 'Off'] });
  const plan = await a.call('POST', '/api/devices/cam/settings/irLights/plan', { value: { state: 'Off' } });
  assert.equal(plan.status, 200);
  const bad2 = await a.call('POST', '/api/devices/cam/settings/irLights/plan', { value: { state: 'On' } });
  assert.equal(bad2.status, 400); assert.match(bad2.json.error, /offers only: Auto, Off/);
  const ap = await a.call('POST', `/api/changes/${plan.json.planId}/apply`);
  assert.equal(ap.json.verified, true);
  assert.deepEqual(cam.st.writes, [{ by: 'adm', channel: 0, state: 'Off' }], 'written with the administrator account');
  a.close();
});

test('API: an account with read only (permit 4) is told it may not change IR lights', async () => {
  const cam = await httpCamera({ adminPermit: 4 }); const a = await app(cam);
  await a.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  const ir = (await a.call('GET', '/api/devices/cam/settings')).json.settings.find((s) => s.id === 'irLights');
  assert.equal(ir.editable, false); assert.match(ir.reason, /may not change/);
  assert.equal((await a.call('POST', '/api/devices/cam/settings/irLights/plan', { value: { state: 'Off' } })).status, 403);
  assert.deepEqual(cam.st.writes, []);
  a.close();
});
