import { access, constants } from 'node:fs/promises';
import path from 'node:path';

/** First candidate found on PATH, or null. */
export const BROWSERS = ['brave-browser', 'brave', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

/**
 * The full path of an executable: `cmd` itself if it contains a slash, otherwise the first match on `pathVar`. @returns {Promise<string|null>}
 */
export async function which(cmd, pathVar = process.env.PATH ?? '') {
  if (cmd.includes('/')) { try { await access(cmd, constants.X_OK); return cmd; } catch { return null; } }
  for (const dir of pathVar.split(':').filter(Boolean)) {
    const p = path.join(dir, cmd);
    try { await access(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/** The first Chromium-family browser found (or the one asked for). @returns {Promise<string|null>} its path */
export async function findBrowser({ preferred = null, whichFn = which } = {}) {
  for (const name of preferred ? [preferred] : BROWSERS) {
    const p = await whichFn(name);
    if (p) return p;
  }
  return null;
}

/** Chromium-family "application window": no tabs, no address bar. */
export const appArgs = (url) => [`--app=${url}`, '--class=ReoLook', '--name=ReoLook'];

/** True only if something answering as ReoLook is listening (not just any server on the port). */
export async function isUp(port, fetchFn = fetch) {
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const body = await r.json();
    return Array.isArray(body.cameras);
  } catch { return false; }
}

/**
 * Make sure the server answers. Returns 'already-running' or 'started'.
 * `start()` must launch it detached; we then poll until it answers or time runs out.
 */
export async function ensureServer({ port, start, up = isUp, timeoutMs = 15_000, intervalMs = 250 }) {
  if (await up(port)) return 'already-running';
  await start();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await up(port)) return 'started';
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`the ReoLook server did not answer on port ${port} within ${Math.round(timeoutMs / 1000)}s (see its log)`);
}

/**
 * True when systemd is running or starting the ReoLook service, in which case the launcher
 * must only wait for it and never start a second server on the same port.
 */
export async function managedByService(statusFn) {
  try {
    const st = await statusFn();
    return st.active === 'active' || st.active === 'activating' || st.active === 'reloading';
  } catch { return false; }
}
