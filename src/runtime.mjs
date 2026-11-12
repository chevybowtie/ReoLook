import { startRecorders, startRetention, assertWritable } from './service.mjs';
import { ClientPool } from './client-pool.mjs';

/**
 * Owns the recorders and the retention loop so they can be reloaded when settings change.
 * `reload()` finalizes open recordings before starting again with the new config.
 */
export function createRuntime({ config, user, password, log = console.log, makeRecorders = startRecorders, makeRetention = startRetention, makeDetection = null, events = null, clients = new ClientPool() }) {
  let recorders = null, retention = null, detection = null, reloading = Promise.resolve();

  /**
   * Starts the recorders (when recording is on), the retention loop and detection. A detection that fails to start is logged, not fatal.
   */
  async function start() {
    if (config.record.enabled && config.root) recorders = makeRecorders({ config, user, password, log, clients });
    retention = makeRetention({ config, log });
    if (makeDetection) detection = await makeDetection({ config, user, password, events, log, clients }).catch((e) => { log(`detection could not start: ${e.message}`); return null; });
  }
  /** Stops detection, retention and the recorders (finalizing recordings in progress). */
  async function stop() {
    retention?.stop();
    await recorders?.stop();
    await detection?.stop();
    recorders = null; retention = null; detection = null;
  }
  let storage = { checkedAt: 0, ok: null, error: null };
  /**
   * Whether the recordings folder can be written, remembered for 30 seconds unless `force`. @returns {Promise<{checkedAt: number, ok: boolean|null, error: string|null}>} ok null when no folder is set
   */
  async function checkStorage(force = false) {
    if (!config.root) return (storage = { checkedAt: Date.now(), ok: null, error: null });
    if (!force && Date.now() - storage.checkedAt < 30_000) return storage;
    try { await assertWritable(config.root); storage = { checkedAt: Date.now(), ok: true, error: null }; }
    catch (e) { storage = { checkedAt: Date.now(), ok: false, error: e.message }; }
    return storage;
  }
  return {
    /** Starts recording and detection, then reports once, loudly, if the recordings folder cannot be written. */
    async start() {
      await start();
      // say it once, loudly, instead of letting every motion event fail quietly
      if (config.record.enabled && config.root) {
        checkStorage(true).then((s) => { if (s.ok === false) log(`ERROR recording cannot work: ${s.error}`); });
      }
    },
    checkStorage,
    stop,
    /** The running detection service (or null), and the event log (kept across reloads). */
    detection: () => detection,
    events,
    /** Serialized: overlapping reloads queue instead of racing. */
    reload() { reloading = reloading.then(async () => { await stop(); await start(); }); return reloading; },
    status: () => ({
      recording: recorders ? { enabled: true, cameras: recorders.status() } : { enabled: false, cameras: [] },
      detection: detection ? detection.service.status() : { running: false, frames: 0, cameras: {} },
      retention: retention ? retention.status() : { configured: false, apply: false, lastRun: null, last: null, running: false },
    }),
  };
}
