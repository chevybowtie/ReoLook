// Several requests in flight on one client share one session: one sign-in, and one renewal if the
// device forgets the session, however many requests were waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReolinkClient } from '../src/client.mjs';
import { startFakeCamera, fail } from './support/fake-camera.mjs';

const client = (cam) => new ReolinkClient({ host: cam.host, user: 'viewer', password: 'secret123' });
const logins = (cam) => cam.requests.filter((r) => r.cmd === 'Login').length;

test('many commands started together on a new client sign in once', async () => {
  const cam = await startFakeCamera({ delayMs: 15, commands: { GetX: () => ({ ok: true }) } });
  const c = client(cam);
  const out = await Promise.all(Array.from({ length: 8 }, () => c.command('GetX')));
  assert.equal(out.length, 8);
  assert.ok(out.every((v) => v.ok === true));
  assert.equal(logins(cam), 1);
  assert.ok(cam.peak() > 1, 'they really did overlap');
  await c.logout(); await cam.stop();
});

test('describe and command share the same session', async () => {
  const cam = await startFakeCamera({ commands: { GetX: () => ({ ok: true }) } });
  const c = client(cam);
  await Promise.all([c.command('GetX'), c.describe('GetX'), c.command('GetX')]);
  assert.equal(logins(cam), 1);
  await c.logout(); await cam.stop();
});

test('when the device forgets the session, commands in flight together renew it once', async () => {
  const cam = await startFakeCamera({ delayMs: 15, commands: { GetX: () => ({ ok: true }) } });
  const c = client(cam);
  await c.command('GetX');
  assert.equal(logins(cam), 1);
  // the camera restarts: every token it handed out is gone
  cam.forgetSessions();
  const out = await Promise.all(Array.from({ length: 6 }, () => c.command('GetX')));
  assert.ok(out.every((v) => v.ok === true));
  assert.equal(logins(cam), 2, 'one renewal for all six, not six');
  await c.logout(); await cam.stop();
});

test('a persistent refusal is still an error, not a loop, with requests in flight', async () => {
  const cam = await startFakeCamera({ commands: { GetX: () => fail(-6, 'please login first') } });
  const c = client(cam);
  const results = await Promise.allSettled([c.command('GetX'), c.command('GetX')]);
  assert.ok(results.every((r) => r.status === 'rejected' && /please login first/.test(r.reason.message)));
  assert.ok(logins(cam) <= 4, `bounded sign-ins, got ${logins(cam)}`);
  await cam.stop();
});

test('after sign-out the next command signs in again', async () => {
  const cam = await startFakeCamera({ commands: { GetX: () => ({ ok: true }) } });
  const c = client(cam);
  await c.command('GetX'); await c.logout(); await c.command('GetX');
  assert.equal(logins(cam), 2);
  await c.logout(); await cam.stop();
});

test('a late "please login first" for the old session does not throw away a session another request already renewed', async () => {
  // after the camera forgets the session, the two GetX sent together are the 2nd and 3rd it sees: the 2nd is
  // refused quickly and renews the session; the 3rd was sent on the old session and is refused long after that
  const cam = await startFakeCamera({ delayMs: (cmd, nth) => (cmd === 'GetX' && nth === 2 ? 120 : 8), commands: { GetX: () => ({ ok: true }) } });
  const c = client(cam);
  await c.command('GetX');                 // sign in; this is the 1st GetX
  cam.forgetSessions();
  const [a, b] = await Promise.all([c.command('GetX'), c.command('GetX')]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.equal(logins(cam), 2, 'one renewal in total: the slow request reuses it');
  await c.logout(); await cam.stop();
});
