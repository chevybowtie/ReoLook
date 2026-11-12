import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError, settingById } from '../src/device-settings.mjs';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { ProfileCache } from '../src/capabilities.mjs';
import { WriteService } from '../src/safe-write.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { tcpProbe } from '../src/net-probe.mjs';

const cur = { mode: 'DHCP', ip: '192.168.1.243', mask: '255.255.254.0', gateway: '192.168.0.1', dnsAuto: true, dns1: '192.168.0.1', dns2: '' };
const s = settingById('ipConfig');
const bad = (intent, re, current = cur) => assert.throws(() => s.target(s.validate(intent), current), (e) => e instanceof WriteError && re.test(e.message));

test('a fixed address is checked before it can be sent', () => {
  const ok = s.target(s.validate({ mode: 'Static', dnsAuto: false }), cur);
  assert.equal(ok.mode, 'Static');
  assert.equal(s.target(s.validate({ mode: 'Static', ip: '192.168.1.50', dnsAuto: false }), cur).ip, '192.168.1.50');
  bad({ mode: 'Static', ip: '192.168.1.999' }, /not a valid IPv4 address/);
  bad({ mode: 'Static', ip: '192.168.01.5' }, /not a valid IPv4 address/);
  bad({ mode: 'Static', mask: '255.0.255.0' }, /subnet mask is not valid/);
  bad({ mode: 'Static', mask: '0.0.0.0' }, /subnet mask is not valid/);
  bad({ mode: 'Static', ip: '192.168.5.10' }, /gateway is not on the same network/);
  bad({ mode: 'Static', ip: '192.168.1.255' }, /broadcast/);
  bad({ mode: 'Static', ip: '192.168.0.0' }, /network or broadcast/);
  bad({ mode: 'Static', ip: '192.168.0.1' }, /same as the gateway/);
  bad({ mode: 'Static', dnsAuto: false, dns1: '' }, /enter a DNS server/);
  bad({ mode: 'Static', dns2: 'not-an-ip' }, /second DNS server/);
});

test('going back to DHCP needs no fixed-address checks, and the typed confirmation names the result', () => {
  assert.equal(s.target({ mode: 'DHCP' }, { ...cur, mode: 'Static', ip: 'garbage' }).mode, 'DHCP');
  assert.equal(s.confirmText({ proposed: { mode: 'Static', ip: '192.168.1.50' } }), '192.168.1.50');
  assert.equal(s.confirmText({ proposed: { mode: 'DHCP' } }), 'DHCP');
  assert.equal(s.risk, 'high');
});

test('an address that already answers is refused, silence is accepted', async () => {
  const proposed = { ...cur, mode: 'Static', ip: '192.168.1.50' };
  await assert.rejects(s.guard(proposed, cur, { probe: async () => true }), (e) => e instanceof WriteError && /already answers/.test(e.message));
  await s.guard(proposed, cur, { probe: async () => false });
  await s.guard({ ...cur, mode: 'Static' }, { ...cur, mode: 'Static' }, { probe: async () => true });   // not moving: nothing to check
});

test('tcpProbe: a listening port and a refusing port both mean "something is there"', async () => {
  const srv = http.createServer((q, r) => r.end('x'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  assert.equal(await tcpProbe('127.0.0.1', { ports: [srv.address().port], timeoutMs: 500 }), true);
  assert.equal(await tcpProbe('127.0.0.1', { ports: [1], timeoutMs: 500 }), true, 'a reset is an answer');
  srv.close();
});

function camera() {
  const st = { link: { activeLink: 'LAN', dns: { auto: 1, dns1: '10.0.0.1', dns2: '' }, mac: 'aa:bb:cc:00:00:01', static: { gateway: '10.0.0.1', ip: '10.0.0.5', mask: '255.255.255.0' }, type: 'DHCP' }, writes: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), cmd = u.searchParams.get('cmd'), token = u.searchParams.get('token') ?? '';
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const ok = (value) => res.end(JSON.stringify([{ cmd, code: 0, value }]));
      const err = (rspCode, detail) => res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode, detail } }]));
      const parsed = body ? JSON.parse(body)[0] : {};
      if (cmd === 'Login') { const { userName, password } = parsed.param.User; return { adm: 'good', viewer: 'v' }[userName] === password ? ok({ Token: { name: `tok-${userName}` } }) : err(-7, 'bad'); }
      if (cmd === 'GetDevInfo') return ok({ DevInfo: { model: 'M', name: 'Cam', firmVer: 'f', channelNum: 1 } });
      if (cmd === 'GetAbility') { const p = token.endsWith('adm') ? 6 : 4; return ok({ Ability: { localLink: { permit: p, ver: 1 }, mediaPort: { permit: p, ver: 1 }, abilityChn: [{}] } }); }
      if (cmd === 'GetLocalLink') return ok({ LocalLink: structuredClone(st.link) });
      if (cmd === 'GetNetPort') return ok({ NetPort: { httpPort: 80, rtspPort: 554, httpsPort: 443, onvifPort: 8000, rtmpPort: 1935, mediaPort: 9000 } });
      if (cmd === 'SetLocalLink') { st.writes++; st.link = { ...st.link, ...parsed.param.LocalLink }; return ok({ rspCode: 200 }); }
      return err(-9, 'not support');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { st }))));
}

test('changing the address needs the new address typed, and the page learns what to type', async () => {
  const cam = await camera();
  const dir = mkdtempSync(path.join(tmpdir(), 'net-'));
  const config = normalize({ cameras: [{ name: 'Cam', host: `127.0.0.1:${cam.address().port}` }] });
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'viewer', password: 'v',
    capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }),
    writes: new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }), probe: async () => false }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); return { status: r.status, json: (() => { try { return JSON.parse(t); } catch { return null; } })() };
  };
  await call('POST', '/api/admin/login', { user: 'adm', password: 'good' });
  const net = await call('GET', '/api/devices/cam/network');
  assert.equal(net.json.link.ip, '10.0.0.5'); assert.equal(net.json.ports.rtspPort, 554);

  const plan = await call('POST', '/api/devices/cam/settings/ipConfig/plan', { value: { mode: 'Static', ip: '10.0.0.77', dnsAuto: false } });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.confirm, '10.0.0.77');
  assert.equal((await call('POST', `/api/changes/${plan.json.planId}/apply`, {})).status, 400);
  assert.equal((await call('POST', `/api/changes/${plan.json.planId}/apply`, { confirm: '10.0.0.5' })).status, 400);
  assert.equal(cam.st.writes, 0, 'nothing was written without the typed address');
  server.closeAllConnections(); server.close(); cam.close(); rmSync(dir, { recursive: true, force: true });
});

test('a setting that takes a moment to settle is read again before it is called unverified', async () => {
  let reads = 0;
  const registry = [{ id: 'slow', label: 'Slow', area: 'x', feature: 'x', risk: 'low', restartRequired: false, secret: [],
    verifyRetries: 3, verifyDelayMs: 1,
    read: async () => { reads++; return { v: reads > 3 ? 2 : 1 }; },        // plan, apply (before), then it settles
    write: async () => {}, validate: (i) => ({ v: i.v }), equal: (a, b) => a.v === b.v }];
  const svc = new WriteService({ registry, changeLog: new ChangeLog({ file: path.join(mkdtempSync(path.join(tmpdir(), 'rt-')), 'c.jsonl') }) });
  const plan = await svc.plan({ client: {}, deviceId: 'd', settingId: 'slow', input: { v: 2 }, owner: 's' });
  const r = await svc.apply({ client: {}, planId: plan.planId, owner: 's', by: 'a' });
  assert.equal(r.verified, true);
  assert.ok(reads >= 4);
});
