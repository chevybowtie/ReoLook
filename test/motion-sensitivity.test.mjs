import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError, settingById } from '../src/device-settings.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { WriteService } from '../src/safe-write.mjs';

const WINDOWS = [[0, 0, 6, 0], [6, 0, 12, 0], [12, 0, 18, 0], [18, 0, 23, 59]];

/**
 * Behaves like the RLC-410 did on hardware: SetAlarm changes the sensitivities (both reports follow),
 * SetMdAlarm accepts a `sens` array and changes nothing.
 */
function device({ values = [10, 10, 10, 10], newOn = false, disagree = false, range = { min: 1, max: 50 } } = {}) {
  const d = { sens: WINDOWS.map(([bh, bm, eh, em], id) => ({ id, beginHour: bh, beginMin: bm, endHour: eh, endMin: em, sensitivity: values[id] })), sent: [], mdSent: [] };
  d.client = {
    command: async (cmd, param) => {
      if (cmd === 'GetAlarm') return { Alarm: { channel: 0, type: 'md', enable: 1602, scope: { cols: 2, rows: 1, table: '10' }, sens: structuredClone(d.sens) } };
      if (cmd === 'GetMdAlarm') {
        return { MdAlarm: { channel: 0, scope: { cols: 2, rows: 1, table: '10' },
          sens: d.sens.map((w) => ({ ...w, sensitivity: disagree ? w.sensitivity + 1 : w.sensitivity })), useNewSens: 1,
          newSens: { sensDef: 10, sens: [0, 1, 2, 3].map((id) => ({ id, enable: newOn && id === 0 ? 1 : 0, sensitivity: 0 })) } } };
      }
      if (cmd === 'SetAlarm') { d.sent.push(structuredClone(param)); d.sens = param.Alarm.sens; return { rspCode: 200 }; }
      if (cmd === 'SetMdAlarm') { d.mdSent.push(structuredClone(param)); return { rspCode: 200 }; }
      throw new Error(`unexpected ${cmd}`);
    },
    describe: async () => ({ value: {}, range: { MdAlarm: { sens: [{ sensitivity: range }] } }, initial: null }),
  };
  return d;
}
function setup(opts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sens-'));
  const dev = device(opts);
  const svc = new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }) });
  return {
    dev, svc,
    plan: (input) => svc.plan({ client: dev.client, deviceId: 'cam', settingId: 'motionSensitivity', input, owner: 's' }),
    apply: (id) => svc.apply({ client: dev.client, planId: id, owner: 's', by: 'adm' }),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const s = settingById('motionSensitivity');

test('read: one value per window, keyed by its times', async () => {
  const c = setup({ values: [10, 12, 14, 16] });
  assert.deepEqual(await s.read(c.dev.client), { '00:00-06:00': 10, '06:00-12:00': 12, '12:00-18:00': 14, '18:00-23:59': 16 });
  c.done();
});

test('write goes through SetAlarm, keeps the area and the other windows, and verifies on read-back', async () => {
  const c = setup();
  const p = await c.plan({ '06:00-12:00': 25 });
  assert.deepEqual(p.diff.map((d) => d.path), ['06:00-12:00']);
  const r = await c.apply(p.planId);
  assert.equal(r.verified, true);
  assert.deepEqual(c.dev.sent[0].Alarm.sens.map((w) => w.sensitivity), [10, 25, 10, 10]);
  assert.deepEqual(c.dev.sent[0].Alarm.scope, { cols: 2, rows: 1, table: '10' });
  assert.deepEqual(c.dev.sent[0].Alarm.sens[1], { id: 1, beginHour: 6, beginMin: 0, endHour: 12, endMin: 0, sensitivity: 25 });
  assert.deepEqual(c.dev.mdSent, [], 'SetMdAlarm silently ignores sens, so it is not used');
  c.done();
});

test('values outside the device range are refused at planning; so are unknown windows and junk', async () => {
  const c = setup({ range: { min: 1, max: 50 } });
  await assert.rejects(c.plan({ '00:00-06:00': 51 }), (e) => e instanceof WriteError && /between 1 and 50/.test(e.message));
  await assert.rejects(c.plan({ '00:00-06:00': 0 }), (e) => e instanceof WriteError && /between 1 and 50/.test(e.message));
  await assert.rejects(c.plan({ '01:00-02:00': 5 }), (e) => e instanceof WriteError && /no sensitivity window/.test(e.message));
  await assert.rejects(c.plan({ night: 5 }), (e) => e instanceof WriteError && /not a time window/.test(e.message));
  await assert.rejects(c.plan({ '00:00-06:00': 'high' }), (e) => e instanceof WriteError);
  await assert.rejects(c.plan({}), (e) => e instanceof WriteError);
  assert.deepEqual(c.dev.sent, []);
  c.done();
});

test('editing is refused when a scheduled newer table is switched on, or the two reports disagree', async () => {
  await assert.rejects(s.read(device({ newOn: true }).client), /newer scheduled sensitivity table/);
  await assert.rejects(s.read(device({ disagree: true }).client), /two different sensitivities/);
});

test('a device that ignores the write is reported unverified, not applied', async () => {
  const c = setup();
  const realCommand = c.dev.client.command;
  c.dev.client.command = async (cmd, param) => (cmd === 'SetAlarm' ? { rspCode: 200 } : realCommand(cmd, param));
  const r = await c.apply((await c.plan({ '00:00-06:00': 20 })).planId);
  assert.equal(r.verified, false);
  c.done();
});
