// Telling the outside world about an event: MQTT topics, an optional web address per rule, and
// Home Assistant discovery. Used for real events and for the "send a test" button, so the test
// exercises exactly the path a real event takes.
import { labelSlug } from './config.mjs';

/** Replace {camera} {label} {event} {tag} {id} in a URL, each URL-encoded. */
export function fillUrl(template, vars) {
  return String(template).replace(/\{(camera|cameraId|label|event|tag|id|vehicle)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

/** The JSON body that MQTT and webhooks both carry. */
export function eventBody(rec) {
  return { event: `${labelSlug(rec.rule)}_${rec.type}`, type: rec.type, label: rec.rule, tag: rec.tag, camera: rec.cameraName, cameraId: rec.camera,
    vehicle: rec.vehicle, score: rec.score, at: rec.at, id: rec.id, ...(rec.test ? { test: true } : {}) };
}

export class Notifier {
  #cfg; #mqtt; #fetch; #log;
  /** cfg: the detection config; mqtt: a publisher or null. */
  constructor({ config, mqtt = null, fetchImpl = fetch, log = () => {} }) { this.#cfg = config; this.#mqtt = mqtt; this.#fetch = fetchImpl; this.#log = log; }

  /**
   * Send one event everywhere it should go. Resolves to what happened on each channel; never throws,
   * so a dead broker or web address cannot stop detection.
   */
  async notify(rec, rule) {
    const out = { mqtt: null, webhook: null };
    const body = eventBody(rec);
    const tasks = [];
    if (this.#mqtt) {
      const base = `${this.#cfg.mqtt.topic}/${rec.camera}`;
      tasks.push((async () => {
        try {
          await this.#mqtt.publish(`${base}/event`, body, { qos: 1 });
          await this.#mqtt.publish(`${base}/${labelSlug(rec.rule)}`, rec.type === 'left' ? 'OFF' : 'ON', { qos: 1, retain: this.#cfg.mqtt.retain && !rec.test });
          out.mqtt = { ok: true, topic: `${base}/event` };
        } catch (e) { out.mqtt = { ok: false, error: e.message }; this.#log(`MQTT: ${e.message}`); }
      })());
    }
    const hook = rule?.webhook;
    const url = rec.type === 'left' ? hook?.leftUrl : hook?.url;
    if (url) {
      tasks.push((async () => {
        const vars = { camera: rec.cameraName, cameraId: rec.camera, label: rec.rule, event: body.event, tag: rec.tag, id: rec.id, vehicle: rec.vehicle };
        const target = fillUrl(url, vars);
        try {
          const res = await this.#fetch(target, {
            method: hook.method, redirect: 'manual', signal: AbortSignal.timeout(5000),
            ...(hook.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
          });
          out.webhook = { ok: res.status >= 200 && res.status < 300, status: res.status, url: target };
          if (!out.webhook.ok) { out.webhook.error = `the address answered ${res.status}`; this.#log(`webhook ${target}: ${res.status}`); }
        } catch (e) { out.webhook = { ok: false, url: target, error: e.name === 'TimeoutError' ? 'no answer within 5 seconds' : e.message }; this.#log(`webhook ${target}: ${e.message}`); }
      })());
    }
    await Promise.all(tasks);
    return out;
  }

  /**
   * Home Assistant MQTT discovery: one binary sensor per rule, so each shows up there by itself.
   * Retained, so it survives a restart of either side.
   */
  async announce(cameras, prefixDiscovery = 'homeassistant') {
    if (!this.#mqtt) return;
    const status = `${this.#cfg.mqtt.topic}/status`;
    for (const cam of cameras) {
      const cc = this.#cfg.cameras[cam.id];
      for (const rule of cc?.enabled ? cc.rules.filter((r) => r.enabled) : []) {
        const slug = labelSlug(rule.label), id = `reolook_${cam.id.replace(/-/g, '_')}_${slug}`;
        const payload = { name: `${cam.name} ${rule.label}`, unique_id: id, state_topic: `${this.#cfg.mqtt.topic}/${cam.id}/${slug}`,
          payload_on: 'ON', payload_off: 'OFF', device_class: 'occupancy', json_attributes_topic: `${this.#cfg.mqtt.topic}/${cam.id}/event`,
          availability_topic: status, payload_available: 'online', payload_not_available: 'offline',
          device: { identifiers: ['reolook'], name: 'ReoLook', manufacturer: 'ReoLook' } };
        await this.#mqtt.publish(`${prefixDiscovery}/binary_sensor/${id}/config`, payload, { qos: 1, retain: true }).catch(() => {});
      }
    }
  }
}
