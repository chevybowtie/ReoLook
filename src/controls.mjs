// Live controls that act on the world rather than store a setting: pan/tilt/zoom, presets and the
// siren. These follow Reolink's documented HTTP API and have NOT been exercised on hardware that
// has them (the development cameras have none); every request is built here, validated before it
// is sent, and tested against a fake that checks the exact shape.
import { WriteError } from './device-settings.mjs';

export const PTZ_MOVES = ['Left', 'Right', 'Up', 'Down', 'LeftUp', 'LeftDown', 'RightUp', 'RightDown', 'ZoomInc', 'ZoomDec', 'FocusInc', 'FocusDec'];

/** Checks a whole number in a range. @throws {WriteError} naming `what` */
const int = (v, min, max, what) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new WriteError(`${what} must be a whole number from ${min} to ${max}`);
  return v;
};

/** Validate a PTZ request from the page. Returns the command parameters (without channel). */
export function ptzRequest(body) {
  const op = body?.op;
  if (op === 'Stop') return { op };
  if (PTZ_MOVES.includes(op)) return { op, speed: body.speed === undefined ? 32 : int(body.speed, 1, 64, 'speed') };
  if (op === 'ToPos') return { op, id: int(body.id, 0, 255, 'preset'), speed: body.speed === undefined ? 32 : int(body.speed, 1, 64, 'speed') };
  throw new WriteError(`unknown PTZ operation "${String(op).slice(0, 20)}"`);
}

/** Sends a pan/tilt/zoom command: `req` is the device's own PtzCtrl parameters (op, speed, id). */
export async function ptz(client, channel, req) {
  await client.command('PtzCtrl', { channel, ...req });
}

/** Presets the device has saved: [{ id, name }]. A preset is "saved" when its enable flag is on. */
export async function listPresets(client, channel) {
  const v = await client.command('GetPtzPreset', { channel });
  const t = v?.PtzPreset?.table;
  if (!Array.isArray(t)) return [];
  return t.filter((p) => p && (p.enable === 1 || p.enable === true)).map((p) => ({ id: Number(p.id), name: String(p.name ?? '') }))
    .filter((p) => Number.isInteger(p.id));
}

/** Save the camera's CURRENT position as preset `id`. */
export async function savePreset(client, channel, { id, name }) {
  const n = typeof name === 'string' ? name.trim() : '';
  if ([...n].length > 31 || /[\u0000-\u001f\u007f]/.test(n)) throw new WriteError('the preset name can be at most 31 characters, with no control characters');
  await client.command('SetPtzPreset', { PtzPreset: { channel, enable: 1, id: int(id, 0, 255, 'preset'), name: n || `pos${id}` } });
}

/** Sound the siren once, or stop it. */
export async function siren(client, channel, action) {
  if (action !== 'start' && action !== 'stop') throw new WriteError('siren action must be start or stop');
  await client.command('AudioAlarmPlay', { alarm_mode: 'manul', manual_switch: action === 'start' ? 1 : 0, times: 1, channel });
}

/** Restarts the device. It stops answering for about a minute; sessions held open with it end. */
export async function reboot(client) {
  await client.command('Reboot');
}

/** Battery facts, whichever the device reports. Numbers only; nothing is guessed. */
export async function batteryInfo(client, channel) {
  const v = (await client.command('GetBatteryInfo', { channel }))?.Battery;
  if (!v || typeof v !== 'object') return null;
  /** The number the device reported under `k`, or null. */
  const pick = (k) => (Number.isFinite(v[k]) ? v[k] : null);
  return { percent: pick('batteryPercent'), charging: Number.isFinite(v.chargeStatus) ? v.chargeStatus : null,
    temperature: pick('temperature'), voltage: pick('voltage'), adapterPresent: Number.isFinite(v.adapterStatus) ? v.adapterStatus : null };
}
