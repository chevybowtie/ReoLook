import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTools, createSystem } from '../src/system.mjs';

test('checkTools: installed, missing and failing-but-present programs', async () => {
  const exec = async (cmd) => {
    if (cmd === 'ffmpeg') return { stdout: 'ffmpeg version' };
    if (cmd === 'ffprobe') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    throw Object.assign(new Error('exit 1'), { code: 1 });
  };
  assert.deepEqual(await checkTools({ exec }), { ffmpeg: true, ffprobe: false });
  assert.deepEqual(await checkTools({ exec, tools: ['ffmpeg', 'other'] }), { ffmpeg: true, other: true }, 'a program that runs but exits non-zero is still installed');
});

test('checkTools asks each program for its version', async () => {
  const calls = [];
  await checkTools({ exec: async (c, a) => { calls.push([c, a]); return {}; }, tools: ['a', 'b'] });
  assert.deepEqual(calls.sort(), [['a', ['-version']], ['b', ['-version']]]);
});

test('linger: reads yes/no, and says unknown when loginctl fails', async () => {
  const run = (stdout) => createSystem({ user: 'paul', exec: async () => ({ stdout }) });
  assert.equal(await run('yes\n').linger(), 'yes');
  assert.equal(await run('no\n').linger(), 'no');
  assert.equal(await run('').linger(), 'no');
  const broken = createSystem({ user: 'paul', exec: async () => { throw new Error('no loginctl'); } });
  assert.equal(await broken.linger(), 'unknown');
  assert.equal(broken.user, 'paul');
});

test('setLinger enables or disables for the user, then reports the new state', async () => {
  const calls = [];
  let state = 'no';
  const sys = createSystem({ user: 'paul', exec: async (c, a) => {
    calls.push([c, ...a]);
    if (a[0] === 'enable-linger') state = 'yes'; else if (a[0] === 'disable-linger') state = 'no';
    return { stdout: state };
  } });
  assert.equal(await sys.setLinger(true), 'yes');
  assert.equal(await sys.setLinger(false), 'no');
  assert.deepEqual(calls.filter((c) => /able-linger/.test(c[1])), [['loginctl', 'enable-linger', 'paul'], ['loginctl', 'disable-linger', 'paul']]);
});
