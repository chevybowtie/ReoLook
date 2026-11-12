import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WriteError } from '../src/device-settings.mjs';
import { resolutionOptions, targetStream, changeResolution } from '../src/resolution.mjs';

const OPTIONS = [
  { size: '2560*1920', resolution: 54, width: 2560, height: 1920, bitRate: [1024, 4096, 6144], frameRate: [30, 15], default: { bitRate: 6144, frameRate: 30 } },
  { size: '2560*1440', resolution: 41, width: 2560, height: 1440, bitRate: [1024, 4096], frameRate: [30, 15], default: { bitRate: 4096, frameRate: 30 } },
];
const TABLE = ('1'.repeat(10) + '0'.repeat(70)).repeat(60);

/** Behaves as the RLC-410 did: a resolution change makes it go quiet, drops sessions, and resets the area. */
function device({ downPolls = 2, keepArea = false } = {}) {
  const d = { main: { bitRate: 6144, frameRate: 30, height: 1920, profile: 'High', resolution: 54, size: '2560*1920', width: 2560 }, table: TABLE, sens: [{ id: 0, sensitivity: 10 }], down: 0, gen: 0, sent: [] };
  d.makeClient = () => {
    const gen = d.gen;
    return {
      describe: async () => ({ value: { Enc: { mainStream: { ...d.main } } }, range: { Enc: OPTIONS.map((o) => ({ mainStream: { ...o } })) } }),
      command: async (cmd, param) => {
        if (gen !== d.gen) throw Object.assign(new Error('please login first'), { code: -6 });
        if (d.down > 0) { d.down--; throw new Error('fetch failed'); }
        if (cmd === 'GetEnc') return { Enc: { channel: 0, mainStream: { ...d.main } } };
        if (cmd === 'GetAlarm') return { Alarm: { channel: 0, scope: { cols: 80, rows: 60, table: d.table } } };
        if (cmd === 'GetMdAlarm') return { MdAlarm: { sens: d.sens, scope: { cols: 80, rows: 60, table: d.table } } };
        if (cmd === 'SetEnc') {
          d.sent.push(structuredClone(param));
          d.main = { ...param.Enc.mainStream };
          d.down = downPolls; d.gen++;                       // restarts: silent, sessions gone
          if (!keepArea) d.table = '1'.repeat(4800);          // and the area is reset
          return {};
        }
        if (cmd === 'SetMdAlarm') { d.sent.push(structuredClone(param)); d.table = param.MdAlarm.scope.table; return {}; }
        throw new Error(`unexpected ${cmd}`);
      },
    };
  };
  return d;
}
const fast = { pollMs: 0, wait: async () => {} };

test('options are the device\'s own sizes with their allowed rates', async () => {
  const d = device();
  const r = await resolutionOptions(d.makeClient());
  assert.equal(r.current.size, '2560*1920');
  assert.deepEqual(r.options.map((o) => o.size), ['2560*1920', '2560*1440']);
  assert.deepEqual(r.options[1].bitRates, [1024, 4096]);
});

test('the stream sent keeps its rates when the size allows them, and falls back to the size\'s defaults when not', () => {
  const cur = { bitRate: 4096, frameRate: 15, height: 1920, profile: 'High', resolution: 54, size: '2560*1920', width: 2560 };
  const o = { size: '2560*1440', resolution: 41, width: 2560, height: 1440, bitRates: [1024, 4096], frameRates: [30, 15], defaults: { bitRate: 4096, frameRate: 30 } };
  assert.deepEqual(targetStream(cur, o), { bitRate: 4096, frameRate: 15, height: 1440, profile: 'High', resolution: 41, size: '2560*1440', width: 2560 });
  assert.equal(targetStream({ ...cur, bitRate: 6144 }, o).bitRate, 4096);
});

test('changing resolution waits out the restart, signs in again, and puts the motion area back', async () => {
  const d = device({ downPolls: 3 });
  const r = await changeResolution({ makeClient: d.makeClient, size: '2560*1440', ...fast });
  assert.equal(r.verified, true);
  assert.equal(r.zones, 'restored');
  assert.equal(d.main.size, '2560*1440');
  assert.equal(d.table, TABLE, 'the area is the one from before, not "everything"');
  assert.deepEqual(d.sent.map((s) => Object.keys(s)[0]), ['Enc', 'MdAlarm']);
});

test('if the device keeps the area itself nothing is rewritten; a refused size or the same size is an error', async () => {
  const d = device({ keepArea: true });
  const r = await changeResolution({ makeClient: d.makeClient, size: '2560*1440', ...fast });
  assert.equal(r.zones, 'preserved');
  assert.equal(d.sent.length, 1);
  const e = device();
  await assert.rejects(changeResolution({ makeClient: e.makeClient, size: '1920*1080', ...fast }), (x) => x instanceof WriteError && /does not offer 1920\*1080/.test(x.message));
  await assert.rejects(changeResolution({ makeClient: e.makeClient, size: '2560*1920', ...fast }), (x) => x instanceof WriteError && /already/.test(x.message));
  assert.deepEqual(e.sent, []);
});

test('a device that never comes back is reported, not assumed', async () => {
  const d = device({ downPolls: 1e9 });
  let t = 0;
  const realNow = Date.now;
  Date.now = () => (t += 40_000);
  try {
    const r = await changeResolution({ makeClient: d.makeClient, size: '2560*1440', waitMs: 100_000, ...fast });
    assert.equal(r.verified, false);
    assert.match(r.error, /did not report 2560\*1440/);
  } finally { Date.now = realNow; }
});

/** The same device, but the motion grid follows the picture's shape (80x60 for 4:3, 80x45 for 16:9). */
function shapedDevice() {
  const d = device({ downPolls: 1 });
  const base = d.makeClient;
  d.makeClient = () => {
    const c = base();
    const run = c.command;
    c.command = async (cmd, param) => {
      const out = await run(cmd, param);
      const rows = d.main.height === 1440 ? 45 : 60;
      if (cmd === 'GetAlarm') return { Alarm: { channel: 0, scope: { cols: 80, rows, table: d.table.slice(0, 80 * rows) } } };
      if (cmd === 'SetMdAlarm') { d.table = param.MdAlarm.scope.table; }
      return out;
    };
    return c;
  };
  return d;
}

test('a change of picture shape cannot carry the area across, but returning restores the layout that was saved', async () => {
  const d = shapedDevice();
  const first = await changeResolution({ makeClient: d.makeClient, size: '2560*1440', ...fast });
  assert.match(first.zones, /not restored: the picture shape changed \(grid 80x60 to 80x45\)/);
  assert.equal(first.saved.table, TABLE, 'the 4:3 layout is returned so it can be kept');
  const back = await changeResolution({ makeClient: d.makeClient, size: '2560*1920', remembered: [first.saved], ...fast });
  assert.equal(back.zones, 'restored from an earlier layout');
  assert.equal(d.table, TABLE);
});
