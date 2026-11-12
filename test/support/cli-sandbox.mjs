// Runs bin/reolook.mjs as a subprocess with an isolated HOME, so nothing of the developer's own
// configuration is read or written.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'reolook.mjs');

/**
 * A throwaway home directory with a signed-in camera account (unless `signedIn` is false).
 * @param {{signedIn?: boolean, user?: string, password?: string, env?: object}} [o] `env` adds or overrides variables
 * @returns {{home: string, env: object, cli: Function, run: Function, cleanup: Function}}
 *   `cli(args, {input, timeout})` blocks and returns {code, out, err}; use it when nothing in this process must answer.
 *   `run(args, {input, timeout, cwd})` is the same but returns a promise, so an in-process fake server keeps serving.
 */
export function sandbox({ signedIn = true, user = 'viewer', password = 'secret123', env: extra = {} } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'cli-'));
  const env = { PATH: process.env.PATH, HOME: home, ...extra };
  if (signedIn) { env.REOLINK_USER = user; env.REOLINK_PASS = password; }
  const cli = (args, { input = '', timeout = 15_000 } = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8', timeout });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const run = (args, { input = '', timeout = 15_000, cwd = undefined } = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(input);
  });
  return { home, env, cli, run, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
