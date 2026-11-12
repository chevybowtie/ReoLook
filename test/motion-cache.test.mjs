// motionState: every call asks the camera unless the caller says an older answer will do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReolinkClient, SHARED_MOTION_MS } from '../src/client.mjs';
import { startFakeCamera, fail } from './support/fake-camera.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rig({ delayMs = 0 } = {}) {
  const state = { motion: 0, fail: false };
  const cam = await startFakeCamera({ delayMs, commands: { GetMdState: () => (state.fail ? fail(-1, 'busy') : { state: state.motion }) } });
  const c = new ReolinkClient({ host: cam.host, user: 'viewer', password: 'secret123' });
  const asks = () => cam.requests.filter((r) => r.cmd === 'GetMdState').length;
  return { cam, c, state, asks, done: async () => { await c.logout(); await cam.stop(); } };
}

test('by default every call asks the camera, so the answer is as fresh as the call', async () => {
  const r = await rig();
  assert.equal(await r.c.motionState(), false);
  r.state.motion = 1;
  assert.equal(await r.c.motionState(), true, 'a change is seen at once');
  assert.equal(await r.c.motionState({ channel: 0 }), true);
  assert.equal(r.asks(), 3);
  await r.done();
});

test('a patient caller reuses a recent answer, and asks again once it is too old', async () => {
  const r = await rig();
  assert.equal(await r.c.motionState({ maxAgeMs: 200 }), false);
  r.state.motion = 1;
  assert.equal(await r.c.motionState({ maxAgeMs: 200 }), false, 'still the answer from a moment ago');
  assert.equal(r.asks(), 1);
  await sleep(250);
  assert.equal(await r.c.motionState({ maxAgeMs: 200 }), true, 'too old: asked again');
  assert.equal(r.asks(), 2);
  await r.done();
});

test('every answer, even to a caller that wanted a fresh one, can be reused by a patient caller', async () => {
  const r = await rig();
  r.state.motion = 1;
  await r.c.motionState();                                             // the recorder's poll
  assert.equal(await r.c.motionState({ maxAgeMs: SHARED_MOTION_MS }), true);
  assert.equal(r.asks(), 1, 'the detector did not ask the camera again');
  await r.done();
});

test('a caller that wants a fresh answer is never given an old one', async () => {
  const r = await rig();
  await r.c.motionState({ maxAgeMs: 5000 });
  r.state.motion = 1;
  assert.equal(await r.c.motionState(), true);
  assert.equal(r.asks(), 2);
  await r.done();
});

test('patient callers that arrive while a request is on its way share it', async () => {
  const r = await rig({ delayMs: 60 });
  r.state.motion = 1;
  const out = await Promise.all([r.c.motionState({ maxAgeMs: 500 }), r.c.motionState({ maxAgeMs: 500 }), r.c.motionState({ maxAgeMs: 500 })]);
  assert.deepEqual(out, [true, true, true]);
  assert.equal(r.asks(), 1);
  await r.done();
});

test('a patient caller joins a fresh caller\'s request in flight, but a fresh caller always makes its own', async () => {
  const r = await rig({ delayMs: 60 });
  const [a, b, c] = await Promise.all([r.c.motionState(), r.c.motionState({ maxAgeMs: 500 }), r.c.motionState()]);
  assert.deepEqual([a, b, c], [false, false, false]);
  assert.equal(r.asks(), 2, 'two fresh calls, and the patient one rode along with one of them');
  await r.done();
});

test('channels are kept apart', async () => {
  const cam = await startFakeCamera({ commands: { GetMdState: (p) => ({ state: p.channel === 1 ? 1 : 0 }) } });
  const c = new ReolinkClient({ host: cam.host, user: 'viewer', password: 'secret123' });
  assert.equal(await c.motionState({ channel: 0, maxAgeMs: 500 }), false);
  assert.equal(await c.motionState({ channel: 1, maxAgeMs: 500 }), true);
  assert.equal(await c.motionState({ channel: 0, maxAgeMs: 500 }), false);
  await c.logout(); await cam.stop();
});

test('a failure is passed on and not remembered as an answer: the next patient call asks again', async () => {
  const r = await rig();
  assert.equal(await r.c.motionState({ maxAgeMs: 100 }), false);          // a good answer is kept
  r.state.fail = true; r.state.motion = 1;
  await sleep(150);                                                       // now too old to reuse
  await assert.rejects(r.c.motionState({ maxAgeMs: 100 }), /busy/);
  await assert.rejects(r.c.motionState({ maxAgeMs: 100 }), /busy/, 'the failure was not stored as if it were an answer');
  r.state.fail = false;
  assert.equal(await r.c.motionState({ maxAgeMs: 100 }), true, 'and it recovers when the camera does');
  await r.done();
});
