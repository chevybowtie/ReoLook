// Reolink HTTP/CGI API client. Zero dependencies; Node >= 22 (global fetch).

import { pad2 } from './format.mjs';

export class ReolinkError extends Error {
  constructor(message, { code, detail } = {}) {
    super(message);
    this.name = 'ReolinkError';
    this.code = code;
    this.detail = detail;
  }
}


/** Date -> Reolink time object (device-local wall clock as given). */
export function toReolinkTime(d) {
  return {
    year: d.getFullYear(), mon: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), min: d.getMinutes(), sec: d.getSeconds(),
  };
}

/**
 * A Reolink time object as a Date (device wall clock read in this computer's zone). @param {{year: number, mon: number, day: number, hour: number, min: number, sec: number}} t
 */
export function fromReolinkTime(t) {
  return new Date(t.year, t.mon - 1, t.day, t.hour, t.min, t.sec);
}

/** Formats a Reolink time object as `YYYY-MM-DD HH:MM:SS`. */
export function formatReolinkTime(t) {
  return `${t.year}-${pad2(t.mon)}-${pad2(t.day)} ${pad2(t.hour)}:${pad2(t.min)}:${pad2(t.sec)}`;
}

/** How old a motion answer a patient caller (the detector, the web page) accepts, in ms. */
export const SHARED_MOTION_MS = 500;

/** host -> (opts) => stream address; used by the demo cameras, which have no RTSP server. */
export const streamOverrides = new Map();

export class ReolinkClient {
  #base; #user; #pass; #hostname; #token = null; #signingIn = null; #motion = new Map();

  constructor({ host, user, password, https = false, timeoutMs = 10_000 }) {
    if (!host) throw new ReolinkError('host is required');
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.#user = user;
    this.#pass = password;
    this.#base = `${https ? 'https' : 'http'}://${host}/cgi-bin/api.cgi`;
    this.#hostname = new URL(`http://${host}`).hostname; // host may include an HTTP port
  }

  /**
   * Sends one command to the device's API and returns the reply. @throws {ReolinkError} for an HTTP failure or an error the device reports, carrying its `code` and `detail`
   */
  async #post(cmd, body, { auth = true } = {}) {
    const url = new URL(this.#base);
    url.searchParams.set('cmd', cmd);
    if (auth) url.searchParams.set('token', this.#token);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([body]),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new ReolinkError(`HTTP ${res.status} for ${cmd}`);
    const [reply] = await res.json();
    if (reply.error) {
      throw new ReolinkError(`${cmd}: ${reply.error.detail ?? 'error'}`, {
        code: reply.error.rspCode, detail: reply.error.detail,
      });
    }
    return reply;
  }

  /**
   * Signs in with the account this client was made with and keeps the session token. @returns {Promise<ReolinkClient>} this client
   */
  async login() {
    const r = await this.#post('Login', {
      cmd: 'Login',
      param: { User: { Version: '0', userName: this.#user, password: this.#pass } },
    }, { auth: false });
    this.#token = r.value.Token.name;
    return this;
  }

  /** Ends the session, if there is one. Best effort: a device that does not answer is simply left to expire the session. */
  async logout() {
    if (!this.#token) return;
    try { await this.#post('Logout', { cmd: 'Logout', param: {} }); } catch { /* best effort */ }
    this.#token = null;
  }

  /** Signs in once, however many callers ask meanwhile: they all wait for the same sign-in. */
  #signIn() { return this.#signingIn ??= this.login().finally(() => { this.#signingIn = null; }); }

  /** Makes sure there is a session token, signing in if there is none. */
  async #ensure() { if (!this.#token) await this.#signIn(); }

  /** The device answers "please login first" (-6) once it has forgotten our session, e.g. after it restarted. */
  #lostSession(e) { return e instanceof ReolinkError && e.code === -6; }

  /**
   * Sends a request on the current session. If the device says it has forgotten the session, signs in
   * again and sends it once more; a second refusal is a real one. Several requests may be in flight at
   * once: if one of them has already renewed the session, the others reuse it instead of signing in again.
   * @template T
   * @param {() => Promise<T>} send makes the request with the current token
   * @returns {Promise<T>}
   */
  async #withSession(send) {
    await this.#ensure();
    const used = this.#token;
    try { return await send(); }
    catch (e) {
      if (!this.#lostSession(e)) throw e;
      if (this.#token === used) this.#token = null;
      await this.#ensure();
      return send();
    }
  }

  /**
   * Runs a device command and returns its value.
   * @param {string} cmd command name, e.g. "GetDevInfo"
   * @param {object} [param] command parameters
   * @param {number} [action] 0 read/write, 1 read with range and default
   * @returns {Promise<object>} the reply's `value`
   */
  async command(cmd, param = {}, action = 0) {
    return (await this.#withSession(() => this.#post(cmd, { cmd, action, param }))).value;
  }

  /**
   * A read with `action: 1`, which also returns the device's own description of the value:
   * `range` (what it may be set to) and `initial` (its default). Not every command supports it.
   * @param {string} cmd
   * @param {object} [param]
   * @returns {Promise<{value: object, range: object|null, initial: object|null}>}
   */
  async describe(cmd, param = {}) {
    const r = await this.#withSession(() => this.#post(cmd, { cmd, action: 1, param }));
    return { value: r.value, range: r.range ?? null, initial: r.initial ?? null };
  }

  async devInfo() { return (await this.command('GetDevInfo')).DevInfo; }
  async time() { return this.command('GetTime'); }

  /**
   * The camera's own capability report. The firmware refuses it without the account's user
   * name, because `permit` reflects what *this account* may do, not only what the device has.
   */
  async ability() {
    return (await this.command('GetAbility', { User: { userName: this.#user } })).Ability;
  }

  /**
   * Try a read command and classify the outcome instead of throwing:
   * ok | unsupported (device says it lacks the feature) | param (we sent the wrong shape) | error.
   */
  async probe(cmd, param = {}) {
    try { return { ok: true, kind: 'ok', value: await this.command(cmd, param) }; }
    catch (e) {
      const detail = String(e.detail ?? e.message ?? '');
      if (e instanceof ReolinkError && e.code !== undefined) {
        if (/not support|ability error|not exist|not found/i.test(detail)) return { ok: false, kind: 'unsupported', code: e.code, detail };
        if (/param/i.test(detail)) return { ok: false, kind: 'param', code: e.code, detail };
      }
      return { ok: false, kind: 'error', code: e.code ?? null, detail };
    }
  }

  /** Configured encoder size per stream: { main: {width,height}, sub: {...} }. */
  async encoding({ channel = 0 } = {}) {
    const { Enc } = await this.command('GetEnc', { channel });
    // older firmware gives only a "2560*1440" size string, newer also width and height
    const dim = (s) => {
      let w = Number(s?.width), h = Number(s?.height);
      if (!(w > 0 && h > 0)) { const m = /^(\d+)\s*[*x]\s*(\d+)$/.exec(String(s?.size ?? '')); if (m) { w = Number(m[1]); h = Number(m[2]); } }
      return { width: w, height: h };
    };
    return { main: dim(Enc.mainStream), sub: dim(Enc.subStream) };
  }

  /**
   * Camera's own motion decision (honours zones set in the Reolink app).
   *
   * Several parts of ReoLook ask this of the same camera. By default every call asks the camera, so the
   * answer is as fresh as the call. A caller that can live with a slightly older answer (the detector,
   * the web page) passes `maxAgeMs`: it then gets the latest answer if that is no older, or joins a
   * request already on its way, and only otherwise asks the camera. Every answer, whoever asked for it,
   * is available to such callers.
   * @param {{channel?: number, maxAgeMs?: number}} [opts]
   * @returns {Promise<boolean>} whether the camera reports motion
   */
  async motionState({ channel = 0, maxAgeMs = 0 } = {}) {
    let seen = this.#motion.get(channel);
    if (!seen) this.#motion.set(channel, seen = { at: 0, value: false, pending: null });
    if (maxAgeMs > 0) {
      if (seen.pending) return seen.pending;
      if (seen.at && Date.now() - seen.at <= maxAgeMs) return seen.value;
    }
    const asking = this.command('GetMdState', { channel }).then((v) => Number(v.state) === 1);
    seen.pending = asking;
    try { seen.value = await asking; seen.at = Date.now(); return seen.value; }
    finally { if (seen.pending === asking) seen.pending = null; }
  }

  /** Storage devices (SD card/HDD). */
  async storage() {
    const v = await this.command('GetHddInfo');
    return v.HddInfo ?? [];
  }

  /** Days of a month that have recordings. Returns array of day numbers. */
  async recordingDays({ channel = 0, year, month, streamType = 'main' }) {
    const v = await this.command('Search', {
      Search: {
        channel, onlyStatus: 1, streamType,
        StartTime: { year, mon: month, day: 1, hour: 0, min: 0, sec: 0 },
        EndTime: { year, mon: month, day: 31, hour: 23, min: 59, sec: 59 },
      },
    }, 1);
    const status = v.SearchResult?.Status ?? [];
    const days = [];
    for (const s of status) {
      // `table` is a string of '0'/'1', one char per day of the month
      [...(s.table ?? '')].forEach((c, i) => { if (c === '1') days.push(i + 1); });
    }
    return days;
  }

  /** Recording files between two Dates. */
  async search({ channel = 0, from, to, streamType = 'main' }) {
    const v = await this.command('Search', {
      Search: {
        channel, onlyStatus: 0, streamType,
        StartTime: toReolinkTime(from), EndTime: toReolinkTime(to),
      },
    }, 1);
    const files = v.SearchResult?.File ?? [];
    return files.map((f) => ({
      name: f.name,
      size: Number(f.size),
      type: f.type,
      start: fromReolinkTime(f.StartTime),
      end: fromReolinkTime(f.EndTime),
    }));
  }

  /** URL for a recording download; contains the session token. Do not log. */
  async downloadUrl(file) {
    await this.#ensure();
    const u = new URL(this.#base);
    u.searchParams.set('cmd', 'Download');
    u.searchParams.set('source', file);
    u.searchParams.set('output', file.split('/').pop());
    u.searchParams.set('token', this.#token);
    return u;
  }

  /** JPEG snapshot as Buffer. */
  async snapshot({ channel = 0 } = {}) {
    await this.#ensure();
    const u = new URL(this.#base);
    u.searchParams.set('cmd', 'Snap');
    u.searchParams.set('channel', String(channel));
    u.searchParams.set('rs', Math.random().toString(36).slice(2, 10));
    u.searchParams.set('token', this.#token);
    const res = await fetch(u, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new ReolinkError(`HTTP ${res.status} for Snap`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new ReolinkError('Snap did not return a JPEG');
    return buf;
  }

  /** Credentialed RTSP URL (channel is 0-based). Contains the password; do not log. */
  rtspUrl({ channel = 0, stream = 'main', port = 554 } = {}) {
    const override = streamOverrides.get(this.host);
    if (override) return override({ channel, stream });
    const n = String(channel + 1).padStart(2, '0');
    const cred = `${encodeURIComponent(this.#user)}:${encodeURIComponent(this.#pass)}`;
    return `rtsp://${cred}@${this.#hostname}:${port}/h264Preview_${n}_${stream === 'main' ? 'main' : 'sub'}`;
  }

  /** Credentialed RTMP URL for live view. Contains the password; do not log. */
  rtmpUrl({ channel = 0, stream = 'sub' } = {}) {
    const name = stream === 'main' ? 'main' : 'sub';
    const q = new URLSearchParams({
      channel: String(channel), stream: stream === 'main' ? '0' : '1',
      user: this.#user, password: this.#pass,
    });
    return `rtmp://${this.#hostname}/bcs/channel${channel}_${name}.bcs?${q}`;
  }
}
