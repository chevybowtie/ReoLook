import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MqttPublisher, parseUrl, connectPacket, publishPacket } from '../src/mqtt.mjs';

test('addresses are parsed, and anything else is refused with a clear message', () => {
  assert.deepEqual(parseUrl('mqtt://broker.lan'), { secure: false, host: 'broker.lan', port: 1883 });
  assert.deepEqual(parseUrl('mqtts://10.0.0.5:8884'), { secure: true, host: '10.0.0.5', port: 8884 });
  for (const bad of ['broker', 'http://x', 'mqtt://', 'mqtt://h:99999x', '', null]) assert.throws(() => parseUrl(bad), /must look like/);
});

test('packets have the MQTT 3.1.1 layout', () => {
  const c = connectPacket({ clientId: 'cid', username: 'u', password: 'p', keepAlive: 30, will: { topic: 'a/status', payload: 'offline', retain: true } });
  assert.equal(c[0], 0x10);
  assert.equal(c.subarray(2, 8).toString('latin1'), '\x00\x04MQTT');
  assert.equal(c[8], 4, 'protocol level 3.1.1');
  assert.equal(c[9], 0x02 | 0x04 | 0x20 | 0x80 | 0x40, 'clean session, will, will retain, user, password');
  assert.equal(c.readUInt16BE(10), 30);
  const p = publishPacket({ topic: 't/x', payload: '{"a":1}', retain: true, qos: 1, id: 7 });
  assert.equal(p[0], 0x30 | 0x02 | 0x01);
  assert.equal(p.readUInt16BE(2), 3);
  assert.equal(p.subarray(4, 7).toString(), 't/x');
  assert.equal(p.readUInt16BE(7), 7);
  assert.equal(p.subarray(9).toString(), '{"a":1}');
  // a long payload uses a multi-byte remaining length
  const big = publishPacket({ topic: 't', payload: 'x'.repeat(300) });
  assert.equal(big[1] & 0x80, 0x80);
});

/** A tiny broker: accepts CONNECT (checking credentials), acknowledges QoS 1, records what it gets. */
function broker({ user = null, pass = null } = {}) {
  const got = { connects: [], publishes: [] };
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
        const type = first >> 4;
        if (type === 1) {
          const flags = body[7]; let off = 10;
          const str = () => { const l = body.readUInt16BE(off); const v = body.subarray(off + 2, off + 2 + l).toString(); off += 2 + l; return v; };
          const clientId = str(); let will = null;
          if (flags & 0x04) will = { topic: str(), payload: str() };
          const u = flags & 0x80 ? str() : null, p = flags & 0x40 ? str() : null;
          got.connects.push({ clientId, will, u, p });
          const ok = (user === null || (u === user && p === pass));
          s.write(Buffer.from([0x20, 2, 0, ok ? 0 : 4]));
        } else if (type === 3) {
          const qos = (first >> 1) & 3, tl = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + tl).toString();
          let o = 2 + tl, id = 0;
          if (qos) { id = body.readUInt16BE(o); o += 2; }
          got.publishes.push({ topic, payload: body.subarray(o).toString(), retain: !!(first & 1), qos });
          if (qos) s.write(Buffer.from([0x40, 2, id >> 8, id & 255]));
        }
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { got }))));
}
const waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timed out'); };

test('connects with credentials and a last will, publishes at QoS 1 and is acknowledged', async () => {
  const b = await broker({ user: 'mq', pass: 'secret' });
  const pub = new MqttPublisher({ url: `mqtt://127.0.0.1:${b.address().port}`, username: 'mq', password: 'secret', statusTopic: 'reolook/status', clientId: 'rl-test' });
  pub.on('error', () => {});
  pub.start();
  await pub.publish('reolook/front/event', { type: 'stopped' });
  assert.equal(b.got.connects[0].u, 'mq');
  assert.deepEqual(b.got.connects[0].will, { topic: 'reolook/status', payload: 'offline' });
  assert.ok(b.got.publishes.some((p) => p.topic === 'reolook/status' && p.payload === 'online'));
  const ev = b.got.publishes.find((p) => p.topic === 'reolook/front/event');
  assert.deepEqual(JSON.parse(ev.payload), { type: 'stopped' });
  assert.equal(ev.qos, 1);
  await pub.end(); b.closeAllConnections?.(); b.close();
});

test('a refused login is reported, not retried forever', async () => {
  const b = await broker({ user: 'mq', pass: 'secret' });
  const pub = new MqttPublisher({ url: `mqtt://127.0.0.1:${b.address().port}`, username: 'mq', password: 'wrong' });
  const errors = [];
  pub.on('error', (e) => errors.push(e.message));
  pub.start();
  await waitFor(() => errors.length > 0);
  assert.match(errors[0], /user name or password was refused/);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(b.got.connects.length, 1, 'no reconnect loop against a broker that said no');
  await pub.end(); b.closeAllConnections?.(); b.close();
});

test('messages sent before the broker is reachable are delivered once it is', async () => {
  const b = await broker();
  const pub = new MqttPublisher({ url: `mqtt://127.0.0.1:${b.address().port}` });
  pub.on('error', () => {});
  const early = pub.publish('t/early', 'hello');      // not connected yet: queued
  pub.start();
  await early;
  assert.ok(b.got.publishes.some((p) => p.topic === 't/early' && p.payload === 'hello'));
  await pub.end(); b.closeAllConnections?.(); b.close();
});
