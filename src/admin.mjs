// In-memory administrator sessions. The password lives only in this process's memory, is never
// serialised, logged or written to disk, and is dropped on sign-out, expiry or restart.
import { randomBytes } from 'node:crypto';

const SECRET = Symbol('credentials');

export class AdminSession {
  constructor({ id, user, password, accepted, now }) {
    this.id = id;
    this.user = user;
    this.accepted = accepted;            // { deviceId: 'accepted' | 'denied' | 'unreachable' }
    this.createdAt = now;
    this.lastUsed = now;
    // non-enumerable, so JSON.stringify / console.log / spread never expose it
    Object.defineProperty(this, SECRET, { value: { user, password }, enumerable: false });
  }
  credentials() { return { ...this[SECRET] }; }
  toJSON() { return { user: this.user, devices: this.accepted, createdAt: this.createdAt }; }
}

export class AdminSessions {
  #byId = new Map(); #idleMs; #maxMs; #now;
  constructor({ idleMs = 15 * 60_000, maxMs = 8 * 3600_000, now = () => Date.now() } = {}) {
    this.#idleMs = idleMs; this.#maxMs = maxMs; this.#now = now;
  }

  /** Starts a session for an administrator who signed in. @returns {AdminSession} (its `id` is the cookie value) */
  create({ user, password, accepted }) {
    this.sweep();
    const id = randomBytes(32).toString('base64url');
    const s = new AdminSession({ id, user, password, accepted, now: this.#now() });
    this.#byId.set(id, s);
    return s;
  }

  /** Returns the live session (sliding idle timeout) or null. */
  get(id) {
    if (!id) return null;
    const s = this.#byId.get(id);
    if (!s) return null;
    const t = this.#now();
    if (t - s.lastUsed > this.#idleMs || t - s.createdAt > this.#maxMs) { this.#byId.delete(id); return null; }
    s.lastUsed = t;
    return s;
  }

  expiresAt(s) { return Math.min(s.lastUsed + this.#idleMs, s.createdAt + this.#maxMs); }
  destroy(id) { return this.#byId.delete(id); }
  clear() { this.#byId.clear(); }
  get size() { return this.#byId.size; }
  /** Forgets sessions that have been idle too long or have lasted too long. */
  sweep() {
    const t = this.#now();
    for (const [id, s] of this.#byId) if (t - s.lastUsed > this.#idleMs || t - s.createdAt > this.#maxMs) this.#byId.delete(id);
  }
}

/**
 * Failed sign-ins lock further attempts for a while. Cameras may lock the account itself after
 * a few bad passwords, so ReoLook must never become the thing that hammers it.
 */
export class LoginThrottle {
  #fails = 0; #lockedUntil = 0; #max; #lockMs; #now;
  constructor({ maxFailures = 3, lockMs = 60_000, now = () => Date.now() } = {}) {
    this.#max = maxFailures; this.#lockMs = lockMs; this.#now = now;
  }
  /** Seconds to wait, or 0 when an attempt is allowed. */
  waitSeconds() { return Math.max(0, Math.ceil((this.#lockedUntil - this.#now()) / 1000)); }
  /** Counts a failed sign-in; enough of them in a row lock sign-in for a while. */
  fail() {
    this.#fails++;
    if (this.#fails >= this.#max) { this.#lockedUntil = this.#now() + this.#lockMs; this.#fails = 0; }
  }
  success() { this.#fails = 0; this.#lockedUntil = 0; }
}

/** Parse a Cookie header into an object. */
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
