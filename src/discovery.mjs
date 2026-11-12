import os from 'node:os';
import { ReolinkClient, ReolinkError } from './client.mjs';
import { mapLimit } from './concurrency.mjs';

/**
 * Finding cameras on the local network, so a device whose address changed (DHCP lease, replaced
 * router) can be found again.
 *
 * Two steps, deliberately separate:
 *  1. scan: an unauthenticated request per address. A Reolink answers `please login first`
 *     (rspCode -6) to a command sent without a token; nothing else on a LAN answers that way.
 *     No account is tried against anything that has not already shown that signature.
 *  2. identify: ONE sign-in per found device with the viewer account, reading name, model and the
 *     network MAC. If the account is refused, identification stops at once so a wrong password is
 *     never repeated against every camera (cameras lock an account after a few failures).
 */

const ip2int = (a) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0);
/** An IPv4 address from its number. */
const int2ip = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** Usable addresses of each private IPv4 network this machine is on, excluding this machine. */
export function candidateHosts(interfaces = os.networkInterfaces(), { maxHosts = 1024 } = {}) {
  const out = new Set();
  const own = new Set();
  for (const addrs of Object.values(interfaces)) for (const a of addrs ?? []) if (a.family === 'IPv4') own.add(a.address);
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = ip2int(a.address), mask = ip2int(a.netmask);
      const prefix = 32 - Math.log2((~mask >>> 0) + 1);
      if (!Number.isInteger(prefix) || prefix < 22 || prefix > 30) continue; // bigger than a /22 is not a home LAN
      const net = (ip & mask) >>> 0, size = 2 ** (32 - prefix);
      for (let i = 1; i < size - 1; i++) {
        const h = int2ip(net + i);
        if (!own.has(h)) out.add(h);
      }
    }
  }
  return [...out].slice(0, maxHosts);
}

/** Is there a Reolink API at this address? Never sends credentials. */
export async function looksLikeReolink(host, { timeoutMs = 1500, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`http://${host}/cgi-bin/api.cgi?cmd=GetDevInfo`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ cmd: 'GetDevInfo', action: 0, param: {} }]),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    const e = Array.isArray(body) ? body[0]?.error : null;
    return Boolean(e) && e.rspCode === -6 && /login/i.test(e.detail ?? '');
  } catch { return false; }
}

/**
 * Probe many addresses with bounded concurrency.
 * @param {string[]} hosts addresses to try
 * @param {{concurrency?: number, timeoutMs?: number, fetchImpl?: typeof fetch, signal?: AbortSignal}} [opts]
 *   once `signal` aborts, addresses not yet started are skipped
 * @returns {Promise<string[]>} the addresses that answered like a Reolink, in address order
 */
export async function scan(hosts, { concurrency = 48, timeoutMs = 1500, fetchImpl = fetch, signal } = {}) {
  const found = [];
  await mapLimit(hosts, concurrency, async (h) => {
    if (!signal?.aborted && await looksLikeReolink(h, { timeoutMs, fetchImpl })) found.push(h);
  });
  return found.sort((a, b) => ip2int(a) - ip2int(b));
}

/** A hardware address in lower-case `aa:bb:cc:dd:ee:ff` form, or null if it is not one. Accepts `:` `-` or no separators. */
export const normMac = (m) => (typeof m === 'string' && /^([0-9a-f]{2}[:-]?){5}[0-9a-f]{2}$/i.test(m)
  ? m.toLowerCase().replace(/[^0-9a-f]/g, '').replace(/(..)(?=.)/g, '$1:') : null);

/**
 * One sign-in: who is at this address? Throws a ReolinkError with `.code` when the account is
 * refused (the caller must stop), or another error when the device is unreachable.
 */
export async function identify(host, { user, password, make = (o) => new ReolinkClient(o) }) {
  const c = make({ host, user, password, timeoutMs: 8000 });
  try {
    const info = await c.devInfo();
    let mac = null;
    try { mac = normMac((await c.command('GetLocalLink')).LocalLink?.mac); } catch { /* optional */ }
    return { host, name: info.name ?? null, model: info.model ?? null, firmware: info.firmVer ?? null, mac };
  } finally { c.logout().catch(() => {}); }
}

/**
 * Pair configured devices with what was found. Same MAC is certain; same name and model is only a
 * suggestion, and only when exactly one device fits.
 */
export function matchDevices(configured, found) {
  const byMac = new Map(found.filter((f) => f.mac).map((f) => [f.mac, f]));
  return configured.map((c) => {
    const here = found.find((f) => f.host === c.host);
    if (here) return { id: c.id, host: here.host, found: here, by: 'address', changed: false };
    if (c.mac && byMac.has(c.mac)) return { id: c.id, host: byMac.get(c.mac).host, found: byMac.get(c.mac), by: 'mac', changed: true };
    if (!c.mac) {
      const twins = found.filter((f) => f.name === c.name && !configured.some((o) => o.host === f.host));
      if (twins.length === 1) return { id: c.id, host: twins[0].host, found: twins[0], by: 'name', changed: true };
    }
    return { id: c.id, host: null, found: null, by: null, changed: false };
  });
}

/**
 * Full pass: scan, identify each device once, and report. Stops identifying on the first refused
 * account. `known` addresses are always identified so their MAC can be learned.
 */
export async function discover({ configured, user, password, interfaces, fetchImpl, make, timeoutMs } = {}) {
  const hosts = candidateHosts(interfaces);
  const reachable = await scan(hosts, { fetchImpl, timeoutMs });
  const devices = [];
  let credentials = 'ok';
  if (!user || !password) credentials = 'missing';
  for (const host of reachable) {
    if (credentials !== 'ok') { devices.push({ host, name: null, model: null, firmware: null, mac: null }); continue; }
    try { devices.push(await identify(host, { user, password, make })); }
    catch (e) {
      devices.push({ host, name: null, model: null, firmware: null, mac: null });
      if (e instanceof ReolinkError && e.code !== undefined) credentials = 'refused'; // do not try the rest
    }
  }
  const matches = matchDevices(configured, devices);
  return { scanned: hosts.length, credentials, devices, matches };
}
