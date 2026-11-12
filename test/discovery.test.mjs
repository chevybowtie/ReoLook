import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candidateHosts, looksLikeReolink, scan, matchDevices, discover, normMac } from '../src/discovery.mjs';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

const iface = (address, netmask, extra = {}) => ({ family: 'IPv4', address, netmask, internal: false, ...extra });

test('candidateHosts: every usable address of a /23, never this machine, loopback, or a huge network', () => {
  const hosts = candidateHosts({
    lo: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
    eth: [iface('192.168.0.66', '255.255.254.0'), { family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false }],
    big: [iface('172.16.0.5', '255.240.0.0')],
  });
  assert.equal(hosts.length, 510 - 1);
  assert.ok(hosts.includes('192.168.1.241') && hosts.includes('192.168.0.1') && hosts.includes('192.168.1.254'));
  assert.ok(!hosts.includes('192.168.0.66') && !hosts.includes('192.168.0.0') && !hosts.includes('192.168.1.255'));
  assert.ok(!hosts.some((h) => h.startsWith('172.')));
});

const reply = (body) => ({ json: async () => body });
const reolink = reply([{ cmd: 'GetDevInfo', code: 1, error: { rspCode: -6, detail: 'please login first' } }]);

test('only the Reolink "please login first" answer counts; credentials are never sent', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: init.body });
    if (String(url).includes('10.0.0.5')) return reolink;
    if (String(url).includes('10.0.0.6')) return reply({ not: 'it' });
    if (String(url).includes('10.0.0.7')) return reply([{ error: { rspCode: -1, detail: 'other' } }]);
    throw new Error('ECONNREFUSED');
  };
  assert.equal(await looksLikeReolink('10.0.0.5', { fetchImpl }), true);
  assert.equal(await looksLikeReolink('10.0.0.6', { fetchImpl }), false);
  assert.equal(await looksLikeReolink('10.0.0.7', { fetchImpl }), false);
  assert.equal(await looksLikeReolink('10.0.0.8', { fetchImpl }), false);
  assert.ok(seen.every((s) => !/password|token=/i.test(s.url + s.body)));
  assert.deepEqual(await scan(['10.0.0.9', '10.0.0.5', '10.0.0.6'], { fetchImpl }), ['10.0.0.5']);
});

test('normMac accepts common spellings and rejects junk', () => {
  assert.equal(normMac('EC:71:DB:12:34:56'), 'ec:71:db:12:34:56');
  assert.equal(normMac('ec-71-db-12-34-56'), 'ec:71:db:12:34:56');
  assert.equal(normMac('ec71db123456'), 'ec:71:db:12:34:56');
  assert.equal(normMac('nope'), null);
  assert.equal(normMac(undefined), null);
});

test('matching: by address, then by hardware address, then by a unique name; ambiguity is not guessed', () => {
  const conf = [
    { id: 'a', name: 'A', host: '10.0.0.1', mac: 'aa:aa:aa:aa:aa:01' },
    { id: 'b', name: 'B', host: '10.0.0.2', mac: 'aa:aa:aa:aa:aa:02' },
    { id: 'c', name: 'C', host: '10.0.0.3' },
    { id: 'd', name: 'Twin', host: '10.0.0.4' },
  ];
  const found = [
    { host: '10.0.0.1', name: 'A', mac: 'aa:aa:aa:aa:aa:01' },
    { host: '10.0.0.52', name: 'renamed', mac: 'aa:aa:aa:aa:aa:02' },
    { host: '10.0.0.53', name: 'C', mac: 'aa:aa:aa:aa:aa:03' },
    { host: '10.0.0.54', name: 'Twin', mac: 'aa:aa:aa:aa:aa:04' },
    { host: '10.0.0.55', name: 'Twin', mac: 'aa:aa:aa:aa:aa:05' },
  ];
  const m = Object.fromEntries(matchDevices(conf, found).map((x) => [x.id, x]));
  assert.deepEqual([m.a.by, m.a.changed], ['address', false]);
  assert.deepEqual([m.b.by, m.b.host, m.b.changed], ['mac', '10.0.0.52', true]);
  assert.deepEqual([m.c.by, m.c.host], ['name', '10.0.0.53']);
  assert.equal(m.d.host, null, 'two devices with the same name: do not guess');
});

test('a refused account stops identification so the password is not retried on every camera', async () => {
  const logins = [];
  // ReolinkError check uses instanceof, so build the real class for the refusal
  const { ReolinkError } = await import('../src/client.mjs');
  const makeReal = ({ host }) => ({
    devInfo: async () => { logins.push(host); throw new ReolinkError('login failed', { code: -7 }); },
    command: async () => ({}), logout: async () => {},
  });
  const fetchImpl = async () => reolink;
  const r = await discover({ configured: [], user: 'u', password: 'wrong', interfaces: { e: [iface('10.0.0.1', '255.255.255.248')] }, fetchImpl, make: makeReal });
  assert.equal(r.credentials, 'refused');
  assert.equal(logins.length, 1, 'exactly one attempt');
  assert.ok(r.devices.length > 1, 'the other devices are still listed, unidentified');
});

// ---- the endpoint that points a device at a new address
function camera({ name, mac }) {
  const srv = http.createServer((req, res) => {
    const cmd = new URL(req.url, 'http://x').searchParams.get('cmd');
    const v = cmd === 'Login' ? { Token: { name: 't' } } : cmd === 'GetDevInfo' ? { DevInfo: { name, model: 'RLC-410' } }
      : cmd === 'GetLocalLink' ? { LocalLink: { mac } } : {};
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ cmd, code: 0, value: v }]));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const addr = (s) => `127.0.0.1:${s.address().port}`;

async function app(cameras, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'disc-'));
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ cameras }));
  const config = normalize({ cameras });
  const server = createServer({ config, configPath, user: 'u', password: 'p', ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  return { post, config, configPath, close: () => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('re-pointing: the same device at a new address is accepted, saved, and its address updated', async () => {
  const moved = await camera({ name: 'Front porch - out', mac: 'aa:bb:cc:dd:ee:01' });
  const a = await app([{ name: 'Front porch - out', host: '127.0.0.1:1', mac: 'aa:bb:cc:dd:ee:01' }]);
  const r = await a.post('/api/cameras/front-porch-out/host', { host: addr(moved) });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(readFileSync(a.configPath, 'utf8')).cameras[0].host, addr(moved));
  assert.equal(a.config.cameras[0].host, addr(moved));
  a.close(); moved.close();
});

test('re-pointing at a different device is refused unless confirmed; unreachable and cross-origin are refused', async () => {
  const other = await camera({ name: 'Garage', mac: 'aa:bb:cc:dd:ee:99' });
  const a = await app([{ name: 'Front porch - out', host: '127.0.0.1:1', mac: 'aa:bb:cc:dd:ee:01' }]);
  const r = await a.post('/api/cameras/front-porch-out/host', { host: addr(other) });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).found.name, 'Garage');
  assert.equal(a.config.cameras[0].host, '127.0.0.1:1', 'unchanged');
  assert.equal((await a.post('/api/cameras/front-porch-out/host', { host: '127.0.0.1:2' })).status, 502);
  assert.equal((await a.post('/api/cameras/front-porch-out/host', { host: addr(other) }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await a.post('/api/cameras/front-porch-out/host', { host: addr(other), confirm: true })).status, 200);
  assert.equal((await a.post('/api/cameras/nope/host', { host: addr(other) })).status, 404);
  a.close(); other.close();
});

test('POST /api/discovery reports moved devices and remembers hardware addresses it sees', async () => {
  const at = await camera({ name: 'Here', mac: 'aa:bb:cc:dd:ee:07' });
  const calls = [];
  const discoverFn = async ({ configured }) => {
    calls.push(configured.map((c) => c.id));
    return { scanned: 3, credentials: 'ok',
      devices: [{ host: addr(at), name: 'Here', model: 'RLC-410', mac: 'aa:bb:cc:dd:ee:07' }, { host: '192.168.1.77', name: 'Moved', model: 'RLC-410', mac: 'aa:bb:cc:dd:ee:08' }],
      matches: [{ id: 'here', host: addr(at), by: 'address', changed: false, found: {} },
        { id: 'moved', host: '192.168.1.77', by: 'name', changed: true, found: { name: 'Moved', model: 'RLC-410' } }] };
  };
  const a = await app([{ name: 'Here', host: addr(at) }, { name: 'Moved', host: '192.168.1.241' }], { discoverFn });
  const r = await a.post('/api/discovery', {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.moved.map((m) => [m.id, m.from, m.to, m.by]), [['moved', '192.168.1.241', '192.168.1.77', 'name']]);
  assert.equal(body.devices.find((d) => d.host === addr(at)).added, true);
  assert.equal(JSON.parse(readFileSync(a.configPath, 'utf8')).cameras[0].mac, 'aa:bb:cc:dd:ee:07');
  assert.equal((await a.post('/api/discovery', {}, { origin: 'http://evil.example' })).status, 403);
  a.close(); at.close();
});
