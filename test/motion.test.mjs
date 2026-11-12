import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMotion } from '../src/motion.mjs';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { ProfileCache } from '../src/capabilities.mjs';

const sens = [0, 6, 12, 18].map((h, i) => ({ id: i, beginHour: h, beginMin: 0, endHour: h + 6 > 23 ? 23 : h + 6, endMin: h + 6 > 23 ? 59 : 0, sensitivity: 10 }));
const table = (cols, rows, on) => Array.from({ length: cols * rows }, (_, i) => (on(i % cols, Math.floor(i / cols)) ? '1' : '0')).join('');

test('a valid grid: size, active cells and coverage are counted from the table', () => {
  const t = table(80, 60, (x) => x >= 20);                         // left quarter excluded
  const r = parseMotion({ enable: 1602, channel: 0, scope: { cols: 80, rows: 60, table: t }, sens }, { scope: { table: t }, useNewSens: 1, newSens: { sensDef: 10, sens: [] }, sens });
  assert.equal(r.problem, null);
  assert.equal(r.grid.cols, 80); assert.equal(r.grid.rows, 60);
  assert.equal(r.grid.totalCells, 4800); assert.equal(r.grid.activeCells, 3600); assert.equal(r.grid.coveragePercent, 75);
  assert.equal(r.tablesAgree, true);
  assert.equal(r.raw.enableField, 1602, 'the odd enable value is passed through, not interpreted');
});

test('a malformed area is reported, never repaired or guessed', () => {
  const g = (scope) => parseMotion({ scope });
  assert.match(g({ cols: 80, rows: 60, table: '101' }).problem, /3 cells but a 80 x 60 grid needs 4800/);
  assert.match(g({ cols: 2, rows: 2, table: '10x1' }).problem, /other than 0 and 1/);
  assert.match(g({ cols: 0, rows: 60, table: '' }).problem, /unusable grid size/);
  assert.match(g({ cols: 9999, rows: 60, table: '' }).problem, /unusable grid size/);
  assert.match(g({ cols: 2, rows: 2, table: 1010 }).problem, /not a string/);
  assert.match(parseMotion({}).problem, /did not report/);
  assert.equal(g({ cols: 80, rows: 60, table: '1' }).grid, null);
});

test('any grid size works: a different camera simply reports a different one', () => {
  const r = parseMotion({ scope: { cols: 22, rows: 18, table: table(22, 18, () => true) } });
  assert.equal(r.grid.totalCells, 396); assert.equal(r.grid.coveragePercent, 100);
});

test('sensitivity: windows kept as reported, one summary number only when every source agrees', () => {
  const agree = parseMotion({ sens, scope: { cols: 1, rows: 1, table: '1' } }, { newSens: { sensDef: 10, sens: [] }, useNewSens: 1, sens });
  assert.deepEqual(agree.sensitivity.summary, { value: 10, uniform: true });
  assert.equal(agree.sensitivity.windows.length, 4);
  assert.deepEqual(agree.sensitivity.windows[3], { id: 3, from: '18:00', to: '23:59', sensitivity: 10 });
  assert.equal(agree.sensitivity.newStructure.inUse, true);
  const mixed = parseMotion({ sens: [{ ...sens[0], sensitivity: 5 }, sens[1]], scope: { cols: 1, rows: 1, table: '1' } });
  assert.deepEqual(mixed.sensitivity.summary, { value: null, uniform: false });
  const disagree = parseMotion({ sens, scope: { cols: 1, rows: 1, table: '1' } }, { newSens: { sensDef: 25, sens: [] }, useNewSens: 1 });
  assert.equal(disagree.sensitivity.summary.uniform, false, 'a conflicting default is not hidden');
});

test('two tables that differ are flagged', () => {
  const r = parseMotion({ scope: { cols: 2, rows: 1, table: '11' } }, { scope: { cols: 2, rows: 1, table: '10' } });
  assert.equal(r.tablesAgree, false);
});

function camera(handlers) {
  const srv = http.createServer((req, res) => {
    const cmd = new URL(req.url, 'http://x').searchParams.get('cmd');
    res.setHeader('content-type', 'application/json');
    const out = handlers[cmd] ?? (() => ({}));
    const v = out();
    res.end(JSON.stringify(v?.error ? [{ cmd, code: 1, error: v.error }] : [{ cmd, code: 0, value: v }]));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
async function app(cams) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mo-'));
  const config = normalize({ cameras: cams.map((c, i) => ({ name: `Cam${i}`, host: `127.0.0.1:${c.address().port}` })) });
  const server = createServer({ config, configPath: path.join(dir, 'c.json'), user: 'u', password: 'p', capabilityCache: new ProfileCache({ file: path.join(dir, 'cap.json') }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); for (const c of cams) { c.closeAllConnections(); c.close(); } rmSync(dir, { recursive: true, force: true }); } };
}
const baseHandlers = (extra = {}) => ({
  Login: () => ({ Token: { name: 't' } }),
  GetDevInfo: () => ({ DevInfo: { model: 'M', name: 'N', firmVer: 'f', channelNum: 1 } }),
  GetAbility: () => ({ Ability: { abilityChn: [{ alarmMd: { permit: 4, ver: 1 } }] } }),
  ...extra,
});

test('GET /api/devices/:id/motion: reads the grid with the viewing account; refuses unknown and unsupported devices', async () => {
  const t = table(80, 60, (x, y) => y >= 10);
  const ok = await camera(baseHandlers({
    GetAlarm: () => ({ Alarm: { enable: 1602, channel: 0, scope: { cols: 80, rows: 60, table: t }, sens } }),
    GetMdAlarm: () => ({ MdAlarm: { scope: { cols: 80, rows: 60, table: t }, sens, useNewSens: 1, newSens: { sensDef: 10, sens: [] } } }),
  }));
  const none = await camera(baseHandlers({ GetAbility: () => ({ Ability: { abilityChn: [{}] } }), GetMdAlarm: () => ({ error: { rspCode: -9, detail: 'not support' } }), GetAlarm: () => ({ error: { rspCode: -9, detail: 'not support' } }) }));
  const a = await app([ok, none]);
  const r = await fetch(`${a.base}/api/devices/cam0/motion`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.grid.coveragePercent, 83.3); assert.equal(j.grid.cols, 80);
  assert.equal(j.grid.table.length, 4800);
  assert.equal(j.problem, null);
  assert.equal((await fetch(`${a.base}/api/devices/nope/motion`)).status, 404);
  assert.equal((await fetch(`${a.base}/api/devices/cam1/motion`)).status, 409);
  a.close();
});
