// One signed-in client per device, shared by everything in the process that reads from it (the recorder,
// the detector, the web page). A camera allows only so many sessions and is slow to answer, so three
// parts of ReoLook each signing in and each asking for motion once a second multiplied the load for no
// benefit. Administrator sessions are different (a different account, held only while someone is signed
// in) and are not pooled.
import { ReolinkClient } from './client.mjs';

export class ClientPool {
  #clients = new Map(); #make;

  /** @param {{make?: (o: object) => ReolinkClient}} [opts] how to build a client; replaceable in tests */
  constructor({ make = (o) => new ReolinkClient(o) } = {}) { this.#make = make; }

  /** How many devices have a client. */
  get size() { return this.#clients.size; }

  /**
   * The shared viewer client for a device, made on first use. The same address with the same account
   * always gets the same client; a different address or account gets its own.
   * @param {{host: string, user: string, password: string}} account
   * @returns {ReolinkClient}
   */
  viewer({ host, user, password }) {
    const key = `${host}\0${user}\0${password}`;
    let c = this.#clients.get(key);
    if (!c) this.#clients.set(key, c = this.#make({ host, user, password }));
    return c;
  }

  /**
   * Drops the clients for an address the device no longer has. Does not sign out: the session belongs
   * to an address nothing answers at any more.
   * @param {string} host
   */
  forget(host) {
    for (const [key, c] of this.#clients) if (c.host === host) this.#clients.delete(key);
  }

  /**
   * Signs every client out (best effort, in parallel, without waiting longer than `timeoutMs`) and
   * empties the pool, so a restart does not leave sessions behind on the cameras.
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<void>}
   */
  async close({ timeoutMs = 1500 } = {}) {
    const all = [...this.#clients.values()];
    this.#clients.clear();
    let timer;
    const giveUp = new Promise((r) => { timer = setTimeout(r, timeoutMs); });
    await Promise.race([Promise.all(all.map((c) => c.logout().catch(() => {}))), giveUp]);
    clearTimeout(timer);
  }
}
