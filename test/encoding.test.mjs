import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteError, settingById } from '../src/device-settings.mjs';
import { ChangeLog } from '../src/change-log.mjs';
import { WriteService } from '../src/safe-write.mjs';

const main = { bitRate: 6144, frameRate: 30, height: 1920, profile: 'High', resolution: 54, size: '2560*1920', width: 2560 };
const sub = { bitRate: 160, frameRate: 7, height: 480, profile: 'High', resolution: 28, size: '640*480', width: 640 };
const RANGE = { Enc: [
  { audio: 'boolean', mainStream: { bitRate: [1024, 2048, 4096, 6144], frameRate: [30, 15, 10], profile: ['Base', 'Main', 'High'], resolution: 41, size: '2560*1440' }, subStream: { bitRate: [64, 128], frameRate: [15], profile: ['Base'], size: '640*480' } },
  { audio: 'boolean', mainStream: { bitRate: [1024, 2048, 4096, 6144, 8192], frameRate: [30, 25, 15, 10], profile: ['Base', 'Main', 'High'], resolution: 54, size: '2560*1920' }, subStream: { bitRate: [64, 128, 160, 256], frameRate: [15, 10, 7, 4], profile: ['Base', 'Main', 'High'], size: '640*480' } },
] };

/** As on hardware: a stream object of only the changed fields is refused; the whole stream object is accepted. */
function device() {
  const d = { enc: { audio: 1, channel: 0, mainStream: { ...main }, subStream: { ...sub } }, sent: [] };
  d.client = {
    command: async (cmd, param) => {
      if (cmd === 'GetEnc') return { Enc: structuredClone(d.enc) };
      if (cmd === 'SetEnc') {
        d.sent.push(structuredClone(param));
        for (const key of ['mainStream', 'subStream']) {
          if (param.Enc[key] && !('size' in param.Enc[key])) throw Object.assign(new Error('set config failed'), { detail: 'set config failed' });
        }
        Object.assign(d.enc, structuredClone(param.Enc));
        return {};
      }
      throw new Error(`unexpected ${cmd}`);
    },
    describe: async () => ({ value: { Enc: structuredClone(d.enc) }, range: RANGE }),
  };
  return d;
}
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'enc-'));
  const dev = device();
  const svc = new WriteService({ changeLog: new ChangeLog({ file: path.join(dir, 'c.jsonl') }) });
  return { dev, svc,
    plan: (input) => svc.plan({ client: dev.client, deviceId: 'cam', settingId: 'encoding', input, owner: 's' }),
    apply: (id) => svc.apply({ client: dev.client, planId: id, owner: 's', by: 'adm' }),
    done: () => rmSync(dir, { recursive: true, force: true }) };
}
const refused = (p, re) => assert.rejects(p, (e) => e instanceof WriteError && re.test(e.message));

test('read flattens both streams and audio', async () => {
  const c = setup();
  assert.deepEqual(await settingById('encoding').read(c.dev.client), { mainBitRate: 6144, mainFrameRate: 30, mainProfile: 'High', subBitRate: 160, subFrameRate: 7, subProfile: 'High', audio: true });
  c.done();
});

test('a change sends the whole stream object as read, only for the stream that changed', async () => {
  const c = setup();
  const r = await c.apply((await c.plan({ mainBitRate: 4096 })).planId);
  assert.equal(r.verified, true);
  assert.deepEqual(c.dev.sent, [{ Enc: { channel: 0, mainStream: { ...main, bitRate: 4096 } } }]);
  assert.deepEqual(c.dev.enc.subStream, sub, 'the other stream is untouched');
  c.done();
});

test('audio and sub stream changes are sent together in one write', async () => {
  const c = setup();
  const r = await c.apply((await c.plan({ audio: false, subFrameRate: 10, subProfile: 'Main' })).planId);
  assert.equal(r.verified, true);
  assert.deepEqual(c.dev.sent[0].Enc, { channel: 0, audio: 0, subStream: { ...sub, frameRate: 10, profile: 'Main' } });
  c.done();
});

test('only values the device lists for the resolution in use are accepted', async () => {
  const c = setup();
  await refused(c.plan({ mainBitRate: 5000 }), /main stream bit rate must be one of: 1024, 2048, 4096, 6144, 8192/);
  await refused(c.plan({ mainFrameRate: 60 }), /main stream frame rate must be one of/);
  await refused(c.plan({ subProfile: 'Baseline' }), /sub stream profile must be one of/);
  // the 2560*1440 entry offers different lists and is not the one in use
  await refused(c.plan({ subFrameRate: 30 }), /sub stream frame rate must be one of: 15, 10, 7, 4/);
  assert.deepEqual(c.dev.sent, []);
  c.done();
});

test('junk input and unknown fields are refused', async () => {
  const c = setup();
  await refused(c.plan({ mainBitRate: 'lots' }), /whole number/);
  await refused(c.plan({ resolution: 41 }), /unknown field/);
  c.done();
});
