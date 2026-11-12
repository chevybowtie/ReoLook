import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdgDir } from '../src/xdg.mjs';
import { paths } from '../src/service-install.mjs';
import { defaultConfigPath } from '../src/config.mjs';

test('xdgDir honours an absolute value and ignores unset, empty and relative ones', () => {
  const home = '/home/u';
  assert.equal(xdgDir('config', { env: { XDG_CONFIG_HOME: '/etc/cfg' }, home }), '/etc/cfg');
  assert.equal(xdgDir('config', { env: {}, home }), '/home/u/.config');
  assert.equal(xdgDir('config', { env: { XDG_CONFIG_HOME: '' }, home }), '/home/u/.config');
  assert.equal(xdgDir('config', { env: { XDG_CONFIG_HOME: 'relative/dir' }, home }), '/home/u/.config');
  assert.equal(xdgDir('cache', { env: { XDG_CACHE_HOME: '/c' }, home }), '/c');
  assert.equal(xdgDir('cache', { env: {}, home }), '/home/u/.cache');
});

test('derived paths are absolute with the real environment, even with a stray empty XDG_CONFIG_HOME', () => {
  const saved = process.env.XDG_CONFIG_HOME;
  try {
    for (const bad of ['', 'relative/dir']) {
      process.env.XDG_CONFIG_HOME = bad;
      const p = paths({ home: '/home/u' });
      assert.equal(p.unitFile, '/home/u/.config/systemd/user/reolook.service', JSON.stringify(bad));
      assert.equal(p.envFile, '/home/u/.config/reolook/env');
    }
    process.env.XDG_CONFIG_HOME = '/custom/cfg';
    assert.equal(paths({ home: '/home/u' }).envFile, '/custom/cfg/reolook/env');
  } finally { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; }
  assert.ok(defaultConfigPath.startsWith('/'));
});
