// systemd *user* unit management. Plans first; every write is additive and idempotent.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { xdgDir } from './xdg.mjs';
import path from 'node:path';

const run = promisify(execFile);
export const UNIT_NAME = 'reolook.service';

/** systemd word quoting: wrap in double quotes when needed. */
export function q(s) {
  return /[\s"'\\]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
}

/** The text of the systemd user unit that runs `reolook serve`. @returns {string} */
export function renderUnit({ node, bin, workDir, envFile, configFile = null }) {
  const exec = [q(node), q(bin), 'serve', ...(configFile ? ['--config', q(configFile)] : [])].join(' ');
  return `# Managed by \`reolook service install\`. Safe to edit; re-running install shows a diff first.
[Unit]
Description=ReoLook recorder and viewer

[Service]
Type=simple
EnvironmentFile=${q(envFile)}
WorkingDirectory=${q(workDir)}
ExecStart=${exec}
Restart=on-failure
RestartSec=10
# SIGTERM finalizes in-progress recordings; give ffmpeg time to close the files.
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

/**
 * Where the unit file and the sign-in file live, under the XDG configuration folder. @returns {{unitDir: string, unitFile: string, envFile: string}}
 */
export function paths({ home = os.homedir(), xdgConfig = null } = {}) {
  // an explicit absolute override (tests); otherwise the normal XDG rules, which ignore empty/relative values
  const cfg = xdgConfig && path.isAbsolute(xdgConfig) ? xdgConfig : xdgDir('config', { home });
  return { unitDir: path.join(cfg, 'systemd', 'user'), unitFile: path.join(cfg, 'systemd', 'user', UNIT_NAME), envFile: path.join(cfg, 'reolook', 'env') };
}

/** A file's text, or null when it does not exist. */
async function read(p) { try { return await readFile(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

/**
 * Work out what install would do, without doing it.
 * Returns { unit, steps: [{ id, text, action }] } where action is 'create' | 'update' | 'keep' | 'run'.
 */
export async function planInstall({ node = process.execPath, bin, workDir, configFile = null, creds, linger = false, now = true, home, xdgConfig, enabledCheck = null }) {
  const p = paths({ home, xdgConfig });
  const unit = renderUnit({ node, bin, workDir, envFile: p.envFile, configFile });
  const steps = [];
  const existingUnit = await read(p.unitFile);
  steps.push({ id: 'unit', file: p.unitFile, action: existingUnit === null ? 'create' : existingUnit === unit ? 'keep' : 'update',
    text: `${existingUnit === null ? 'write' : existingUnit === unit ? 'already up to date:' : 'update (previous saved as .bak)'} ${p.unitFile}` });
  let envState = 'create';
  try { await stat(p.envFile); envState = 'keep'; } catch { /* absent */ }
  steps.push({ id: 'env', file: p.envFile, action: envState,
    text: envState === 'keep' ? `keep existing ${p.envFile} (never overwritten)`
      : creds?.user && creds?.password ? `create ${p.envFile} (mode 600) with REOLINK_USER / REOLINK_PASS from the current environment`
        : `cannot create ${p.envFile}: REOLINK_USER / REOLINK_PASS are not set in this shell` , blocked: envState === 'create' && !(creds?.user && creds?.password) });
  steps.push({ id: 'reload', action: 'run', text: 'systemctl --user daemon-reload' });
  steps.push({ id: 'enable', action: 'run', text: `systemctl --user enable${now ? ' --now' : ''} ${UNIT_NAME}` });
  if (linger) steps.push({ id: 'linger', action: 'run', text: `loginctl enable-linger ${os.userInfo().username}   (start at boot without logging in)` });
  return { unit, paths: p, steps };
}

/** Apply a plan. `exec(cmd, args)` is injectable for tests. */
export async function applyInstall(plan, { creds, linger = false, now = true, exec = (c, a) => run(c, a) } = {}) {
  const { paths: p, unit, steps } = plan;
  if (steps.some((s) => s.blocked)) throw new Error(steps.find((s) => s.blocked).text);
  const done = [];
  await mkdir(p.unitDir, { recursive: true });
  const unitStep = steps.find((s) => s.id === 'unit');
  if (unitStep.action !== 'keep') {
    if (unitStep.action === 'update') await copyFile(p.unitFile, `${p.unitFile}.bak`);
    const tmp = `${p.unitFile}.tmp-${process.pid}`;
    await writeFile(tmp, unit, { mode: 0o644 });
    await rename(tmp, p.unitFile);
    done.push(`wrote ${p.unitFile}`);
  }
  if (steps.find((s) => s.id === 'env').action === 'create') {
    await mkdir(path.dirname(p.envFile), { recursive: true });
    await writeFile(p.envFile, `REOLINK_USER=${creds.user}\nREOLINK_PASS=${creds.password}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(p.envFile, 0o600);
    done.push(`created ${p.envFile} (mode 600)`);
  }
  await exec('systemctl', ['--user', 'daemon-reload']); done.push('reloaded systemd');
  await exec('systemctl', ['--user', 'enable', ...(now ? ['--now'] : []), UNIT_NAME]); done.push(`enabled${now ? ' and started' : ''} ${UNIT_NAME}`);
  if (linger) { await exec('loginctl', ['enable-linger', os.userInfo().username]); done.push('enabled linger'); }
  return done;
}

/** Disable and remove the unit. Keeps the env file and the config. */
export async function uninstall({ home, xdgConfig, exec = (c, a) => run(c, a) } = {}) {
  const p = paths({ home, xdgConfig });
  const done = [];
  try { await exec('systemctl', ['--user', 'disable', '--now', UNIT_NAME]); done.push(`disabled ${UNIT_NAME}`); } catch { /* not enabled */ }
  if ((await read(p.unitFile)) !== null) { await rm(p.unitFile); done.push(`removed ${p.unitFile}`); }
  try { await exec('systemctl', ['--user', 'daemon-reload']); } catch { /* ignore */ }
  return done;
}

/**
 * Whether the unit is enabled and active, as systemd reports. @returns {Promise<{enabled: string, active: string}>} 'unknown' when systemctl cannot say
 */
export async function status({ exec = (c, a) => run(c, a) } = {}) {
  /** Runs one `systemctl --user` query and returns its output, or what it printed on failure. */
  const get = async (args) => { try { return (await exec('systemctl', ['--user', ...args])).stdout.trim(); } catch (e) { return (e.stdout ?? '').trim() || 'unknown'; } };
  return { enabled: await get(['is-enabled', UNIT_NAME]), active: await get(['is-active', UNIT_NAME]) };
}
