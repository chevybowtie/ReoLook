// Run a saved rule over recordings that already exist, to see what it would have done: a missed
// delivery, a false alarm, or the effect of a changed setting, without waiting for tomorrow.
// Frames are taken every 1.5 s, which is how often the live service looks.
import { readdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StopTracker, pointInPolygon, footOf, inWindow } from './rules.mjs';

const run = promisify(execFile);
export const STEP_MS = 1500;

/** "<Name>-00-HHMMSS-HHMMSS.mp4" to { camera, start, end } in seconds since midnight. */
export function parseClipName(name) {
  const m = /^(.*)-00-(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mp4$/.exec(name);
  if (!m) return null;
  return { camera: m[1], start: +m[2] * 3600 + +m[3] * 60 + +m[4], end: +m[5] * 3600 + +m[6] * 60 + +m[7] };
}
/** Formats seconds since midnight as HH:MM:SS. */
export const clock = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
/** Seconds since midnight of an HH:MM string. */
const secs = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60; };

/** The clips of one camera on one day that overlap [from, to] ("HH:MM"), oldest first. */
export async function clipsFor({ root, day, camera, from = '00:00', to = '23:59' }) {
  const [y, mo, d] = day.split('-');
  const dir = path.join(root, `${mo}${d}${y}`);
  const names = await readdir(dir).catch(() => []);
  const a = secs(from), b = secs(to) + 59;
  return names.map((n) => ({ name: n, ...parseClipName(n) })).filter((c) => c.camera === camera && c.end >= a && c.start <= b)
    .sort((p, q) => p.start - q.start).map((c) => ({ ...c, file: path.join(dir, c.name) }));
}

/** What a rule makes of a list of per-frame detections. Pure; `frames` is [{ t (ms), detections }]. */
export function judge(rule, frames) {
  const tracker = new StopTracker(rule);
  const events = [];
  const near = [];                                         // everything of the right type, and why it did or did not count
  for (const f of frames) {
    events.push(...tracker.update(f.detections, f.t));
    for (const d of f.detections) {
      if (!rule.classes.includes(d.label)) continue;
      const h = d.box[3] - d.box[1];
      const inZone = rule.zone.length < 3 || pointInPolygon(footOf(d.box), rule.zone);
      near.push({ t: f.t, label: d.label, score: d.score, h, inZone, why: d.score < rule.minScore ? 'too faint' : h < rule.minHeight ? 'too small' : h > (rule.maxHeight ?? 1) ? 'too large' : !inZone ? 'outside the zone' : 'counts' });
    }
  }
  const counting = near.filter((n) => n.why === 'counts');
  const best = [...near].sort((p, q) => (q.why === 'counts') - (p.why === 'counts') || q.score - p.score)[0] ?? null;
  const reasons = new Set(near.map((n) => n.why));
  let verdict;
  if (events.some((e) => e.type !== 'left')) verdict = 'WOULD FIRE';
  else if (counting.length) verdict = `NO EVENT: it was in the zone and big enough for ${counting.length} sample${counting.length > 1 ? 's' : ''} (${((counting.length - 1) * STEP_MS / 1000).toFixed(1)} s), which is less than the rule needs`;
  else if (near.length) verdict = `NO EVENT: ${[...reasons].join(' / ')}`;
  else verdict = 'NO EVENT: nothing of a type this rule wants was seen';
  return { events, verdict, best, counting: counting.length, samples: frames.length };
}

/** Frames of a clip every 1.5 s, as JPEG files in `dir`. */
export async function extractFrames(file, dir, { exec = run } = {}) {
  await exec('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vf', 'fps=2/3,scale=1280:-1', '-q:v', '3', path.join(dir, 'f%04d.jpg')], { maxBuffer: 10 * 1024 * 1024 });
  return (await readdir(dir)).filter((n) => n.endsWith('.jpg')).sort().map((n) => path.join(dir, n));
}

/** Replay one clip: extract frames, detect, judge. `detect(file)` resolves { detections }. */
export async function replayClip({ file, rule, detect, extract = extractFrames, keepFrames = false }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'reolook-replay-'));
  try {
    const files = await extract(file, dir);
    const frames = [];
    for (let i = 0; i < files.length; i++) frames.push({ t: i * STEP_MS, detections: (await detect(files[i])).detections });
    const result = judge(rule, frames);
    // the picture each event fired on, for review (only read when asked: they are large)
    if (keepFrames) for (const ev of result.events) if (ev.type !== 'left') ev.jpeg = await readFile(files[Math.round(ev.at / STEP_MS)]).catch(() => null);
    return result;
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

export { inWindow };
