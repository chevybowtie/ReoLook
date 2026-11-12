import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

function camera(getState) {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    const cmd = new URL(req.url, 'http://x').searchParams.get('cmd');
    res.setHeader('content-type', 'application/json');
    if (cmd === 'GetMdState') { hits++; return res.end(JSON.stringify([{ cmd, code: 0, value: { state: getState() } }])); }
    res.end(JSON.stringify([{ cmd, code: 0, value: cmd === 'Login' ? { Token: { name: 't' } } : {} }]));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(Object.assign(srv, { hits: () => hits }))));
}

test('/api/motion-state reports each device, tolerates one that is down, and is shared for a second', async () => {
  let state = 0;
  const cam = await camera(() => state);
  const dir = mkdtempSync(path.join(tmpdir(), 'ms-'));
  const cameras = [{ name: 'Up', host: `127.0.0.1:${cam.address().port}` }, { name: 'Down', host: '127.0.0.1:1' }];
  writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ cameras }));
  const server = createServer({ config: normalize({ cameras }), configPath: path.join(dir, 'c.json'), user: 'u', password: 'p' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/motion-state`)).json();

  const a = await get();
  assert.equal(a.devices.up.motion, false);
  assert.equal(a.devices.down.motion, null);
  assert.ok(a.devices.down.error);
  state = 1;
  const b = await get();
  assert.equal(b.devices.up.motion, false, 'served from the one-second cache');
  assert.equal(cam.hits(), 1);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await get()).devices.up.motion, true);
  server.closeAllConnections(); server.close(); cam.close(); rmSync(dir, { recursive: true, force: true });
});
