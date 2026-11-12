// A small MQTT 3.1.1 publisher: enough to tell a broker "this happened", with no dependencies.
// CONNECT (with a last-will so subscribers see "offline"), PUBLISH at QoS 0 or 1, keep-alive pings
// and reconnection. It never subscribes, so nothing from the broker is acted on.
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

/** An MQTT string: two length bytes, then the UTF-8 bytes. */
const utf8 = (s) => { const b = Buffer.from(String(s), 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
/** The MQTT 'remaining length' field for a packet body of `n` bytes (7 bits per byte, high bit means more follow). */
function remaining(n) {
  const out = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; out.push(d); } while (n > 0);
  return Buffer.from(out);
}
/** A complete MQTT packet: the first byte, the remaining length, then the body. */
const packet = (first, body) => Buffer.concat([Buffer.from([first]), remaining(body.length), body]);

/**
 * Reads an MQTT address like `mqtt://host:1883` or `mqtts://host:8883` (default ports 1883 / 8883).
 * @param {string} url @returns {{secure: boolean, host: string, port: number}} @throws {Error} when it is not in that form
 */
export function parseUrl(url) {
  const m = /^(mqtts?):\/\/([^/:]+)(?::(\d{1,5}))?\/?$/.exec(String(url ?? ''));
  if (!m) throw new Error('the MQTT address must look like mqtt://host:1883 or mqtts://host:8883');
  const secure = m[1] === 'mqtts';
  return { secure, host: m[2], port: m[3] ? Number(m[3]) : secure ? 8883 : 1883 };
}

/** The bytes of a CONNECT packet. Exported for tests. */
export function connectPacket({ clientId, username, password, keepAlive = 60, will = null }) {
  let flags = 0x02;                                  // clean session
  if (will) flags |= 0x04 | (will.retain ? 0x20 : 0);
  if (username) flags |= 0x80;
  if (username && password) flags |= 0x40;
  const ka = Buffer.alloc(2); ka.writeUInt16BE(keepAlive);
  const parts = [utf8('MQTT'), Buffer.from([4, flags]), ka, utf8(clientId)];
  if (will) parts.push(utf8(will.topic), utf8(will.payload));
  if (username) parts.push(utf8(username));
  if (username && password) parts.push(utf8(password));
  return packet(0x10, Buffer.concat(parts));
}

/**
 * The bytes of a PUBLISH packet. A string payload is sent as is, anything else as JSON. Exported for tests.
 * @param {{topic: string, payload: unknown, retain?: boolean, qos?: 0|1, id?: number}} o `id` is the packet number, used at QoS 1
 */
export function publishPacket({ topic, payload, retain = false, qos = 0, id = 0 }) {
  const body = [utf8(topic)];
  if (qos > 0) { const i = Buffer.alloc(2); i.writeUInt16BE(id); body.push(i); }
  body.push(Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8'));
  return packet(0x30 | (qos << 1) | (retain ? 1 : 0), Buffer.concat(body));
}

export class MqttPublisher extends EventEmitter {
  #opts; #sock = null; #connected = false; #nextId = 1; #acks = new Map(); #queue = []; #timer = null; #ping = null;
  #retry = 1000; #closed = false; #buf = Buffer.alloc(0);

  /** opts: { url, username, password, clientId, statusTopic, keepAlive, connectTimeoutMs } */
  constructor(opts) {
    super();
    this.#opts = { keepAlive: 60, connectTimeoutMs: 8000, clientId: `reolook-${Math.random().toString(16).slice(2, 10)}`, ...opts };
    this.target = parseUrl(opts.url);
  }
  get connected() { return this.#connected; }

  start() { this.#closed = false; this.#connect(); }

  /** Opens the connection and sends CONNECT; on loss, retries with a doubling delay (up to a minute) until `end()`. */
  #connect() {
    if (this.#closed || this.#sock) return;
    const { host, port, secure } = this.target;
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    this.#sock = sock; this.#buf = Buffer.alloc(0);
    sock.setTimeout(this.#opts.connectTimeoutMs, () => { if (!this.#connected) sock.destroy(new Error('connect timed out')); });
    sock.on(secure ? 'secureConnect' : 'connect', () => {
      const will = this.#opts.statusTopic ? { topic: this.#opts.statusTopic, payload: 'offline', retain: true } : null;
      sock.write(connectPacket({ clientId: this.#opts.clientId, username: this.#opts.username, password: this.#opts.password, keepAlive: this.#opts.keepAlive, will }));
    });
    sock.on('data', (d) => this.#onData(d));
    sock.on('error', (e) => this.emit('error', e));
    sock.on('close', () => {
      this.#connected = false; this.#sock = null; clearInterval(this.#ping);
      for (const [, a] of this.#acks) a.reject(new Error('connection closed'));
      this.#acks.clear();
      this.emit('disconnected');
      if (!this.#closed) { this.#timer = setTimeout(() => this.#connect(), this.#retry); this.#retry = Math.min(this.#retry * 2, 60_000); }
    });
  }

  /**
   * Takes bytes from the broker, splits them into packets, and acts on CONNACK (connected, or refused) and PUBACK (a QoS 1 message was received).
   */
  #onData(d) {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      if (this.#buf.length < 2) return;
      let mult = 1, len = 0, i = 1, b;
      do { if (i >= this.#buf.length) return; b = this.#buf[i++]; len += (b & 127) * mult; mult *= 128; } while (b & 128);
      if (this.#buf.length < i + len) return;
      const type = this.#buf[0] >> 4, body = this.#buf.subarray(i, i + len);
      this.#buf = this.#buf.subarray(i + len);
      if (type === 2) {                                        // CONNACK
        const code = body[1];
        if (code !== 0) { this.emit('error', new Error(connackText(code))); this.#closed = true; this.#sock?.destroy(); return; }
        this.#connected = true; this.#retry = 1000;
        this.#ping = setInterval(() => this.#sock?.write(Buffer.from([0xc0, 0])), (this.#opts.keepAlive * 1000) / 2);
        this.#ping.unref?.();
        if (this.#opts.statusTopic) this.publish(this.#opts.statusTopic, 'online', { retain: true }).catch(() => {});
        for (const q of this.#queue.splice(0)) this.publish(q.topic, q.payload, q.opts).then(q.resolve, q.reject);
        this.emit('connected');
      } else if (type === 4) {                                 // PUBACK
        const id = body.readUInt16BE(0), a = this.#acks.get(id);
        if (a) { this.#acks.delete(id); a.resolve(); }
      }
    }
  }

  /** Resolves when the broker has it (QoS 1) or it has been written (QoS 0). Queues while offline. */
  publish(topic, payload, { retain = false, qos = 1 } = {}) {
    if (!this.#connected) {
      if (this.#queue.length >= 50) return Promise.reject(new Error('MQTT broker unreachable; message dropped'));
      return new Promise((resolve, reject) => this.#queue.push({ topic, payload, opts: { retain, qos }, resolve, reject }));
    }
    if (qos === 0) { this.#sock.write(publishPacket({ topic, payload, retain })); return Promise.resolve(); }
    const id = this.#nextId; this.#nextId = (this.#nextId % 65535) + 1;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.#acks.delete(id); reject(new Error('the broker did not acknowledge in time')); }, 5000);
      this.#acks.set(id, { resolve: () => { clearTimeout(t); resolve(); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.#sock.write(publishPacket({ topic, payload, retain, qos: 1, id }));
    });
  }

  /** Publishes 'offline', says goodbye and closes the connection; no reconnection follows. */
  async end() {
    this.#closed = true; clearTimeout(this.#timer); clearInterval(this.#ping);
    if (this.#sock) {
      if (this.#connected) { if (this.#opts.statusTopic) await this.publish(this.#opts.statusTopic, 'offline', { retain: true }).catch(() => {}); this.#sock.write(Buffer.from([0xe0, 0])); }
      this.#sock.end(); this.#sock.destroy();
    }
  }
}

/** The plain-language reason for a CONNACK refusal code. */
const connackText = (c) => ({ 1: 'the broker refused the protocol version', 2: 'the broker refused the client id', 3: 'the broker is not available',
  4: 'the MQTT user name or password was refused', 5: 'the MQTT account is not allowed to connect' }[c] ?? `the broker refused the connection (code ${c})`);
