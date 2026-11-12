import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeEnvFile, loadCredentials } from '../src/credentials.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'init-'));

test('the sign-in file is created private, readable back, and not overwritten by accident', async () => {
  const d = tmp(), file = path.join(d, 'nested', 'reolook', 'env');
  await writeEnvFile({ file, user: 'viewer', password: 'p@ss w0rd#1' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(await loadCredentials({ env: {}, file }), { user: 'viewer', password: 'p@ss w0rd#1', source: file });
  await assert.rejects(writeEnvFile({ file, user: 'a', password: 'b12345' }), /already exists/);
  await writeEnvFile({ file, user: 'a', password: 'b12345', force: true });
  assert.match(readFileSync(file, 'utf8'), /REOLINK_USER=a\nREOLINK_PASS=b12345\n/);
  rmSync(d, { recursive: true, force: true });
});

test('values the reader could not give back unchanged are refused', async () => {
  const d = tmp(), file = path.join(d, 'env');
  for (const [user, password] of [['', 'x12345'], ['u', ''], ['u', ' pad'], ['u', 'pad '], ['u', '"quoted"'], ['u', 'line\nbreak'], ['u\r', 'x12345']]) {
    await assert.rejects(writeEnvFile({ file, user, password }), /empty|cannot contain/, JSON.stringify([user, password]));
  }
  writeFileSync(file, 'keep');
  await assert.rejects(writeEnvFile({ file, user: 'u', password: ' bad' }));
  assert.equal(readFileSync(file, 'utf8'), 'keep', 'a refused write leaves the old file alone');
  rmSync(d, { recursive: true, force: true });
});
