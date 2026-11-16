// Builds the Homebridge `homebridge-camera-ffmpeg` configuration for ReoLook's cameras, so that nobody has to
// work out the stream and snapshot addresses by hand. Pure functions plus one file writer; nothing here talks
// to a camera or to Homebridge.
import { readFile, writeFile, rename, copyFile, access, stat, chmod } from 'node:fs/promises';
import path from 'node:path';

export const PLATFORM = 'Camera-ffmpeg';
export const DEFAULT_HTTP_PORT = 8080;

/**
 * Percent-encodes a value for use inside a URL's user, password or query. Stricter than encodeURIComponent: the
 * plugin splits the command on spaces without a shell, so nothing that could be read as a separator may remain.
 * @param {string} s @returns {string}
 */
export function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The address part of a device host without its port: the RTSP service is on its own port (554), while a port
 * written in ReoLook's configuration is the web port. @param {string} host @returns {string}
 */
function bareHost(host) { return host.replace(/:\d+$/, ''); }

/**
 * One camera as the plugin wants it: live video from the sub stream over TCP, and stills from the camera's own
 * snapshot address (a still taken from the video stream waits for a clean picture and can take many seconds).
 * @param {{name: string, host: string, channel?: number}} camera one entry of ReoLook's configuration
 * @param {{user: string, password: string}} login the camera sign-in
 * @returns {object} a `cameras` entry
 */
export function cameraEntry(camera, { user, password }) {
  const channel = camera.channel ?? 0;
  const rtsp = `rtsp://${enc(user)}:${enc(password)}@${bareHost(camera.host)}:554/h264Preview_${String(channel + 1).padStart(2, '0')}_sub`;
  const snap = `http://${camera.host}/cgi-bin/api.cgi?cmd=Snap&channel=${channel}&rs=reolook&user=${enc(user)}&password=${enc(password)}`;
  return {
    name: camera.name,
    motion: true,
    doorbell: true,
    videoConfig: {
      source: `-rtsp_transport tcp -i ${rtsp}`,
      stillImageSource: `-i ${snap} -frames:v 1`,
      maxWidth: 1280,
      maxHeight: 720,
      maxFPS: 15,
      audio: false,
    },
  };
}

/**
 * The whole `Camera-ffmpeg` platform block for a list of cameras. @param {object[]} cameras @param {{user: string, password: string}} login
 * @param {{httpPort?: number}} [o] the port of the plugin's trigger server @returns {object}
 */
export function buildPlatform(cameras, login, { httpPort = DEFAULT_HTTP_PORT } = {}) {
  return { platform: PLATFORM, porthttp: httpPort, cameras: cameras.map((c) => cameraEntry(c, login)) };
}

/**
 * The addresses a detection rule calls to make a camera pop up (and to clear it). The name is the camera's name
 * as ReoLook shows it, which is also what the plugin was given. @param {string} name @param {{bridgeHost?: string, httpPort?: number}} [o]
 * @returns {{doorbell: string, motion: string, reset: string}}
 */
export function triggerUrls(name, { bridgeHost = '<this PC>', httpPort = DEFAULT_HTTP_PORT } = {}) {
  const base = `http://${bridgeHost}:${httpPort}`;
  const n = encodeURIComponent(name);
  return { doorbell: `${base}/doorbell?${n}`, motion: `${base}/motion?${n}`, reset: `${base}/motion/reset?${n}` };
}

/**
 * Puts the wanted cameras into an existing Homebridge configuration, leaving everything else alone. A camera is
 * matched by name: an existing one gets only its two addresses refreshed (its other settings are the user's), a
 * missing one is added. The trigger port is set only when none is. A configuration with no `Camera-ffmpeg`
 * platform gets one. The input is not changed. @param {object} config the parsed Homebridge config.json @param {object} wanted from `buildPlatform`
 * @returns {{config: object, added: string[], updated: string[], unchanged: string[]}} names in each group
 */
export function mergePlatform(config, wanted) {
  const out = structuredClone(config);
  const added = [], updated = [], unchanged = [];
  if (!Array.isArray(out.platforms)) out.platforms = [];
  let platform = out.platforms.find((p) => p?.platform === PLATFORM);
  if (!platform) { platform = { platform: PLATFORM, cameras: [] }; out.platforms.push(platform); }
  if (!Array.isArray(platform.cameras)) platform.cameras = [];
  if (platform.porthttp == null) platform.porthttp = wanted.porthttp;
  for (const cam of wanted.cameras) {
    const have = platform.cameras.find((c) => c?.name === cam.name);
    if (!have) { platform.cameras.push(cam); added.push(cam.name); continue; }
    have.videoConfig ??= {};
    const same = have.videoConfig.source === cam.videoConfig.source && have.videoConfig.stillImageSource === cam.videoConfig.stillImageSource;
    have.videoConfig.source = cam.videoConfig.source;
    have.videoConfig.stillImageSource = cam.videoConfig.stillImageSource;
    (same ? unchanged : updated).push(cam.name);
  }
  return { config: out, added, updated, unchanged };
}

/**
 * Merges the wanted cameras into a Homebridge configuration file. Keeps one `.bak` of the file as it was before
 * the first change, and replaces the file in one step, with its permissions. The file must already exist, since
 * a Homebridge folder that was never started would otherwise be half set up. @param {string} file @param {object} wanted from `buildPlatform`
 * @returns {Promise<{added: string[], updated: string[], unchanged: string[], backup: string|null, wrote: boolean}>}
 * @throws {Error} with advice when the file is missing, is not JSON, or cannot be written (for example owned by root)
 */
export async function writeHomebridgeConfig(file, wanted) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error(`${file} does not exist; point --write at Homebridge's config.json (start Homebridge once so it creates it)`);
    throw new Error(`cannot read ${file}: ${e.message}${e.code === 'EACCES' ? '; leave out --write to print the block and paste it into the Homebridge UI instead' : ''}`);
  }
  let config;
  try { config = JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
  const merged = mergePlatform(config, wanted);
  const changed = merged.added.length + merged.updated.length > 0;
  if (!changed) return { ...merged, backup: null, wrote: false };
  const backup = `${file}.bak`;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const mode = (await stat(file)).mode & 0o777;
    let made = null;
    try { await access(backup); } catch { await copyFile(file, backup); made = backup; }
    await writeFile(tmp, JSON.stringify(merged.config, null, 4) + '\n', { mode });
    await chmod(tmp, mode);
    await rename(tmp, file);
    return { ...merged, backup: made, wrote: true };
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
      throw new Error(`cannot write ${file} (${e.code}); it is probably owned by another user, such as root when Docker created it.\n`
        + '  Either leave out --write and paste the printed block into the Homebridge UI (Plugins, Camera FFmpeg, Settings, JSON config),\n'
        + `  or fix the ownership: sudo chown $USER ${file} ${path.dirname(file)}`);
    }
    throw e;
  }
}
