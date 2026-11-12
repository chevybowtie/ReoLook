import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { status as serviceStatus } from './service-install.mjs';

const run = promisify(execFile);

/** Which of the programs ReoLook shells out to are installed. */
export async function checkTools({ exec = (c, a) => run(c, a), tools = ['ffmpeg', 'ffprobe'] } = {}) {
  const out = {};
  await Promise.all(tools.map(async (t) => {
    try { await exec(t, ['-version']); out[t] = true; } catch (e) { out[t] = e.code === 'ENOENT' ? false : true; }
  }));
  return out;
}

/** Thin, injectable wrapper over systemd/loginctl for the settings page. */
export function createSystem({ exec = (c, a) => run(c, a), user = os.userInfo().username } = {}) {
  const self = {
    service: () => serviceStatus({ exec }),
    /** Whether the user's services keep running after logout. @returns {Promise<'yes'|'no'|'unknown'>} 'unknown' if loginctl cannot say */
    async linger() {
      try {
        const { stdout } = await exec('loginctl', ['show-user', user, '-p', 'Linger', '--value']);
        return stdout.trim() === 'yes' ? 'yes' : 'no';
      } catch { return 'unknown'; }
    },
    /** Turns lingering on or off for the user. @param {boolean} on @returns {Promise<'yes'|'no'|'unknown'>} the setting as it now stands */
    async setLinger(on) {
      await exec('loginctl', [on ? 'enable-linger' : 'disable-linger', user]);
      return self.linger();
    },
    user,
  };
  return self;
}
