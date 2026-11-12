// buildProfile reads many independent things from a camera. It does so a few at a time; the profile
// must still come out exactly as if the reads had been made one after another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, buildProfile } from '../src/capabilities.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A client whose probes take a while (so overlap shows) and whose answers depend only on the command. */
function client({ delayMs = 5 } = {}) {
  const c = { calls: [], now: 0, peak: 0 };
  c.devInfo = async () => ({ model: 'M1', name: 'Cam', firmVer: 'v9', hardVer: 'h1', channelNum: 1 });
  c.ability = async () => ({ devInfo: { permit: 4 }, devName: { permit: 6 }, ntp: { permit: 0 }, abilityChn: [{ enc: { permit: 6 } }] });
  c.probe = async (cmd, param) => {
    c.calls.push([cmd, param]);
    c.now++; c.peak = Math.max(c.peak, c.now);
    await sleep(delayMs);
    c.now--;
    if (cmd === 'GetDevInfo' || cmd === 'GetDevName' || cmd === 'GetEnc') return { ok: true, kind: 'ok', value: {} };
    if (cmd === 'GetNtp') return { ok: false, kind: 'unsupported', code: -9, detail: 'not support' };
    return { ok: false, kind: 'error', code: null, detail: `no answer for ${cmd}` };
  };
  return c;
}

const NOW = () => new Date('2026-11-10T12:00:00Z');

test('every feature is listed in order, with its probes\' evidence in order', async () => {
  const p = await buildProfile(client(), { now: NOW });
  assert.deepEqual(Object.keys(p.features), FEATURES.map((f) => f.id));
  for (const f of FEATURES) assert.deepEqual(p.features[f.id].evidence.map((e) => e.split(':')[0]), f.probes.map(([cmd]) => cmd), f.id);
  for (const f of FEATURES) {
    for (const e of p.features[f.id].evidence.filter((x) => / error /.test(x))) {
      const [, cmd, asked] = /^(\w+): error \(no answer for (\w+)\)$/.exec(e);
      assert.equal(asked, cmd, `${f.id}: the outcome recorded for ${cmd} is the one the camera gave for ${cmd}`);
    }
  }
  assert.equal(p.features.general.state, 'supported');
  assert.equal(p.features.ntp.state, 'unsupported');
  assert.equal(p.features.image.evidence.length, 2, 'a feature with two probes keeps both');
  assert.match(p.features.time.evidence[0], /^GetTime: error \(no answer for GetTime\)$/);
  assert.equal(p.builtAt, '2026-11-10T12:00:00.000Z');
  assert.deepEqual([p.model, p.name, p.firmware, p.hardware, p.channels, p.source], ['M1', 'Cam', 'v9', 'h1', 1, 'ability+reads']);
});

test('every probe is made exactly once, with the channel\'s parameters', async () => {
  const c = client();
  await buildProfile(c, { channel: 2 });
  const expected = FEATURES.flatMap((f) => f.probes.map(([cmd, make]) => [cmd, make(2)]));
  assert.equal(c.calls.length, expected.length);
  assert.deepEqual([...c.calls].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), expected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
});

test('a few reads are in flight together, never more than the cap', async () => {
  const c = client({ delayMs: 10 });
  await buildProfile(c);
  assert.ok(c.peak > 1, `reads overlapped (peak ${c.peak})`);
  assert.ok(c.peak <= 4, `but not beyond the cap (peak ${c.peak})`);
});

test('the answer does not depend on which read finishes first', async () => {
  const slowFirst = client();
  const base = slowFirst.probe;
  slowFirst.probe = async (cmd, param) => { if (slowFirst.calls.length === 0) await sleep(40); return base(cmd, param); };
  const a = await buildProfile(slowFirst, { now: NOW });
  const b = await buildProfile(client({ delayMs: 0 }), { now: NOW });
  assert.deepEqual(a, b);
});

test('a camera that will not give its report still yields a profile built from reads alone', async () => {
  const c = client();
  c.ability = async () => { throw new Error('permission denied'); };
  const p = await buildProfile(c, { now: NOW });
  assert.equal(p.source, 'reads-only');
  assert.equal(p.abilityError, 'permission denied');
  assert.equal(p.features.general.state, 'supported');
});
