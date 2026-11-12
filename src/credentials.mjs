import { readFile, stat, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { xdgDir } from './xdg.mjs';
import path from 'node:path';

export const defaultEnvPath = path.join(xdgDir('config'), 'reolook', 'env');

/** KEY=VALUE lines; `#` comments and blank lines ignored; one pair of quotes stripped. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Other settings kept in the same private file (the MQTT account). Environment wins, then the file,
 * which must not be readable by others. Missing file gives {}.
 */
export async function loadEnvVars({ env = process.env, file = defaultEnvPath, names = ['REOLOOK_MQTT_USER', 'REOLOOK_MQTT_PASS'] } = {}) {
  const out = {};
  let fromFile = {};
  try {
    const st = await stat(file);
    if (!(st.mode & 0o077)) fromFile = parseEnvFile(await readFile(file, 'utf8'));
  } catch { /* none */ }
  for (const n of names) out[n] = env[n] || fromFile[n] || '';
  return out;
}

/**
 * Camera sign-in. Environment wins; otherwise the env file, which must not be
 * readable by group or others. Returns { user, password, source } with nulls when absent.
 */
export async function loadCredentials({ env = process.env, file = defaultEnvPath } = {}) {
  if (env.REOLINK_USER && env.REOLINK_PASS) return { user: env.REOLINK_USER, password: env.REOLINK_PASS, source: 'environment' };
  let st;
  try { st = await stat(file); } catch (e) { if (e.code === 'ENOENT') return { user: null, password: null, source: null }; throw e; }
  if (st.mode & 0o077) throw new Error(`${file} is readable by other users; run: chmod 600 ${file}`);
  const vars = parseEnvFile(await readFile(file, 'utf8'));
  if (!vars.REOLINK_USER || !vars.REOLINK_PASS) return { user: null, password: null, source: null };
  return { user: vars.REOLINK_USER, password: vars.REOLINK_PASS, source: file };
}

/**
 * Create the sign-in file: mode 600 from the first byte (written to a private temp file, then renamed).
 * Refuses to replace an existing file unless `force`. Values may not hold a newline or begin or end
 * with whitespace or a quote, since the reader would not give them back unchanged.
 */
export async function writeEnvFile({ file = defaultEnvPath, user, password, force = false } = {}) {
  for (const [what, v] of [['user name', user], ['password', password]]) {
    if (typeof v !== 'string' || !v) throw new Error(`the ${what} is empty`);
    if (/[\r\n\0]/.test(v) || v !== v.trim() || /^["']|["']$/.test(v)) throw new Error(`the ${what} cannot contain a line break, or begin or end with a space or quote`);
  }
  try { await stat(file); if (!force) throw new Error(`${file} already exists; use --force to replace it`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `REOLINK_USER=${user}\nREOLINK_PASS=${password}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  return file;
}
