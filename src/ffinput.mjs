// ffmpeg input arguments for a stream address. A camera is read over RTSP; the demo cameras have no
// RTSP server, so their address is `lavfi:<filter graph>`, a generated test picture played at real time.
/**
 * ffmpeg input options for a stream address.
 * @param {string} url an RTSP address, or `lavfi:<filter graph>` for a demo camera
 * @returns {string[]} the options up to and including `-i <input>`
 */
export function inputArgs(url) {
  if (typeof url === 'string' && url.startsWith('lavfi:')) return ['-re', '-f', 'lavfi', '-i', url.slice(6)];
  return ['-rtsp_transport', 'tcp', '-i', url];
}

/** How long, in microseconds of stream time, and how many bytes ffmpeg may look at to work out what a recording's streams are. */
export const RECORDER_PROBE = { analyzeduration: 15_000_000, probesize: 32_000_000 };

/**
 * How long, in microseconds, a recording's camera connection may be silent before ffmpeg gives up on it. ffmpeg's own
 * default is no limit, so a camera that starts a stream and then stops sending (seen about every five minutes on one
 * camera) held the recording open until the recorder's 20-second stall watchdog killed it. With this, ffmpeg ends by
 * itself, keeps what it had recorded, and the recorder starts a fresh recording. A healthy stream sends something many
 * times a second; the same limit also covers the start-up exchange with the camera, so it is kept generous.
 */
export const RECORDER_SILENCE_TIMEOUT_US = 10_000_000;

/**
 * Input options for recording. A camera's picture size is only known from the stream's parameter sets, which
 * arrive with a key frame. Joining part-way through a group of pictures, ffmpeg has to wait for the next one,
 * and its default window (5 s, 5 MB) is shorter than the key-frame interval of some streams (a low frame rate
 * stretches it), so the recording failed with "dimensions not set" and was discarded. This allows 15 s and 32 MB.
 * ffmpeg stops looking as soon as it knows, so a stream that identifies itself promptly starts just as fast.
 * A silence timeout (RECORDER_SILENCE_TIMEOUT_US) makes ffmpeg end by itself when the camera stops sending.
 * @param {string} url an RTSP address, or `lavfi:<filter graph>` for a demo camera (which has no key-frame wait)
 * @returns {string[]} the options up to and including `-i <input>`
 */
export function recorderInputArgs(url) {
  if (typeof url === 'string' && url.startsWith('lavfi:')) return inputArgs(url);
  return ['-analyzeduration', String(RECORDER_PROBE.analyzeduration), '-probesize', String(RECORDER_PROBE.probesize),
    '-timeout', String(RECORDER_SILENCE_TIMEOUT_US), ...inputArgs(url)];
}
