import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tcpProbe } from '../src/net-probe.mjs';

const listen = () => new Promise((resolve) => { const s = net.createServer((c) => c.end()); s.listen(0, '127.0.0.1', () => resolve(s)); });
const freePort = async () => { const s = await listen(); const { port } = s.address(); await new Promise((r) => s.close(r)); return port; };

test('an address with something listening is occupied', async () => {
  const s = await listen();
  assert.equal(await tcpProbe('127.0.0.1', { ports: [s.address().port] }), true);
  s.close();
});

test('a refused connection still counts as occupied: a host answered with a reset', async () => {
  assert.equal(await tcpProbe('127.0.0.1', { ports: [await freePort()] }), true);
});

test('one answering port among several is enough', async () => {
  const s = await listen();
  assert.equal(await tcpProbe('127.0.0.1', { ports: [s.address().port, await freePort()] }), true);
  s.close();
});

test('no ports to try means nothing answered', async () => {
  assert.equal(await tcpProbe('127.0.0.1', { ports: [] }), false);
});

test('an address that does not resolve looks free', async () => {
  assert.equal(await tcpProbe('host.invalid', { ports: [80], timeoutMs: 500 }), false);
});
