// The safe-write pipeline: plan -> confirm -> apply -> read back -> log -> undo.
//   plan   reads the current value, validates the proposal and returns the exact diff.
//   apply  re-reads (refuses if anything changed since the plan), writes, reads back and
//          reports whether the device really holds the proposed value.
//   undo   writes the previous value back, only if the device still holds what we left.
import { randomBytes } from 'node:crypto';
import { DEVICE_SETTINGS, WriteError, diffValues, redact, settingById } from './device-settings.mjs';

/** The device's own explanation of a failure, or the error message, as text. */
const deviceText = (e) => String(e?.detail ?? e?.message ?? e);

export class WriteService {
  #plans = new Map(); #locks = new Map(); #log; #now; #ttl; #registry;
  #probe;
  /** `probe(host)` says whether anything answers at an address; only settings with a guard use it. */
  constructor({ changeLog, now = () => Date.now(), planTtlMs = 5 * 60_000, registry = DEVICE_SETTINGS, probe = null } = {}) {
    this.#log = changeLog; this.#now = now; this.#ttl = planTtlMs; this.#registry = registry; this.#probe = probe;
  }

  list() { return this.#registry; }

  /** Add a note to the history for a change made outside the plan/apply path (never undoable). */
  async record(entry) {
    const full = { id: randomBytes(9).toString('base64url'), at: new Date(this.#now()).toISOString(), undoOf: null, restartRequired: false,
      undoable: false, ...entry };
    await this.#log.append(full);
    return full;
  }
  history(opts) { return this.#log.list(opts); }

  /** One write at a time per device: a plan, apply or undo never interleaves with another. */
  #locked(deviceId, fn) {
    const prev = this.#locks.get(deviceId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.#locks.set(deviceId, run.catch(() => {}));
    return run;
  }
  /** The registered setting with this id. @throws {WriteError} 404 when there is none. */
  #setting(id) {
    const s = this.#registry.find((x) => x.id === id) ?? settingById(id);
    if (!s) throw new WriteError(`unknown setting "${id}"`, 404);
    return s;
  }
  /**
   * The value the device should hold if `intent` is applied to `current`, within what the device says it allows.
   * Worked out again at apply time, so "this computer's time" is the time of the write.
   * @returns {Promise<object>}
   */
  async #proposed(s, { client, channel, intent, current }) {
    const constraints = s.constraints ? await s.constraints(client, channel) : null;
    return (s.target ?? ((i) => i))(intent, current, { now: this.#now(), constraints });
  }

  /** Drops plans that have expired. */
  #sweep() { const t = this.#now(); for (const [id, p] of this.#plans) if (t > p.expiresAt) this.#plans.delete(id); }

  /** Read the live value of a setting (used to show the current state). */
  async current({ client, deviceId, settingId, channel = 0 }) {
    const s = this.#setting(settingId);
    return this.#locked(deviceId, async () => redact(await s.read(client, channel), s.secret));
  }

  /**
   * Reads the current value, validates the proposal and returns the exact diff, without writing anything.
   * A change worth applying is kept as a plan (valid for a few minutes, usable once, by the same owner).
   * @returns {Promise<object>} the plan: `planId`, `diff`, `current`, `proposed`, or `noop: true` when nothing would change
   * @throws {WriteError} 502 when the device cannot be read, 4xx for an invalid proposal
   */
  async plan({ client, deviceId, settingId, input, channel = 0, owner }) {
    const s = this.#setting(settingId);
    const intent = s.validate(input);
    return this.#locked(deviceId, async () => {
      let current;
      try { current = await s.read(client, channel); }
      catch (e) { throw new WriteError(`could not read the current value: ${deviceText(e)}`, 502); }
      const proposed = await this.#proposed(s, { client, channel, intent, current });
      if (s.guard) await s.guard(proposed, current, { client, channel, probe: this.#probe });
      const changed = diffValues(current, proposed, s.secret);
      // a setting whose value is large (a grid of cells) supplies a readable description of the change
      const diff = changed.length && s.describeDiff ? s.describeDiff(current, proposed) : changed;
      const base = { settingId, deviceId, label: s.label, risk: s.risk, restartRequired: s.restartRequired };
      if (!diff.length) return { ...base, noop: true, diff: [], current: redact(current, s.secret) };
      this.#sweep();
      const planId = randomBytes(18).toString('base64url');
      const expiresAt = this.#now() + this.#ttl;
      this.#plans.set(planId, { ...base, channel, current, intent, proposed, owner, expiresAt });
      return { ...base, noop: false, planId, diff, expiresAt: new Date(expiresAt).toISOString(),
        confirm: s.confirmText ? s.confirmText({ proposed }) : null,
        current: redact(current, s.secret), proposed: redact(proposed, s.secret) };
    });
  }

  /** Who and which device a plan belongs to, so the caller can pick the right client. */
  planInfo(planId) { const p = this.#plans.get(planId); return p ? { deviceId: p.deviceId, owner: p.owner, settingId: p.settingId, proposed: p.proposed } : null; }
  async changeInfo(id) { const e = await this.#log.get(id); return e ? { deviceId: e.deviceId, settingId: e.settingId } : null; }

  /**
   * Carries out a plan: re-reads the device and refuses if it changed since the plan, then writes, reads back and logs.
   * @returns {Promise<object>} the history entry (`verified` says whether the device holds the new value)
   * @throws {WriteError} 404 unknown or used plan, 403 another owner's, 410 expired, 409 the device changed, 502 it refused
   */
  async apply({ client, planId, owner, by = owner }) {
    const plan = this.#plans.get(planId);
    if (!plan) throw new WriteError('this change was not found or has already been applied', 404);
    if (plan.owner !== owner) throw new WriteError('this change belongs to a different session', 403);
    if (this.#now() > plan.expiresAt) { this.#plans.delete(planId); throw new WriteError('this change expired; review it again', 410); }
    this.#plans.delete(planId); // single use, whatever happens next
    const s = this.#setting(plan.settingId);
    return this.#locked(plan.deviceId, async () => {
      let before;
      try { before = await s.read(client, plan.channel); }
      catch (e) { throw new WriteError(`could not read the device before changing it: ${deviceText(e)}`, 502); }
      // volatile settings (a clock) are compared with their own rule, never with strict equality
      if (!(s.conflictEqual ?? s.equal)(before, plan.current)) {
        throw new WriteError('the device changed since you reviewed this; nothing was written. Review it again.', 409, { current: redact(before, s.secret) });
      }
      // the target is worked out again now, so "this computer's time" is the time of the write
      const target = await this.#proposed(s, { client, channel: plan.channel, intent: plan.intent, current: before });
      return this.#writeAndVerify({ s, client, plan, before, target, by, undoOf: null });
    });
  }

  /**
   * Reads a setting back after a write until it holds `target`. A setting such as the address can take a few seconds to
   * settle, so it looks again (as many times as the setting allows) before giving up.
   * @param {object} s the setting @param {object} client @param {number} channel
   * @param {object} target what was written @param {number} wroteAt when, in ms (for settings that compare with elapsed time)
   * @returns {Promise<{after: object|null, verified: boolean, readError: string|null}>}
   */
  async #readBack(s, client, channel, target, wroteAt) {
    let after = null, verified = false, readError = null;
    const tries = 1 + (s.verifyRetries ?? 0);
    for (let i = 0; i < tries && !verified; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, s.verifyDelayMs ?? 2000));
      try { after = await s.read(client, channel); verified = (s.verifyEqual ?? s.equal)(after, target, { elapsedMs: this.#now() - wroteAt }); readError = null; }
      catch (e) { readError = deviceText(e); }
    }
    return { after, verified, readError };
  }

  /**
   * Writes `target`, reads the value back and records the outcome in the history.
   * @returns {Promise<object>} the history entry without the raw values kept for undo
   * @throws {WriteError} 502 when the device refuses the write (that failure is recorded too)
   */
  async #writeAndVerify({ s, client, plan, before, target, by, undoOf }) {
    const base = { id: randomBytes(9).toString('base64url'), at: new Date(this.#now()).toISOString(), deviceId: plan.deviceId,
      settingId: plan.settingId, label: s.label, by, undoOf, restartRequired: s.restartRequired,
      before: redact(before, s.secret), proposed: redact(target, s.secret) };
    if (s.summarize) base.summary = s.summarize(before, target);
    const undoable = s.secret.length === 0 && !s.volatile;
    const wroteAt = this.#now();
    try { await s.write(client, plan.channel, target); }
    catch (e) {
      const entry = { ...base, state: 'failed', error: deviceText(e), verified: false, undoable: false };
      await this.#log.append(entry);
      throw new WriteError(`the device refused the change: ${deviceText(e)}`, 502, { changeId: entry.id });
    }
    const { after, verified, readError } = await this.#readBack(s, client, plan.channel, target, wroteAt);
    const entry = { ...base, state: verified ? 'applied' : 'unverified', verified, after: after ? redact(after, s.secret) : null,
      rawBefore: undoable ? before : undefined, rawAfter: undoable && after ? after : undefined,
      undoable: undoable && after !== null, error: readError ?? (verified ? null : 'the device does not report the value that was written') };
    await this.#log.append(entry);
    const { rawBefore, rawAfter, ...pub } = entry;
    return pub;
  }

  /**
   * Puts back the value a change replaced, only if the device still holds what that change left.
   * @returns {Promise<object>} the history entry of the undo
   * @throws {WriteError} 404 unknown change, 409 not undoable / already undone / changed again since, 502 unreadable
   */
  async undo({ client, changeId, by, channel = 0 }) {
    const entry = await this.#log.get(changeId);
    if (!entry) throw new WriteError('that change was not found', 404);
    if (!entry.undoable || !entry.rawBefore) throw new WriteError('this change cannot be undone automatically', 409);
    if (entry.undone) throw new WriteError('this change was already undone', 409);
    const s = this.#setting(entry.settingId);
    return this.#locked(entry.deviceId, async () => {
      let now;
      try { now = await s.read(client, channel); }
      catch (e) { throw new WriteError(`could not read the device: ${deviceText(e)}`, 502); }
      if (!s.equal(now, entry.rawAfter)) {
        throw new WriteError('the device has been changed again since this edit; undoing would overwrite that newer change. Nothing was written.', 409, { current: redact(now, s.secret) });
      }
      const plan = { deviceId: entry.deviceId, settingId: entry.settingId, channel };
      const result = await this.#writeAndVerify({ s, client, plan, before: now, target: entry.rawBefore, by, undoOf: entry.id });
      if (result.verified) await this.#log.patch(entry.id, { undone: true, undoneBy: result.id });
      return result;
    });
  }
}
