// The version of this build. It is set in one place, the "version" field of package.json (semantic
// versioning: MAJOR.MINOR.PATCH), and read once when ReoLook starts. To make a new build, change it there;
// Settings > About shows it.
import { readFileSync } from 'node:fs';

// The official semantic versioning pattern (semver.org): no leading zeros in numbers, optional -prerelease and +build parts.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * What package.json says this build is.
 * @param {string|URL} [file] the package.json to read; replaceable in tests
 * @returns {{version: string, license: string}} `version` is "unknown" when the file cannot be read or its version is not valid semver
 */
export function readPackageInfo(file = new URL('../package.json', import.meta.url)) {
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    return { version: SEMVER.test(String(pkg.version)) ? pkg.version : 'unknown', license: typeof pkg.license === 'string' ? pkg.license : 'unknown' };
  } catch { return { version: 'unknown', license: 'unknown' }; }
}

/** This build's version, for example "0.0.1". */
export const { version: VERSION, license: LICENSE } = readPackageInfo();
