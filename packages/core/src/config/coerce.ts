/**
 * Turn a raw value from any layer into the declared type, or fail loudly.
 *
 * Every message names its source (`env HANDBOOK_READ_WORKERS`, `flag
 * --read-workers`, `handbook.config.yaml (generate.readWorkers)`), because the
 * failure this replaces was a typo'd env var silently running at the default.
 */
import { isAbsolute, resolve } from 'node:path';
import { HandbookError } from '../errors.js';
import type { Setting } from './types.js';

export class ConfigError extends HandbookError {
  constructor(message: string) {
    super('CONFIG_INVALID', message);
    this.name = 'ConfigError';
  }
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSEY = new Set(['0', 'false', 'no', 'off']);

const fail = (where: string, detail: string): never => {
  throw new ConfigError(`${where}: ${detail}`);
};

/**
 * @param raw   string from env/file, or the value commander produced
 * @param where human-readable source, used verbatim in the error
 * @param pathBase directory a relative `path` value resolves against — cwd for
 *   flags and env, the config file's own directory for file values, so a
 *   committed config file stays portable
 */
export function coerceValue(
  setting: Setting,
  raw: unknown,
  where: string,
  pathBase: string = process.cwd(),
): unknown {
  const { key, type } = setting;

  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    if (TRUTHY.has(text)) return true;
    if (FALSEY.has(text)) return false;
    return fail(where, `${key} must be one of 1|true|yes|on or 0|false|no|off, got "${String(raw)}"`);
  }

  const text = typeof raw === 'string' ? raw : String(raw);

  switch (type) {
    case 'int': {
      const min = setting.min ?? 0;
      const parsed = Number(text);
      // Number('') is 0 and Number('  ') is 0, which would sail past a `>= 0`
      // check — the trim test below is what rejects them.
      if (text.trim() === '' || !Number.isFinite(parsed) || parsed < min || Object.is(parsed, -0)) {
        return fail(where, `${key} must be an integer >= ${min}, got "${text}"`);
      }
      return Math.trunc(parsed);
    }
    case 'enum': {
      const choices = setting.choices ?? [];
      if (!choices.includes(text)) {
        return fail(where, `${key} must be one of ${choices.join(' | ')}, got "${text}"`);
      }
      return text;
    }
    case 'json': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return fail(
          where,
          `${key} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return fail(where, `${key} must be a JSON object, got ${text}`);
      }
      return parsed;
    }
    case 'path': {
      const trimmed = text.trim();
      if (trimmed === '') return fail(where, `${key} must not be empty`);
      return isAbsolute(trimmed) ? trimmed : resolve(pathBase, trimmed);
    }
    default: {
      if (text.trim() === '' && setting.default !== '') {
        // An explicitly blank string is "unset" everywhere else in this
        // toolchain (applyEnvFile skips empties); treating it as a value here
        // would render, for instance, a handbook titled with nothing.
        return fail(where, `${key} must not be empty`);
      }
      return text;
    }
  }
}
