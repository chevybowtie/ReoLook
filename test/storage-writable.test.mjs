import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertWritable } from '../src/service.mjs';

test('assertWritable passes on a writable folder and explains a read-only one', async (t) => {
  const d = await mkdtemp(path.join(tmpdir(), 'rl-w-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  await assertWritable(d);
  if (process.getuid?.() === 0) return t.skip('root ignores permissions');
  await chmod(d, 0o555);
  await assert.rejects(assertWritable(d), /cannot write to .*permission denied/);
  await chmod(d, 0o755);
});
