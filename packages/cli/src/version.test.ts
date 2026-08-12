import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { program } from './main.js';
import { CLI_MANIFEST, readCliVersion, UNKNOWN_VERSION } from './version.js';

/** The manifest, read the long way round so the test cannot share the bug it guards. */
function manifestVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

// Real files in a real temp dir, not a mocked `node:fs` — a mocked read proves
// nothing about how the manifest is actually found.
const dir = mkdtempSync(join(tmpdir(), 'hb-version-'));
const fileWith = (name: string, body: string): URL => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return pathToFileURL(path);
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the CLI version', () => {
  it('is the manifest version, not a literal that drifts behind a release', () => {
    const declared = manifestVersion();
    expect(declared).toMatch(/^\d+\.\d+\.\d+/);
    expect(readCliVersion()).toBe(declared);
  });

  it('is what `--version` actually reports', () => {
    // What smoke-install.mjs checks against a real npm install, checked here too
    // so `pnpm check` fails on the drift rather than `check:all` in CI.
    expect(program.version()).toBe(manifestVersion());
  });

  it('looks one directory up, which is the manifest from both src/ and dist/', () => {
    expect(CLI_MANIFEST.pathname).toMatch(/\/packages\/cli\/package\.json$/);
  });

  describe('a damaged install', () => {
    it('does not report a plausible version', () => {
      expect(UNKNOWN_VERSION).not.toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('degrades rather than throwing when the manifest is missing', () => {
      expect(readCliVersion(pathToFileURL(join(dir, 'absent.json')))).toBe(UNKNOWN_VERSION);
    });

    it('degrades when the manifest is not JSON', () => {
      expect(readCliVersion(fileWith('broken.json', '{ not json'))).toBe(UNKNOWN_VERSION);
    });

    it('degrades when the manifest has no version', () => {
      expect(readCliVersion(fileWith('no-version.json', '{"name":"@handbooks/cli"}'))).toBe(UNKNOWN_VERSION);
    });

    it('degrades when the version is present but empty', () => {
      expect(readCliVersion(fileWith('empty.json', '{"version":""}'))).toBe(UNKNOWN_VERSION);
    });

    it('degrades when the version is not a string', () => {
      expect(readCliVersion(fileWith('numeric.json', '{"version":1.2}'))).toBe(UNKNOWN_VERSION);
    });
  });
});
