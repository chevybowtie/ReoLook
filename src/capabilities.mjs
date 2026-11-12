// What a specific camera can do, from its own capability report reconciled with real reads.
// Nothing here is keyed on a model number: a new camera simply reports more.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { xdgDir } from './xdg.mjs';
import { mapLimit } from './concurrency.mjs';

/** The parameters of a read that takes only a channel. */
const ch = (channel) => ({ channel });

/**
 * One row per feature the original app exposes. `ability` lists keys in the camera's report
 * ("dev.x" device-level, "chn.x" channel-level); `probes` are read commands that prove the
 * camera answers. Features with no read command (PTZ control, siren trigger) rely on the report.
 */
export const FEATURES = [
  { id: 'general', area: 'General', label: 'Device info', ability: ['dev.devInfo'], probes: [['GetDevInfo', () => ({})]] },
  { id: 'deviceName', area: 'General', label: 'Device name', ability: ['dev.devName'], probes: [['GetDevName', () => ({})]] },
  { id: 'time', area: 'Date, time, NTP', label: 'Date and time', ability: ['dev.time'], probes: [['GetTime', () => ({})]] },
  { id: 'ntp', area: 'Date, time, NTP', label: 'NTP', ability: ['dev.ntp'], probes: [['GetNtp', () => ({})]] },
  { id: 'image', area: 'Image', label: 'Image and exposure', ability: ['chn.isp', 'chn.image'], probes: [['GetIsp', ch], ['GetImage', ch]] },
  { id: 'osd', area: 'OSD and masks', label: 'On-screen display', ability: ['chn.osd'], probes: [['GetOsd', ch]] },
  { id: 'mask', area: 'OSD and masks', label: 'Privacy masks', ability: ['chn.mask', 'chn.shelterCfg'], probes: [['GetMask', ch]] },
  { id: 'encoding', area: 'Encoding', label: 'Stream encoding', ability: ['chn.enc'], probes: [['GetEnc', ch]] },
  { id: 'irLights', area: 'Night vision', label: 'IR lights', ability: ['chn.ledControl', 'dev.ledControl'], probes: [['GetIrLights', ch]] },
  { id: 'motion', area: 'Motion detection', label: 'Motion zones and sensitivity', ability: ['chn.alarmMd'], probes: [['GetMdAlarm', ch], ['GetAlarm', (c) => ({ Alarm: { channel: c, type: 'md' } })]] },
  { id: 'ai', area: 'AI detection', label: 'People, vehicle, animal detection', ability: ['chn.supportAi', 'chn.aiTrack'], probes: [['GetAiAlarm', (c) => ({ channel: c, ai_type: 'people' })]] },
  { id: 'push', area: 'Alarm actions', label: 'Push notifications', ability: ['dev.push'], probes: [['GetPush', ch]] },
  { id: 'email', area: 'Alarm actions', label: 'Email alerts', ability: ['dev.email'], probes: [['GetEmail', () => ({})]] },
  { id: 'ftp', area: 'Alarm actions', label: 'FTP upload', ability: ['chn.ftp'], probes: [['GetFtp', () => ({})]] },
  { id: 'siren', area: 'Siren', label: 'Siren / audio alarm', ability: ['chn.alarmAudio', 'dev.alarmAudio'], probes: [['GetAudioAlarm', ch]] },
  { id: 'floodlight', area: 'Floodlight', label: 'Floodlight / spotlight', ability: ['chn.floodLight'], probes: [['GetWhiteLed', ch]] },
  { id: 'ptz', area: 'PTZ', label: 'Pan, tilt, zoom', ability: ['chn.ptzCtrl', 'chn.ptzType'], probes: [['GetPtzCheckState', ch]] },
  { id: 'ptzPreset', area: 'PTZ', label: 'PTZ presets', ability: ['chn.ptzPreset'], probes: [['GetPtzPreset', ch]] },
  { id: 'ptzPatrol', area: 'PTZ', label: 'PTZ patrol / cruise', ability: ['chn.ptzPatrol'], probes: [['GetPtzPatrol', ch]] },
  { id: 'recording', area: 'On-camera recording', label: 'On-camera recording schedule', ability: ['chn.recCfg', 'chn.recSchedule'], probes: [['GetRec', ch]] },
  { id: 'storage', area: 'Storage', label: 'Card / disk', ability: ['dev.disk', 'dev.sdCard'], probes: [['GetHddInfo', () => ({})]] },
  { id: 'network', area: 'Network', label: 'Network settings', ability: ['dev.localLink', 'dev.mediaPort'], probes: [['GetLocalLink', () => ({})], ['GetNetPort', () => ({})]] },
  { id: 'p2p', area: 'Network', label: 'Reolink cloud (P2P)', ability: ['dev.p2p'], probes: [['GetP2p', () => ({})]] },
  { id: 'upnp', area: 'Network', label: 'UPnP', ability: ['dev.upnp'], probes: [['GetUpnp', () => ({})]] },
  { id: 'ddns', area: 'Network', label: 'DDNS', ability: ['dev.ddns', 'dev.ddnsCfg'], probes: [['GetDdns', () => ({})]] },
  { id: 'wifi', area: 'Network', label: 'Wi-Fi', ability: ['dev.wifi'], probes: [['GetWifi', () => ({})]] },
  { id: 'users', area: 'Users', label: 'User accounts', ability: ['dev.user'], probes: [['GetUser', () => ({})]] },
  { id: 'autoMaint', area: 'Maintenance', label: 'Scheduled reboot', ability: ['dev.autoMaint'], probes: [['GetAutoMaint', () => ({})]] },
  { id: 'reboot', area: 'Maintenance', label: 'Reboot', ability: ['dev.reboot'], probes: [] },
  { id: 'restore', area: 'Maintenance', label: 'Restore defaults', ability: ['dev.restore'], probes: [] },
  { id: 'firmware', area: 'Firmware', label: 'Firmware update check', ability: ['dev.upgrade'], probes: [['CheckFirmware', () => ({})]] },
  { id: 'battery', area: 'Battery', label: 'Battery and power', ability: ['chn.battery', 'chn.batAnalysis', 'chn.powerLed'], probes: [] },
  { id: 'diagnostics', area: 'Diagnostics', label: 'Performance and logs', ability: ['dev.performance', 'dev.log'], probes: [['GetPerformance', () => ({})]] },
];

const FEATURE_SET = FEATURES.map((f) => f.id).join(',').split('').reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 7).toString(36);

/** Highest `permit` among the listed ability keys, or undefined when none is in the report. */
export function abilityPermit(report, keys, channel = 0) {
  if (!report) return undefined;
  let best;
  for (const key of keys) {
    const [scope, name] = key.split('.');
    const entry = scope === 'chn' ? report.abilityChn?.[channel]?.[name] : report[name];
    const permit = entry && typeof entry === 'object' ? entry.permit : undefined;
    if (typeof permit === 'number') best = Math.max(best ?? 0, permit);
  }
  return best;
}

/**
 * `permit` is a bitmask. Observed on an RLC-410: the viewer account sees 4 (read), the
 * administrator 6 (read + write), and reboot / restore flip from 0 to 1. So: 4 = read,
 * 2 = write, 1 = execute. This is inferred from those values, not from documentation.
 */
export function accessOf(permit) {
  if (typeof permit !== 'number') return { read: null, write: null, execute: null };
  return { read: (permit & 4) !== 0, write: (permit & 2) !== 0, execute: (permit & 1) !== 0 };
}

/**
 * Reconcile the report with real reads.
 *  supported    a read worked
 *  unsupported  neither the report nor a read says yes
 *  conflict     the report says yes but the camera refuses the read
 *  reported     no read exists for this feature; the report says yes
 *  unknown      reads failed for other reasons (network, wrong parameter shape) and the report is silent
 * `limited` is true when the report says 0: the device may lack it, or this account may not use it.
 */
export function classify({ permit, probes }) {
  const ran = probes.filter((p) => p);
  const anyOk = ran.some((p) => p.kind === 'ok');
  const allUnsupported = ran.length > 0 && ran.every((p) => p.kind === 'unsupported');
  const reported = permit !== undefined ? permit > 0 : undefined;
  let state;
  if (anyOk) state = 'supported';
  else if (allUnsupported) state = reported ? 'conflict' : 'unsupported';
  else if (ran.length === 0) state = reported === undefined ? 'unknown' : reported ? 'reported' : 'unsupported';
  else state = reported === false ? 'unsupported' : 'unknown';
  return { state, limited: permit === 0 && state === 'unsupported' };
}

/** Whether a feature can be used: a read worked, or the device reports it and no read exists to confirm. */
export const isUsable = (f) => f.state === 'supported' || f.state === 'reported';

/** How many reads of one camera may be in flight while a profile is built: enough to hide the round trips, few enough for a small device. */
const PROBE_CONCURRENCY = 4;

/**
 * Runs every feature's probe reads, a few at a time.
 * @param {object} client needs probe(cmd, param)
 * @param {number} channel
 * @returns {Promise<object[][]>} for each feature (in FEATURES order), the outcome of each of its probes (in order)
 */
async function runProbes(client, channel) {
  const jobs = FEATURES.flatMap((f, fi) => f.probes.map(([cmd, make]) => ({ fi, cmd, param: make(channel) })));
  const results = await mapLimit(jobs, PROBE_CONCURRENCY, (j) => client.probe(j.cmd, j.param));
  const byFeature = FEATURES.map(() => []);
  jobs.forEach((j, i) => byFeature[j.fi].push(results[i]));
  return byFeature;
}

/**
 * Turns one feature's report entry and probe outcomes into its profile row.
 * @param {object} f the FEATURES row
 * @param {object|null} report the device's own capability report
 * @param {object[]} probes outcomes of this feature's probes, in order
 * @param {number} channel
 * @returns {object} the feature as it appears in a profile
 */
function featureRow(f, report, probes, channel) {
  const permit = abilityPermit(report, f.ability, channel);
  const evidence = f.probes.map(([cmd], i) => `${cmd}: ${probes[i].kind}${probes[i].kind === 'ok' ? '' : probes[i].detail ? ` (${probes[i].detail})` : ''}`);
  const { state, limited } = classify({ permit, probes });
  return { id: f.id, area: f.area, label: f.label, state, usable: state === 'supported' || state === 'reported',
    limited, permit: permit ?? null, access: accessOf(permit), evidence };
}

/**
 * Build a profile for one device. `client` needs devInfo(), ability() and probe(cmd, param).
 * The probe reads are independent, so a few run at once; the profile is the same as if they ran in turn.
 * Never throws for a camera that answers poorly; failures are recorded as evidence.
 * @param {object} client
 * @param {{channel?: number, account?: string, now?: () => Date}} [opts]
 * @returns {Promise<object>} the profile
 */
export async function buildProfile(client, { channel = 0, account = 'viewer', now = () => new Date() } = {}) {
  const info = await client.devInfo();
  let report = null, reportError = null;
  try { report = await client.ability(); } catch (e) { reportError = e.message; }
  const probed = await runProbes(client, channel);
  const features = {};
  FEATURES.forEach((f, i) => { features[f.id] = featureRow(f, report, probed[i], channel); });
  return {
    model: info.model ?? null, name: info.name ?? null, firmware: info.firmVer ?? null, hardware: info.hardVer ?? null,
    channels: info.channelNum ?? null, channel, account,
    source: report ? 'ability+reads' : 'reads-only', abilityError: reportError,
    builtAt: now().toISOString(), features,
  };
}

/** Cache keyed by host, channel, model and firmware, so a firmware change re-probes. */
export class ProfileCache {
  #mem = new Map(); #file; #ttlMs; #loaded = false;
  constructor({ file = path.join(xdgDir('cache'), 'reolook', 'capabilities.json'), ttlMs = 24 * 3600_000 } = {}) {
    this.#file = file; this.#ttlMs = ttlMs;
  }
  // The feature list is part of the key: a profile built before a feature was added would otherwise
  // be served for a day without it.
  static key(host, channel, model, firmware, account = 'viewer') { return `${host}|${channel}|${model}|${firmware}|${account}|${FEATURE_SET}`; }

  /** Reads the cache file into memory, once. A missing or damaged file is the same as an empty cache. */
  async #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try { for (const [k, v] of Object.entries(JSON.parse(await readFile(this.#file, 'utf8')))) this.#mem.set(k, v); } catch { /* none yet */ }
  }
  async get(key, now = Date.now()) {
    await this.#load();
    const v = this.#mem.get(key);
    return v && now - new Date(v.builtAt).getTime() < this.#ttlMs ? v : null;
  }
  /** Remembers a profile and saves the cache; a cache that cannot be written is only slower. */
  async set(key, profile) {
    await this.#load();
    this.#mem.set(key, profile);
    try {
      await mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.#mem)), { mode: 0o600 });
      await rename(tmp, this.#file);
    } catch { /* a cache that cannot be written is only slower */ }
  }
}

/**
 * Profile for a device, using the cache unless `refresh`. The device info read is cheap and
 * decides the cache key, so a firmware upgrade is noticed.
 */
export async function getProfile(client, host, { channel = 0, refresh = false, account = 'viewer', cache = new ProfileCache(), now = Date.now } = {}) {
  const info = await client.devInfo();
  const key = ProfileCache.key(host, channel, info.model, info.firmVer, account);
  if (!refresh) { const hit = await cache.get(key, now()); if (hit) return { ...hit, cached: true }; }
  const profile = await buildProfile(client, { channel, account });
  await cache.set(key, profile);
  return { ...profile, cached: false };
}
