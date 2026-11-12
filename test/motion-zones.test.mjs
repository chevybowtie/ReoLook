import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError, settingById } from '../src/device-settings.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { WriteService } from '../src/safe-write.mjs';

const COLS = 8, ROWS = 6;
const grid = (on) => Array.from({ length: COLS * ROWS }, (_, i) => (on(i % COLS, Math.floor(i / COLS)) ? '1' : '0')).join('');
const ALL = grid(() => true);

/**
 * A camera that reports its detection area through GetAlarm and GetMdAlarm. Like a real RLC-410 it
 * accepts the area only through SetMdAlarm { channel, scope, sens } and refuses SetAlarm and a whole
 * MdAlarm object with "param error".
 */
function camera({ table = ALL, mirror = true, ignore = false } = {}) {
  const sens = [{ id: 0, beginHour: 0, beginMin: 0, endHour: 23, endMin: 59, sensitivity: 10 }];
  const d = {
    alarm: { enable: 1602, channel: 0, type: 'md', schedule: { table: '' }, action: { mail: 0, push: 0, recChannel: null },
      scope: { cols: COLS, rows: ROWS, table }, sens },
    mdTable: table, sens, sent: [], mirror, ignore,
  };
  const refuse = (detail) => Object.assign(new Error(`param error`), { code: -4, detail });
  d.client = {
    command: async (cmd, param) => {
      if (cmd === 'GetAlarm') return { Alarm: structuredClone(d.alarm) };
      if (cmd === 'GetMdAlarm') return { MdAlarm: { channel: 0, scope: { cols: COLS, rows: ROWS, table: d.mdTable }, sens: structuredClone(d.sens), useNewSens: 1, newSens: { sensDef: 10, sens: [] } } };
      if (cmd === 'SetMdAlarm') {
        const m = param.MdAlarm;
        const keys = Object.keys(m).sort().join(',');
        if (keys !== 'channel,scope,sens') throw refuse(`unexpected fields: ${keys}`);
        d.sent.push(structuredClone(param));
        if (!d.ignore) { d.alarm.scope.table = m.scope.table; if (d.mirror) d.mdTable = m.scope.table; d.sens = m.sens; }
        return { rspCode: 200 };
      }
      throw refuse(`${cmd} is not accepted`);
    },
  };
  return d;
}
function setup(opts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mz-'));
  const dev = camera(opts);
  const svc = new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }) });
  const plan = (value) => svc.plan({ client: dev.client, deviceId: 'cam', settingId: 'motionZones', input: value, owner: 's' });
  const apply = (planId) => svc.apply({ client: dev.client, planId, owner: 's', by: 'adm' });
  return { dev, svc, plan, apply, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const zones = (table) => ({ cols: COLS, rows: ROWS, table });
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof WriteError && e.status === status && re.test(e.message));

test('read: the grid as reported; a malformed area or two disagreeing areas are refused, not guessed', async () => {
  const s = settingById('motionZones');
  assert.deepEqual(await s.read(camera().client), zones(ALL));
  const short = camera(); short.alarm.scope.table = '101';
  await assert.rejects(s.read(short.client), /usable detection area/);
  const split = camera(); split.mdTable = grid((x) => x < 4);
  await assert.rejects(s.read(split.client), /two different detection areas/);
});

test('guard rails: nothing watched, wrong size, wrong length and non-0/1 cells are all refused', () => {
  const v = settingById('motionZones').validate;
  assert.throws(() => v(zones('0'.repeat(COLS * ROWS))), /at least one cell must stay watched/);
  assert.throws(() => v({ cols: COLS, rows: ROWS, table: '1' }), /does not match the grid size/);
  assert.throws(() => v({ cols: COLS, rows: ROWS, table: 'x'.repeat(COLS * ROWS) }), /0 or 1/);
  assert.throws(() => v({ cols: 0, rows: 6, table: '' }), /unusable grid size/);
  assert.throws(() => v({ cols: 9999, rows: 1, table: '' }), /unusable grid size/);
  assert.throws(() => v(null), WriteError);
  assert.doesNotThrow(() => v(zones(grid((x) => x === 0))));
});

test('a different grid size from the device is refused at planning, before anything can be written', async () => {
  const c = setup();
  await rejects(c.plan({ cols: 4, rows: 3, table: '1'.repeat(12) }), 400, /changes cells, not the grid size/);
  assert.deepEqual(c.dev.sent, []);
  c.done();
});

test('plan: a readable summary of the change, no write, and a same-grid change is a no-op', async () => {
  const c = setup();
  const same = await c.plan(zones(ALL));
  assert.equal(same.noop, true);
  const p = await c.plan(zones(grid((x) => x >= 2)));            // ignore the two left columns: 12 cells
  assert.equal(p.noop, false); assert.equal(p.risk, 'medium');
  assert.deepEqual(p.diff.map((d) => d.path), ['watched cells', 'cells changed']);
  assert.match(p.diff[0].from, /48 of 48 \(100%\)/); assert.match(p.diff[0].to, /36 of 48 \(75%\)/);
  assert.match(p.diff[1].to, /12 \(0 now watched, 12 now ignored\)/);
  assert.deepEqual(c.dev.sent, []);
  c.done();
});

test('apply: sends exactly { channel, scope, sens } through SetMdAlarm, verifies, and logs a summary', async () => {
  const c = setup();
  const target = grid((x, y) => y >= 1);
  const r = await c.apply((await c.plan(zones(target))).planId);
  assert.equal(r.verified, true); assert.equal(r.state, 'applied');
  assert.equal(c.dev.sent.length, 1);
  const md = c.dev.sent[0].MdAlarm;
  assert.deepEqual(Object.keys(md).sort(), ['channel', 'scope', 'sens']);
  assert.equal(md.scope.cols, COLS); assert.equal(md.scope.rows, ROWS); assert.equal(md.scope.table, target);
  assert.deepEqual(md.sens.map((s) => s.sensitivity), [10], 'the sensitivity windows are carried through as read');
  assert.equal(c.dev.alarm.enable, 1602, 'fields outside the request are untouched');
  assert.match(r.summary, /8 cells changed; watched 48 → 40 of 48/);
  c.done();
});

test('undo restores exactly the previous cells', async () => {
  const before = grid((x) => x % 2 === 0);
  const c = setup({ table: before });
  const r = await c.apply((await c.plan(zones(grid((x, y) => y < 3)))).planId);
  assert.equal(c.dev.alarm.scope.table, grid((x, y) => y < 3));
  const u = await c.svc.undo({ client: c.dev.client, changeId: r.id, by: 'adm' });
  assert.equal(u.verified, true);
  assert.equal(c.dev.alarm.scope.table, before);
  assert.equal(c.dev.mdTable, before);
  c.done();
});

test('a device that accepts but ignores the write is reported unverified', async () => {
  const c = setup({ ignore: true });
  const r = await c.apply((await c.plan(zones(grid((x) => x > 0)))).planId);
  assert.equal(r.verified, false); assert.equal(r.state, 'unverified');
  c.done();
});

test('a device that updates only one of its two area reports is not called a success', async () => {
  const c = setup({ mirror: false });                              // GetAlarm changes, GetMdAlarm does not
  const r = await c.apply((await c.plan(zones(grid((x) => x > 0)))).planId);
  assert.equal(r.verified, false);
  assert.match(r.error, /two different detection areas/);
  c.done();
});

test('the device changing between review and apply is refused and nothing is written', async () => {
  const c = setup();
  const p = await c.plan(zones(grid((x) => x > 0)));
  c.dev.alarm.scope.table = grid((x) => x < 4); c.dev.mdTable = c.dev.alarm.scope.table;   // edited elsewhere (e.g. the Windows app)
  await assert.rejects(c.apply(p.planId), (e) => e.status === 409 && /changed since you reviewed/.test(e.message));
  assert.deepEqual(c.dev.sent, []);
  c.done();
});
