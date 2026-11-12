import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { q, renderUnit, planInstall, applyInstall, uninstall, status, UNIT_NAME } from '../src/service-install.mjs';

const creds = { user: 'observer', password: 'pw-123' };
const base = (xdg) => ({ node: '/usr/bin/node', bin: '/opt/reo look/bin/reolook.mjs', workDir: '/opt/reo look', xdgConfig: xdg, creds });
const fakeExec = () => { const calls = []; const fn = async (c, a) => { calls.push([c, ...a].join(' ')); return { stdout: 'ok' }; }; fn.calls = calls; return fn; };
const dir = () => mkdtempSync(path.join(tmpdir(), 'svc-'));

test('q quotes only when needed', () => {
  assert.equal(q('/usr/bin/node'), '/usr/bin/node');
  assert.equal(q('/opt/reo look/x'), '"/opt/reo look/x"');
  assert.equal(q('a"b'), '"a\\"b"');
});

test('unit runs `serve` with absolute paths, quotes spaces, and carries no credentials', () => {
  const u = renderUnit({ node: '/usr/bin/node', bin: '/opt/reo look/bin/reolook.mjs', workDir: '/opt/reo look', envFile: '/h/.config/reolook/env', configFile: '/h/c.json' });
  assert.match(u, /^ExecStart=\/usr\/bin\/node "\/opt\/reo look\/bin\/reolook.mjs" serve --config \/h\/c.json$/m);
  assert.match(u, /^EnvironmentFile=\/h\/.config\/reolook\/env$/m);
  assert.match(u, /^WorkingDirectory="\/opt\/reo look"$/m);
  assert.match(u, /^KillSignal=SIGTERM$/m);
  assert.match(u, /^WantedBy=default.target$/m);
  assert.ok(!/pw-|PASS/.test(u), 'no secrets in the unit file');
});

test('plan lists what will happen and writes nothing', async () => {
  const x = dir();
  const plan = await planInstall({ ...base(x), linger: true });
  assert.deepEqual(plan.steps.map((s) => s.id), ['unit', 'env', 'reload', 'enable', 'linger']);
  assert.equal(plan.steps[0].action, 'create'); assert.equal(plan.steps[1].action, 'create');
  assert.ok(!existsSync(path.join(x, 'systemd')), 'planning wrote nothing');
  assert.match(plan.steps.find((s) => s.id === 'enable').text, /enable --now reolook.service/);
  rmSync(x, { recursive: true, force: true });
});

test('plan is blocked, not silently empty, when there is no sign-in to store', async () => {
  const x = dir();
  const plan = await planInstall({ ...base(x), creds: { user: null, password: null } });
  const env = plan.steps.find((s) => s.id === 'env');
  assert.equal(env.blocked, true);
  await assert.rejects(() => applyInstall(plan, { creds: {}, exec: fakeExec() }), /REOLINK_USER/);
  rmSync(x, { recursive: true, force: true });
});

test('install writes the unit and a mode-600 env file, then reloads and enables', async () => {
  const x = dir(); const exec = fakeExec();
  const plan = await planInstall(base(x));
  const done = await applyInstall(plan, { creds, exec });
  const unit = path.join(x, 'systemd', 'user', UNIT_NAME), env = path.join(x, 'reolook', 'env');
  assert.equal(readFileSync(unit, 'utf8'), plan.unit);
  assert.equal(readFileSync(env, 'utf8'), 'REOLINK_USER=observer\nREOLINK_PASS=pw-123\n');
  assert.equal(statSync(env).mode & 0o777, 0o600);
  assert.deepEqual(exec.calls, ['systemctl --user daemon-reload', 'systemctl --user enable --now reolook.service']);
  assert.ok(done.length >= 3);
  rmSync(x, { recursive: true, force: true });
});

test('re-running is a no-op; an existing env file is never overwritten', async () => {
  const x = dir();
  await applyInstall(await planInstall(base(x)), { creds, exec: fakeExec() });
  writeFileSync(path.join(x, 'reolook', 'env'), 'REOLINK_USER=someone\nREOLINK_PASS=else\n', { mode: 0o600 });
  const again = await planInstall({ ...base(x), creds: { user: 'other', password: 'other' } });
  assert.deepEqual(again.steps.filter((s) => s.id === 'unit' || s.id === 'env').map((s) => s.action), ['keep', 'keep']);
  await applyInstall(again, { creds: { user: 'other', password: 'other' }, exec: fakeExec() });
  assert.equal(readFileSync(path.join(x, 'reolook', 'env'), 'utf8'), 'REOLINK_USER=someone\nREOLINK_PASS=else\n');
  rmSync(x, { recursive: true, force: true });
});

test('a changed unit is backed up before being replaced', async () => {
  const x = dir();
  const unitFile = path.join(x, 'systemd', 'user', UNIT_NAME);
  mkdirSync(path.dirname(unitFile), { recursive: true });
  writeFileSync(unitFile, '[Service]\nExecStart=/old\n');
  const plan = await planInstall(base(x));
  assert.equal(plan.steps[0].action, 'update');
  await applyInstall(plan, { creds, exec: fakeExec() });
  assert.equal(readFileSync(`${unitFile}.bak`, 'utf8'), '[Service]\nExecStart=/old\n');
  assert.equal(readFileSync(unitFile, 'utf8'), plan.unit);
  rmSync(x, { recursive: true, force: true });
});

test('uninstall disables and removes the unit but keeps the env file', async () => {
  const x = dir(); const exec = fakeExec();
  await applyInstall(await planInstall(base(x)), { creds, exec: fakeExec() });
  const done = await uninstall({ xdgConfig: x, exec });
  assert.ok(done.some((d) => /removed/.test(d)));
  assert.ok(!existsSync(path.join(x, 'systemd', 'user', UNIT_NAME)));
  assert.ok(existsSync(path.join(x, 'reolook', 'env')), 'sign-in file kept');
  assert.ok(exec.calls.includes('systemctl --user disable --now reolook.service'));
  rmSync(x, { recursive: true, force: true });
});

test('status reports systemd answers, including a non-zero exit', async () => {
  const exec = async (c, a) => { if (a[1] === 'is-active') { const e = new Error('x'); e.stdout = 'inactive\n'; throw e; } return { stdout: 'enabled\n' }; };
  assert.deepEqual(await status({ exec }), { enabled: 'enabled', active: 'inactive' });
});
