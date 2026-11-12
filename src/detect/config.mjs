// The `detection` section of config.json: for each camera, a list of rules ("a vehicle stopped in the
// zone", "a bird appeared"), plus where to send the news. Validation is strict and returns
// plain-language errors, because this is typed into a page by a person.
import { DETECTABLE } from './rules.mjs';
import { parseUrl } from '../mqtt.mjs';

export class DetectionConfigError extends Error {}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Lower-case letters and digits only, with single underscores between words. */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
export const labelSlug = slug;
export const MAX_RULES = 8;

/** A rule with every setting at its default, with `over` applied on top. */
export const defaultRule = (over = {}) => ({ id: 'r1', enabled: true, label: 'mail truck', mode: 'stops', zone: [], classes: ['truck', 'car', 'bus'],
  minStopSec: 20, minPresenceSec: 2, minHeight: 0, maxHeight: 1, cooldownSec: 0, from: null, to: null, minScore: 0.4, requireArrival: true, webhook: { url: null, leftUrl: null, method: 'POST' }, ...over });

/**
 * Validates one rule and fills in defaults.
 * @param {object} raw @param {string} where how the rule is named in error messages
 * @returns {object} the rule @throws {DetectionConfigError} naming what is wrong
 */
export function normalizeRule(raw = {}, where = 'rule') {
  const c = { ...defaultRule(), ...raw };
  /** Rejects the rule, naming where. */
  const bad = (m) => { throw new DetectionConfigError(`${where}: ${m}`); };
  if (!/^[a-z0-9_-]{1,20}$/.test(String(c.id))) bad('the rule id is not valid');
  c.enabled = c.enabled === true;
  c.requireArrival = c.requireArrival !== false;
  c.label = typeof c.label === 'string' ? c.label.trim() : '';
  if (!c.label || [...c.label].length > 40 || /[\u0000-\u001f\u007f]/.test(c.label) || !slug(c.label)) bad('the event name must be 1 to 40 characters, for example "mail truck"');
  if (c.mode !== 'stops' && c.mode !== 'appears') bad('the rule must be "stops" or "appears"');
  if (!Array.isArray(c.zone) || c.zone.length > 16) bad('the zone must be a list of up to 16 points');
  c.zone = c.zone.map((p) => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) bad('each zone point must be [x, y] between 0 and 1');
    return [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000];
  });
  if (c.zone.length > 0 && c.zone.length < 3) bad('a zone needs at least 3 points, or none for the whole picture');
  if (c.enabled && c.mode === 'stops' && c.zone.length < 3) bad('draw the zone (at least 3 points) before turning a "stops" rule on');
  if (!Array.isArray(c.classes) || !c.classes.length || !c.classes.every((k) => DETECTABLE.includes(k))) bad(`types must be from: ${DETECTABLE.join(', ')}`);
  c.classes = [...new Set(c.classes)];
  if (!Number.isFinite(c.minStopSec) || c.minStopSec < 3 || c.minStopSec > 600) bad('the stop time must be from 3 to 600 seconds');
  if (!Number.isFinite(c.minPresenceSec) || c.minPresenceSec < 0 || c.minPresenceSec > 60) bad('the time it must be seen must be from 0 to 60 seconds');
  if (!Number.isFinite(c.minHeight) || c.minHeight < 0 || c.minHeight > 0.9) bad('the smallest size must be from 0 to 0.9 of the picture height');
  if (!Number.isFinite(c.maxHeight) || c.maxHeight <= c.minHeight || c.maxHeight > 1) bad('the largest size must be above the smallest, and at most 1 (the whole picture)');
  if (!Number.isFinite(c.cooldownSec) || c.cooldownSec < 0 || c.cooldownSec > 86400) bad('the quiet time after an event must be from 0 to 86400 seconds');
  if (!Number.isFinite(c.minScore) || c.minScore < 0.1 || c.minScore > 0.95) bad('the confidence must be from 0.1 to 0.95');
  for (const k of ['from', 'to']) {
    if (c[k] !== null && c[k] !== '' && !HHMM.test(c[k])) bad('times must look like 09:30');
    if (c[k] === '') c[k] = null;
  }
  if ((c.from === null) !== (c.to === null)) bad('give both a start and an end time, or neither');
  const w = c.webhook ?? {};
  /** Checks an optional web address (it may contain {placeholders}); returns it, or null when empty. */
  const url = (v, what) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'string' || v.length > 500 || /[\u0000-\u001f\u007f\s]/.test(v.replace(/\{[a-zA-Z]+\}/g, ''))) bad(`${what} is not a usable address`);
    let probe;
    try { probe = new URL(v.replace(/\{[a-zA-Z]+\}/g, 'x')); } catch { bad(`${what} must be a full address such as http://192.168.1.5:8581/motion?Front`); }
    if (probe.protocol !== 'http:' && probe.protocol !== 'https:') bad(`${what} must start with http:// or https://`);
    if (probe.username || probe.password) bad(`${what} cannot contain a user name or password`);
    return v;
  };
  const webhook = { url: url(w.url, 'the web address'), leftUrl: url(w.leftUrl, 'the "gone" web address'), method: w.method === 'GET' ? 'GET' : 'POST' };
  if (w.method !== undefined && w.method !== 'GET' && w.method !== 'POST') bad('the web address method must be GET or POST');
  return { id: c.id, enabled: c.enabled, label: c.label, mode: c.mode, zone: c.zone, classes: c.classes, minStopSec: c.minStopSec,
    minPresenceSec: c.minPresenceSec, minHeight: c.minHeight, maxHeight: c.maxHeight, cooldownSec: c.cooldownSec, from: c.from, to: c.to, minScore: c.minScore, requireArrival: c.requireArrival, webhook };
}

/** A camera section; the first version stored one flat rule, which becomes the first of a list. */
export function normalizeCamera(raw = {}, name = 'camera') {
  /** Rejects the device's section, naming the device. */
  const bad = (m) => { throw new DetectionConfigError(`${name}: ${m}`); };
  let rules = raw.rules;
  if (!Array.isArray(rules)) {
    const { enabled, ...flat } = raw;
    rules = Object.keys(flat).length ? [{ ...flat, id: 'r1', enabled: enabled === true }] : [];
  }
  if (rules.length > MAX_RULES) bad(`at most ${MAX_RULES} rules per device`);
  const out = rules.map((r, i) => normalizeRule({ ...r, id: r.id ?? `r${i + 1}` }, `${name}`));
  if (new Set(out.map((r) => r.id)).size !== out.length) bad('two rules share an id');
  // there is no separate device switch to forget: a device is watched when any of its rules is on
  return { enabled: out.some((x) => x.enabled), rules: out };
}

/**
 * Validates the detection settings (sampling, MQTT, per-device rules) and fills in defaults.
 * @returns {object} @throws {DetectionConfigError} naming what is wrong
 */
export function normalizeDetection(raw = {}) {
  /** Rejects the settings. */
  const bad = (m) => { throw new DetectionConfigError(m); };
  const out = { enabled: raw.enabled === true, intervalMs: raw.intervalMs ?? 1500, mqtt: { enabled: false, url: null, topic: 'reolook', retain: true, discovery: false }, cameras: {} };
  if (!Number.isFinite(out.intervalMs) || out.intervalMs < 500 || out.intervalMs > 10_000) bad('the sampling interval must be from 500 to 10000 ms');
  const m = raw.mqtt ?? {};
  out.mqtt.enabled = m.enabled === true;
  out.mqtt.url = typeof m.url === 'string' && m.url.trim() ? m.url.trim() : null;
  out.mqtt.topic = typeof m.topic === 'string' && m.topic.trim() ? m.topic.trim() : 'reolook';
  out.mqtt.retain = m.retain !== false;
  out.mqtt.discovery = m.discovery === true;
  if (!/^[A-Za-z0-9_\-/]{1,100}$/.test(out.mqtt.topic) || out.mqtt.topic.startsWith('/') || out.mqtt.topic.endsWith('/') || out.mqtt.topic.includes('//')) {
    bad('the MQTT topic prefix may use letters, digits, - _ and / (no leading, trailing or doubled /)');
  }
  if (out.mqtt.enabled) {
    if (!out.mqtt.url) bad('enter the MQTT broker address, for example mqtt://192.168.1.5:1883');
    try { parseUrl(out.mqtt.url); } catch (e) { bad(e.message); }
  }
  for (const [id, c] of Object.entries(raw.cameras ?? {})) {
    if (!/^[a-z0-9-]+$/.test(id)) bad(`unknown device id "${id}"`);
    out.cameras[id] = normalizeCamera(c, id);
  }
  return out;
}
