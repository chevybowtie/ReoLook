import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import util from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AdminSessions, LoginThrottle, parseCookies } from '../src/admin.mjs';
import { accessOf, ProfileCache } from '../src/capabilities.mjs';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

test('sessions: sliding idle timeout, absolute lifetime, destroy, and the password is never serialised', () => {
  let t = 1_000;
  const s = new AdminSessions({ idleMs: 100, maxMs: 500, now: () => t });
  const a = s.create({ user: 'adm', password: 'hunter2', accepted: { cam: 'accepted' } });
  assert.ok(a.id.length >= 40);
  for (const dump of [JSON.stringify(a), util.inspect(a, { showHidden: false }), JSON.stringify(Object.assign({}, a)), `${Object.keys(a)}`]) {
    assert.ok(!dump.includes('hunter2'), 'password must not appear in any dump');
  }
  assert.deepEqual(a.credentials(), { user: 'adm', password: 'hunter2' });
  t += 90; assert.ok(s.get(a.id), 'within idle window');
  t += 90; assert.ok(s.get(a.id), 'idle window slides with use');
  t += 150; assert.equal(s.get(a.id), null, 'idle expired');
  const b = s.create({ user: 'adm', password: 'x', accepted: {} });
  for (let i = 0; i < 5; i++) { t += 90; assert.ok(s.get(b.id), `still alive at +${(i + 1) * 90} ms`); }   // 450 ms of 500
  t += 90; assert.equal(s.get(b.id), null, 'absolute lifetime (500 ms) reached even though it was kept active');
  const c = s.create({ user: 'u', password: 'p', accepted: {} });
  assert.equal(s.destroy(c.id), true); assert.equal(s.get(c.id), null);
  assert.equal(s.get('not-a-session'), null); assert.equal(s.get(undefined), null);
});

test('throttle locks after repeated failures, reports the wait, and unlocks', () => {
  let t = 0;
  const th = new LoginThrottle({ maxFailures: 3, lockMs: 60_000, now: () => t });
  th.fail(); th.fail(); assert.equal(th.waitSeconds(), 0);
  th.fail(); assert.equal(th.waitSeconds(), 60);
  t += 30_000; assert.equal(th.waitSeconds(), 30);
  t += 31_000; assert.equal(th.waitSeconds(), 0);
  th.fail(); th.success(); th.fail(); th.fail(); assert.equal(th.waitSeconds(), 0, 'success resets the count');
});

test('parseCookies handles several cookies and encoded values', () => {
  assert.deepEqual(parseCookies('a=1; reolook_admin=x%2Fy; b=2'), { a: '1', reolook_admin: 'x/y', b: '2' });
  assert.deepEqual(parseCookies(''), {});
});

test('accessOf decodes the observed permit bits', () => {
  assert.deepEqual(accessOf(4), { read: true, write: false, execute: false });
  assert.deepEqual(accessOf(6), { read: true, write: true, execute: false });
  assert.deepEqual(accessOf(1), { read: false, write: false, execute: true });
  assert.deepEqual(accessOf(0), { read: false, write: false, execute: false });
  assert.deepEqual(accessOf(undefined), { read: null, write: null, execute: null });
});

/** Fake camera: accepts the given accounts; its ability report depends on who signed in. */
function fakeCam(accounts) {
  const stats = { logins: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), cmd = u.searchParams.get('cmd'), token = u.searchParams.get('token') ?? '';
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const reply = (value) => res.end(JSON.stringify([{ cmd, code: 0, value }]));
      if (cmd === 'Login') {
        stats.logins++;
        const { userName, password } = JSON.parse(body)[0].param.User;
        if (accounts[userName] === password) return reply({ Token: { name: `tok-${userName}` } });
        return res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode: -7, detail: 'login failed' } }]));
      }
      const who = token.replace(/^tok-/, '');
      if (cmd === 'GetDevInfo') return reply({ DevInfo: { model: 'M', name: 'N', firmVer: 'f1', channelNum: 1 } });
      if (cmd === 'GetAbility') return reply({ Ability: { abilityChn: [{ osd: { permit: who === 'adm' ? 6 : 4, ver: 1 } }] } });
      return reply({});
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { stats }))));
}

async function app(cams) {
  const dir = mkdtempSync(path.join(tmpdir(), 'adm-'));
  const config = normalize({ cameras: cams.map((c, i) => ({ name: `Cam${i}`, host: c.host ?? `127.0.0.1:${c.srv.address().port}` })) });
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'viewer', password: 'v',
    capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body, { origin = base, withCookie = true } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    if (withCookie && cookie) headers.cookie = cookie;
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, headers: r.headers, setCookie: sc, json: await r.json().catch(() => null) };
  };
  return { base, call, dir, close: () => { server.closeAllConnections(); server.close(); for (const c of cams) c.srv?.closeAllConnections(); rmSync(dir, { recursive: true, force: true }); },
    clearCookie: () => { cookie = ''; } };
}

test('login: accepted everywhere, cookie is HttpOnly/SameSite=Strict/session-only, no secrets in any response', async () => {
  const a = await fakeCam({ adm: 'good' }), b = await fakeCam({ adm: 'good' });
  const ap = await app([{ srv: a }, { srv: b }]);
  const r = await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Strict/); assert.match(r.setCookie, /Path=\/api/);
  assert.doesNotMatch(r.setCookie, /Max-Age|Expires/i, 'a session cookie, gone when the browser closes');
  assert.equal(r.json.user, 'adm');
  assert.deepEqual(Object.values(r.json.devices), ['accepted', 'accepted']);
  assert.ok(!JSON.stringify(r.json).includes('good') && !r.setCookie.includes('good'));
  const st = await ap.call('GET', '/api/admin/status');
  assert.equal(st.json.active, true); assert.ok(!JSON.stringify(st.json).includes('good'));
  ap.clearCookie();
  assert.equal((await ap.call('GET', '/api/admin/status')).json.active, false, 'no cookie, no session');
  ap.close(); a.close(); b.close();
});

test('a wrong password is tried on one device only, then locks out repeated attempts', async () => {
  const a = await fakeCam({ adm: 'good' }), b = await fakeCam({ adm: 'good' });
  const ap = await app([{ srv: a }, { srv: b }]);
  const bad = await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal(a.stats.logins, 1); assert.equal(b.stats.logins, 0, 'the second device was not tried');
  assert.equal((await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'nope' })).status, 401);
  assert.equal((await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'nope' })).status, 401);
  const locked = await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  assert.equal(locked.status, 429, 'even the right password is refused while locked');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal(a.stats.logins, 3, 'the camera saw exactly the three failed attempts');
  ap.close(); a.close(); b.close();
});

test('login input and origin checks; no device means no sign-in', async () => {
  const a = await fakeCam({ adm: 'good' });
  const ap = await app([{ srv: a }]);
  assert.equal((await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'good' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'good' }, { origin: null })).status, 403);
  assert.equal((await ap.call('POST', '/api/admin/login', { user: '', password: '' })).status, 400);
  assert.equal((await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'x'.repeat(300) })).status, 400);
  assert.equal(a.stats.logins, 0, 'refused requests never reached the camera');
  ap.close(); a.close();
});

test('an unreachable first device is skipped; a device that denies the account is reported per device', async () => {
  const good = await fakeCam({ adm: 'good' }), other = await fakeCam({ someoneelse: 'x' });
  const ap = await app([{ host: '127.0.0.1:1' }, { srv: good }, { srv: other }]);
  const r = await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  assert.equal(r.status, 200);
  const d = r.json.devices;
  assert.equal(d.cam0, 'unreachable'); assert.equal(d.cam1, 'accepted'); assert.equal(d.cam2, 'denied');
  ap.close(); good.close(); other.close();
});

test('capabilities as administrator: needs a session and an accepting device, uses the admin account, separate cache', async () => {
  const a = await fakeCam({ adm: 'good', viewer: 'v' }), denied = await fakeCam({ viewer: 'v' });
  const ap = await app([{ srv: a }, { srv: denied }]);
  assert.equal((await ap.call('GET', '/api/devices/cam0/capabilities?as=admin')).status, 401);
  await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  const viewer = await ap.call('GET', '/api/devices/cam0/capabilities');
  assert.equal(viewer.json.account, 'viewer');
  assert.deepEqual(viewer.json.features.osd.access, { read: true, write: false, execute: false });
  const admin = await ap.call('GET', '/api/devices/cam0/capabilities?as=admin');
  assert.equal(admin.status, 200);
  assert.equal(admin.json.account, 'administrator');
  assert.deepEqual(admin.json.features.osd.access, { read: true, write: true, execute: false });
  assert.equal((await ap.call('GET', '/api/devices/cam0/capabilities')).json.account, 'viewer', 'viewer profile not overwritten');
  assert.equal((await ap.call('GET', '/api/devices/cam1/capabilities?as=admin')).status, 403, 'device that denied the account');
  assert.ok(!JSON.stringify(admin.json).includes('good'));
  ap.close(); a.close(); denied.close();
});

test('logout ends the session and clears the cookie; the server forgets the credentials', async () => {
  const a = await fakeCam({ adm: 'good' });
  const ap = await app([{ srv: a }]);
  await ap.call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  assert.equal((await ap.call('POST', '/api/admin/logout', {}, { origin: 'http://evil.example' })).status, 403);
  const out = await ap.call('POST', '/api/admin/logout', {});
  assert.equal(out.status, 200); assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await ap.call('GET', '/api/admin/status', undefined, { withCookie: false })).json.active, false);
  assert.equal((await ap.call('GET', '/api/devices/cam0/capabilities?as=admin')).status, 401);
  ap.close(); a.close();
});
