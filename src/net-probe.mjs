import net from 'node:net';

/**
 * Is anything at this address? A refused connection counts as "yes" (a host answered with a reset);
 * only silence or an unreachable network means the address looks free. Ports are the ones a camera
 * or most other network devices listen on.
 */
export async function tcpProbe(host, { ports = [80, 443, 554, 8000, 22], timeoutMs = 1500 } = {}) {
  /** Tries one port. @returns {Promise<boolean>} true if something answered (a connection, or a refusal) */
  const one = (port) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    /** Closes the connection and reports the outcome. */
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', (e) => done(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET'));
  });
  return (await Promise.all(ports.map(one))).some(Boolean);
}
