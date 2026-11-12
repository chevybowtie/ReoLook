import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError } from '../src/device-settings.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { WriteService } from '../src/safe-write.mjs';

const TABLE = '1'.repeat(168);
function device({ mailConfigured = false, ftpConfigured = false } = {}) {
  const d = {
    push: { schedule: { enable: 1, table: TABLE } },
    email: { addr1: mailConfigured ? 'a@example.org' : '', addr2: '', addr3: '', interval: '5 Minutes', nickName: '', password: mailConfigured ? 'hunter2' : '', schedule: { enable: 0, table: TABLE }, smtpPort: 465, smtpServer: 'smtp.example.org', ssl: 1, userName: mailConfigured ? 'u' : '' },
    ftp: { anonymous: 0, interval: 30, maxSize: 100, mode: 0, password: '', port: 21, remoteDir: '', schedule: { enable: 0, table: TABLE }, server: ftpConfigured ? 'ftp.example.org' : '', streamType: 0, userName: ftpConfigured ? 'cam' : '' },
    sent: [],
  };
  const merge = (obj, patch) => { for (const [k, v] of Object.entries(patch)) obj[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...obj[k], ...v } : v; };
  d.client = {
    command: async (cmd, param) => {
      if (cmd === 'GetPush') return { Push: structuredClone(d.push) };
      if (cmd === 'GetEmail') return { Email: structuredClone(d.email) };
      if (cmd === 'GetFtp') return { Ftp: structuredClone(d.ftp) };
      if (cmd === 'SetPush') { d.sent.push([cmd, structuredClone(param)]); merge(d.push, param.Push); return {}; }
      if (cmd === 'SetEmail') { d.sent.push([cmd, structuredClone(param)]); merge(d.email, param.Email); return {}; }
      if (cmd === 'SetFtp') { d.sent.push([cmd, structuredClone(param)]); merge(d.ftp, param.Ftp); return {}; }
      throw new Error(`unexpected ${cmd}`);
    },
    describe: async (cmd) => ({ value: {}, range: cmd === 'GetEmail'
      ? { Email: { interval: ['30 Seconds', '1 Minute', '5 Minutes', '10 Minutes', '30 Minutes'] } }
      : { Ftp: { interval: [15, 30, 60, 300, 600, 1800] } } }),
  };
  return d;
}
function setup(opts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'alarm-'));
  const dev = device(opts);
  const svc = new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }) });
  return { dev, svc,
    plan: (settingId, input) => svc.plan({ client: dev.client, deviceId: 'cam', settingId, input, owner: 's' }),
    apply: (id) => svc.apply({ client: dev.client, planId: id, owner: 's', by: 'adm' }),
    done: () => rmSync(dir, { recursive: true, force: true }) };
}
const refused = (p, re) => assert.rejects(p, (e) => e instanceof WriteError && re.test(e.message));

test('push: toggles the enable flag and carries the weekly table as read', async () => {
  const c = setup();
  const r = await c.apply((await c.plan('pushNotifications', { enabled: false })).planId);
  assert.equal(r.verified, true);
  assert.deepEqual(c.dev.sent, [['SetPush', { Push: { schedule: { enable: 0, table: TABLE } } }]]);
  c.done();
});

test('email cannot be turned on until a server and recipient exist; the interval must be one the device lists', async () => {
  const bare = setup();
  await refused(bare.plan('emailAlerts', { enabled: true }), /set up the mail server and a recipient/);
  const ok = setup({ mailConfigured: true });
  await refused(ok.plan('emailAlerts', { interval: '2 Minutes' }), /interval must be one of/);
  const r = await ok.apply((await ok.plan('emailAlerts', { enabled: true, interval: '10 Minutes' })).planId);
  assert.equal(r.verified, true);
  assert.deepEqual(ok.dev.sent[0], ['SetEmail', { Email: { interval: '10 Minutes', schedule: { enable: 1, table: TABLE } } }]);
  assert.equal(ok.dev.email.password, 'hunter2', 'credentials are never rewritten');
  bare.done(); ok.done();
});

test('the interval can be changed while email stays off on an unconfigured device', async () => {
  const c = setup();
  const r = await c.apply((await c.plan('emailAlerts', { interval: '30 Minutes' })).planId);
  assert.equal(r.verified, true);
  c.done();
});

test('ftp: same rules, numeric interval from the device list', async () => {
  const bare = setup();
  await refused(bare.plan('ftpUpload', { enabled: true }), /set up the FTP server and account/);
  const ok = setup({ ftpConfigured: true });
  await refused(ok.plan('ftpUpload', { interval: 45 }), /interval must be one of: 15, 30, 60, 300, 600, 1800 seconds/);
  const r = await ok.apply((await ok.plan('ftpUpload', { enabled: true, interval: 60 })).planId);
  assert.equal(r.verified, true);
  assert.deepEqual(ok.dev.sent[0], ['SetFtp', { Ftp: { interval: 60, schedule: { enable: 1, table: TABLE } } }]);
  bare.done(); ok.done();
});

test('the "configured" fact is read-only, and secrets never appear in a plan', async () => {
  const c = setup({ mailConfigured: true });
  await refused(c.plan('emailAlerts', { configured: true }), /unknown field/);
  const p = await c.plan('emailAlerts', { enabled: true });
  assert.ok(!JSON.stringify(p).includes('hunter2'));
  c.done();
});
