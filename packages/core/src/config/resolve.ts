/**
 * Layered resolution with provenance.
 *
 *   CLI flag  >  shell env  >  .env file  >  handbook.config.yaml  >  default
 *
 * `.env` needs no layer of its own: `applyEnvFile` has already merged it into
 * `process.env` without overriding what the shell set, so the env layer covers
 * both — which is also why an empty value must read as "unset" here.
 *
 * Errors are collected rather than thrown so `handbook config --check` can
 * report every problem in one pass.
 */
import { ConfigError, coerceValue } from './coerce.js';
import { envName, fileKeyCandidates, scopedEnvName } from './names.js';
import { settingsFor } from './registry.js';
import type { ResolveResult, Setting, Source } from './types.js';

export interface ConfigFileData {
  readonly path: string;
  /** Already flattened by camelCase join — see `file.ts`. */
  readonly flat: Record<string, unknown>;
}

export interface ResolveInput {
  readonly command: string;
  /** commander's opts object: camelCase keys, absent when the flag was not passed. */
  readonly flags: Record<string, unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly file?: ConfigFileData;
  /** Base for relative `path` values from flags and env. */
  readonly cwd?: string;
}

/** Env names to try, most specific first. */
export function envCandidates(command: string, setting: Setting): string[] {
  return [
    scopedEnvName(command, setting.key),
    ...(setting.scopedOnly ? [] : [envName(setting.key)]),
    ...(setting.envAliases ?? []),
  ];
}

/** `--read-workers <n>` → `--read-workers`, for error messages and provenance. */
function flagName(setting: Setting): string {
  return setting.flag?.split(/[ ,]/)[0] ?? `(${setting.key})`;
}

function supplyRoutes(command: string, setting: Setting): string {
  const routes: string[] = [];
  if (setting.flag) routes.push(`pass ${flagName(setting)}`);
  routes.push(`set ${envCandidates(command, setting)[0] as string}`);
  if (!setting.secret) routes.push('add it to handbook.config.yaml');
  return routes.join(', or ');
}

export function resolveConfig(input: ResolveInput): ResolveResult {
  const { command, flags, env = {}, file, cwd = process.cwd() } = input;
  const values: Record<string, unknown> = {};
  const sources: Record<string, Source> = {};
  const errors: string[] = [];

  for (const setting of settingsFor(command)) {
    const attempt = (raw: unknown, where: string, source: Source, pathBase: string): boolean => {
      try {
        values[setting.key] = coerceValue(setting, raw, where, pathBase);
        sources[setting.key] = source;
        return true;
      } catch (error) {
        errors.push(error instanceof ConfigError ? error.message : String(error));
        return true; // a supplied-but-invalid value must not fall through to a default
      }
    };

    // 1. flag
    const fromFlag = flags[setting.key];
    if (fromFlag !== undefined) {
      attempt(fromFlag, `flag ${flagName(setting)}`, { kind: 'flag', name: flagName(setting) }, cwd);
      continue;
    }

    // 2. shell env (already includes .env)
    const hit = envCandidates(command, setting).find((name) => {
      const value = env[name];
      return value !== undefined && value !== '';
    });
    if (hit) {
      attempt(env[hit], `env ${hit}`, { kind: 'env', name: hit }, cwd);
      continue;
    }

    // 3. config file — relative paths resolve against the file, not the cwd
    if (file) {
      const keyPath = fileKeyCandidates(command, setting).find((k) => file.flat[k] !== undefined);
      if (keyPath !== undefined) {
        const base = file.path.replace(/[/\\][^/\\]*$/, '') || cwd;
        attempt(
          file.flat[keyPath],
          `${file.path} (${keyPath})`,
          { kind: 'file', path: file.path, keyPath },
          base,
        );
        continue;
      }
    }

    // 4. default. `undefined` means pass-through: leave the key out so a
    // downstream default still applies.
    if (setting.default !== undefined) {
      values[setting.key] = setting.default;
      sources[setting.key] = { kind: 'default' };
    } else if (setting.required) {
      errors.push(`${setting.key} is required: ${supplyRoutes(command, setting)}`);
    }
  }

  return { values, sources, errors };
}
