// A scriptable stand-in for a Reolink camera's HTTP API (/cgi-bin/api.cgi), for tests that need a real
// network peer: Login/Logout with a token, read commands, recording search and download, snapshots.
// It records every request so a test can check what was asked, and in what order.
//
//   const cam = await startFakeCamera({ commands: { GetHddInfo: () => ({ HddInfo: [] }) } });
//   cam.host  -> "127.0.0.1:PORT" (pass as the camera's host)
//   cam.requests -> [{ cmd, action, param, token, method }, ...]
//   cam.forgetSessions() -> every issued token stops working (a camera restart)
//   cam.peak() -> the most requests ever in flight together (needs `delayMs` to be meaningful)
//   await cam.stop()
import http from 'node:http';

/** The smallest byte sequence that passes the client's "is this a JPEG?" check. */
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

/** A reply in the device's error shape. @param {number} rspCode @param {string} detail */
export const fail = (rspCode, detail) => ({ error: { rspCode, detail } });

/**
 * Starts the fake on a free loopback port.
 * @param {object} [o]
 * @param {string} [o.user] accepted account name
 * @param {string} [o.password] accepted password
 * @param {Record<string, (param: object, ctx: {action: number, account: string}) => object>} [o.commands]
 *   handlers by command name; return the `value`, or `fail(code, detail)` for an error. A command with
 *   no handler answers like a device that lacks the feature.
 * @param {Buffer} [o.snapshot] bytes returned for Snap
 * @param {Record<string, Buffer|string>} [o.downloads] recording files by device path, for Download
 * @param {number|((cmd: string, nth: number) => number)} [o.delayMs] how long each request takes to answer, to make overlap
 *   observable; a function gets the command and how many times it has been asked so far (0 for the first)
 * @returns {Promise<{host: string, requests: object[], peak: () => number, stop: () => Promise<void>}>}
 */
export async function startFakeCamera({ user = 'viewer', password = 'secret123', commands = {}, snapshot = JPEG, downloads = {}, delayMs = 0 } = {}) {
  const requests = [];
  let inflight = 0, peak = 0;
  const asks = {};
  let issued = 0;
  const live = new Set();            // tokens currently valid

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cmd = url.searchParams.get('cmd');
    const token = url.searchParams.get('token');
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      inflight++; peak = Math.max(peak, inflight);
      const wait = typeof delayMs === 'function' ? delayMs(cmd, asks[cmd] = (asks[cmd] ?? -1) + 1) : delayMs;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      res.on('close', () => { inflight--; });
      let body = null;
      try { body = raw ? JSON.parse(raw)[0] : null; } catch { /* a GET has no body */ }
      requests.push({ method: req.method, cmd, token, action: body?.action ?? null, param: body?.param ?? null });
      const json = (code, value, error) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ cmd, code, ...(error ? { error } : { value }) }])); };

      if (cmd === 'Login') {
        const u = body?.param?.User;
        if (u?.userName !== user || u?.password !== password) return json(1, null, { rspCode: -7, detail: 'login failed' });
        const t = `tok${++issued}`; live.add(t);
        return json(0, { Token: { name: t, leaseTime: 3600 } });
      }
      if (!live.has(token)) return json(1, null, { rspCode: -6, detail: 'please login first' });
      if (cmd === 'Logout') { live.delete(token); return json(0, { rspCode: 200 }); }

      if (cmd === 'Snap') { res.setHeader('content-type', 'image/jpeg'); return res.end(snapshot); }
      if (cmd === 'Download') {
        const file = downloads[url.searchParams.get('source')];
        if (file === undefined) { res.statusCode = 404; return res.end('no such recording'); }
        res.setHeader('content-type', 'application/octet-stream'); return res.end(file);
      }

      const handler = commands[cmd];
      if (!handler) return json(1, null, { rspCode: -9, detail: 'not support' });
      const out = handler(body?.param ?? {}, { action: body?.action ?? 0, account: user });
      if (out?.error) return json(1, null, out.error);
      return json(0, out);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    host: `127.0.0.1:${server.address().port}`,
    requests,
    peak: () => peak,
    /** Invalidates every token handed out, as if the camera had restarted. */
    forgetSessions: () => live.clear(),
    stop: () => new Promise((r) => { if (!server.listening) return r(); server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** The `Search` handler's answer for a month's day table: `days` are day numbers (1-31). */
export const dayStatus = (year, mon, days) => ({ SearchResult: { Status: [{ year, mon, table: Array.from({ length: 31 }, (_, i) => (days.includes(i + 1) ? '1' : '0')).join('') }] } });

/** One recording entry as the device lists it. */
export const recording = (name, [h1, m1, s1], [h2, m2, s2], size, { year = 2026, mon = 10, day = 10, type = 'main' } = {}) => ({
  name, size: String(size), type,
  StartTime: { year, mon, day, hour: h1, min: m1, sec: s1 }, EndTime: { year, mon, day, hour: h2, min: m2, sec: s2 },
});
