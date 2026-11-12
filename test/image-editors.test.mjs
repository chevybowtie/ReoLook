import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError, settingById } from '../src/device-settings.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { WriteService } from '../src/safe-write.mjs';

/** Behaves as the RLC-410 did on hardware (see the descriptors' comments). */
function device() {
  const d = {
    image: { bright: 128, channel: 0, contrast: 128, hue: 128, saturation: 128, sharpen: 128 },
    isp: { antiFlicker: 'Off', backLight: 'Off', blc: 128, blueGain: 128, channel: 0, dayNight: 'Auto', drc: 128, exposure: 'Auto', mirroring: 0, nr3d: 1, redGain: 128, rotation: 0 },
    sent: [],
  };
  d.client = {
    command: async (cmd, param) => {
      if (cmd === 'GetImage') return { Image: structuredClone(d.image) };
      if (cmd === 'GetIsp') return { Isp: structuredClone(d.isp) };
      if (cmd === 'SetImage') { d.sent.push([cmd, structuredClone(param)]); Object.assign(d.image, param.Image); return {}; }
      if (cmd === 'SetIsp') {
        d.sent.push([cmd, structuredClone(param)]);
        const p = param.Isp;
        // a back-light mode on its own is refused; a level without its mode is accepted and ignored
        if (p.backLight && p.backLight !== 'Off' && !('blc' in p) && !('drc' in p)) throw Object.assign(new Error('param error'), { detail: 'param error' });
        for (const [k, v] of Object.entries(p)) {
          if (k === 'blc' && (p.backLight ?? d.isp.backLight) !== 'BackLightControl') continue;
          if (k === 'drc' && (p.backLight ?? d.isp.backLight) !== 'DynamicRangeControl') continue;
          d.isp[k] = v;
        }
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    },
    describe: async (cmd) => (cmd === 'GetImage'
      ? { value: {}, range: { Image: Object.fromEntries(['bright', 'contrast', 'hue', 'saturation', 'sharpen'].map((k) => [k, { min: 0, max: 255 }])) } }
      : { value: {}, range: { Isp: { dayNight: ['Auto', 'Color', 'Black&White'], antiFlicker: ['Outdoor', '50HZ', '60HZ', 'Off'], backLight: ['Off', 'BackLightControl', 'DynamicRangeControl'], blc: { min: 0, max: 255 }, drc: { min: 0, max: 255 } } } }),
  };
  return d;
}
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'img-'));
  const dev = device();
  const svc = new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }) });
  return {
    dev,
    plan: (settingId, input) => svc.plan({ client: dev.client, deviceId: 'cam', settingId, input, owner: 's' }),
    apply: (id) => svc.apply({ client: dev.client, planId: id, owner: 's', by: 'adm' }),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const refused = (p, re) => assert.rejects(p, (e) => e instanceof WriteError && re.test(e.message));

test('picture: only changed fields are sent, the rest of the device is untouched, and it verifies', async () => {
  const c = setup();
  const p = await c.plan('picture', { sharpen: 140, hue: 100 });
  assert.deepEqual(p.diff.map((d) => d.path).sort(), ['hue', 'sharpen']);
  const r = await c.apply(p.planId);
  assert.equal(r.verified, true);
  assert.deepEqual(c.dev.sent, [['SetImage', { Image: { channel: 0, hue: 100, sharpen: 140 } }]]);
  c.done();
});

test('picture: values outside the device range, unknown fields and non-numbers are refused', async () => {
  const c = setup();
  await refused(c.plan('picture', { bright: 300 }), /must be from 0 to 255/);
  await refused(c.plan('picture', { gamma: 1 }), /unknown field/);
  await refused(c.plan('picture', { bright: 'high' }), /whole number/);
  assert.deepEqual(c.dev.sent, []);
  c.done();
});

test('day/night, anti-flicker and noise reduction are sent alone', async () => {
  const c = setup();
  const r = await c.apply((await c.plan('imageMode', { dayNight: 'Color', antiFlicker: '60HZ', nr3d: false })).planId);
  assert.equal(r.verified, true);
  assert.deepEqual(c.dev.sent, [['SetIsp', { Isp: { channel: 0, dayNight: 'Color', antiFlicker: '60HZ', nr3d: 0 } }]]);
  assert.equal(c.dev.isp.mirroring, 0);
  c.done();
});

test('back light: a mode travels with its own level, and a level without its mode is refused up front', async () => {
  const c = setup();
  const r = await c.apply((await c.plan('imageMode', { backLight: 'BackLightControl', blc: 100 })).planId);
  assert.equal(r.verified, true);
  assert.deepEqual(c.dev.sent.at(-1), ['SetIsp', { Isp: { channel: 0, backLight: 'BackLightControl', blc: 100 } }]);
  const fresh = setup();
  await refused(fresh.plan('imageMode', { blc: 50 }), /only applies in BackLightControl mode/);
  await refused(fresh.plan('imageMode', { drc: 50 }), /only applies in DynamicRangeControl mode/);
  // switching mode alone is accepted by planning and carries the current level so the device takes it
  const p = await fresh.plan('imageMode', { backLight: 'DynamicRangeControl' });
  await fresh.apply(p.planId);
  assert.deepEqual(fresh.dev.sent.at(-1), ['SetIsp', { Isp: { channel: 0, backLight: 'DynamicRangeControl', drc: 128 } }]);
  c.done(); fresh.done();
});

test('enumerated values must be ones the device lists', async () => {
  const c = setup();
  await refused(c.plan('imageMode', { dayNight: 'Night' }), /dayNight must be one of: Auto, Color, Black&White/);
  await refused(c.plan('imageMode', { antiFlicker: '' }), /antiFlicker must be one of/);
  c.done();
});

test('image settings are read from the device by their own descriptors', async () => {
  const c = setup();
  assert.deepEqual(await settingById('picture').read(c.dev.client), { bright: 128, contrast: 128, hue: 128, saturation: 128, sharpen: 128 });
  assert.deepEqual(await settingById('imageMode').read(c.dev.client), { dayNight: 'Auto', antiFlicker: 'Off', backLight: 'Off', blc: 128, drc: 128, nr3d: true });
  c.done();
});

test('undoing a back-light change restores the level of the mode that was left (found on hardware)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'img-'));
  const dev = device();
  const svc = new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }) });
  const original = structuredClone(dev.isp);
  const plan = await svc.plan({ client: dev.client, deviceId: 'cam', settingId: 'imageMode', input: { backLight: 'BackLightControl', blc: 110 }, owner: 's' });
  const r = await svc.apply({ client: dev.client, planId: plan.planId, owner: 's', by: 'adm' });
  assert.equal(dev.isp.blc, 110);
  const u = await svc.undo({ client: dev.client, changeId: r.id, by: 'adm' });
  assert.equal(u.verified, true);
  assert.deepEqual(dev.isp, original);
  rmSync(dir, { recursive: true, force: true });
});

test('orientation: mirror and rotate are sent one field at a time, and read back', async () => {
  const c = setup();
  assert.deepEqual(await settingById('orientation').read(c.dev.client), { mirrored: false, rotated: false });
  const r = await c.apply((await c.plan('orientation', { rotated: true })).planId);
  assert.equal(r.verified, true);
  assert.deepEqual(c.dev.sent, [['SetIsp', { Isp: { channel: 0, rotation: 1 } }]]);
  await refused(c.plan('orientation', { upsideDown: true }), /unknown field/);
  c.done();
});
