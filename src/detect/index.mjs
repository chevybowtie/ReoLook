// Assembles the detection service for a config: the helper process, the MQTT publisher, the
// per-camera watchers. Returns null when detection is off or not installed.
import { ClientPool } from '../client-pool.mjs';
import { DetectorClient, detectorStatus } from './helper-client.mjs';
import { DetectionService } from './service.mjs';
import { Notifier } from './notify.mjs';
import { Classifiers } from './classifier.mjs';
import { detectorPaths } from './helper-client.mjs';
import { MqttPublisher } from '../mqtt.mjs';
import { loadEnvVars } from '../credentials.mjs';

/**
 * @param {object} o
 * @param {ClientPool} [o.clients] the pool the device clients come from, shared with whoever else reads from the
 *   cameras; whoever passes one owns it and signs it out. Without one, detection uses its own and signs it out on stop.
 */
export async function createDetection({ config, user, password, events, log = () => {}, env = process.env, detectorDir, makeDetector = null, clients: pool = null }) {
  const d = config.detection;
  if (!d?.enabled || !Object.values(d.cameras).some((c) => c.enabled && c.rules.some((r) => r.enabled))) return null;
  const st = await detectorStatus(detectorDir);
  if (!st.ready) { log(`detection is turned on but the detector is not installed (run: node bin/reolook.mjs detect setup)`); return null; }

  const ownPool = !pool;
  pool ??= new ClientPool();
  const clients = new Map(config.cameras.map((c) => [c.id, pool.viewer({ host: c.host, user, password })]));
  const detector = makeDetector ? makeDetector() : new DetectorClient({ dir: detectorDir });
  let mqtt = null;
  if (d.mqtt.enabled && d.mqtt.url) {
    const vars = await loadEnvVars({ env });
    mqtt = new MqttPublisher({ url: d.mqtt.url, username: vars.REOLOOK_MQTT_USER || undefined, password: vars.REOLOOK_MQTT_PASS || undefined,
      statusTopic: `${d.mqtt.topic}/status`, clientId: `reolook-${process.pid}` });
    mqtt.on('error', (e) => log(`MQTT: ${e.message}`));
    mqtt.on('connected', () => {
      log(`MQTT: connected to ${mqtt.target.host}:${mqtt.target.port}`);
      if (d.mqtt.discovery) new Notifier({ config: d, mqtt }).announce(config.cameras).catch(() => {});
    });
    mqtt.start();
  }
  // the appearance check, when its model is installed and a rule has been trained
  const classifiers = new Classifiers(detectorPaths(detectorDir).dir);
  const looks = st.canLook ? async (cameraId, ruleId, file, box) => {
    if (!(await classifiers.get(cameraId, ruleId))) return null;
    return classifiers.score(cameraId, ruleId, await detector.embed(file, box));
  } : null;
  const service = new DetectionService({ config: d, cameras: config.cameras, clients: (id) => clients.get(id), detector, events, mqtt, log, looks });
  await service.start();
  log(`detection: watching ${Object.entries(d.cameras).filter(([, c]) => c.enabled).map(([id, c]) => `${id} (${c.rules.filter((r) => r.enabled).map((r) => r.label).join(', ')})`).join('; ')}${mqtt ? ' (MQTT on)' : ''}`);
  return {
    service, mqtt,
    async stop() { await service.stop(); detector.close(); await mqtt?.end(); if (ownPool) pool.close().catch(() => {}); },
  };
}
