import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VERSION, LICENSE, readPackageInfo } from '../src/version.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;   // semver.org's own pattern, kept here separately from the one under test
const pkgFile = (text) => { const d = mkdtempSync(path.join(tmpdir(), 'ver-')); const f = path.join(d, 'package.json'); writeFileSync(f, text); return { f, done: () => rmSync(d, { recursive: true, force: true }) }; };

test('the build\'s version is the semantic version in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, SEMVER, 'MAJOR.MINOR.PATCH');
  assert.equal(LICENSE, pkg.license);
});

test('a valid version and license are read as they are written, including pre-release and build parts', () => {
  for (const v of ['0.0.1', '1.2.3', '10.20.30', '1.0.0-alpha.1', '1.0.0+build.5', '2.1.0-rc.1+sha.abc']) {
    const t = pkgFile(JSON.stringify({ version: v, license: 'MIT' }));
    assert.deepEqual(readPackageInfo(t.f), { version: v, license: 'MIT' }, v);
    t.done();
  }
});

test('anything that is not a semantic version reads as "unknown", never as something misleading', () => {
  for (const v of ['1.2', 'v1.2.3', '1.2.3.4', 'latest', '', '01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3-01', 1, null, undefined]) {
    const t = pkgFile(JSON.stringify({ version: v, license: 'MIT' }));
    assert.equal(readPackageInfo(t.f).version, 'unknown', JSON.stringify(v));
    t.done();
  }
});

test('a missing or broken package.json gives "unknown" and does not throw', () => {
  assert.deepEqual(readPackageInfo('/nowhere/package.json'), { version: 'unknown', license: 'unknown' });
  const t = pkgFile('{ not json');
  assert.deepEqual(readPackageInfo(t.f), { version: 'unknown', license: 'unknown' });
  t.done();
  const noLicense = pkgFile(JSON.stringify({ version: '0.0.1' }));
  assert.deepEqual(readPackageInfo(noLicense.f), { version: '0.0.1', license: 'unknown' });
  noLicense.done();
});
