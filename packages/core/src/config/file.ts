/**
 * The project config layer: `handbook.config.yaml`.
 *
 * Discovery walks up from the cwd so a command run in a subdirectory still sees
 * the project's settings — unlike `.env`, which stays cwd-only because it means
 * "this machine right now" and changing its existing behaviour is not on the
 * table. Parsing uses `yaml` for all three extensions, since JSON is valid YAML.
 *
 * This file is the one config layer that gets COMMITTED, which is why the two
 * refusals below live here and nowhere else: a secret in it is a secret in the
 * repo, and a credential embedded in an otherwise-committable value is the same
 * leak wearing a different shape.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from './coerce.js';
import { envName, fileKeyCandidates, joinKey, nearestKey } from './names.js';
import { SETTINGS } from './registry.js';
import type { ConfigFileData, UnknownConfigKey } from './resolve.js';
import type { Setting } from './types.js';

const EXTENSIONS = ['yaml', 'yml', 'json'] as const;
const FILENAMES = EXTENSIONS.map((ext) => `handbook.config.${ext}`);

/**
 * Nearest config file at or above `from`, not crossing out of a git root.
 *
 * When `name` is given, every directory visited on the way up is checked for
 * `handbook.config.<name>.{yaml,yml,json}` before the plain `handbook.config.*`
 * — so an environment-named file always wins over a plain one sitting right
 * next to it, even if a plain file exists closer to `from`. With no `name`,
 * discovery is exactly what it was before environments existed.
 */
export function discoverConfigFile(from: string, name?: string): string | undefined {
  let dir = from;
  for (;;) {
    if (name) {
      for (const ext of EXTENSIONS) {
        const candidate = join(dir, `handbook.config.${name}.${ext}`);
        if (existsSync(candidate)) return candidate;
      }
    }
    for (const filename of FILENAMES) {
      const candidate = join(dir, filename);
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

/** One leaf of the file, carrying both spellings of where it came from. */
interface FlatEntry {
  /** Flattened key — what every lookup in this package uses. */
  readonly key: string;
  /** Dotted path as the file nests it, which is the form a reader has to edit. */
  readonly path: string;
  readonly value: unknown;
}

function flattenEntries(data: Record<string, unknown>, prefix = '', path = ''): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const [rawKey, value] of Object.entries(data)) {
    const key = joinKey(prefix, rawKey);
    const here = path ? `${path}.${rawKey}` : rawKey;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out.push(...flattenEntries(value as Record<string, unknown>, key, here));
    } else {
      out.push({ key, path: here, value });
    }
  }
  return out;
}

/**
 * Flatten nested maps by camelCase join, so `llm: { model }` and
 * `generate: { detail }` need no special cases — grouping and command scoping
 * are the same operation, and the result matches the registry's key space.
 */
export function flattenConfig(data: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  return Object.fromEntries(flattenEntries(data, prefix).map((entry) => [entry.key, entry.value]));
}

/**
 * Every key the file layer will ever look up, mapped to the setting that owns
 * it. Built from `fileKeyCandidates` — the same function the resolver uses — so
 * a second, hand-written list cannot drift and start calling valid keys unknown.
 */
function fileKeyOwners(): Map<string, Setting> {
  const owners = new Map<string, Setting>();
  for (const setting of SETTINGS) {
    for (const command of setting.commands) {
      for (const candidate of fileKeyCandidates(command, setting)) {
        if (!owners.has(candidate)) owners.set(candidate, setting);
      }
    }
  }
  return owners;
}

/**
 * True when `key` IS `owned`, or is nested inside it.
 *
 * The nesting half is not hypothetical: a `json`-typed setting written as a
 * map does not survive flattening as itself — `llm: { extraBody: { thinking:
 * … } }` arrives as `llmExtraBodyThinking`, which an equality check walks
 * straight past. That is the shape a credential would actually be written in.
 */
function isKeyOrNestedUnder(key: string, owned: string): boolean {
  return key === owned || (key.startsWith(owned) && /[A-Z]/.test(key.charAt(owned.length)));
}

/** Every config-file spelling that reaches `setting`, across all its commands. */
function ownedKeys(setting: Setting): string[] {
  return [...new Set(setting.commands.flatMap((command) => fileKeyCandidates(command, setting)))];
}

/** `HANDBOOK_LLM_API_KEY or OPENAI_API_KEY` — the routes that are not this file. */
function envRoutes(setting: Setting): string {
  return [envName(setting.key), ...(setting.envAliases ?? [])].join(' or ');
}

function refuseSecrets(path: string, entries: readonly FlatEntry[]): void {
  for (const setting of SETTINGS) {
    if (!setting.secret) continue;
    const owned = ownedKeys(setting);
    const leaked = entries.find((entry) => owned.some((key) => isKeyOrNestedUnder(entry.key, key)));
    if (leaked) {
      throw new ConfigError(
        `${path}: ${setting.key} must not appear in a config file (it gets committed) — use .env ` +
          `or the shell environment instead (${envRoutes(setting)}), and remove "${leaked.path}" from this file`,
      );
    }
  }
}

/**
 * RFC 3986 userinfo, and only that.
 *
 * `new URL` is the arbiter rather than a regex: `https://user:pass@host` and
 * `https://token@host` both land in `username`/`password`, and nothing that is
 * merely a path can. A value that is not a URL at all is not this guard's
 * problem — `coerceValue` reports the shape.
 */
function hasUrlCredentials(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.username !== '' || url.password !== '';
  } catch {
    return false;
  }
}

function refuseEmbeddedCredentials(
  path: string,
  entries: readonly FlatEntry[],
  owners: Map<string, Setting>,
): void {
  for (const entry of entries) {
    const setting = owners.get(entry.key);
    if (setting?.rejectInFile !== 'urlCredentials' || !hasUrlCredentials(entry.value)) continue;
    throw new ConfigError(
      `${path}: ${entry.path} embeds credentials in the URL (userinfo, as in ` +
        `https://user:pass@host) and this file gets committed — keep the credential out of the ` +
        `value here, or set the whole URL through ${envRoutes(setting)} in .env or the shell`,
    );
  }
}

/**
 * `generate.readWorker` + `generateReadWorkers` → `generate.readWorkers`.
 *
 * The suggestion has to come back in the shape the file already uses, or the
 * reader has to do the flattening in their head before they can act on it.
 */
function suggestionInFileShape(entry: FlatEntry, suggestion: string): string {
  const segments = entry.path.split('.');
  const parents = segments.slice(0, -1);
  const prefix = parents.reduce((acc, segment) => joinKey(acc, segment), '');
  if (prefix === '' || !suggestion.startsWith(prefix)) return suggestion;
  const leaf = suggestion.slice(prefix.length);
  return [...parents, leaf.charAt(0).toLowerCase() + leaf.slice(1)].join('.');
}

function findUnknownKeys(entries: readonly FlatEntry[], owners: Map<string, Setting>): UnknownConfigKey[] {
  const unknown: UnknownConfigKey[] = [];
  for (const entry of entries) {
    if (owners.has(entry.key)) continue;
    // A key with no value declares nothing, so there is nothing to be wrong
    // about: `generate:` with an empty body is how a section gets commented
    // out, and reporting it would train readers to ignore this whole class of
    // message.
    if (entry.value === null || entry.value === undefined) continue;
    const near = nearestKey(entry.key, owners.keys());
    unknown.push({
      path: entry.path,
      key: entry.key,
      ...(near ? { suggestion: suggestionInFileShape(entry, near) } : {}),
    });
  }
  return unknown;
}

/** One printable line per unknown key, with the file it came from. */
export function unknownKeyWarnings(file: ConfigFileData | undefined): string[] {
  if (!file) return [];
  return (file.unknownKeys ?? []).map(
    (unknown) =>
      `${file.path}: unknown key "${unknown.path}" is ignored — ` +
      (unknown.suggestion
        ? `did you mean "${unknown.suggestion}"?`
        : 'no setting by that name (see handbook.config.example.yaml)'),
  );
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
  if (parsed === null || parsed === undefined) return { path, flat: {}, unknownKeys: [] };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${path}: must contain a mapping of settings, not a list or a scalar`);
  }
  const entries = flattenEntries(parsed as Record<string, unknown>);
  const owners = fileKeyOwners();
  refuseSecrets(path, entries);
  refuseEmbeddedCredentials(path, entries, owners);
  return {
    path,
    flat: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
    unknownKeys: findUnknownKeys(entries, owners),
  };
}

/** The path that was attempted, loaded or not — a broken file must stay nameable. */
export interface ConfigFileRead {
  readonly path: string;
  readonly file?: ConfigFileData;
  /** Why the file could not be used. Present exactly when `file` is absent. */
  readonly error?: string;
}

/**
 * `loadConfigFile` without the throw.
 *
 * `handbook config` exists to show configuration INCLUDING when it is broken,
 * and the config file is the likeliest broken thing: unparseable YAML, a path
 * that turned out to be a directory, a file this process cannot read. Throwing
 * during bootstrap took down the one command whose entire job is to explain
 * that situation, before it could print a line — and the person running it is
 * running it precisely because something is broken. Every other command still
 * refuses to run: the CLI carries `error` into its own resolve-or-throw.
 */
export function readConfigFile(path: string): ConfigFileRead {
  try {
    return { path, file: loadConfigFile(path) };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}
