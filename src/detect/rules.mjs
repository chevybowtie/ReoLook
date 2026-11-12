// Turning per-frame detections into "a vehicle stopped in the zone". Pure functions, no I/O.
//
// A detection is { label, score, box: [x1, y1, x2, y2] } with the box in fractions of the frame.
// A zone is a polygon of [x, y] points, also fractions. A vehicle counts as being in the zone when
// the bottom-centre of its box (where it meets the ground) is inside the polygon.

export const VEHICLES = ['car', 'truck', 'bus', 'motorcycle'];
export const ANIMALS = ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'];
export const PEOPLE = ['person'];
export const DETECTABLE = [...VEHICLES, ...ANIMALS, ...PEOPLE, 'bicycle'];

/**
 * Whether a point lies inside a polygon (ray casting). @param {[number, number]} point @param {Array<[number, number]>} poly
 */
export function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether a detected label is a kind of vehicle. */
const isVehicle = (l) => VEHICLES.includes(l);
/**
 * Where a box meets the ground: the middle of its bottom edge. @param {[number, number, number, number]} box x1, y1, x2, y2 as fractions of the picture
 */
export const footOf = (box) => [(box[0] + box[2]) / 2, box[3]];
/** The middle of a box. */
export const centreOf = (box) => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];

/** Intersection over union of two boxes: 0 when they do not overlap, 1 when identical. */
export function iou(a, b) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/** Is the local time `t` within [from, to] ("HH:MM", may wrap past midnight)? Null bounds mean always. */
export function inWindow(t, from, to) {
  if (!from || !to) return true;
  /** Minutes since midnight of an HH:MM string. */
  const m = (s) => { const [h, mm] = s.split(':').map(Number); return h * 60 + mm; };
  const now = t.getHours() * 60 + t.getMinutes(), a = m(from), b = m(to);
  return a <= b ? now >= a && now <= b : now >= a || now <= b;
}

/**
 * Follows detections from frame to frame and reports what a rule asks for.
 *   rule: { mode: 'stops' | 'appears', zone (empty = the whole picture), classes, minScore,
 *           minHeight / maxHeight (box height as a fraction of the picture: leaves small animals out, or a
 *           bigger truck than the one you want),
 *           minStopSec (stops), minPresenceSec (appears), requireArrival, moveTolerance, lostAfterSec }
 * update() returns events: { type: 'stopped' | 'appeared' | 'left', track, at }.
 */
export class StopTracker {
  #tracks = []; #next = 1; #rule; #lastReport = -Infinity;
  constructor(rule) {
    this.#rule = { mode: 'stops', zone: [], classes: VEHICLES, minStopSec: 20, minPresenceSec: 2, minHeight: 0, maxHeight: 1, cooldownSec: 0, moveTolerance: 0.03, minScore: 0.35, lostAfterSec: 6, requireArrival: true, ...rule };
  }
  get active() { return this.#tracks.filter((t) => t.inZone).length; }
  get tracks() { return this.#tracks.map((t) => ({ ...t })); }

  /**
   * Feeds one frame's detections: keeps only what the rule wants, matches them to the vehicles already followed,
   * advances their timers, and returns the events that have just happened.
   * @param {object[]} detections @param {number} atMs time of the frame @returns {object[]} events
   */
  update(detections, atMs) {
    const r = this.#rule, events = [];
    const dets = detections.filter((d) => r.classes.includes(d.label) && d.score >= r.minScore && d.box[3] - d.box[1] >= r.minHeight && d.box[3] - d.box[1] <= r.maxHeight);
    const whole = !r.zone || r.zone.length < 3;
    /** Whether a box's foot is in the rule's zone (always, when no zone is drawn). */
    const inside = (box) => whole || pointInPolygon(footOf(box), r.zone);
    const used = new Set();
    // greedy match by overlap; a vehicle keeps its identity while its box keeps overlapping
    for (const t of this.#tracks) {
      // same thing as before: the box overlaps the old one, or (for something that moved a body
      // length between samples) it is close to where it was
      let best = -1, bestIou = 0.3;
      dets.forEach((d, i) => { if (used.has(i) || d.label !== t.label && !(isVehicle(d.label) && isVehicle(t.label))) return; const v = iou(t.box, d.box); if (v > bestIou) { bestIou = v; best = i; } });
      if (best < 0) {
        const size = Math.max(t.box[2] - t.box[0], t.box[3] - t.box[1]);
        let bestD = size * 1.2;
        const tc = centreOf(t.box);
        dets.forEach((d, i) => {
          if (used.has(i) || d.label !== t.label && !(isVehicle(d.label) && isVehicle(t.label))) return;
          const c = centreOf(d.box), dist = Math.hypot(c[0] - tc[0], c[1] - tc[1]);
          if (dist < bestD) { bestD = dist; best = i; }
        });
      }
      if (best >= 0) {
        used.add(best);
        const d = dets[best];
        t.box = d.box; t.label = d.label; t.score = Math.max(t.score, d.score); t.lastSeen = atMs;
        const c = centreOf(d.box);
        if (Math.hypot(c[0] - t.anchor[0], c[1] - t.anchor[1]) > r.moveTolerance) { t.anchor = c; t.stillSince = atMs; t.moved = true; }   // it moved: start counting again
        t.inZone = inside(d.box);
        // a vehicle that was already parked when first seen (a car in the driveway) never arrived, so it is not a stop
        const arrived = !r.requireArrival || t.moved;
        if (r.mode === 'appears') {
          if (t.inZone && !t.reported && atMs - t.firstSeen >= r.minPresenceSec * 1000) {
            // the same visit seen again a little later (it turned around, drove back past) is one event
            t.reported = true;
            if (atMs - this.#lastReport >= r.cooldownSec * 1000) { this.#lastReport = atMs; t.counted = true; events.push({ type: 'appeared', track: { ...t }, at: atMs }); }
          }
        } else if (t.inZone && arrived && !t.reported && atMs - t.stillSince >= r.minStopSec * 1000) {
          t.reported = true;
          if (atMs - this.#lastReport >= r.cooldownSec * 1000) { this.#lastReport = atMs; t.counted = true; events.push({ type: 'stopped', track: { ...t }, at: atMs }); }
        }
      }
    }
    dets.forEach((d, i) => {
      if (used.has(i)) return;
      this.#tracks.push({ id: this.#next++, label: d.label, score: d.score, box: d.box, anchor: centreOf(d.box),
        firstSeen: atMs, lastSeen: atMs, stillSince: atMs, moved: false, inZone: inside(d.box), reported: false });
    });
    // tracks not seen for a while are gone
    this.#tracks = this.#tracks.filter((t) => {
      if (atMs - t.lastSeen <= r.lostAfterSec * 1000) return true;
      if (t.counted) events.push({ type: 'left', track: { ...t }, at: atMs });
      return false;
    });
    return events;
  }
}
