// HTTP Range requests for a single file (RFC 9110, one "bytes=" range only).

/**
 * Interprets a `Range` header against a file of `size` bytes.
 * Forms understood: `bytes=a-b`, `bytes=a-` (to the end) and `bytes=-n` (the last n bytes); an end
 * beyond the file is clamped to it. Anything else (no header, another unit, several ranges) is not a
 * range, and the whole file should be sent.
 * @param {string|undefined} header the Range header value
 * @param {number} size file size in bytes
 * @returns {null | 'unsatisfiable' | {start: number, end: number}} null: send everything;
 *   'unsatisfiable': the range lies outside the file (answer 416); otherwise the inclusive byte range to send
 */
export function byteRange(header, size) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!range || !(range[1] || range[2])) return null;
  let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
  const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  start = Math.max(0, start);
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}
