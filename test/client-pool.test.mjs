import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientPool } from '../src/client-pool.mjs';
import { ReolinkClient } from '../src/client.mjs';
import { startFakeCamera } from './support/fake-camera.mjs';

const acct = (host, user = 'viewer', password = 'secret123') => ({ host, user, password });

test('the same address and account always gets the same client; anything different gets its own', () => {
  const pool = new ClientPool();
  const a = pool.viewer(acct('10.0.0.5'));
  assert.ok(a instanceof ReolinkClient);
  assert.equal(pool.viewer(acct('10.0.0.5')), a);
  assert.notEqual(pool.viewer(acct('10.0.0.6')), a, 'another address');
  assert.notEqual(pool.viewer(acct('10.0.0.5', 'other')), a, 'another account');
  assert.notEqual(pool.viewer(acct('10.0.0.5', 'viewer', 'changed')), a, 'a changed password');
  assert.equal(pool.size, 4);
});

test('pools do not share clients with each other', () => {
  assert.notEqual(new ClientPool().viewer(acct('10.0.0.5')), new ClientPool().viewer(acct('10.0.0.5')));
});

test('forget drops every client for an address and leaves the others', () => {
  const pool = new ClientPool();
  const keep = pool.viewer(acct('10.0.0.6'));
  const old = pool.viewer(acct('10.0.0.5'));
  pool.viewer(acct('10.0.0.5', 'other'));
  pool.forget('10.0.0.5');
  assert.equal(pool.size, 1);
  assert.equal(pool.viewer(acct('10.0.0.6')), keep);
  assert.notEqual(pool.viewer(acct('10.0.0.5')), old, 'a new client is made after forgetting');
  pool.forget('10.9.9.9');
});

test('close signs every client out on its camera and empties the pool', async () => {
  const cams = [await startFakeCamera(), await startFakeCamera()];
  const pool = new ClientPool();
  for (const c of cams) await pool.viewer(acct(c.host)).command('GetX').catch(() => {});
  assert.ok(cams.every((c) => c.requests.some((r) => r.cmd === 'Login')));
  await pool.close();
  assert.ok(cams.every((c) => c.requests.filter((r) => r.cmd === 'Logout').length === 1), 'one sign-out each');
  assert.equal(pool.size, 0);
  await pool.close();                                                   // closing twice is harmless
  assert.ok(cams.every((c) => c.requests.filter((r) => r.cmd === 'Logout').length === 1));
  for (const c of cams) await c.stop();
});

test('close does not wait for a camera that never answers', async () => {
  const cam = await startFakeCamera({ delayMs: (cmd) => (cmd === 'Logout' ? 5000 : 0) });
  const pool = new ClientPool();
  await pool.viewer(acct(cam.host)).command('GetX').catch(() => {});
  const t = Date.now();
  await pool.close({ timeoutMs: 100 });
  assert.ok(Date.now() - t < 1000, `gave up after about the timeout (${Date.now() - t} ms)`);
  await cam.stop();
});

test('a client that is not signed in is closed without error', async () => {
  const pool = new ClientPool();
  pool.viewer(acct('127.0.0.1:1'));
  await assert.doesNotReject(pool.close());
});
