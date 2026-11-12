import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError, settingById } from '../src/device-settings.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { WriteService } from '../src/safe-write.mjs';

const pad = (n) => String(n).padStart(2, '0');

/** A camera with an OSD, a clock with DST rules, and NTP. The clock only moves when the test moves it. */
function device() {
  const d = {
    osd: { bgcolor: 0, channel: 0, osdChannel: { enable: 1, name: 'Front Porch', pos: 'Lower Left' }, osdTime: { enable: 1, pos: 'Lower Right' }, watermark: 0 },
    dst: { enable: 1, offset: 1, startMon: 3, startWeek: 2, startWeekday: 0, startHour: 1, startMin: 59, startSec: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 1, endMin: 59, endSec: 0 },
    time: { year: 2026, mon: 10, day: 10, hour: 21, min: 55, sec: 39, hourFmt: 1, timeFmt: 'MM/DD/YYYY', timeZone: 21600 },
    ntp: { enable: 1, interval: 60, port: 123, server: 'pfsense.lan', extra: 'keep-me' },
    sent: [], ignore: new Set(),
  };
  d.client = {
    command: async (cmd, param) => {
      switch (cmd) {
        case 'GetOsd': return { Osd: structuredClone(d.osd) };
        case 'SetOsd': d.sent.push([cmd, structuredClone(param)]); if (!d.ignore.has('osd')) d.osd = structuredClone(param.Osd); return { rspCode: 200 };
        case 'GetTime': return { Time: { ...d.time }, Dst: { ...d.dst } };
        case 'SetTime': d.sent.push([cmd, structuredClone(param)]); if (!d.ignore.has('time')) { d.time = { ...param.Time }; d.dst = { ...param.Dst }; } return { rspCode: 200 };
        case 'GetNtp': return { Ntp: { ...d.ntp } };
        case 'SetNtp': d.sent.push([cmd, structuredClone(param)]); d.ntp = { ...param.Ntp }; return { rspCode: 200 };
        default: throw new Error(`unexpected ${cmd}`);
      }
    },
  };
  return d;
}
function setup(nowRef = { t: Date.UTC(2026, 9, 10, 21, 56, 0) }, regOpts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-'));
  const dev = device();
  const svc = new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }), now: () => nowRef.t, ...regOpts });
  const plan = (settingId, input) => svc.plan({ client: dev.client, deviceId: 'cam', settingId, input, owner: 's' });
  const apply = (planId) => svc.apply({ client: dev.client, planId, owner: 's', by: 'adm' });
  return { dev, svc, plan, apply, nowRef, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const bad = (fn, re) => assert.throws(fn, (e) => e instanceof WriteError && re.test(e.message));

test('OSD: reads a flat model; validation rejects unknown fields, bad positions and bad text', async () => {
  const c = setup();
  assert.deepEqual(await settingById('osd').read(c.dev.client), {
    showName: true, name: 'Front Porch', namePosition: 'Lower Left', showTime: true, timePosition: 'Lower Right', watermark: false });
  const v = settingById('osd').validate;
  assert.deepEqual(v({ name: '  Porch  ' }), { name: 'Porch' });
  bad(() => v({}), /nothing to change/);
  bad(() => v({ color: 'red' }), /unknown field "color"/);
  bad(() => v({ namePosition: 'Middle' }), /namePosition must be one of/);
  bad(() => v({ showTime: 'yes' }), /true or false/);
  bad(() => v({ name: 'x'.repeat(32) }), /at most 31/);
  bad(() => v({ name: 'a\nb' }), /control characters/);
  bad(() => v(null), /expected an object/);
  c.done();
});

test('OSD: a partial change shows only that field and sends the whole object back, keeping what it does not own', async () => {
  const c = setup();
  const p = await c.plan('osd', { name: 'Front Porch (north)', timePosition: 'Top Center' });
  assert.deepEqual(p.diff.map((d) => d.path).sort(), ['name', 'timePosition']);
  assert.deepEqual(c.dev.sent, [], 'planning wrote nothing');
  const r = await c.apply(p.planId);
  assert.equal(r.verified, true);
  const [, sent] = c.dev.sent[0];
  assert.equal(sent.Osd.bgcolor, 0, 'a field the editor does not own is preserved');
  assert.equal(sent.Osd.channel, 0);
  assert.deepEqual(sent.Osd.osdChannel, { enable: 1, name: 'Front Porch (north)', pos: 'Lower Left' });
  assert.deepEqual(sent.Osd.osdTime, { enable: 1, pos: 'Top Center' });
  const off = await c.plan('osd', { showTime: false });
  await c.apply(off.planId);
  assert.deepEqual(c.dev.osd.osdTime, { enable: 0, pos: 'Top Center' }, 'hiding the time keeps its position');
  c.done();
});

test('OSD: undo restores the earlier text; a device that ignores the write is reported unverified', async () => {
  const c = setup();
  const r = await c.apply((await c.plan('osd', { name: 'Garage' })).planId);
  const undone = await c.svc.undo({ client: c.dev.client, changeId: r.id, by: 'adm' });
  assert.equal(undone.verified, true); assert.equal(c.dev.osd.osdChannel.name, 'Front Porch');
  c.dev.ignore.add('osd');
  const ignored = await c.apply((await c.plan('osd', { name: 'Ignored' })).planId);
  assert.equal(ignored.verified, false); assert.equal(ignored.state, 'unverified');
  c.done();
});

test('time zone: shows the familiar signed UTC offset and preserves the DST rules and clock on write', async () => {
  const c = setup();
  assert.deepEqual(await settingById('timeZone').read(c.dev.client), { utcOffsetMinutes: -360, dstEnabled: true });
  const p = await c.plan('timeZone', { utcOffsetMinutes: -300 });
  assert.deepEqual(p.diff, [{ path: 'utcOffsetMinutes', from: -360, to: -300, secret: false }]);
  const r = await c.apply(p.planId);
  assert.equal(r.verified, true);
  assert.equal(c.dev.time.timeZone, 18000, 'stored as seconds west of UTC');
  assert.equal(c.dev.time.hour, 21, 'the clock fields are untouched');
  assert.equal(c.dev.dst.startMon, 3, 'the DST rules are untouched');
  const off = await c.plan('timeZone', { dstEnabled: false });
  await c.apply(off.planId);
  assert.equal(c.dev.dst.enable, 0); assert.equal(c.dev.dst.endMon, 11);
  const v = settingById('timeZone').validate;
  bad(() => v({ utcOffsetMinutes: -355 }), /steps of 15/);
  bad(() => v({ utcOffsetMinutes: 900 }), /from -720 to 840/);
  bad(() => v({ utcOffsetMinutes: 1.5 }), /UTC offset in minutes/);
  c.done();
});

test('clock: the target is the time of the write, and a moving clock never causes a false conflict', async () => {
  const ref = { t: new Date(2026, 9, 10, 22, 0, 0).getTime() };   // local wall clock 22:00:00
  const c = setup(ref);
  c.dev.time = { ...c.dev.time, hour: 21, min: 59, sec: 50 };    // camera 10 s behind
  const p = await c.plan('clock', { syncToComputer: true });
  assert.deepEqual(p.diff, [{ path: 'time', from: '2026-10-10 21:59:50', to: '2026-10-10 22:00:00', secret: false }]);
  assert.equal(p.risk, 'low');
  // two minutes pass between the review and the click; the camera's own clock also moved
  ref.t += 120_000;
  c.dev.time = { ...c.dev.time, hour: 22, min: 1, sec: 50 };
  const r = await c.apply(p.planId);                              // must not be a 409
  assert.equal(r.verified, true);
  const [, sent] = c.dev.sent[0];
  assert.deepEqual([sent.Time.hour, sent.Time.min, sent.Time.sec], [22, 2, 0], 'written with the time of the click, not of the review');
  assert.equal(sent.Time.timeZone, 21600, 'time zone untouched');
  assert.equal(sent.Dst.enable, 1);
  c.done();
});

test('clock: verification tolerates a second or two but not a write the device ignored; it is never undoable', async () => {
  const ref = { t: new Date(2026, 9, 10, 22, 0, 0).getTime() };
  const c = setup(ref);
  c.dev.ignore.add('time');
  const r = await c.apply((await c.plan('clock', { syncToComputer: true })).planId);
  assert.equal(r.verified, false);
  assert.equal(r.undoable, false);
  await assert.rejects(c.svc.undo({ client: c.dev.client, changeId: r.id, by: 'adm' }), (e) => e.status === 409 && /cannot be undone/.test(e.message));
  const v = settingById('clock');
  assert.equal(v.verifyEqual({ time: '2026-10-10 22:00:02' }, { time: '2026-10-10 22:00:00' }, { elapsedMs: 0 }), true);
  assert.equal(v.verifyEqual({ time: '2026-10-10 22:00:01' }, { time: '2026-10-10 22:00:00' }, { elapsedMs: 1000 }), true);
  assert.equal(v.verifyEqual({ time: '2026-10-10 22:00:30' }, { time: '2026-10-10 22:00:00' }, { elapsedMs: 0 }), false);
  assert.equal(v.verifyEqual({ time: '' }, { time: '2026-10-10 22:00:00' }), false);
  bad(() => v.validate({ time: '2020-01-01 00:00:00' }), /only "set to this computer/);
  bad(() => v.validate({ syncToComputer: false }), /only "set to this computer/);
  c.done();
});

test('NTP: reads and writes the real shape, keeps fields it does not own, and validates', async () => {
  const c = setup();
  assert.deepEqual(await settingById('ntp').read(c.dev.client), { enabled: true, server: 'pfsense.lan', port: 123, intervalMinutes: 60 });
  const p = await c.plan('ntp', { server: 'time.cloudflare.com', intervalMinutes: 1440 });
  assert.deepEqual(p.diff.map((d) => d.path).sort(), ['intervalMinutes', 'server']);
  const r = await c.apply(p.planId);
  assert.equal(r.verified, true);
  assert.equal(c.dev.ntp.server, 'time.cloudflare.com'); assert.equal(c.dev.ntp.interval, 1440);
  assert.equal(c.dev.ntp.extra, 'keep-me');
  const v = settingById('ntp').validate;
  bad(() => v({ server: 'http://x' }), /host name or IP/);
  bad(() => v({ server: '' }), /host name or IP/);
  bad(() => v({ server: 'a b' }), /host name or IP/);
  bad(() => v({ port: 0 }), /from 1 to 65535/);
  bad(() => v({ intervalMinutes: 2.5 }), /whole number/);
  assert.deepEqual(v({ enabled: false }), { enabled: false });
  c.done();
});

test('every new editor needs the capability its feature id names', () => {
  for (const [id, feature] of [['osd', 'osd'], ['timeZone', 'time'], ['clock', 'time'], ['ntp', 'ntp'], ['deviceName', 'deviceName']]) {
    assert.equal(settingById(id).feature, feature, id);
  }
});
