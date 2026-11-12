// discovery.scan: bounded concurrency, abort, and ordering, with a fake network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../src/discovery.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REOLINK = [{ cmd: 'GetDevInfo', code: 1, error: { rspCode: -6, detail: 'please login first' } }];

/** A fake `fetch`: addresses in `cameras` answer like a Reolink; everything else answers with something else. */
function network(cameras, { ms = 5 } = {}) {
  const net = { now: 0, peak: 0, asked: [] };
  net.fetch = async (url) => {
    const host = new URL(url).host;
    net.asked.push(host);
    net.now++; net.peak = Math.max(net.peak, net.now);
    await sleep(ms);
    net.now--;
    if (host.startsWith('bad')) throw new Error('unreachable');
    return { json: async () => (cameras.includes(host) ? REOLINK : { not: 'a camera' }) };
  };
  return net;
}

test('only addresses that answer like a Reolink are returned, sorted by address', async () => {
  const hosts = ['10.0.0.200', '10.0.0.9', 'bad1', '10.0.0.30', '10.0.0.100'];
  const net = network(['10.0.0.200', '10.0.0.9', '10.0.0.100']);
  assert.deepEqual(await scan(hosts, { fetchImpl: net.fetch }), ['10.0.0.9', '10.0.0.100', '10.0.0.200'], 'numeric order, not text order');
  assert.equal(net.asked.length, hosts.length, 'every address was tried once');
});

test('no more than `concurrency` addresses are probed at once', async () => {
  const hosts = Array.from({ length: 30 }, (_, i) => `10.0.0.${i + 1}`);
  const net = network([]);
  await scan(hosts, { concurrency: 5, fetchImpl: net.fetch });
  assert.equal(net.peak, 5);
  assert.equal(net.asked.length, 30);
});

test('a short list, an empty list and a concurrency of zero', async () => {
  const net = network(['10.0.0.1']);
  assert.deepEqual(await scan(['10.0.0.1'], { concurrency: 48, fetchImpl: net.fetch }), ['10.0.0.1']);
  assert.deepEqual(await scan([], { fetchImpl: net.fetch }), []);
  assert.deepEqual(await scan(['10.0.0.1'], { concurrency: 0, fetchImpl: net.fetch }), [], 'nobody to do the work');
});

test('once aborted, addresses not yet started are skipped, and what was found so far is kept', async () => {
  const hosts = Array.from({ length: 40 }, (_, i) => `10.0.0.${i + 1}`);
  const ctl = new AbortController();
  const net = network(hosts, { ms: 5 });
  setTimeout(() => ctl.abort(), 20);
  const found = await scan(hosts, { concurrency: 4, fetchImpl: net.fetch, signal: ctl.signal });
  assert.ok(net.asked.length < 40, `stopped early (asked ${net.asked.length})`);
  assert.ok(net.asked.length >= 4);
  assert.equal(found.length, net.asked.length, 'everything started before the abort was kept');
});

test('an address already aborted at the start is never probed', async () => {
  const ctl = new AbortController(); ctl.abort();
  const net = network(['10.0.0.1']);
  assert.deepEqual(await scan(['10.0.0.1', '10.0.0.2'], { fetchImpl: net.fetch, signal: ctl.signal }), []);
  assert.equal(net.asked.length, 0);
});
