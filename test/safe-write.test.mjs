import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEVICE_SETTINGS, WriteError, diffValues, redact, sameValue, settingById } from '../src/device-settings.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { WriteService } from '../src/safe-write.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'sw-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-memory camera speaking just GetDevName / SetDevName. */
function fakeDevice({ name = 'Front Porch', refuse = null, ignore = false, transform = (v) => v, onWrite = null, delayMs = 0 } = {}) {
  const dev = { name, writes: [], reads: 0 };
  dev.client = {
    command: async (cmd, param) => {
      if (delayMs) await sleep(delayMs);
      if (cmd === 'GetDevName') { dev.reads++; return { DevName: { name: dev.name } }; }
      if (cmd === 'SetDevName') {
        if (refuse) throw Object.assign(new Error(`SetDevName: ${refuse}`), { detail: refuse, code: -13 });
        dev.writes.push(param.DevName.name);
        onWrite?.(dev);
        if (!ignore) dev.name = transform(param.DevName.name);
        return { rspCode: 200 };
      }
      throw new Error(`unexpected ${cmd}`);
    },
  };
  return dev;
}
async function setup(opts = {}, svcOpts = {}) {
  const d = tmp();
  const log = new ChangeLog({ file: path.join(d, 'changes.jsonl') });
  const dev = fakeDevice(opts);
  const svc = new WriteService({ changeLog: log, ...svcOpts });
  return { d, log, dev, svc, file: path.join(d, 'changes.jsonl'), done: () => rmSync(d, { recursive: true, force: true }) };
}
const plan = (c, name, extra = {}) => c.svc.plan({ client: c.dev.client, deviceId: 'cam', settingId: 'deviceName', input: { name }, owner: 'adm', ...extra });
const apply = (c, planId, owner = 'adm') => c.svc.apply({ client: c.dev.client, planId, owner });
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof WriteError && e.status === status && (!re || re.test(e.message)), `expected WriteError ${status}`);

test('value helpers: equality, diff paths, redaction', () => {
  assert.equal(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(sameValue({ a: 1 }, { a: 1, b: 2 }), false);
  assert.deepEqual(diffValues({ n: 'a', x: { y: 1 } }, { n: 'b', x: { y: 1 } }), [{ path: 'n', from: 'a', to: 'b', secret: false }]);
  assert.deepEqual(diffValues({ pw: 'old' }, { pw: 'new' }, ['pw']), [{ path: 'pw', from: '(hidden)', to: '(hidden)', secret: true }]);
  assert.deepEqual(redact({ user: 'u', pw: 'x' }, ['pw']), { user: 'u', pw: '(hidden)' });
});

test('deviceName validation: trims, rejects empty, long and control characters', () => {
  const v = settingById('deviceName').validate;
  assert.deepEqual(v({ name: '  Garage  ' }), { name: 'Garage' });
  for (const bad of [{ name: '' }, { name: '   ' }, {}, null, { name: 'x'.repeat(32) }, { name: 'a\u0000b' }, { name: 'a\nb' }, { name: 5 }]) {
    assert.throws(() => v(bad), WriteError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => v({ name: 'x'.repeat(31) }));
});

test('plan: same value is a no-op that writes nothing; a change returns the exact diff and a single-use id', async () => {
  const c = await setup();
  const same = await plan(c, 'Front Porch');
  assert.equal(same.noop, true); assert.equal(same.planId, undefined);
  const p = await plan(c, 'Front Porch (north)');
  assert.equal(p.noop, false);
  assert.deepEqual(p.diff, [{ path: 'name', from: 'Front Porch', to: 'Front Porch (north)', secret: false }]);
  assert.equal(p.risk, 'low'); assert.ok(p.planId);
  assert.deepEqual(c.dev.writes, [], 'planning never writes');
  c.done();
});

test('apply: writes, reads back and verifies, logs before and after, and the plan cannot be reused', async () => {
  const c = await setup();
  const p = await plan(c, 'Driveway');
  const r = await apply(c, p.planId);
  assert.equal(r.state, 'applied'); assert.equal(r.verified, true);
  assert.deepEqual(r.before, { name: 'Front Porch' }); assert.deepEqual(r.after, { name: 'Driveway' });
  assert.equal(c.dev.name, 'Driveway'); assert.deepEqual(c.dev.writes, ['Driveway']);
  assert.equal(r.by, 'adm'); assert.equal(r.undoable, true);
  assert.ok(!('rawBefore' in r) && !('rawAfter' in r), 'internal undo data is not exposed');
  assert.equal((await c.log.list()).length, 1);
  await rejects(apply(c, p.planId), 404);
  assert.deepEqual(c.dev.writes, ['Driveway'], 'second apply wrote nothing');
  c.done();
});

test('apply refuses another session, an expired plan, and an unknown plan', async () => {
  let t = 1_000_000;
  const c = await setup({}, { now: () => t, planTtlMs: 1000 });
  const p = await plan(c, 'A');
  await rejects(apply(c, p.planId, 'someone-else'), 403);        // refused, and the plan is still there for its owner
  t += 1500;
  await rejects(apply(c, p.planId), 410, /expired/);             // the owner is too late
  await rejects(apply(c, p.planId), 404);                        // and an expired plan is gone, not retryable
  await rejects(apply(c, 'nope'), 404);
  assert.deepEqual(c.dev.writes, []);
  c.done();
});

test('apply refuses, and writes nothing, when the device changed after the plan', async () => {
  const c = await setup();
  const p = await plan(c, 'Mine');
  c.dev.name = 'Changed by someone else';
  await assert.rejects(apply(c, p.planId), (e) => e.status === 409 && /changed since you reviewed/.test(e.message) && e.current.name === 'Changed by someone else');
  assert.deepEqual(c.dev.writes, []);
  assert.equal(c.dev.name, 'Changed by someone else');
  c.done();
});

test('a device that refuses the write: the reason is surfaced, the failure is logged, nothing is undoable', async () => {
  const c = await setup({ refuse: 'permission denied' });
  const p = await plan(c, 'X');
  await assert.rejects(apply(c, p.planId), (e) => e.status === 502 && /permission denied/.test(e.message) && Boolean(e.changeId));
  const [entry] = await c.log.list();
  assert.equal(entry.state, 'failed'); assert.match(entry.error, /permission denied/); assert.equal(entry.undoable, false);
  assert.equal(c.dev.name, 'Front Porch');
  c.done();
});

test('a device that accepts but silently ignores the write is reported as unverified, never as success', async () => {
  const c = await setup({ ignore: true });
  const p = await plan(c, 'Ignored');
  const r = await apply(c, p.planId);
  assert.equal(r.verified, false); assert.equal(r.state, 'unverified');
  assert.match(r.error, /does not report the value/);
  assert.deepEqual(r.after, { name: 'Front Porch' });
  c.done();
});

test('a device that normalises the value is also reported honestly', async () => {
  const c = await setup({ transform: (v) => v.toUpperCase() });
  const r = await apply(c, (await plan(c, 'garage')).planId);
  assert.equal(r.verified, false);
  assert.deepEqual(r.after, { name: 'GARAGE' });
  c.done();
});

test('undo restores the previous value, is marked once, and refuses to overwrite a newer change', async () => {
  const c = await setup();
  const applied = await apply(c, (await plan(c, 'Renamed')).planId);
  const undone = await c.svc.undo({ client: c.dev.client, changeId: applied.id, by: 'adm' });
  assert.equal(undone.verified, true); assert.equal(undone.undoOf, applied.id);
  assert.equal(c.dev.name, 'Front Porch');
  assert.equal((await c.log.get(applied.id)).undone, true);
  await rejects(c.svc.undo({ client: c.dev.client, changeId: applied.id, by: 'adm' }), 409, /already undone/);

  const second = await apply(c, (await plan(c, 'Second')).planId);
  c.dev.name = 'Edited elsewhere';
  const writesBefore = c.dev.writes.length;
  await rejects(c.svc.undo({ client: c.dev.client, changeId: second.id, by: 'adm' }), 409, /changed again/);
  assert.equal(c.dev.writes.length, writesBefore, 'a refused undo writes nothing');
  await rejects(c.svc.undo({ client: c.dev.client, changeId: 'missing', by: 'adm' }), 404);
  c.done();
});

test('secret settings: never shown, never logged, and not offered for undo', async () => {
  const secretSetting = {
    id: 'wifiPassword', label: 'Wi-Fi', area: 'Network', feature: 'wifi', risk: 'high', restartRequired: true, secret: ['password'],
    state: { ssid: 'home', password: 'old-secret' },
    async read() { return { ...this.state }; },
    async write(_c, _ch, v) { this.state = { ...v }; },
    validate: (i) => ({ ssid: i.ssid, password: i.password }),
    equal: sameValue,
  };
  const d = tmp(), log = new ChangeLog({ file: path.join(d, 'c.jsonl') });
  const svc = new WriteService({ changeLog: log, registry: [secretSetting] });
  const p = await svc.plan({ client: {}, deviceId: 'cam', settingId: 'wifiPassword', input: { ssid: 'home', password: 'new-secret' }, owner: 'adm' });
  assert.deepEqual(p.diff, [{ path: 'password', from: '(hidden)', to: '(hidden)', secret: true }]);
  assert.ok(!/old-secret|new-secret/.test(JSON.stringify(p)), 'plan response has no secret values');
  assert.equal(p.restartRequired, true);
  const r = await svc.apply({ client: {}, planId: p.planId, owner: 'adm' });
  assert.equal(r.verified, true); assert.equal(r.undoable, false);
  const onDisk = readFileSync(path.join(d, 'c.jsonl'), 'utf8');
  assert.ok(!onDisk.includes('old-secret') && !onDisk.includes('new-secret'), 'the log file holds no secret');
  await rejects(svc.undo({ client: {}, changeId: r.id, by: 'adm' }), 409, /cannot be undone/);
  rmSync(d, { recursive: true, force: true });
});

test('writes to one device are serialised', async () => {
  const order = [];
  const c = await setup({ delayMs: 15, onWrite: (d) => order.push(`write:${d.writes.at(-1)}`) });
  const [p1, p2] = [await plan(c, 'One'), await plan(c, 'Two')];
  const results = await Promise.allSettled([apply(c, p1.planId), apply(c, p2.planId)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected', 'the second plan was made against a value the first apply changed');
  assert.equal(results[1].reason.status, 409);
  assert.deepEqual(order, ['write:One']);
  c.done();
});

test('change log persists, tolerates damaged lines, and is private', async () => {
  const d = tmp(), file = path.join(d, 'changes.jsonl');
  const a = new ChangeLog({ file });
  await a.append({ id: 'e1', at: '2026-01-01', deviceId: 'cam', undoable: true });
  await a.append({ id: 'e2', at: '2026-01-02', deviceId: 'other' });
  await a.patch('e1', { undone: true });
  writeFileSync(file, readFileSync(file, 'utf8') + 'not json at all\n');
  const b = new ChangeLog({ file });
  assert.deepEqual((await b.list()).map((e) => e.id), ['e2', 'e1'], 'newest first');
  assert.equal((await b.get('e1')).undone, true, 'the patch survives a restart');
  assert.deepEqual((await b.list({ deviceId: 'cam' })).map((e) => e.id), ['e1']);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  rmSync(d, { recursive: true, force: true });
});
