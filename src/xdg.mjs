import os from 'node:os';
import path from 'node:path';

/**
 * XDG base directory. Per the spec, an unset, empty or relative value is ignored,
 * so a stray `XDG_CONFIG_HOME=` can never turn into a path relative to the cwd.
 */
export function xdgDir(kind, { env = process.env, home = os.homedir() } = {}) {
  const [name, fallback] = {
    config: ['XDG_CONFIG_HOME', '.config'], cache: ['XDG_CACHE_HOME', '.cache'], state: ['XDG_STATE_HOME', path.join('.local', 'state')],
    data: ['XDG_DATA_HOME', path.join('.local', 'share')],
  }[kind];
  const v = env[name];
  return v && path.isAbsolute(v) ? v : path.join(home, fallback);
}
