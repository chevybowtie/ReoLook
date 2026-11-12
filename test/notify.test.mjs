import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Notifier, fillUrl, eventBody } from '../src/detect/notify.mjs';
import { normalizeDetection, normalizeRule, DetectionConfigError } from '../src/detect/config.mjs';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

const rec = (over = {}) => ({ type: 'appeared', camera: 'front-porch', cameraName: 'Front Porch', rule: 'peacock', ruleId: 'r1', vehicle: 'bird', score: 0.8, at: '2026-10-12T13:22:00.000Z', tag: 'peacock 13:22', id: 'abc', ...over });

test('placeholders in a web address are filled in and URL-encoded', () => {
  assert.equal(fillUrl('http://hb:8581/motion?{camera}', { camera: 'Front Porch' }), 'http://hb:8581/motion?Front%20Porch');
  assert.equal(fillUrl('http://x/{label}/{event}', { label: 'mail truck', event: 'mail_truck_stopped' }), 'http://x/mail%20truck/mail_truck_stopped');
  assert.equal(fillUrl('http://x/{unknown}', {}), 'http://x/{unknown}');
  assert.equal(eventBody(rec()).event, 'peacock_appeared');
  assert.equal(eventBody(rec({ test: true })).test, true);
});

test('web addresses are validated: http(s) only, no embedded login, placeholders allowed', () => {
  const ok = (webhook) => normalizeRule({ id: 'r1', enabled: false, mode: 'appears', label: 'x', classes: ['bird'], webhook });
  assert.equal(ok({ url: 'http://192.168.1.5:8581/motion?{camera}' }).webhook.url, 'http://192.168.1.5:8581/motion?{camera}');
  assert.equal(ok({ url: '' }).webhook.url, null);
  assert.equal(ok({ url: 'https://hooks.example/x', method: 'GET' }).webhook.method, 'GET');
  const bad = (webhook, re) => assert.throws(() => ok(webhook), (e) => e instanceof DetectionConfigError && re.test(e.message));
  bad({ url: 'ftp://x/y' }, /http:\/\/ or https:\/\//);
  bad({ url: 'http://u:p@host/x' }, /user name or password/);
  bad({ url: 'not a url' }, /usable address|full address/);
  bad({ url: 'http://x/y', method: 'DELETE' }, /GET or POST/);
});

test('an event goes to MQTT and to the rule\'s web address; "left" uses the second address', async () => {
  const calls = [], published = [];
  const notifier = new Notifier({
    config: { mqtt: { topic: 'reolook', retain: true }, cameras: {} },
    mqtt: { publish: async (t, p, o) => { published.push([t, p, o]); } },
    fetchImpl: async (url, init) => { calls.push([url, init.method, init.body]); return { status: 200 }; },
  });
  const rule = { webhook: { url: 'http://hb/motion?{camera}', leftUrl: 'http://hb/reset?{camera}', method: 'GET' } };
  const a = await notifier.notify(rec(), rule);
  assert.deepEqual(a.mqtt, { ok: true, topic: 'reolook/front-porch/event' });
  assert.equal(a.webhook.ok, true);
  assert.deepEqual(calls[0], ['http://hb/motion?Front%20Porch', 'GET', undefined]);
  assert.deepEqual(published.map((p) => p[0]), ['reolook/front-porch/event', 'reolook/front-porch/peacock']);
  assert.equal(published[1][1], 'ON'); assert.equal(published[1][2].retain, true);
  await notifier.notify(rec({ type: 'left' }), rule);
  assert.equal(calls[1][0], 'http://hb/reset?Front%20Porch');
  assert.equal(published.at(-1)[1], 'OFF');
  // POST carries the same JSON as MQTT
  await notifier.notify(rec(), { webhook: { url: 'http://hook/x', method: 'POST' } });
  assert.deepEqual(JSON.parse(calls.at(-1)[2]).event, 'peacock_appeared');
});

test('failures are reported per channel and never thrown; test events are not retained', async () => {
  const notifier = new Notifier({
    config: { mqtt: { topic: 'r', retain: true }, cameras: {} },
    mqtt: { publish: async () => { throw new Error('broker unreachable'); } },
    fetchImpl: async () => ({ status: 503 }),
  });
  const r = await notifier.notify(rec(), { webhook: { url: 'http://x/y', method: 'POST' } });
  assert.equal(r.mqtt.ok, false); assert.match(r.mqtt.error, /unreachable/);
  assert.equal(r.webhook.ok, false); assert.match(r.webhook.error, /503/);
  const kept = [];
  const n2 = new Notifier({ config: { mqtt: { topic: 'r', retain: true }, cameras: {} }, mqtt: { publish: async (t, p, o) => { kept.push(o.retain); } } });
  await n2.notify(rec({ test: true }), {});
  assert.equal(kept.length, 2);
  assert.equal(kept[1], false, 'a test must not leave a retained ON behind');
});

test('Home Assistant discovery: one retained sensor per enabled rule', async () => {
  const sent = [];
  const cfg = normalizeDetection({ mqtt: { enabled: true, url: 'mqtt://h', topic: 'reolook', discovery: true },
    cameras: { 'front-porch': { rules: [{ id: 'r1', enabled: true, mode: 'appears', label: 'peacock', classes: ['bird'] }, { id: 'r2', enabled: false, mode: 'appears', label: 'person', classes: ['person'] }] } } });
  await new Notifier({ config: cfg, mqtt: { publish: async (t, p, o) => { sent.push([t, p, o]); } } }).announce([{ id: 'front-porch', name: 'Front Porch' }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'homeassistant/binary_sensor/reolook_front_porch_peacock/config');
  assert.equal(sent[0][1].state_topic, 'reolook/front-porch/peacock');
  assert.equal(sent[0][1].availability_topic, 'reolook/status');
  assert.equal(sent[0][2].retain, true);
});

// ---- the "send a test event" endpoint, against a real web server and a real (tiny) broker
function broker() {
  const got = [];
  const srv = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let mult = 1, len = 0, i = 1, b;
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mult; mult *= 128; } while (b & 128);
        if (buf.length < i + len) return;
        const first = buf[0], body = buf.subarray(i, i + len); buf = buf.subarray(i + len);
        if (first >> 4 === 1) s.write(Buffer.from([0x20, 2, 0, 0]));
        else if (first >> 4 === 3) {
          const qos = (first >> 1) & 3, tl = body.readUInt16BE(0); let o = 2 + tl, id = 0;
          if (qos) { id = body.readUInt16BE(o); o += 2; }
          got.push({ topic: body.subarray(2, 2 + tl).toString(), payload: body.subarray(o).toString(), retain: !!(first & 1) });
          if (qos) s.write(Buffer.from([0x40, 2, id >> 8, id & 255]));
        }
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { got }))));
}

test('POST /api/detection/test-event reaches the broker and the web address, and says what each did', async () => {
  const b = await broker();
  const hits = [];
  const web = http.createServer((q, r) => { hits.push(q.method + ' ' + q.url); r.end('ok'); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(path.join(tmpdir(), 'tev-'));
  const config = normalize({ cameras: [{ name: 'Front Porch', host: '127.0.0.1:1' }] });
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'v', password: 'p' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (body, origin = base) => { const r = await fetch(base + '/api/detection/test-event', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const rule = { id: 'r1', label: 'peacock', mode: 'appears', classes: ['bird'], webhook: { url: `http://127.0.0.1:${web.address().port}/motion?{camera}`, leftUrl: `http://127.0.0.1:${web.address().port}/reset?{camera}`, method: 'GET' } };
  const mqtt = { enabled: true, url: `mqtt://127.0.0.1:${b.address().port}`, topic: 'reolook' };

  assert.equal((await call({ camera: 'front-porch', rule, mqtt }, 'http://evil.example')).status, 403);
  assert.equal((await call({ camera: 'nope', rule, mqtt })).status, 404);
  assert.equal((await call({ camera: 'front-porch', rule: { ...rule, webhook: { url: 'ftp://x' } }, mqtt })).status, 400);

  const r = await call({ camera: 'front-porch', rule, mqtt, leave: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sent, 'appeared');
  assert.equal(r.json.mqtt.ok, true); assert.equal(r.json.webhook.ok, true); assert.equal(r.json.left.webhook.ok, true);
  assert.deepEqual(hits, ['GET /motion?Front%20Porch', 'GET /reset?Front%20Porch']);
  const ev = b.got.find((m) => m.topic === 'reolook/front-porch/event' && JSON.parse(m.payload).type === 'appeared');
  assert.equal(JSON.parse(ev.payload).test, true);
  assert.ok(b.got.some((m) => m.topic === 'reolook/front-porch/peacock' && m.payload === 'ON' && m.retain === false), 'a test sets no retained state');

  // a broker that is not there is reported, not thrown
  const dead = await call({ camera: 'front-porch', rule: { ...rule, webhook: {} }, mqtt: { enabled: true, url: 'mqtt://127.0.0.1:1', topic: 'reolook' } });
  assert.equal(dead.json.mqtt.ok, false);
  server.closeAllConnections(); server.close(); web.close(); b.close(); rmSync(dir, { recursive: true, force: true });
});
