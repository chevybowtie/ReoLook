// Pure recording state machine: turns motion samples into start/stop/roll decisions.

export class MotionGate {
  #postRollMs; #maxSegmentMs;
  #recording = false; #lastMotionAt = 0; #segmentStartedAt = 0;

  constructor({ postRollMs = 15_000, maxSegmentMs = 30 * 60_000 } = {}) {
    this.#postRollMs = postRollMs;
    this.#maxSegmentMs = maxSegmentMs;
  }

  get recording() { return this.#recording; }

  /** @returns {'start'|'stop'|'roll'|null} */
  update(motion, now) {
    if (motion) this.#lastMotionAt = now;
    if (!this.#recording) {
      if (!motion) return null;
      this.#recording = true;
      this.#segmentStartedAt = now;
      return 'start';
    }
    if (now - this.#lastMotionAt >= this.#postRollMs) {
      this.#recording = false;
      return 'stop';
    }
    if (now - this.#segmentStartedAt >= this.#maxSegmentMs) {
      this.#segmentStartedAt = now;
      return 'roll';
    }
    return null;
  }

  /** The recording process ended on its own (camera dropped, ffmpeg died). */
  reset() { this.#recording = false; }
}
