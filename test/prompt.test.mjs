// With no terminal (as in a script or a test) the prompts read one line from standard input.
// Run in a child process so the test controls stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'prompt.mjs');
const ask = (fn, input) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { ${fn} } from ${JSON.stringify(PROMPT)}; const v = await ${fn}('Q? '); console.log(JSON.stringify(v));`], { input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
};

test('askLine writes the question and returns the first line only', () => {
  const r = ask('askLine', 'first\nsecond\n');
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Q? "first"\n');
});

test('askLine accepts Windows line endings and empty input', () => {
  assert.equal(ask('askLine', 'abc\r\nmore').out, 'Q? "abc"\n');
  assert.equal(ask('askLine', '').out, 'Q? ""\n');
});

test('askSecret returns the first line and never writes the question or the answer to the terminal', () => {
  const r = ask('askSecret', 'p@ss w0rd\nignored\n');
  assert.equal(r.code, 0);
  assert.equal(r.out, '"p@ss w0rd"\n', 'only the program\'s own print; no prompt text, no echo');
});
