/**
 * The CLI's version, read from its own manifest rather than written twice.
 *
 * `changeset version` rewrites `package.json` and nothing else, so any literal
 * here would silently drift a release behind — which is exactly what shipped as
 * `--version 0.1.0` against a 1.1.0 manifest. `scripts/smoke-install.mjs`
 * compares the two, but only under `check:all`; `version.test.ts` closes the
 * same loop in `pnpm check`.
 *
 * `rootDir` is `src` and `outDir` is `dist`, so this module sits exactly one
 * directory below the manifest whether it runs from source (tests, via the
 * `@handbooks/*` → `src` aliases) or from the published `dist`.
 */
import { readFileSync } from 'node:fs';

/** Deliberately not a plausible version, so a damaged install cannot read as a real one. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/** Where the version really comes from. Overridable so a test can point at a real broken file. */
export const CLI_MANIFEST = new URL('../package.json', import.meta.url);

/** Read when `--version` is built, i.e. at module load — hence the fallback rather than a throw. */
export function readCliVersion(manifest: URL = CLI_MANIFEST): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : UNKNOWN_VERSION;
  } catch {
    // A missing or unparseable manifest means a damaged install. Degrade, never
    // block: a broken `--version` must not take every other command down with it.
    return UNKNOWN_VERSION;
  }
}
