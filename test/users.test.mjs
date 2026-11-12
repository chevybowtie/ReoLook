import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError } from '../src/device-settings.mjs';
import { checkOperation } from '../src/users.mjs';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { ProfileCache } from '../src/capabilities.mjs';
import { WriteService } from '../src/safe-write.mjs';
import { ChangeLog } from '../src/change-log.mjs';

const ctx = (over = {}) => ({ users: [{ userName: 'admin', level: 'admin' }, { userName: 'observer', level: 'guest' }, { userName: 'kid', level: 'guest' }],
  viewerName: 'observer', sessionUser: 'admin', constraints: { levels: ['guest', 'admin'], passwordMin: 6, passwordMax: 31 }, ...over });
const bad = (op, c, re, status) => assert.throws(() => checkOperation(op, c), (e) => e instanceof WriteError && re.test(e.message) && (!status || e.status === status));

test('guard rails: the accounts ReoLook and this session depend on cannot be deleted or re-passworded', () => {
  bad({ action: 'delete', userName: 'observer', confirm: 'observer' }, ctx(), /account ReoLook uses to view/);
  bad({ action: 'delete', userName: 'admin', confirm: 'admin' }, ctx(), /you are signed in with this account/);
  bad({ action: 'password', userName: 'observer', password: 'Newpass1', confirm: 'observer' }, ctx(), /lock ReoLook out/);
  bad({ action: 'password', userName: 'admin', password: 'Newpass1', confirm: 'admin' }, ctx(), /signed in with this account/);
});

test('the last administrator cannot be deleted, even by another administrator', () => {
  const only = ctx({ users: [{ userName: 'boss', level: 'admin' }, { userName: 'observer', level: 'guest' }], sessionUser: 'someone-else' });
  bad({ action: 'delete', userName: 'boss', confirm: 'boss' }, only, /only administrator/);
});

test('destructive operations need the account name typed; adding a guest does not', () => {
  bad({ action: 'delete', userName: 'kid' }, ctx(), /type the account name \(kid\)/);
  bad({ action: 'delete', userName: 'kid', confirm: 'other' }, ctx(), /type the account name/);
  assert.equal(checkOperation({ action: 'delete', userName: 'kid', confirm: 'kid' }, ctx()).summary, 'deleted account kid');
  assert.equal(checkOperation({ action: 'add', userName: 'guest2', password: 'Secret-12', level: 'guest' }, ctx()).level, 'guest');
  bad({ action: 'add', userName: 'boss2', password: 'Secret-12', level: 'admin' }, ctx(), /type the account name/);
  assert.equal(checkOperation({ action: 'add', userName: 'boss2', password: 'Secret-12', level: 'admin', confirm: 'boss2' }, ctx()).level, 'admin');
});

test('names and passwords are checked before anything is sent', () => {
  bad({ action: 'add', userName: 'a b', password: 'Secret-12' }, ctx(), /account name must be/);
  bad({ action: 'add', userName: 'x'.repeat(32), password: 'Secret-12' }, ctx(), /account name must be/);
  bad({ action: 'add', userName: 'newone', password: 'short' }, ctx(), /password must be 6 to 31/);
  bad({ action: 'add', userName: 'newone', password: 'has space1' }, ctx(), /password must be/);
  bad({ action: 'add', userName: 'newone', password: 'quo"te123' }, ctx(), /password must be/);
  bad({ action: 'add', userName: 'kid', password: 'Secret-12' }, ctx(), /already exists/, 409);
  bad({ action: 'add', userName: 'newone', password: 'Secret-12', level: 'root' }, ctx(), /level must be one of/);
  bad({ action: 'delete', userName: 'ghost', confirm: 'ghost' }, ctx(), /no account named ghost/, 404);
  bad({ action: 'explode', userName: 'kid' }, ctx(), /unknown account operation/);
});

/** A camera with a user table that behaves as the RLC-410 did, including logging in as its users. */
function camera() {
  const st = { users: new Map([['admin', { level: 'admin', password: 'good' }], ['viewer', { level: 'guest', password: 'v' }], ['kid', { level: 'guest', password: 'kidpass1' }]]), calls: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), cmd = u.searchParams.get('cmd');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const ok = (value, extra = {}) => res.end(JSON.stringify([{ cmd, code: 0, value, ...extra }]));
      const err = (rspCode, detail) => res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode, detail } }]));
      const parsed = body ? JSON.parse(body)[0] : {};
      if (cmd === 'Login') { const { userName, password } = parsed.param.User; return st.users.get(userName)?.password === password ? ok({ Token: { name: `tok-${userName}` } }) : err(-7, 'login failed'); }
      if (cmd === 'GetDevInfo') return ok({ DevInfo: { model: 'M', name: 'Cam', firmVer: 'f', channelNum: 1 } });
      if (cmd === 'GetAbility') return ok({ Ability: { user: { permit: 6, ver: 1 }, abilityChn: [{}] } });
      if (cmd === 'GetUser') return ok({ User: [...st.users].map(([userName, v]) => ({ userName, level: v.level })) },
        parsed.action === 1 ? { range: { User: { level: ['guest', 'admin'], password: { minLen: 6, maxLen: 31 }, userName: { minLen: 1, maxLen: 31 } } } } : {});
      const p = parsed.param?.User ?? {};
      if (cmd === 'AddUser') { st.calls.push(cmd); st.users.set(p.userName, { level: p.level, password: p.password }); return ok({ rspCode: 200 }); }
      if (cmd === 'DelUser') { st.calls.push(cmd); st.users.delete(p.userName); return ok({ rspCode: 200 }); }
      if (cmd === 'ModifyUser') { st.calls.push(cmd); st.users.get(p.userName).password = p.newPassword; return ok({ rspCode: 200 }); }
      return ok({});
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { st }))));
}

async function app(cam) {
  const dir = mkdtempSync(path.join(tmpdir(), 'usr-'));
  const config = normalize({ cameras: [{ name: 'Cam', host: `127.0.0.1:${cam.address().port}` }] });
  const logFile = path.join(dir, 'changes.jsonl');
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'viewer', password: 'v',
    capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }),
    writes: new WriteService({ changeLog: new ChangeLog({ file: logFile }) }) });
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
  return { call, logFile, close: () => { server.closeAllConnections(); server.close(); cam.closeAllConnections(); rmSync(dir, { recursive: true, force: true }); } };
}

test('accounts API: needs an administrator session, adds, sets a password, deletes, and logs without passwords', async () => {
  const cam = await camera(); const a = await app(cam);
  assert.equal((await a.call('GET', '/api/devices/cam/users')).status, 401);
  assert.equal((await a.call('POST', '/api/devices/cam/users', { action: 'add', userName: 'n', password: 'Secret-12' })).status, 401);
  await a.call('POST', '/api/admin/login', { user: 'admin', password: 'good' });
  const list = await a.call('GET', '/api/devices/cam/users');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.users.map((u) => [u.userName, u.viewer, u.signedIn]), [['admin', false, true], ['viewer', true, false], ['kid', false, false]]);

  assert.equal((await a.call('POST', '/api/devices/cam/users', { action: 'add', userName: 'newone', password: 'Secret-12' }, 'http://evil.example')).status, 403);
  const added = await a.call('POST', '/api/devices/cam/users', { action: 'add', userName: 'newone', password: 'Secret-12', level: 'guest' });
  assert.equal(added.status, 200, added.text); assert.equal(added.json.verified, true);
  assert.equal(cam.st.users.get('newone').password, 'Secret-12');

  assert.equal((await a.call('POST', '/api/devices/cam/users', { action: 'password', userName: 'kid', password: 'Brand-new1' })).status, 400, 'typed confirmation missing');
  const pw = await a.call('POST', '/api/devices/cam/users', { action: 'password', userName: 'kid', password: 'Brand-new1', confirm: 'kid' });
  assert.equal(pw.status, 200, pw.text); assert.equal(pw.json.verified, true, 'the new password was proven by signing in');
  assert.equal(cam.st.users.get('kid').password, 'Brand-new1');

  assert.equal((await a.call('POST', '/api/devices/cam/users', { action: 'delete', userName: 'viewer', confirm: 'viewer' })).status, 409);
  assert.equal((await a.call('POST', '/api/devices/cam/users', { action: 'delete', userName: 'admin', confirm: 'admin' })).status, 409);
  const del = await a.call('POST', '/api/devices/cam/users', { action: 'delete', userName: 'newone', confirm: 'newone' });
  assert.equal(del.status, 200); assert.equal(del.json.verified, true);
  assert.equal(cam.st.users.has('newone'), false);
  assert.deepEqual(cam.st.calls, ['AddUser', 'ModifyUser', 'DelUser']);

  const log = readFileSync(a.logFile, 'utf8');
  assert.ok(log.includes('added guest account newone') && log.includes('changed the password of kid'));
  for (const secret of ['Secret-12', 'Brand-new1', 'kidpass1']) assert.ok(!log.includes(secret), 'no password in the history');
  assert.ok(!JSON.stringify(list.json).includes('kidpass1'));
  a.close(); cam.close();
});
