// Changing the main stream's resolution. Not part of the plan/apply pipeline because of what
// the device does, found on an RLC-410 (v3.0.0.136):
//   * SetEnc takes the main stream object as read with size, resolution, width and height replaced;
//   * the camera then restarts its video service: it stops answering for about a minute and every
//     sign-in token is invalidated, so reading it back means signing in again;
//   * the motion detection area is RESET TO EVERYTHING WATCHED, and is not restored by changing the
//     resolution back. This operation saves the area first and puts it back afterwards.
import { WriteError } from './device-settings.mjs';

/** Waits `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The sizes this device offers for its main stream, with the bit/frame rates each allows. */
export async function resolutionOptions(client, channel = 0) {
  const d = await client.describe('GetEnc', { channel });
  const cur = d.value?.Enc?.mainStream;
  const list = d.range?.Enc;
  if (!cur || !Array.isArray(list)) throw new Error('the device did not report its resolutions');
  const options = list.filter((e) => e.mainStream?.size).map((e) => {
    const m = e.mainStream;
    const [w, h] = String(m.size).split('*').map(Number);
    return { size: m.size, resolution: m.resolution ?? null, width: m.width ?? (Number.isFinite(w) ? w : null), height: m.height ?? (Number.isFinite(h) ? h : null),
      bitRates: m.bitRate ?? null, frameRates: m.frameRate ?? null, defaults: m.default ?? null };
  });
  return { current: { size: cur.size, resolution: cur.resolution ?? null, width: cur.width ?? null, height: cur.height ?? null }, options };
}

/** The main stream object to send for `size`, keeping the rates when the new size allows them. */
export function targetStream(currentStream, option) {
  const next = { ...currentStream, size: option.size };
  for (const k of ['resolution', 'width', 'height']) if (option[k] !== null && k in currentStream) next[k] = option[k];
  /** Keeps a rate the new size still allows, otherwise switches to that size's default (or its first choice). */
  const keep = (key, list, dflt) => {
    if (Array.isArray(list) && !list.includes(currentStream[key])) next[key] = dflt ?? list[0];
  };
  keep('bitRate', option.bitRates, option.defaults?.bitRate);
  keep('frameRate', option.frameRates, option.defaults?.frameRate);
  return next;
}

/**
 * Change the main resolution to `size` and restore the motion area afterwards.
 *   makeClient(): a freshly signed-in client (called again after the restart)
 * Returns { verified, from, to, zones: 'preserved'|'restored'|'not restored: reason'|'none' }.
 */
export async function changeResolution({ makeClient, channel = 0, size, waitMs = 150_000, pollMs = 3000, wait = sleep, remembered = [] }) {
  let c = makeClient();
  const info = await resolutionOptions(c, channel);
  const option = info.options.find((o) => o.size === size);
  if (!option) throw new WriteError(`this device does not offer ${size}; it offers: ${info.options.map((o) => o.size).join(', ')}`);
  if (info.current.size === size) throw new WriteError(`the main stream is already ${size}`, 409);

  const enc = (await c.command('GetEnc', { channel })).Enc;
  const alarm = (await c.command('GetAlarm', { Alarm: { channel, type: 'md' } })).Alarm;
  const saved = alarm?.scope && typeof alarm.scope.table === 'string' ? { cols: alarm.scope.cols, rows: alarm.scope.rows, table: alarm.scope.table } : null;
  const sens = (await c.command('GetMdAlarm', { channel })).MdAlarm?.sens;
  const stream = targetStream(enc.mainStream, option);

  await c.command('SetEnc', { Enc: { channel, mainStream: stream } });

  // wait for the video service to come back showing the new size
  let now = null;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await wait(pollMs);
    try {
      const fresh = makeClient();
      const e = (await fresh.command('GetEnc', { channel })).Enc;
      if (e?.mainStream?.size === size) { now = e.mainStream; c = fresh; break; }
    } catch { /* still restarting */ }
  }
  if (!now) return { verified: false, from: info.current.size, to: size, zones: 'unknown', error: `the device did not report ${size} within ${Math.round(waitMs / 1000)} seconds` };

  // the area is reset by the restart: put the saved one back
  // Another shape of picture has a different grid, so the old area cannot simply be written back.
  // It is kept (returned as `saved`) and used when the picture comes back to a grid it was drawn on.
  let zones = 'none';
  try {
    const after = (await c.command('GetAlarm', { Alarm: { channel, type: 'md' } })).Alarm?.scope;
    const candidates = [saved, ...remembered].filter(Boolean).filter((z) => z.cols === after?.cols && z.rows === after?.rows);
    const want = candidates[0];
    if (want && after?.table === want.table) zones = 'preserved';
    else if (want) {
      await c.command('SetMdAlarm', { MdAlarm: { channel, scope: { cols: want.cols, rows: want.rows, table: want.table }, sens } });
      const check = (await c.command('GetAlarm', { Alarm: { channel, type: 'md' } })).Alarm?.scope;
      zones = check?.table === want.table ? (want === saved ? 'restored' : 'restored from an earlier layout') : 'not restored: the device did not keep it';
    } else if (saved && after) {
      zones = `not restored: the picture shape changed (grid ${saved.cols}x${saved.rows} to ${after.cols}x${after.rows}); the camera watches everything until you draw it again`;
    }
  } catch (e) { zones = `not restored: ${String(e.detail ?? e.message).slice(0, 100)}`; }
  return { verified: true, from: info.current.size, to: size, zones, stream: now, saved };
}
