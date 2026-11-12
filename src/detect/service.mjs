// Watches the cameras that have detection turned on and reports a vehicle that stops in the zone.
// To stay cheap it only samples frames while the camera itself reports motion (or while a vehicle
// is already being followed), a frame or so per second, and never records anything.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StopTracker, inWindow, pointInPolygon, footOf } from './rules.mjs';
import { Notifier } from './notify.mjs';
import { SHARED_MOTION_MS } from '../client.mjs';
import { pad2 } from '../format.mjs';

/** HH:MM of a Date, as shown in event tags. */
export const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

export class DetectionService {
  #auto; #looks; #notifier; #cfg; #clients; #detector; #events; #mqtt; #log; #now; #cams = new Map(); #stopped = true; #tmp = null;
  #status = { running: false, frames: 0, lastMs: null, lastAt: null, lastError: null, cameras: {} };
  #listeners = new Set();

  /**
   * clients: (cameraId) => ReolinkClient. cameras: [{ id, name, channel }].
   * mqtt may be null; when given it needs publish(topic, payload, { retain }).
   */
  constructor({ config, cameras, clients, detector, events, mqtt = null, log = () => {}, now = () => Date.now(), autoLoop = true, fetchImpl = fetch, looks = null }) {
    this.#looks = looks;
    this.#auto = autoLoop;
    this.#cfg = config; this.cameras = cameras; this.#clients = clients; this.#detector = detector; this.#events = events;
    this.#mqtt = mqtt; this.#log = log; this.#now = now;
    this.#notifier = new Notifier({ config, mqtt, fetchImpl, log });
  }

  onEvent(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  status() { return { ...this.#status, cameras: Object.fromEntries(Object.entries(this.#status.cameras).map(([k, v]) => [k, { ...v }])) }; }

  /**
   * Starts watching every device that has an enabled rule: one timer each, polling about once a second. Does nothing if already started or turned off.
   */
  async start() {
    if (!this.#stopped || !this.#cfg.enabled) return;
    this.#stopped = false; this.#status.running = true;
    this.#tmp = await mkdtemp(path.join(tmpdir(), 'reolook-detect-'));
    for (const cam of this.cameras) {
      const cc = this.#cfg.cameras[cam.id];
      const rules = (cc?.enabled ? cc.rules : []).filter((r) => r.enabled);
      if (!rules.length) continue;
      const st = { cam, rules: rules.map((rule) => ({ rule, tracker: new StopTracker(rule) })), lastSample: 0, busy: false, lastSeenAt: 0, state: 'idle', timer: null };
      this.#cams.set(cam.id, st);
      this.#status.cameras[cam.id] = { watching: true, state: 'idle', lastEvent: null, lastError: null };
      if (!this.#auto) continue;
      /** Polls this device, then schedules itself again a second later, until stopped. */
      const loop = async () => {
        if (this.#stopped) return;
        try { await this.#tick(st); } catch (e) { this.#fail(cam.id, e); }
        st.timer = setTimeout(loop, 1000);
      };
      st.timer = setTimeout(loop, 500);
    }
  }

  /** One pass over every watched camera (what the timer does each second); used by tests. */
  async step() { for (const st of this.#cams.values()) { try { await this.#tick(st); } catch (e) { this.#fail(st.cam.id, e); } } }

  /** Stops the timers and removes the temporary pictures. */
  async stop() {
    this.#stopped = true; this.#status.running = false;
    for (const st of this.#cams.values()) clearTimeout(st.timer);
    this.#cams.clear();
    if (this.#tmp) { await rm(this.#tmp, { recursive: true, force: true }).catch(() => {}); this.#tmp = null; }
  }

  /** Records the latest error, for the status page, against the service and the device. */
  #fail(id, e) {
    const msg = String(e?.message ?? e).slice(0, 160);
    this.#status.lastError = msg;
    if (this.#status.cameras[id]) this.#status.cameras[id].lastError = msg;
  }

  /**
   * One look at a device. Skips it outside the rule's hours, reads the camera's own motion state, and, while there is motion or
   * something is being followed, takes a snapshot, runs the detector, feeds each rule's tracker and emits the events that result.
   */
  async #tick(st) {
    const now = this.#now();
    const live = st.rules.filter(({ rule }) => inWindow(new Date(now), rule.from, rule.to));
    if (!live.length) { this.#setState(st, 'outside hours'); return; }
    const client = this.#clients(st.cam.id);
    // look while the camera sees motion, or while something is being followed / was just seen
    const following = live.some(({ tracker }) => tracker.tracks.length > 0) || now - st.lastSeenAt < 15_000;
    let motion = false;
    try { motion = await client.motionState({ channel: st.cam.channel, maxAgeMs: SHARED_MOTION_MS }); } catch { /* treat as no motion */ }
    if (!motion && !following) { this.#setState(st, 'idle'); return; }
    if (st.busy || now - st.lastSample < this.#cfg.intervalMs) return;
    st.busy = true; st.lastSample = now;
    try {
      this.#setState(st, following ? 'following' : 'looking');
      const jpeg = await client.snapshot({ channel: st.cam.channel });
      const file = path.join(this.#tmp, `${st.cam.id}.jpg`);
      await writeFile(file, jpeg);
      const r = await this.#detector.detect(file, { conf: 0.25 });
      this.#status.frames++; this.#status.lastMs = r.ms; this.#status.lastAt = new Date(now).toISOString(); this.#status.lastError = null;
      for (const { rule, tracker } of st.rules) {
        const inHours = inWindow(new Date(now), rule.from, rule.to);
        const events = tracker.update(inHours ? r.detections : [], now);
        if (inHours && r.detections.some((d) => rule.classes.includes(d.label) && d.score >= rule.minScore)) st.lastSeenAt = now;
        for (const ev of events) await this.#emit(st, rule, ev, jpeg, file);
      }
    } finally { st.busy = false; }
  }

  #setState(st, state) { st.state = state; this.#status.cameras[st.cam.id].state = state; }

  /**
   * Records and announces one event: adds the appearance score when available, stores it with its picture, logs it, tells listeners and sends the notifications (MQTT, web address).
   */
  async #emit(st, rule, ev, jpeg, file) {
    const at = new Date(ev.at);
    const base = { type: ev.type, camera: st.cam.id, cameraName: st.cam.name, rule: rule.label, ruleId: rule.id, vehicle: ev.track.label,
      score: Math.round(ev.track.score * 100) / 100, box: ev.track.box, heightPct: Math.round((ev.track.box[3] - ev.track.box[1]) * 100),
      at: at.toISOString(), tag: `${rule.label} ${hhmm(at)}` };
    // the appearance check only watches: it adds a score and never decides whether the event happens
    if (this.#looks && ev.type !== 'left') {
      try { const s = await this.#looks(st.cam.id, rule.id, file, ev.track.box); if (s !== null) { base.look = s; base.lookKind = 'live'; } } catch { /* no score, same event */ }
    }
    const rec = await this.#events.add(base, ev.type !== 'left' ? jpeg : null);
    this.#status.cameras[st.cam.id].lastEvent = { type: rec.type, at: rec.at, tag: rec.tag };
    this.#log(`[${st.cam.name}] ${ev.type === 'left' ? `${rule.label} left` : `${rec.tag}: ${rec.vehicle} ${ev.type}`}`);
    for (const fn of this.#listeners) { try { fn(rec); } catch { /* a listener must not stop detection */ } }
    this.#notifier.notify(rec, rule).then((r) => {
      const bad = [r.mqtt, r.webhook].find((x) => x && !x.ok);
      if (bad) this.#fail(st.cam.id, bad.error);
      this.#status.cameras[st.cam.id].lastNotify = { at: new Date().toISOString(), mqtt: r.mqtt, webhook: r.webhook };
    });
  }

  /** One look right now, for tuning: the frame, what was found, and whether each vehicle is in the zone. */
  async testNow(cameraId, rulesOverride = null) {
    const cam = this.cameras.find((c) => c.id === cameraId);
    const rules = rulesOverride ?? this.#cfg.cameras[cameraId]?.rules ?? [];
    if (!cam) throw new Error('unknown device');
    const dir = this.#tmp ?? await mkdtemp(path.join(tmpdir(), 'reolook-detect-'));
    const own = !this.#tmp;
    try {
      const jpeg = await this.#clients(cameraId).snapshot({ channel: cam.channel });
      const file = path.join(dir, `test-${cameraId}.jpg`);
      await writeFile(file, jpeg);
      const r = await this.#detector.detect(file, { conf: 0.25 });
      // for each detection: which rules would count it (right type, big enough, confident, inside its zone)
      return { jpeg, width: r.width, height: r.height, ms: r.ms,
        detections: r.detections.map((d) => {
          const hits = rules.filter((rl) => rl.classes.includes(d.label) && d.score >= rl.minScore && d.box[3] - d.box[1] >= rl.minHeight && d.box[3] - d.box[1] <= (rl.maxHeight ?? 1)
            && (rl.zone.length < 3 || pointInPolygon(footOf(d.box), rl.zone))).map((rl) => rl.label);
          const typeOk = rules.some((rl) => rl.classes.includes(d.label));
          return { ...d, heightPct: Math.round((d.box[3] - d.box[1]) * 100), counted: hits.length > 0, rules: hits, matchesType: typeOk,
            inZone: rules.some((rl) => rl.zone.length >= 3) ? rules.some((rl) => rl.zone.length >= 3 && pointInPolygon(footOf(d.box), rl.zone)) : null };
        }) };
    } finally { if (own) await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }
}
