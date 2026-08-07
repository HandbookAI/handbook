/**
 * The project config layer: `handbook.config.yaml`.
 *
 * Discovery walks up from the cwd so a command run in a subdirectory still sees
 * the project's settings — unlike `.env`, which stays cwd-only because it means
 * "this machine right now" and changing its existing behaviour is not on the
 * table. Parsing uses `yaml` for all three extensions, since JSON is valid YAML.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from './coerce.js';
import { SETTINGS } from './registry.js';
import type { ConfigFileData } from './resolve.js';

const FILENAMES = ['handbook.config.yaml', 'handbook.config.yml', 'handbook.config.json'] as const;

/** Nearest config file at or above `from`, not crossing out of a git root. */
export function discoverConfigFile(from: string): string | undefined {
  let dir = from;
  for (;;) {
    for (const name of FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    // A repo boundary is a project boundary: do not inherit a parent project's
    // configuration just because this one has none.
    if (existsSync(join(dir, '.git'))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Flatten nested maps by camelCase join, so `llm: { model }` and
 * `generate: { detail }` need no special cases — grouping and command scoping
 * are the same operation, and the result matches the registry's key space.
 */
export function flattenConfig(data: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(data)) {
    const key = prefix ? `${prefix}${rawKey[0]?.toUpperCase() ?? ''}${rawKey.slice(1)}` : rawKey;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, flattenConfig(value as Record<string, unknown>, key));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param path absolute path to the config file. `discoverConfigFile` always
 *   produces one (it joins onto an absolute starting dir); a caller passing an
 *   explicit `--config` must resolve it against the cwd first — this function
 *   does not guess a base directory for a relative path.
 */
export function loadConfigFile(path: string): ConfigFileData {
  // `resolve.ts` derives the file's directory with `dirname(file.path)` and
  // trusts the result as the base for relative `path`-typed settings — a
  // relative `path` here would silently resolve those against the wrong
  // directory instead of failing loudly. The CLI resolves `--config` before
  // calling this.
  if (!isAbsolute(path)) {
    throw new ConfigError(`${path}: config file path must be absolute`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || parsed === undefined) return { path, flat: {} };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${path}: must contain a mapping of settings, not a list or a scalar`);
  }
  const flat = flattenConfig(parsed as Record<string, unknown>);
  for (const setting of SETTINGS) {
    if (!setting.secret) continue;
    const leaked = Object.keys(flat).find(
      (key) => key === setting.key || key.endsWith(setting.key[0]!.toUpperCase() + setting.key.slice(1)),
    );
    if (leaked) {
      throw new ConfigError(
        `${path}: ${setting.key} must not appear in a config file (it gets committed) — use .env or the shell environment instead`,
      );
    }
  }
  return { path, flat };
}
