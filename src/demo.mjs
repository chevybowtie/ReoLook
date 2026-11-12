// Demo mode: ReoLook running against simulated cameras, so the whole interface can be tried with no
// Reolink hardware (and so it can be photographed without anyone's home in the picture).
//
// Each simulated camera is a small HTTP server that answers the same API commands as a real one
// (read and, for the settings pages, write), with its state kept in memory. Its live picture is a
// generated animation (ffmpeg's test sources) and Playback has a short recorded day made the same way.
// Nothing here talks to a real device, a real account or the user's own configuration.
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { streamOverrides } from './client.mjs';
import { pad2, hhmmss } from './format.mjs';

const run = promisify(execFile);

export const DEMO_USER = 'demo';
export const DEMO_ADMIN = 'admin';
export const DEMO_PASSWORD = 'demo';

/** The ffmpeg text overlay that puts a camera's name and the current time on its picture. */
const label = (name) => `drawtext=text='${name}  %{localtime}':x=16:y=16:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.55`;
/** A moving picture for each camera: not real scenes, just recognisably different and always changing. */
const SCENES = [
  (n, s) => `gradients=size=${s}:rate=10:speed=0.04:c0=0x2b4a6f:c1=0x9bb7d4:c2=0x35572e:c3=0xd8c98a,drawbox=x='mod(t*70,iw)':y=ih*0.62:w=110:h=44:color=0xcc3322@0.9:t=fill,${label(n)}`,
  (n, s) => `mandelbrot=size=${s}:rate=10,${label(n)}`,
  (n, s) => `testsrc2=size=${s}:rate=10,${label(n)}`,
  (n, s) => `cellauto=size=${s}:rate=10:rule=110:full=1:scroll=1,${label(n)}`,
];

export const DEMO_CAMERAS = [
  { name: 'Front door', model: 'RLC-DEMO-8MP', firmware: 'v3.1.0.demo', mac: 'de:00:00:00:00:01' },
  { name: 'Driveway', model: 'RLC-DEMO-5MP', firmware: 'v3.1.0.demo', mac: 'de:00:00:00:00:02' },
  { name: 'Living room', model: 'RLC-DEMO-5MP', firmware: 'v3.1.0.demo', mac: 'de:00:00:00:00:03' },
  { name: 'Back garden', model: 'RLC-DEMO-5MP', firmware: 'v3.1.0.demo', mac: 'de:00:00:00:00:04' },
];

const grid = (cols, rows) => {                      // the watched area: everything except a strip along the bottom
  let t = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) t += r < rows - 8 && c > 6 ? '1' : '0';
  return t;
};
/** An entry of the capability report: this permission level. */
const tablePerm = (p) => ({ permit: p, ver: 1 });
/** An error reply in the device's format. */
const ERR = (cmd, rspCode, detail) => [{ cmd, code: 1, error: { rspCode, detail } }];

/** The state and the answers of one simulated camera. */
export function makeCamera(spec, index) {
  const COLS = 80, ROWS = 45;
  const st = {
    name: spec.name, osd: { enable: 1, name: spec.name, pos: 'Upper Left', timeEnable: 1, timePos: 'Lower Right', watermark: 0 },
    ntp: { enable: 1, server: 'pool.ntp.org', port: 123, interval: 1440 }, tz: 21600, dst: 1,
    image: { bright: 128, contrast: 128, hue: 128, saturation: 128, sharpen: 128 },
    isp: { antiFlicker: 'Off', backLight: 'Off', blc: 128, blueGain: 128, dayNight: 'Auto', drc: 128, exposure: 'Auto', mirroring: 0, nr3d: 1, redGain: 128, rotation: 0, whiteBalance: 'Auto' },
    ir: 'Auto', push: 1, email: { enable: 0, interval: '5 Minutes' }, ftp: { enable: 0, interval: 30 },
    upnp: 0, p2p: 1, mdTable: grid(COLS, ROWS), sens: [0, 6, 12, 18].map((h, id) => ({ id, beginHour: h, beginMin: 0, endHour: h + 6 > 23 ? 23 : h + 6, endMin: h + 6 > 23 ? 59 : 0, sensitivity: 10 })),
    enc: { audio: 1, mainStream: { bitRate: 6144, frameRate: 30, height: 1440, profile: 'High', resolution: 41, size: '2560*1440', width: 2560 }, subStream: { bitRate: 160, frameRate: 7, height: 360, profile: 'High', resolution: 28, size: '640*360', width: 640 } },
    users: [{ userName: DEMO_ADMIN, level: 'admin' }, { userName: DEMO_USER, level: 'guest' }],
    link: { type: 'DHCP', ip: `192.168.50.${20 + index}`, mask: '255.255.255.0', gateway: '192.168.50.1', dns1: '192.168.50.1', dns2: '' },
  };
  const sched = '1'.repeat(168);
  /** A value range in the device's format. */
  const range = (min, max) => ({ min, max });
  const imageRange = Object.fromEntries(Object.keys(st.image).map((k) => [k, range(0, 255)]));

  const GET = {
    GetDevInfo: () => ({ DevInfo: { name: st.name, model: spec.model, firmVer: spec.firmware, hardVer: 'demo', channelNum: 1, serial: `DEMO${index}`, diskNum: 0 } }),
    GetDevName: () => ({ DevName: { name: st.name } }),
    GetAbility: (_p, who) => {
      const p = who === DEMO_ADMIN ? 6 : 4;
      return { Ability: { devName: tablePerm(p), time: tablePerm(p), ntp: tablePerm(p), push: tablePerm(p), email: tablePerm(p), upnp: tablePerm(p), p2p: tablePerm(p), localLink: tablePerm(p), mediaPort: tablePerm(p), user: tablePerm(p),
        abilityChn: [{ isp: tablePerm(p), image: tablePerm(p), osd: tablePerm(p), enc: tablePerm(p), ledControl: tablePerm(who === DEMO_ADMIN ? 5 : 4), alarmMd: tablePerm(p), ftp: tablePerm(p), recCfg: tablePerm(p) }] } };
    },
    GetTime: () => { const d = new Date(); return { Time: { year: d.getFullYear(), mon: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), min: d.getMinutes(), sec: d.getSeconds(), timeZone: st.tz, timeFmt: 'MM/DD/YYYY', hourFmt: 0 }, Dst: { enable: st.dst, offset: 1 } }; },
    GetNtp: () => ({ Ntp: { ...st.ntp } }),
    GetOsd: () => ({ Osd: { channel: 0, osdChannel: { enable: st.osd.enable, name: st.osd.name, pos: st.osd.pos }, osdTime: { enable: st.osd.timeEnable, pos: st.osd.timePos }, watermark: st.osd.watermark } }),
    GetImage: () => ({ Image: { channel: 0, ...st.image } }),
    GetIsp: () => ({ Isp: { channel: 0, ...st.isp } }),
    GetEnc: () => ({ Enc: { channel: 0, ...structuredClone(st.enc) } }),
    GetIrLights: () => ({ IrLights: { channel: 0, state: st.ir } }),
    GetAlarm: () => ({ Alarm: { action: { mail: 0, push: st.push, recChannel: null }, channel: 0, enable: 1, schedule: { table: sched }, scope: { cols: COLS, rows: ROWS, table: st.mdTable }, sens: structuredClone(st.sens), type: 'md' } }),
    GetMdAlarm: () => ({ MdAlarm: { channel: 0, newSens: { sens: [0, 1, 2, 3].map((id) => ({ id, enable: 0, beginHour: 0, beginMin: 0, endHour: 0, endMin: 0, priority: 0, sensitivity: 0 })), sensDef: 10 }, scope: { cols: COLS, rows: ROWS, table: st.mdTable }, sens: structuredClone(st.sens), useNewSens: 1 } }),
    GetPush: () => ({ Push: { schedule: { enable: st.push, table: sched } } }),
    GetEmail: () => ({ Email: { addr1: '', addr2: '', addr3: '', interval: st.email.interval, nickName: '', password: '', schedule: { enable: st.email.enable, table: sched }, smtpPort: 465, smtpServer: '', ssl: 1, userName: '' } }),
    GetFtp: () => ({ Ftp: { anonymous: 0, interval: st.ftp.interval, maxSize: 100, mode: 0, password: '', port: 21, remoteDir: '', schedule: { enable: st.ftp.enable, table: sched }, server: '', streamType: 0, userName: '' } }),
    GetLocalLink: () => ({ LocalLink: { activeLink: 'LAN', dns: { auto: st.link.type === 'DHCP' ? 1 : 0, dns1: st.link.dns1, dns2: st.link.dns2 }, mac: spec.mac, static: { gateway: st.link.gateway, ip: st.link.ip, mask: st.link.mask }, type: st.link.type } }),
    GetNetPort: () => ({ NetPort: { httpPort: 80, httpsPort: 443, mediaPort: 9000, onvifPort: 8000, rtmpPort: 1935, rtspPort: 554 } }),
    GetUpnp: () => ({ Upnp: { enable: st.upnp } }),
    GetP2p: () => ({ P2p: { enable: st.p2p, uid: `DEMO0000${index}` } }),
    GetDdns: () => ({ Ddns: { domain: '', enable: 0, password: '', type: 'no-ip', userName: '' } }),
    GetUser: () => ({ User: st.users.map((u) => ({ ...u })) }),
    GetHddInfo: () => ({ HddInfo: [] }),
    GetMdState: () => ({ state: motionNow(index) ? 1 : 0 }),
  };

  const RANGE = {
    GetIrLights: () => ({ IrLights: { state: ['Auto', 'Off'] } }),
    GetImage: () => ({ Image: imageRange }),
    GetIsp: () => ({ Isp: { dayNight: ['Auto', 'Color', 'Black&White'], antiFlicker: ['Outdoor', '50HZ', '60HZ', 'Off'], backLight: ['Off', 'BackLightControl', 'DynamicRangeControl'], blc: range(0, 255), drc: range(0, 255) } }),
    GetEnc: () => ({ Enc: [{ mainStream: { size: '2560*1440', resolution: 41, width: 2560, height: 1440, bitRate: [1024, 2048, 4096, 6144, 8192], frameRate: [30, 25, 15, 10], profile: ['Base', 'Main', 'High'], default: { bitRate: 6144, frameRate: 30 } }, subStream: { size: '640*360', resolution: 28, bitRate: [64, 128, 160, 256, 512], frameRate: [15, 10, 7, 4], profile: ['Base', 'Main', 'High'] } },
      { mainStream: { size: '1920*1080', resolution: 20, width: 1920, height: 1080, bitRate: [1024, 2048, 4096, 6144], frameRate: [30, 25, 15, 10], profile: ['Base', 'Main', 'High'], default: { bitRate: 4096, frameRate: 30 } }, subStream: { size: '640*360', resolution: 28, bitRate: [64, 128, 160, 256, 512], frameRate: [15, 10, 7, 4], profile: ['Base', 'Main', 'High'] } }] }),
    GetMdAlarm: () => ({ MdAlarm: { sens: [{ sensitivity: range(1, 50) }], newSens: { sensDef: range(1, 50) } } }),
    GetEmail: () => ({ Email: { interval: ['30 Seconds', '1 Minute', '5 Minutes', '10 Minutes', '30 Minutes'] } }),
    GetFtp: () => ({ Ftp: { interval: [15, 30, 60, 300, 600, 1800] } }),
    GetUser: () => ({ User: { level: ['guest', 'admin'], password: { minLen: 6, maxLen: 31 }, userName: { minLen: 1, maxLen: 31 } } }),
  };

  const SET = {
    SetDevName: (p) => { st.name = p.DevName.name; },
    SetTime: (p) => { if (p.Time?.timeZone !== undefined) st.tz = p.Time.timeZone; if (p.Dst) st.dst = p.Dst.enable; },
    SetNtp: (p) => { st.ntp = { ...st.ntp, ...p.Ntp }; },
    SetOsd: (p) => { const o = p.Osd; st.osd = { enable: o.osdChannel.enable, name: o.osdChannel.name, pos: o.osdChannel.pos, timeEnable: o.osdTime.enable, timePos: o.osdTime.pos, watermark: o.watermark }; },
    SetImage: (p) => { const { channel, ...rest } = p.Image; Object.assign(st.image, rest); },
    SetIsp: (p) => { const { channel, ...rest } = p.Isp; Object.assign(st.isp, rest); },
    SetEnc: (p) => { const { channel, ...rest } = p.Enc; for (const k of Object.keys(rest)) st.enc[k] = typeof rest[k] === 'object' ? { ...st.enc[k], ...rest[k] } : rest[k]; },
    SetIrLights: (p) => { st.ir = p.IrLights.state; },
    SetAlarm: (p) => { if (p.Alarm.scope) st.mdTable = p.Alarm.scope.table; if (p.Alarm.sens) st.sens = p.Alarm.sens; },
    SetMdAlarm: (p) => { if (p.MdAlarm.scope) st.mdTable = p.MdAlarm.scope.table; },
    SetPush: (p) => { st.push = p.Push.schedule.enable; },
    SetEmail: (p) => { if (p.Email.interval) st.email.interval = p.Email.interval; if (p.Email.schedule) st.email.enable = p.Email.schedule.enable; },
    SetFtp: (p) => { if (p.Ftp.interval) st.ftp.interval = p.Ftp.interval; if (p.Ftp.schedule) st.ftp.enable = p.Ftp.schedule.enable; },
    SetUpnp: (p) => { st.upnp = p.Upnp.enable; },
    SetP2p: (p) => { st.p2p = p.P2p.enable; },
    SetLocalLink: (p) => { const l = p.LocalLink; st.link = { type: l.type, ip: l.static.ip, mask: l.static.mask, gateway: l.static.gateway, dns1: l.dns.dns1, dns2: l.dns.dns2 }; },
    AddUser: (p) => { st.users.push({ userName: p.User.userName, level: p.User.level }); },
    DelUser: (p) => { st.users = st.users.filter((u) => u.userName !== p.User.userName); },
    ModifyUser: () => {},
  };

  return { st, GET, SET, RANGE };
}

// A camera "sees motion" for ten seconds out of every forty, staggered between cameras, so the motion
// outline, the recorder status and sound-on-motion have something to show.
const motionNow = (index) => ((Math.floor(Date.now() / 1000) + index * 11) % 40) < 10;

/** The ffmpeg picture source for the camera with this number: scenes repeat if there are more cameras than scenes. */
export const sceneFor = (index, name, size = '640x360') => SCENES[index % SCENES.length](name, size);

/** One camera's HTTP server. Resolves { server, host, camera }. */
export function startCamera(spec, index) {
  const cam = makeCamera(spec, index);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const cmd = u.searchParams.get('cmd');
    const token = u.searchParams.get('token') ?? '';
    const who = token.replace(/^tok-/, '');
    if (cmd === 'Snap') {
      if (!who) { res.writeHead(401); return res.end(); }
      const jpg = await snapshot(sceneFor(index, spec.name, '1280x720'));
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(jpg);
    }
    let body = '';
    for await (const c of req) body += c;
    let msg = {};
    try { msg = body ? JSON.parse(body)[0] : {}; } catch { /* treated as empty */ }
    /** Answers the command with a value. */
    const reply = (value, extra = {}) => res.end(JSON.stringify([{ cmd, code: 0, value, ...extra }]));
    /** Answers the command with an error. */
    const fail = (code, detail) => res.end(JSON.stringify(ERR(cmd, code, detail)));
    res.setHeader('content-type', 'application/json');
    if (cmd === 'Login') {
      const { userName, password } = msg.param?.User ?? {};
      if ((userName === DEMO_USER || userName === DEMO_ADMIN) && password === DEMO_PASSWORD) return reply({ Token: { name: `tok-${userName}`, leaseTime: 3600 } });
      return fail(-7, 'login failed');
    }
    if (cmd === 'Logout') return reply({ rspCode: 200 });
    if (!who) return fail(-6, 'please login first');
    const param = msg.param ?? {};
    if (cmd in cam.GET) {
      const value = cam.GET[cmd](param, who);
      return reply(value, msg.action === 1 && cam.RANGE[cmd] ? { range: cam.RANGE[cmd](), initial: value } : {});
    }
    if (cmd in cam.SET) {
      if (who !== DEMO_ADMIN) return fail(-13, 'permission denied');
      cam.SET[cmd](param);
      return reply({ rspCode: 200 });
    }
    return fail(-9, 'not support');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, host: `127.0.0.1:${server.address().port}`, camera: cam })));
}

/** One JPEG frame of a scene, made with ffmpeg. @param {string} scene an ffmpeg lavfi source @returns {Promise<Buffer>} */
function snapshot(scene) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', scene, '-frames:v', '1', '-f', 'mjpeg', '-q:v', '4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', reject);
    p.on('close', () => (chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error('ffmpeg produced no picture'))));
  });
}


/**
 * A short recorded day for Playback: every camera gets clips through the day (a few seconds each, in
 * the layout the recorder writes), so the timeline, zoom, tracks and export have something to work with.
 * Made once per day and reused.
 */
export async function makeLibrary(root, cameras, { now = new Date(), perCamera = 14, seconds = 6, log = () => {} } = {}) {
  const dayDir = path.join(root, `${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${now.getFullYear()}`);
  await mkdir(dayDir, { recursive: true });
  const existing = (await readdir(dayDir).catch(() => [])).filter((n) => n.endsWith('.mp4')).length;
  if (existing >= cameras.length * perCamera) return dayDir;
  const upTo = Math.max(2, now.getHours() + (now.getMinutes() > 30 ? 1 : 0));        // only the part of the day that has happened
  let made = 0;
  for (let ci = 0; ci < cameras.length; ci++) {
    for (let k = 0; k < perCamera; k++) {
      const secOfDay = Math.floor(((k + 0.5 + (ci % 3) * 0.17) / perCamera) * upTo * 3600) % 86400;
      const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, secOfDay);
      const e = new Date(s.getTime() + seconds * 1000);
      const file = path.join(dayDir, `${cameras[ci].name}-00-${hhmmss(s)}-${hhmmss(e)}.mp4`);
      if (await stat(file).then(() => true, () => false)) continue;
      const scene = sceneFor(ci, cameras[ci].name, '640x360').replace('%{localtime}', `${pad2(s.getHours())}\\:${pad2(s.getMinutes())}\\:${pad2(s.getSeconds())}`);
      await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', scene, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', file]);
      made++;
    }
    log(`demo recordings: ${cameras[ci].name}`);
  }
  return dayDir;
}

/**
 * Start the simulated cameras and register their live pictures. Returns { cameras, stop }.
 * cameras: [{ name, host }] ready to put in a ReoLook config.
 */
export async function startDemoCameras(specs = DEMO_CAMERAS) {
  const started = [];
  for (let i = 0; i < specs.length; i++) {
    const c = await startCamera(specs[i], i);
    streamOverrides.set(c.host, ({ stream }) => `lavfi:${sceneFor(i, specs[i].name, stream === 'main' ? '1280x720' : '640x360')}`);
    started.push({ ...c, name: specs[i].name });
  }
  return {
    cameras: started.map((c) => ({ name: c.name, host: c.host })),
    async stop() { for (const c of started) { streamOverrides.delete(c.host); c.server.closeAllConnections?.(); c.server.close(); } },
  };
}

/** Removes the demo recordings folder. */
export async function clearLibrary(root) { await rm(root, { recursive: true, force: true }); }
