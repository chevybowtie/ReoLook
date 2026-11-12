import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ReolinkClient } from '../src/client.mjs';

test('a device that forgot the session ("please login first") is signed in to again, once', async () => {
  let logins = 0, forget = true, calls = 0;
  const srv = http.createServer((req, res) => {
    const cmd = new URL(req.url, 'http://x').searchParams.get('cmd');
    res.setHeader('content-type', 'application/json');
    if (cmd === 'Login') { logins++; return res.end(JSON.stringify([{ cmd, code: 0, value: { Token: { name: `t${logins}` } } }])); }
    calls++;
    if (forget && calls === 1) { forget = false; return res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode: -6, detail: 'please login first' } }])); }
    res.end(JSON.stringify([{ cmd, code: 0, value: { ok: true } }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = new ReolinkClient({ host: `127.0.0.1:${srv.address().port}`, user: 'u', password: 'p' });
  assert.deepEqual(await c.command('GetX'), { ok: true });
  assert.equal(logins, 2, 'signed in, was told to sign in again, did so once');
  srv.closeAllConnections(); srv.close();
});

test('a persistent refusal is an error, not a loop', async () => {
  let logins = 0;
  const srv = http.createServer((req, res) => {
    const cmd = new URL(req.url, 'http://x').searchParams.get('cmd');
    res.setHeader('content-type', 'application/json');
    if (cmd === 'Login') { logins++; return res.end(JSON.stringify([{ cmd, code: 0, value: { Token: { name: 't' } } }])); }
    res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode: -6, detail: 'please login first' } }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = new ReolinkClient({ host: `127.0.0.1:${srv.address().port}`, user: 'u', password: 'p' });
  await assert.rejects(c.command('GetX'), /please login first/);
  assert.equal(logins, 2);
  srv.closeAllConnections(); srv.close();
});

test('the configured size is read from either shape: width and height, or only a "2560*1440" string', async () => {
  const srv = http.createServer((req, res) => {
    const cmd = new URL(req.url, 'http://x').searchParams.get('cmd');
    res.setHeader('content-type', 'application/json');
    const value = cmd === 'Login' ? { Token: { name: 't' } }
      : { Enc: { mainStream: { size: '2560*1440', bitRate: 6144 }, subStream: { width: 640, height: 480, size: '640*480' } } };
    res.end(JSON.stringify([{ cmd, code: 0, value }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = new ReolinkClient({ host: `127.0.0.1:${srv.address().port}`, user: 'u', password: 'p' });
  assert.deepEqual(await c.encoding(), { main: { width: 2560, height: 1440 }, sub: { width: 640, height: 480 } });
  srv.closeAllConnections(); srv.close();
});
