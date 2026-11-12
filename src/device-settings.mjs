// Declarative descriptors for settings that can be changed on a device. The generic pipeline
// (safe-write.mjs) does the planning, confirming, verifying and undoing for every one of them.
import { pad2 } from './format.mjs';
import { formatReolinkTime, toReolinkTime } from './client.mjs';

export class WriteError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.name = 'WriteError'; this.status = status; Object.assign(this, extra); }
}

/** Structural equality for plain JSON values. */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && sameValue(a[k], b[k]));
}

/** Flattens nested objects into `{ 'a.b.c': value }`; arrays and other values are kept whole. @returns {object} `out` */
function flatten(v, prefix = '', out = {}) {
  if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out); }
  else out[prefix] = v;
  return out;
}

export const REDACTED = '(hidden)';

/**
 * What changes between two values, as [{ path, from, to }]. Paths in `secret` are never shown:
 * the entry says only that they changed.
 */
export function diffValues(from, to, secret = []) {
  const a = flatten(from), b = flatten(to);
  /** The value, or a placeholder for a secret path. */
  const hide = (path, v) => (secret.includes(path) ? REDACTED : v);
  const out = [];
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!sameValue(a[path], b[path])) out.push({ path, from: hide(path, a[path]), to: hide(path, b[path]), secret: secret.includes(path) });
  }
  return out;
}

/** A copy safe to log or send to the page: secret paths replaced. */
export function redact(value, secret = []) {
  const flat = flatten(value);
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split('.');
    let node = out;
    parts.slice(0, -1).forEach((p) => { node = node[p] ??= {}; });
    node[parts.at(-1)] = secret.includes(k) ? REDACTED : v;
  }
  return out;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const POSITIONS = ['Upper Left', 'Top Center', 'Upper Right', 'Lower Left', 'Bottom Center', 'Lower Right'];
/** Whether the device's 0/1/true/'1' flag means on. */
const bool = (v) => v === 1 || v === true || v === '1';

/** Keep only the fields a patch names and check each one; unknown fields are an error. */
function checkPatch(input, rules, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WriteError(`${label}: expected an object`);
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const rule = rules[k];
    if (!rule) throw new WriteError(`${label}: unknown field "${k}"`);
    out[k] = rule(v, k);
  }
  if (!Object.keys(out).length) throw new WriteError(`${label}: nothing to change`);
  return out;
}
/** A rule for a true/false field named `k`. */
const rBool = (v, k) => { if (typeof v !== 'boolean') throw new WriteError(`${k} must be true or false`); return v; };
/** A rule for a field that must be one of `set`. */
const rEnum = (set) => (v, k) => { if (!set.includes(v)) throw new WriteError(`${k} must be one of: ${set.join(', ')}`); return v; };
/** A rule for trimmed text of at most `max` characters with no control characters. */
const rText = (max) => (v, k) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if ([...t].length > max) throw new WriteError(`${k} can be at most ${max} characters`);
  if (CONTROL.test(t)) throw new WriteError(`${k} cannot contain control characters`);
  return t;
};
/** A rule for a whole number from `min` to `max`. */
const rInt = (min, max) => (v, k) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new WriteError(`${k} must be a whole number from ${min} to ${max}`);
  return v;
};


const AI_TYPES = [['people', 'people'], ['vehicle', 'vehicle'], ['animal', 'dog_cat']];
const IMAGE_FIELDS = ['bright', 'contrast', 'hue', 'saturation', 'sharpen'];
/** Reject a number outside the range the device itself reports for it. */
function checkRanges(value, constraints) {
  for (const [k, r] of Object.entries(constraints?.ranges ?? {})) {
    if (k in value && (value[k] < r.min || value[k] > r.max)) throw new WriteError(`${k} must be from ${r.min} to ${r.max}`);
  }
  return value;
}


/** IPv4 text to an unsigned 32-bit number, or null if it is not a plain dotted quad. */
function ipv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text ?? ''));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255) || m.slice(1).some((x) => x.length > 1 && x.startsWith('0'))) return null;
  return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}
/** Whether a subnet mask (as a number) is a run of ones followed by zeros, and neither empty nor full. */
function contiguousMask(m) {
  if (m === 0 || m === 0xffffffff) return false;
  const inv = (~m) >>> 0;
  return ((inv + 1) & inv) === 0;
}

/** A device clock string `YYYY-MM-DD HH:MM:SS` as milliseconds (read as UTC, so differences are exact), or NaN. */
const clockMs = (str) => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(str ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
};
/** Local wall-clock fields of an instant, in this server's time zone. */
function localClock(ms) {
  return formatReolinkTime(toReolinkTime(new Date(ms)));
}

/**
 * The registry. Each entry:
 *  id, label, area, feature (capability id that must have the write bit), risk, restartRequired,
 *  secret (paths never logged), read(client, channel) -> value, write(client, channel, value),
 *  validate(input) -> value (throws WriteError 400), equal(a, b)
 */
/**
 * How many cells of a motion-area table are watched.
 * @param {string} table one character per cell, '1' watched and '0' ignored
 * @returns {number}
 */
const watchedCells = (table) => [...table].filter((c) => c === '1').length;

/**
 * The settings that can be changed on a device. Each entry describes one setting; the pipeline in safe-write.mjs
 * calls these members, so what each must do is stated once here rather than on every entry.
 *
 * Fields: `id`, `label` and `area` name the setting; `feature` is the capability the device must report;
 * `risk` is 'low' | 'medium' | 'high'; `restartRequired` says the device restarts after a write; `secret` lists value
 * paths that are never shown or logged; `volatile` marks a value that keeps changing (a clock) and is never undone.
 *
 * Members, in the order they are used (`client` is a signed-in ReolinkClient, `channel` the camera's channel number):
 *   read(client, channel)                  the setting as the device holds it now, as a plain object; throws if the device
 *                                          answers with something unusable.
 *   validate(input)                        checks what the caller asked for and returns it cleaned; throws WriteError
 *                                          (status 400) naming the problem, so nothing is sent for a bad request.
 *   target(intent, current, { now, constraints })
 *                                          the full value to write, worked out from the request and the value just read
 *                                          (usually the two merged; without it the request is the value); throws
 *                                          WriteError for a request that cannot apply.
 *   write(client, channel, value)          sends the full target value to the device; returns nothing.
 *   equal(a, b)                            whether two values are the same setting. `conflictEqual` and `verifyEqual`
 *                                          replace it for the "changed since you looked" check and for reading back
 *                                          after a write (the latter also gets `{ elapsedMs }`).
 *   describeDiff(from, to) / summarize(from, to)
 *                                          optional readable forms of a change: a list of { path, from, to, secret } rows
 *                                          for the review, and one line for the history.
 *   constraints(client, channel)           optional: the ranges the device itself allows, or null when it does not say.
 */
export const DEVICE_SETTINGS = [
  {
    id: 'deviceName', label: 'Device name', area: 'General', feature: 'deviceName',
    risk: 'low', restartRequired: false, secret: [],
    async read(client) {
      const v = await client.command('GetDevName', {});
      return { name: String(v?.DevName?.name ?? '') };
    },
    async write(client, _channel, value) {
      await client.command('SetDevName', { DevName: { name: value.name } });
    },
    validate(input) {
      const name = typeof input?.name === 'string' ? input.name.trim() : '';
      if (!name) throw new WriteError('the device name cannot be empty');
      if ([...name].length > 31) throw new WriteError('the device name can be at most 31 characters');
      if (CONTROL.test(name)) throw new WriteError('the device name cannot contain control characters');
      return { name };
    },
    equal: sameValue,
  },
  {
    // The text drawn on the picture. Separate from the device name.
    id: 'osd', label: 'On-screen display', area: 'OSD and masks', feature: 'osd',
    risk: 'low', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const o = (await client.command('GetOsd', { channel })).Osd ?? {};
      return {
        showName: bool(o.osdChannel?.enable), name: String(o.osdChannel?.name ?? ''), namePosition: o.osdChannel?.pos ?? '',
        showTime: bool(o.osdTime?.enable), timePosition: o.osdTime?.pos ?? '', watermark: bool(o.watermark),
      };
    },
    async write(client, channel = 0, v) {
      // read-modify-write so fields this editor does not own (background colour…) are sent back as they were
      const o = (await client.command('GetOsd', { channel })).Osd ?? {};
      const next = { ...o, channel,
        osdChannel: { ...(o.osdChannel ?? {}), enable: v.showName ? 1 : 0, name: v.name, pos: v.namePosition },
        osdTime: { ...(o.osdTime ?? {}), enable: v.showTime ? 1 : 0, pos: v.timePosition },
        watermark: v.watermark ? 1 : 0 };
      await client.command('SetOsd', { Osd: next });
    },
    validate: (input) => checkPatch(input, {
      showName: rBool, name: rText(31), namePosition: rEnum(POSITIONS), showTime: rBool, timePosition: rEnum(POSITIONS), watermark: rBool,
    }, 'on-screen display'),
    target: (intent, current) => ({ ...current, ...intent }),
    equal: sameValue,
  },
  {
    id: 'timeZone', label: 'Time zone and daylight saving', area: 'Date, time, NTP', feature: 'time',
    risk: 'low', restartRequired: false, secret: [],
    async read(client) {
      const v = await client.command('GetTime', {});
      // the device stores seconds *west* of UTC; this shows the familiar signed UTC offset in minutes
      return { utcOffsetMinutes: -Math.round((v.Time?.timeZone ?? 0) / 60), dstEnabled: bool(v.Dst?.enable) };
    },
    async write(client, _channel, v) {
      const cur = await client.command('GetTime', {});
      await client.command('SetTime', {
        Time: { ...cur.Time, timeZone: -v.utcOffsetMinutes * 60 },
        Dst: { ...cur.Dst, enable: v.dstEnabled ? 1 : 0 },
      });
    },
    validate: (input) => checkPatch(input, {
      utcOffsetMinutes: (v, k) => { if (!Number.isInteger(v) || v < -720 || v > 840 || v % 15) throw new WriteError(`${k} must be a UTC offset in minutes, in steps of 15, from -720 to 840`); return v; },
      dstEnabled: rBool,
    }, 'time zone'),
    target: (intent, current) => ({ ...current, ...intent }),
    equal: sameValue,
  },
  {
    // The clock itself. Always moving, so it is compared and verified with tolerance and never undone.
    id: 'clock', label: 'Device clock', area: 'Date, time, NTP', feature: 'time',
    risk: 'low', restartRequired: false, secret: [], volatile: true,
    async read(client) {
      const v = await client.command('GetTime', {});
      return { time: v.Time ? formatReolinkTime(v.Time) : '' };
    },
    async write(client, _channel, v) {
      const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(v.time);
      if (!m) throw new WriteError('invalid time');
      const cur = await client.command('GetTime', {});
      await client.command('SetTime', {
        Time: { ...cur.Time, year: +m[1], mon: +m[2], day: +m[3], hour: +m[4], min: +m[5], sec: +m[6] },
        Dst: cur.Dst,
      });
    },
    validate(input) {
      if (!input || input.syncToComputer !== true) throw new WriteError('only "set to this computer\'s time" is supported');
      return { syncToComputer: true };
    },
    // "this computer's time", worked out when planning and again at the moment of the write
    target: (_intent, _current, { now }) => ({ time: localClock(now) }),
    conflictEqual: () => true,
    verifyEqual: (after, target, { elapsedMs = 0 } = {}) => {
      const a = clockMs(after?.time), t = clockMs(target?.time);
      return Number.isFinite(a) && Number.isFinite(t) && Math.abs(a - (t + elapsedMs)) <= 3000;
    },
    equal: (a, b) => Math.abs(clockMs(a?.time) - clockMs(b?.time)) <= 1000,
  },
  {
    id: 'ntp', label: 'Network time (NTP)', area: 'Date, time, NTP', feature: 'ntp',
    risk: 'low', restartRequired: false, secret: [],
    async read(client) {
      const n = (await client.command('GetNtp', {})).Ntp ?? {};
      return { enabled: bool(n.enable), server: String(n.server ?? ''), port: Number(n.port ?? 123), intervalMinutes: Number(n.interval ?? 0) };
    },
    async write(client, _channel, v) {
      const cur = (await client.command('GetNtp', {})).Ntp ?? {};
      await client.command('SetNtp', { Ntp: { ...cur, enable: v.enabled ? 1 : 0, server: v.server, port: v.port, interval: v.intervalMinutes } });
    },
    validate: (input) => checkPatch(input, {
      enabled: rBool,
      server: (v, k) => {
        const t = typeof v === 'string' ? v.trim() : '';
        if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/.test(t)) throw new WriteError(`${k} must be a host name or IP address`);
        return t;
      },
      port: rInt(1, 65535), intervalMinutes: rInt(1, 65535),
    }, 'NTP'),
    target: (intent, current) => ({ ...current, ...intent }),
    equal: sameValue,
  },
  {
    // Which cells of the picture the camera watches for motion. ReoLook records on this camera's
    // own motion decision, so the guard rails matter: an empty area would silently stop recording.
    id: 'motionZones', label: 'Motion detection area', area: 'Motion detection', feature: 'motion',
    risk: 'medium', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const alarm = (await client.command('GetAlarm', { Alarm: { channel, type: 'md' } })).Alarm;
      const t = alarm?.scope?.table;
      const { cols, rows } = alarm?.scope ?? {};
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || typeof t !== 'string' || t.length !== cols * rows || /[^01]/.test(t)) {
        throw new Error('the device did not report a usable detection area');
      }
      // the device also reports the area through a second command; if the two disagree, which one
      // it acts on is unknown, so editing is refused rather than guessed
      let md = null;
      try { md = (await client.command('GetMdAlarm', { channel })).MdAlarm?.scope?.table; } catch { /* optional */ }
      if (typeof md === 'string' && md !== t) throw new Error('the device reports two different detection areas; refusing to edit until that is understood');
      return { cols, rows, table: t };
    },
    async write(client, channel = 0, v) {
      // Verified on an RLC-410 (v3.0.0.136): SetMdAlarm with { channel, scope, sens } is accepted and
      // updates both GetAlarm and GetMdAlarm, changing nothing else. The whole alarm object sent
      // through SetAlarm, and the whole MdAlarm object sent through SetMdAlarm, were both refused
      // with "param error". `sens` is carried through as read so the sensitivity windows are kept.
      const md = (await client.command('GetMdAlarm', { channel })).MdAlarm;
      await client.command('SetMdAlarm', { MdAlarm: { channel, scope: { cols: v.cols, rows: v.rows, table: v.table }, sens: md.sens } });
    },
    validate(input) {
      if (!input || typeof input !== 'object') throw new WriteError('detection area: expected { cols, rows, table }');
      const { cols, rows, table } = input;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 512 || rows > 512) throw new WriteError('detection area: unusable grid size');
      if (typeof table !== 'string' || table.length !== cols * rows) throw new WriteError('detection area: the table does not match the grid size');
      if (/[^01]/.test(table)) throw new WriteError('detection area: cells must be 0 or 1');
      if (!table.includes('1')) throw new WriteError('at least one cell must stay watched: with none, the camera would never detect motion and nothing would be recorded');
      return { cols, rows, table };
    },
    target(intent, current) {
      if (intent.cols !== current.cols || intent.rows !== current.rows) {
        throw new WriteError(`the grid is ${intent.cols} x ${intent.rows} but the device uses ${current.cols} x ${current.rows}; the editor changes cells, not the grid size`);
      }
      return intent;
    },
    describeDiff(from, to) {
      const total = to.table.length, a = watchedCells(from.table), b = watchedCells(to.table);
      let added = 0, removed = 0;
      for (let i = 0; i < total; i++) { if (from.table[i] !== to.table[i]) (to.table[i] === '1' ? added++ : removed++); }
      /** A count of cells as a percentage of the grid, to one decimal. */
      const pct = (x) => `${Math.round((x / total) * 1000) / 10}%`;
      return [
        { path: 'watched cells', from: `${a} of ${total} (${pct(a)})`, to: `${b} of ${total} (${pct(b)})`, secret: false },
        { path: 'cells changed', from: '', to: `${added + removed} (${added} now watched, ${removed} now ignored)`, secret: false },
      ];
    },
    summarize(from, to) {
      const total = to.table.length;
      let changed = 0;
      for (let i = 0; i < total; i++) if (from.table[i] !== to.table[i]) changed++;
      return `${changed} cells changed; watched ${watchedCells(from.table)} → ${watchedCells(to.table)} of ${total}`;
    },
    equal: sameValue,
  },
  {
    // Whether the camera sends push notifications on alarm. The weekly table is carried through as
    // read and not edited (which day it starts on is not confirmed). Verified on an RLC-410:
    // SetPush with only { schedule: { enable, table } } works. Alarm.action.push cannot be written
    // (SetAlarm accepts and ignores it), so this is the control that exists.
    id: 'pushNotifications', label: 'Push notifications', area: 'Alarm actions', feature: 'push',
    risk: 'low', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const p = (await client.command('GetPush', { channel })).Push?.schedule;
      if (!p || (p.enable !== 0 && p.enable !== 1)) throw new Error('the device did not report its push setting');
      return { enabled: p.enable === 1 };
    },
    async write(client, channel = 0, v) {
      const p = (await client.command('GetPush', { channel })).Push?.schedule;
      await client.command('SetPush', { Push: { schedule: { ...p, enable: v.enabled ? 1 : 0 } } });
    },
    validate: (input) => checkPatch(input, { enabled: rBool }, 'push notifications'),
    target: (intent, current) => ({ ...current, ...intent }),
    equal: sameValue,
  },
  {
    // Email on alarm. The server, recipients and password are not edited here (they are secrets and
    // are shown only as configured or not); turning it on is refused until they exist.
    id: 'emailAlerts', label: 'Email alerts', area: 'Alarm actions', feature: 'email',
    risk: 'medium', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const e = (await client.command('GetEmail', { channel })).Email ?? {};
      if (!e.schedule || (e.schedule.enable !== 0 && e.schedule.enable !== 1) || typeof e.interval !== 'string') throw new Error('the device did not report its email setting');
      const configured = Boolean(String(e.smtpServer ?? '').trim()) && [e.addr1, e.addr2, e.addr3].some((a) => String(a ?? '').trim());
      return { enabled: e.schedule.enable === 1, interval: e.interval, configured };
    },
    async write(client, channel = 0, v) {
      const e = (await client.command('GetEmail', { channel })).Email ?? {};
      await client.command('SetEmail', { Email: { interval: v.interval, schedule: { ...e.schedule, enable: v.enabled ? 1 : 0 } } });
    },
    async constraints(client, channel = 0) {
      try {
        const a = (await client.describe('GetEmail', { channel })).range?.Email?.interval;
        return Array.isArray(a) && a.length ? { intervals: a } : null;
      } catch { return null; }
    },
    validate: (input) => checkPatch(input, { enabled: rBool, interval: rText(24) }, 'email alerts'),
    target(intent, current, { constraints } = {}) {
      const out = { ...current, ...intent };
      if (out.enabled && !current.configured) throw new WriteError('set up the mail server and a recipient address first (in the Reolink app or the camera\'s own page); with none, nothing could be sent');
      if (constraints?.intervals && !constraints.intervals.includes(out.interval)) throw new WriteError(`interval must be one of: ${constraints.intervals.join(', ')}`);
      return out;
    },
    equal: sameValue,
  },
  {
    // FTP upload of alarm pictures or clips. Server and credentials are not edited here.
    id: 'ftpUpload', label: 'FTP upload', area: 'Alarm actions', feature: 'ftp',
    risk: 'medium', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const f = (await client.command('GetFtp', { channel })).Ftp ?? {};
      if (!f.schedule || (f.schedule.enable !== 0 && f.schedule.enable !== 1) || !Number.isInteger(f.interval)) throw new Error('the device did not report its FTP setting');
      const configured = Boolean(String(f.server ?? '').trim()) && (f.anonymous === 1 || Boolean(String(f.userName ?? '').trim()));
      return { enabled: f.schedule.enable === 1, interval: f.interval, configured };
    },
    async write(client, channel = 0, v) {
      const f = (await client.command('GetFtp', { channel })).Ftp ?? {};
      await client.command('SetFtp', { Ftp: { interval: v.interval, schedule: { ...f.schedule, enable: v.enabled ? 1 : 0 } } });
    },
    async constraints(client, channel = 0) {
      try {
        const r = (await client.describe('GetFtp', { channel })).range?.Ftp?.interval;
        if (Array.isArray(r) && r.length) return { intervals: r };
        if (Number.isInteger(r?.min) && Number.isInteger(r?.max)) return { min: r.min, max: r.max };
        return null;
      } catch { return null; }
    },
    validate: (input) => checkPatch(input, { enabled: rBool, interval: rInt(1, 86400) }, 'FTP upload'),
    target(intent, current, { constraints } = {}) {
      const out = { ...current, ...intent };
      if (out.enabled && !current.configured) throw new WriteError('set up the FTP server and account first (in the Reolink app or the camera\'s own page); with none, nothing could be uploaded');
      if (constraints?.intervals && !constraints.intervals.includes(out.interval)) throw new WriteError(`interval must be one of: ${constraints.intervals.join(', ')} seconds`);
      if (constraints?.min !== undefined && (out.interval < constraints.min || out.interval > constraints.max)) throw new WriteError(`interval must be from ${constraints.min} to ${constraints.max} seconds`);
      return out;
    },
    equal: sameValue,
  },
  {
    // Bit rate, frame rate and profile of both streams, and audio. Resolution is shown but not edited.
    // Verified on an RLC-410 (v3.0.0.136): SetEnc refuses a stream object that is only the changed
    // fields ("set config failed") and accepts the stream object as read with the changes applied;
    // only the streams that changed need to be sent. A change restarts that stream.
    id: 'encoding', label: 'Video encoding', area: 'Encoding', feature: 'encoding',
    risk: 'medium', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const e = (await client.command('GetEnc', { channel })).Enc ?? {};
      const out = {};
      for (const [pre, key] of [['main', 'mainStream'], ['sub', 'subStream']]) {
        const st = e[key];
        if (!st || !Number.isInteger(st.bitRate) || !Number.isInteger(st.frameRate) || typeof st.profile !== 'string') throw new Error(`the device did not report the ${pre} stream`);
        out[`${pre}BitRate`] = st.bitRate; out[`${pre}FrameRate`] = st.frameRate; out[`${pre}Profile`] = st.profile;
      }
      out.audio = bool(e.audio);
      return out;
    },
    async write(client, channel = 0, v) {
      const e = (await client.command('GetEnc', { channel })).Enc ?? {};
      const param = { channel };
      for (const [pre, key] of [['main', 'mainStream'], ['sub', 'subStream']]) {
        const cur = e[key] ?? {};
        const next = { ...cur, bitRate: v[`${pre}BitRate`], frameRate: v[`${pre}FrameRate`], profile: v[`${pre}Profile`] };
        if (next.bitRate !== cur.bitRate || next.frameRate !== cur.frameRate || next.profile !== cur.profile) param[key] = next;
      }
      if (bool(e.audio) !== v.audio) param.audio = v.audio ? 1 : 0;
      if (Object.keys(param).length > 1) await client.command('SetEnc', { Enc: param });
    },
    async constraints(client, channel = 0) {
      try {
        const d = await client.describe('GetEnc', { channel });
        const cur = d.value?.Enc ?? {};
        const list = d.range?.Enc;
        if (!Array.isArray(list)) return null;
        // the list has one entry per main-stream resolution; the one in use is the one that applies
        const entry = list.find((r) => (cur.mainStream?.resolution !== undefined ? r.mainStream?.resolution === cur.mainStream.resolution : r.mainStream?.size === cur.mainStream?.size))
          ?? list.find((r) => r.mainStream?.size === cur.mainStream?.size);
        if (!entry) return null;
        /** The encoding fields ReoLook shows for one stream, null where the device did not give them. */
        const pick = (st) => ({ size: st?.size ?? null, bitRate: st?.bitRate ?? null, frameRate: st?.frameRate ?? null, profile: st?.profile ?? null });
        return { main: pick(entry.mainStream), sub: pick(entry.subStream) };
      } catch { return null; }
    },
    validate: (input) => checkPatch(input, {
      mainBitRate: rInt(1, 100000), mainFrameRate: rInt(1, 240), mainProfile: rText(16),
      subBitRate: rInt(1, 100000), subFrameRate: rInt(1, 240), subProfile: rText(16), audio: rBool,
    }, 'video encoding'),
    target(intent, current, { constraints } = {}) {
      const out = { ...current, ...intent };
      for (const pre of ['main', 'sub']) {
        const c = constraints?.[pre];
        if (!c) continue;
        for (const [field, list] of [['BitRate', c.bitRate], ['FrameRate', c.frameRate], ['Profile', c.profile]]) {
          if (Array.isArray(list) && !list.includes(out[`${pre}${field}`])) {
            throw new WriteError(`${pre} stream ${field.replace(/([A-Z])/g, ' $1').trim().toLowerCase()} must be one of: ${list.join(', ')}`);
          }
        }
      }
      return out;
    },
    equal: sameValue,
  },
  {
    // UPnP asks the router to open ports to this camera from the internet. Off is the safe state.
    id: 'upnp', label: 'UPnP port forwarding', area: 'Network', feature: 'upnp',
    risk: 'medium', restartRequired: false, secret: [],
    async read(client) {
      const u = (await client.command('GetUpnp', {})).Upnp;
      if (u?.enable !== 0 && u?.enable !== 1) throw new Error('the device did not report its UPnP setting');
      return { enabled: u.enable === 1 };
    },
    async write(client, _channel, v) { await client.command('SetUpnp', { Upnp: { enable: v.enabled ? 1 : 0 } }); },
    validate: (input) => checkPatch(input, { enabled: rBool }, 'UPnP'),
    target: (intent, current) => ({ ...current, ...intent }),
    equal: sameValue,
  },
  {
    // The connection to Reolink's cloud, used by the Reolink app to reach the camera from outside
    // and by push notifications. LAN access, ReoLook and recordings do not use it.
    id: 'p2p', label: 'Reolink cloud connection (P2P)', area: 'Network', feature: 'p2p',
    risk: 'medium', restartRequired: false, secret: [],
    async read(client) {
      const p = (await client.command('GetP2p', {})).P2p;
      if (p?.enable !== 0 && p?.enable !== 1) throw new Error('the device did not report its P2P setting');
      return { enabled: p.enable === 1 };
    },
    async write(client, _channel, v) { await client.command('SetP2p', { P2p: { enable: v.enabled ? 1 : 0 } }); },
    validate: (input) => checkPatch(input, { enabled: rBool }, 'P2P'),
    target: (intent, current) => ({ ...current, ...intent }),
    equal: sameValue,
  },
  {
    // How the device gets its address. High risk: a wrong static address leaves it unreachable until
    // it is reset in person. Everything that can be checked from here is checked before it is sent.
    id: 'ipConfig', label: 'IP address', area: 'Network', feature: 'network',
    risk: 'high', restartRequired: false, secret: [],
    async read(client) {
      const l = (await client.command('GetLocalLink', {})).LocalLink;
      if (!l || (l.type !== 'DHCP' && l.type !== 'Static') || !l.static) throw new Error('the device did not report its address settings');
      return { mode: l.type, ip: String(l.static.ip ?? ''), mask: String(l.static.mask ?? ''), gateway: String(l.static.gateway ?? ''),
        dnsAuto: l.dns?.auto === 1, dns1: String(l.dns?.dns1 ?? ''), dns2: String(l.dns?.dns2 ?? '') };
    },
    async write(client, _channel, v) {
      const l = (await client.command('GetLocalLink', {})).LocalLink ?? {};
      await client.command('SetLocalLink', { LocalLink: { ...l, type: v.mode,
        static: { ...(l.static ?? {}), ip: v.ip, mask: v.mask, gateway: v.gateway },
        dns: { ...(l.dns ?? {}), auto: v.dnsAuto ? 1 : 0, dns1: v.dns1, dns2: v.dns2 } } });
    },
    validate: (input) => checkPatch(input, { mode: rEnum(['DHCP', 'Static']), ip: rText(15), mask: rText(15), gateway: rText(15),
      dnsAuto: rBool, dns1: rText(15), dns2: rText(15) }, 'IP address'),
    target(intent, current) {
      const out = { ...current, ...intent };
      if (out.mode === 'Static') {
        const ip = ipv4(out.ip), mask = ipv4(out.mask), gw = ipv4(out.gateway);
        if (ip === null) throw new WriteError('the IP address is not a valid IPv4 address');
        if (mask === null || !contiguousMask(mask)) throw new WriteError('the subnet mask is not valid (for example 255.255.255.0)');
        if (gw === null) throw new WriteError('the gateway is not a valid IPv4 address');
        const net = (ip & mask) >>> 0, bcast = (net | (~mask >>> 0)) >>> 0;
        if ((gw & mask) >>> 0 !== net) throw new WriteError('the gateway is not on the same network as the address, so the device could not reach it');
        if (ip === net || ip === bcast) throw new WriteError('that address is the network or broadcast address of its subnet');
        if (ip === gw) throw new WriteError('the address is the same as the gateway');
        for (const k of ['dns1', 'dns2']) if (out[k] && ipv4(out[k]) === null) throw new WriteError(`${k === 'dns1' ? 'the first' : 'the second'} DNS server is not a valid IPv4 address`);
        if (!out.dnsAuto && !out.dns1) throw new WriteError('enter a DNS server, or let the device get it automatically');
      }
      return out;
    },
    // Is something already answering at the new address? Run at planning time (not part of validation).
    async guard(proposed, current, { probe }) {
      if (proposed.mode !== 'Static' || proposed.ip === current.ip || !probe) return;
      if (await probe(proposed.ip)) throw new WriteError(`something already answers at ${proposed.ip}; two devices on one address would knock both off the network`);
    },
    verifyRetries: 6, verifyDelayMs: 2500,
    // what must be typed to apply it
    confirmText: (plan) => (plan.proposed.mode === 'Static' ? plan.proposed.ip : 'DHCP'),
    equal: sameValue,
  },
  {
    // Floodlight / spotlight on or off, and its brightness. NOT verified on hardware (none of the
    // development cameras has one; the RLC-410 reports a floodlight it refuses to read). Follows the
    // documented SetWhiteLed { WhiteLed: { channel, state, bright } }. The lighting mode is left as it is.
    id: 'floodlight', label: 'Floodlight', area: 'Floodlight', feature: 'floodlight',
    risk: 'low', restartRequired: false, secret: [], unverified: true,
    async read(client, channel = 0) {
      const w = (await client.command('GetWhiteLed', { channel })).WhiteLed;
      if (!w || (w.state !== 0 && w.state !== 1) || !Number.isInteger(w.bright)) throw new Error('the device did not report its floodlight');
      return { on: w.state === 1, brightness: w.bright };
    },
    async write(client, channel = 0, v) {
      const w = (await client.command('GetWhiteLed', { channel })).WhiteLed ?? {};
      const patch = {};
      if ((w.state === 1) !== v.on) patch.state = v.on ? 1 : 0;
      if (w.bright !== v.brightness) patch.bright = v.brightness;
      if (Object.keys(patch).length) await client.command('SetWhiteLed', { WhiteLed: { channel, ...patch } });
    },
    validate: (input) => checkPatch(input, { on: rBool, brightness: rInt(0, 100) }, 'floodlight'),
    target: (intent, current) => ({ ...current, ...intent }),
    equal: sameValue,
  },
  {
    // Detection sensitivity of the AI classes a camera reports (people, vehicle, animal). NOT verified
    // on hardware. Follows GetAiAlarm / SetAiAlarm { AiAlarm: <the object as read, sensitivity changed> };
    // the whole object is sent back because that is what the device's own shape implies, and the pipeline's
    // read-back reports a device that disagrees as unverified.
    id: 'aiSensitivity', label: 'AI detection sensitivity', area: 'AI detection', feature: 'ai',
    risk: 'medium', restartRequired: false, secret: [], unverified: true,
    async read(client, channel = 0) {
      const out = {};
      for (const [key, type] of AI_TYPES) {
        try {
          const a = (await client.command('GetAiAlarm', { channel, ai_type: type })).AiAlarm;
          if (a && Number.isInteger(a.sensitivity)) out[key] = a.sensitivity;
        } catch { /* this class is not on the device */ }
      }
      if (!Object.keys(out).length) throw new Error('the device did not report any AI detection class');
      return out;
    },
    async write(client, channel = 0, v) {
      for (const [key, type] of AI_TYPES) {
        if (v[key] === undefined) continue;
        const a = (await client.command('GetAiAlarm', { channel, ai_type: type })).AiAlarm;
        if (a && a.sensitivity !== v[key]) await client.command('SetAiAlarm', { AiAlarm: { ...a, channel, ai_type: type, sensitivity: v[key] } });
      }
    },
    validate: (input) => checkPatch(input, { people: rInt(0, 100), vehicle: rInt(0, 100), animal: rInt(0, 100) }, 'AI sensitivity'),
    target(intent, current) {
      for (const k of Object.keys(intent)) if (!(k in current)) throw new WriteError(`this device does not report ${k} detection`);
      return { ...current, ...intent };
    },
    equal: sameValue,
  },
  {
    // Mirror and rotate the picture. Verified on an RLC-410: SetIsp takes just the field, and the
    // camera turns its own motion area over with the picture (toggling and restoring returns the
    // area byte-identical), so zones keep matching what they cover.
    id: 'orientation', label: 'Picture orientation', area: 'Image', feature: 'image',
    risk: 'medium', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const i = (await client.command('GetIsp', { channel })).Isp ?? {};
      for (const k of ['mirroring', 'rotation']) if (i[k] !== 0 && i[k] !== 1) throw new Error(`the device did not report ${k}`);
      return { mirrored: i.mirroring === 1, rotated: i.rotation === 1 };
    },
    async write(client, channel = 0, v) {
      const i = (await client.command('GetIsp', { channel })).Isp ?? {};
      const patch = {};
      if ((i.mirroring === 1) !== v.mirrored) patch.mirroring = v.mirrored ? 1 : 0;
      if ((i.rotation === 1) !== v.rotated) patch.rotation = v.rotated ? 1 : 0;
      if (Object.keys(patch).length) await client.command('SetIsp', { Isp: { channel, ...patch } });
    },
    validate: (input) => checkPatch(input, { mirrored: rBool, rotated: rBool }, 'picture orientation'),
    target: (intent, current) => ({ ...current, ...intent }),
    equal: sameValue,
  },
  {
    // Brightness, contrast, hue, saturation, sharpness. Verified on an RLC-410 (v3.0.0.136):
    // SetImage accepts just the fields to change, and touches nothing else.
    id: 'picture', label: 'Picture', area: 'Image', feature: 'image',
    risk: 'low', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const i = (await client.command('GetImage', { channel })).Image ?? {};
      const out = {};
      for (const k of IMAGE_FIELDS) {
        if (!Number.isInteger(i[k])) throw new Error(`the device did not report ${k}`);
        out[k] = i[k];
      }
      return out;
    },
    async write(client, channel = 0, v) {
      const cur = (await client.command('GetImage', { channel })).Image ?? {};
      const changed = Object.fromEntries(IMAGE_FIELDS.filter((k) => cur[k] !== v[k]).map((k) => [k, v[k]]));
      if (Object.keys(changed).length) await client.command('SetImage', { Image: { channel, ...changed } });
    },
    async constraints(client, channel = 0) {
      try {
        const r = (await client.describe('GetImage', { channel })).range?.Image;
        return { ranges: Object.fromEntries(IMAGE_FIELDS.filter((k) => Number.isInteger(r?.[k]?.min) && Number.isInteger(r?.[k]?.max)).map((k) => [k, { min: r[k].min, max: r[k].max }])) };
      } catch { return null; }
    },
    validate: (input) => checkPatch(input, Object.fromEntries(IMAGE_FIELDS.map((k) => [k, rInt(0, 1000)])), 'picture'),
    target(intent, current, { constraints } = {}) { return checkRanges({ ...current, ...intent }, constraints); },
    equal: sameValue,
  },
  {
    // Day/night, flicker, back light and noise reduction, from the device's Isp block. Verified on an
    // RLC-410: SetIsp takes only the fields to change. A back-light mode is refused on its own: it must
    // travel with that mode's level (blc for BackLightControl, drc for DynamicRangeControl).
    id: 'imageMode', label: 'Day/night and exposure', area: 'Image', feature: 'image',
    risk: 'low', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const i = (await client.command('GetIsp', { channel })).Isp ?? {};
      for (const k of ['dayNight', 'antiFlicker', 'backLight']) if (typeof i[k] !== 'string') throw new Error(`the device did not report ${k}`);
      for (const k of ['blc', 'drc']) if (!Number.isInteger(i[k])) throw new Error(`the device did not report ${k}`);
      return { dayNight: i.dayNight, antiFlicker: i.antiFlicker, backLight: i.backLight, blc: i.blc, drc: i.drc, nr3d: bool(i.nr3d) };
    },
    async write(client, channel = 0, v) {
      const cur = (await client.command('GetIsp', { channel })).Isp ?? {};
      const now = { dayNight: cur.dayNight, antiFlicker: cur.antiFlicker, backLight: cur.backLight, blc: cur.blc, drc: cur.drc, nr3d: bool(cur.nr3d) };
      const patch = {};
      for (const k of ['dayNight', 'antiFlicker']) if (now[k] !== v[k]) patch[k] = v[k];
      if (now.nr3d !== v.nr3d) patch.nr3d = v.nr3d ? 1 : 0;
      // The device keeps a level only while its mode is active (a level sent in another mode is
      // ignored), so restoring a level of a mode that is not the target means entering that mode
      // first. Verified on hardware: leaving a mode keeps its level.
      for (const [mode, level] of [['BackLightControl', 'blc'], ['DynamicRangeControl', 'drc']]) {
        if (now[level] !== v[level] && v.backLight !== mode) {
          await client.command('SetIsp', { Isp: { channel, backLight: mode, [level]: v[level] } });
          now.backLight = mode; now[level] = v[level];
        }
      }
      if (now.backLight !== v.backLight || now.blc !== v.blc || now.drc !== v.drc) {
        patch.backLight = v.backLight;
        if (v.backLight === 'BackLightControl') patch.blc = v.blc;
        if (v.backLight === 'DynamicRangeControl') patch.drc = v.drc;
      }
      if (Object.keys(patch).length) await client.command('SetIsp', { Isp: { channel, ...patch } });
    },
    async constraints(client, channel = 0) {
      try {
        const r = (await client.describe('GetIsp', { channel })).range?.Isp;
        const enums = {}, ranges = {};
        for (const k of ['dayNight', 'antiFlicker', 'backLight']) if (Array.isArray(r?.[k]) && r[k].length) enums[k] = r[k];
        for (const k of ['blc', 'drc']) if (Number.isInteger(r?.[k]?.min) && Number.isInteger(r?.[k]?.max)) ranges[k] = { min: r[k].min, max: r[k].max };
        return { enums, ranges };
      } catch { return null; }
    },
    validate: (input) => checkPatch(input, {
      dayNight: rText(24), antiFlicker: rText(24), backLight: rText(32), blc: rInt(0, 1000), drc: rInt(0, 1000), nr3d: rBool,
    }, 'image mode'),
    target(intent, current, { constraints } = {}) {
      const out = { ...current, ...intent };
      for (const [k, allowed] of Object.entries(constraints?.enums ?? {})) {
        if (!allowed.includes(out[k])) throw new WriteError(`${k} must be one of: ${allowed.join(', ')}`);
      }
      // verified on hardware: a level sent without its mode is accepted and silently ignored
      if (out.blc !== current.blc && out.backLight !== 'BackLightControl') throw new WriteError('the back light level only applies in BackLightControl mode; choose that mode as well');
      if (out.drc !== current.drc && out.backLight !== 'DynamicRangeControl') throw new WriteError('the dynamic range level only applies in DynamicRangeControl mode; choose that mode as well');
      return checkRanges(out, constraints);
    },
    equal: sameValue,
  },
  {
    // Motion sensitivity by time of day: one number per window. Verified on an RLC-410 (v3.0.0.136):
    // SetAlarm { Alarm: { channel, type: "md", scope, sens } } changes it, and GetAlarm and GetMdAlarm
    // both follow. SetMdAlarm accepts a `sens` array but silently ignores it, and so it does for
    // `newSens`, so this goes through SetAlarm. The value is keyed by the window's own times.
    id: 'motionSensitivity', label: 'Motion sensitivity', area: 'Motion detection', feature: 'motion',
    risk: 'medium', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const alarm = (await client.command('GetAlarm', { Alarm: { channel, type: 'md' } })).Alarm;
      const wins = windowKeys(alarm?.sens);
      let md = null;
      try { md = (await client.command('GetMdAlarm', { channel })).MdAlarm; } catch { /* optional */ }
      // a scheduled newer table that is switched on would govern instead; writing the older one would
      // change nothing, so editing is refused rather than offered
      if (md?.useNewSens && Array.isArray(md.newSens?.sens) && md.newSens.sens.some((w) => w.enable === 1 || w.enable === true)) {
        throw new Error('the device uses its newer scheduled sensitivity table, which ReoLook cannot edit yet');
      }
      if (Array.isArray(md?.sens)) {
        const other = Object.fromEntries(md.sens.map((w) => [w.id, w.sensitivity]));
        if (wins.some((w) => other[w.id] !== undefined && other[w.id] !== w.sensitivity)) {
          throw new Error('the device reports two different sensitivities; refusing to edit until that is understood');
        }
      }
      return Object.fromEntries(wins.map((w) => [w.key, w.sensitivity]));
    },
    async write(client, channel = 0, v) {
      const alarm = (await client.command('GetAlarm', { Alarm: { channel, type: 'md' } })).Alarm;
      const byKey = Object.fromEntries(windowKeys(alarm?.sens).map((w) => [w.key, w.id]));
      const sens = alarm.sens.map((w) => {
        const key = Object.keys(byKey).find((k) => byKey[k] === w.id);
        return key !== undefined && v[key] !== undefined ? { ...w, sensitivity: v[key] } : w;
      });
      await client.command('SetAlarm', { Alarm: { channel, type: 'md', scope: alarm.scope, sens } });
    },
    async constraints(client, channel = 0) {
      try {
        const d = await client.describe('GetMdAlarm', { channel });
        const r = d.range?.MdAlarm?.sens?.[0]?.sensitivity;
        return Number.isInteger(r?.min) && Number.isInteger(r?.max) ? { min: r.min, max: r.max } : null;
      } catch { return null; }
    },
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) throw new WriteError('sensitivity: expected values per time window');
      const out = {};
      for (const [k, n] of Object.entries(input)) {
        if (!/^\d\d:\d\d-\d\d:\d\d$/.test(k)) throw new WriteError(`sensitivity: "${k}" is not a time window`);
        if (!Number.isInteger(n) || n < 0 || n > 1000) throw new WriteError(`sensitivity for ${k} must be a whole number`);
        out[k] = n;
      }
      return out;
    },
    target(intent, current, { constraints } = {}) {
      for (const k of Object.keys(intent)) if (!(k in current)) throw new WriteError(`this device has no sensitivity window ${k}`);
      const out = { ...current, ...intent };
      if (constraints) {
        for (const [k, n] of Object.entries(out)) {
          if (n < constraints.min || n > constraints.max) throw new WriteError(`sensitivity for ${k} must be between ${constraints.min} and ${constraints.max}`);
        }
      }
      return out;
    },
    equal: sameValue,
  },
  {
    // The infrared night-vision LEDs. On this firmware the device's own range is Auto and Off only.
    // The administrator carries the *execute* bit for it (permit 5), not write, so it declares that.
    id: 'irLights', label: 'Night-vision lights (IR)', area: 'Night vision', feature: 'irLights', needs: 'execute',
    risk: 'low', restartRequired: false, secret: [],
    async read(client, channel = 0) {
      const v = await client.command('GetIrLights', { channel });
      return { state: String(v?.IrLights?.state ?? '') };
    },
    async write(client, channel = 0, v) {
      await client.command('SetIrLights', { IrLights: { channel, state: v.state } });
    },
    // what this device accepts, straight from the device
    async constraints(client, channel = 0) {
      try {
        const d = await client.describe('GetIrLights', { channel });
        const states = d.range?.IrLights?.state;
        return Array.isArray(states) && states.length ? { states } : null;
      } catch { return null; }
    },
    validate(input) {
      const state = typeof input?.state === 'string' ? input.state.trim() : '';
      if (!state) throw new WriteError('choose a night-vision mode');
      if ([...state].length > 16 || CONTROL.test(state)) throw new WriteError('that is not a valid night-vision mode');
      return { state };
    },
    target(intent, _current, { constraints } = {}) {
      if (constraints?.states && !constraints.states.includes(intent.state)) {
        throw new WriteError(`this device offers only: ${constraints.states.join(', ')}`);
      }
      return intent;
    },
    equal: sameValue,
  },
];


/** Sensitivity windows from a GetAlarm `sens` list, keyed by their own times. Refuses a list it cannot trust. */
function windowKeys(list) {
  if (!Array.isArray(list) || !list.length || list.length > 8) throw new Error('the device did not report sensitivity windows');
  /** HH:MM from an hour and a minute. */
  const t = (h, m) => `${pad2(h)}:${pad2(m)}`;
  const out = list.map((w) => {
    const ok = [w.id, w.beginHour, w.beginMin, w.endHour, w.endMin, w.sensitivity].every(Number.isInteger);
    if (!ok) throw new Error('the device reported a sensitivity window ReoLook cannot read');
    return { id: w.id, key: `${t(w.beginHour, w.beginMin)}-${t(w.endHour, w.endMin)}`, sensitivity: w.sensitivity };
  });
  if (new Set(out.map((w) => w.key)).size !== out.length || new Set(out.map((w) => w.id)).size !== out.length) {
    throw new Error('the device reported overlapping sensitivity windows');
  }
  return out;
}

/**
 * Which settings can be copied from one device to others, and how. A setting that identifies a
 * device (its name), is a moving value (the clock) or describes what one camera sees (the motion
 * area) is not copied. `omit` drops fields that belong to the device; `defaultOn` is only the
 * checkbox's starting state.
 */
const COPY = {
  timeZone: { defaultOn: true }, ntp: { defaultOn: true },
  osd: { defaultOn: true, omit: ['name'], note: 'The name drawn on the picture stays each device\'s own.' },
  irLights: { defaultOn: true },
  motionSensitivity: { defaultOn: false, note: 'Needs the same time windows on the target.' },
  picture: { defaultOn: false }, imageMode: { defaultOn: false },
  // how one camera is mounted: copying it would turn another camera's picture over
  orientation: null,
  floodlight: { defaultOn: false, note: 'Only on devices that have one.' },
  aiSensitivity: { defaultOn: false },
  ipConfig: null,
  p2p: null,
  upnp: null,
  encoding: { defaultOn: false, note: 'Only values the target lists for its own resolution are accepted.' },
  pushNotifications: { defaultOn: false },
  emailAlerts: { defaultOn: false, omit: ['configured'], note: 'Cannot be turned on where no mail server is set up.' },
  ftpUpload: { defaultOn: false, omit: ['configured'], note: 'Cannot be turned on where no FTP server is set up.' },
};
for (const s of DEVICE_SETTINGS) s.copy = COPY[s.id] ?? null;

/** The input to plan on a target device for a value read from the source, or null if not copyable. */
export function copyIntent(setting, value) {
  if (!setting?.copy || !value || typeof value !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) if (!(setting.copy.omit ?? []).includes(k)) out[k] = v;
  if (setting.id === 'imageMode') {
    // a level only means something in its own mode; sending the other one would be refused
    if (out.backLight !== 'BackLightControl') delete out.blc;
    if (out.backLight !== 'DynamicRangeControl') delete out.drc;
  }
  return out;
}

/** The setting with this id, or null. */
export const settingById = (id) => DEVICE_SETTINGS.find((s) => s.id === id) ?? null;
