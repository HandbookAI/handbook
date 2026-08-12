/**
 * `handbook config` — print the resolved configuration and where each value
 * came from. This is what makes "flags and env are interchangeable" checkable
 * instead of merely claimed: run it twice, once with a flag and once with the
 * env var, and compare.
 */
import { basename } from 'node:path';
import { keysFor, settingByKey, type ResolveResult, type Source } from '@handbooks/core';

/**
 * The environment cascade, for display — what `main.ts`'s preAction hook
 * resolved before this command ran. Four value layers were already a lot to
 * audit; a cascade adds up to eight possible sources, so `handbook config`
 * must show exactly which environment is active, which files it loaded (in
 * precedence order), and which config file that environment resolved to. A
 * layer this command cannot show is indistinguishable from a layer that does
 * not work — same lesson as the studio flags that reached nothing (P0-1).
 */
export interface EnvironmentDisplay {
  readonly name?: string;
  /** Where `name` came from — absent when neither `--env` nor `HANDBOOK_ENV` was set. */
  readonly source?: 'flag' | 'env';
  /** Env files actually loaded, highest precedence first. */
  readonly envFiles: readonly string[];
  readonly configFile?: string;
  /**
   * Why the config file could not be loaded at all. Its keys are then absent
   * from every row below, so without this line the output is indistinguishable
   * from a project that has no config file — the worst possible answer for
   * someone running this command precisely because the file is broken.
   */
  readonly configFileError?: string;
  /** Keys the file sets that the registry does not claim. They resolved to
   *  nothing, and no value row can show that, because there is no row. */
  readonly configFileWarnings?: readonly string[];
}

/** Enough of a key to recognise it, never enough to use it. */
export function maskSecret(value: string): string {
  if (value === '') return '';
  return value.length > 8 ? `${value.slice(0, 3)}…${value.slice(-4)}` : '***';
}

/**
 * `environment: prod  (--env)` / `env files:   .env.prod, .env.local, .env` /
 * `config file: /repo/handbook.config.prod.yaml` — three left-padded lines,
 * label width shared so the values line up regardless of which label is
 * longest, plus one line per file-level problem.
 */
function environmentBlock(env: EnvironmentDisplay | undefined): string {
  const sourceLabel = env?.source === 'flag' ? '--env' : env?.source === 'env' ? 'HANDBOOK_ENV' : undefined;
  const files = env?.envFiles ?? [];
  const configFile = env?.configFile;
  const rows: [string, string][] = [
    ['environment:', env?.name ? `${env.name}  (${sourceLabel})` : '(not set)'],
    [
      'env files:',
      files.length
        ? `${files.map((f) => basename(f)).join(', ')} (highest precedence first)`
        : '(none loaded)',
    ],
    ['config file:', configFile ? `${configFile}${env?.configFileError ? '  (NOT LOADED)' : ''}` : '(none)'],
  ];
  // A parser error arrives multi-line, with its own caret pointing into the
  // source; folded onto one line it still names the line and column, and it
  // keeps this block a table instead of wrecking the alignment of every row.
  if (env?.configFileError) rows.push(['error:', env.configFileError.replace(/\s+/g, ' ').trim()]);
  for (const warning of env?.configFileWarnings ?? []) rows.push(['warning:', warning]);
  const width = Math.max(...rows.map(([label]) => label.length)) + 1;
  return `${rows.map(([label, value]) => `${label.padEnd(width)}${value}`).join('\n')}\n\n`;
}

function describeSource(source: Source): string {
  switch (source.kind) {
    case 'flag':
      return `flag ${source.name}`;
    case 'env':
      return `env ${source.name}`;
    case 'file':
      return `file ${source.path} (${source.keyPath})`;
    default:
      return 'default';
  }
}

/** A setting that no layer supplied is either a plain pass-through (a
 *  downstream default applies) or a required value with nowhere to come
 *  from — the two must not look the same, since the second is a problem. */
function isRequiredMissing(key: string, command: string): boolean {
  const setting = settingByKey(key);
  return Boolean(setting?.required || setting?.requiredFor?.includes(command));
}

function sourceText(key: string, command: string, result: ResolveResult): string {
  const source = result.sources[key];
  if (source) return describeSource(source);
  return isRequiredMissing(key, command) ? 'unset (required)' : 'unset';
}

/** One-line text for a resolved value, objects included. */
function displayText(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

function display(key: string, result: ResolveResult): string {
  if (!(key in result.values)) return '—';
  const text = displayText(result.values[key]);
  return settingByKey(key)?.secret ? maskSecret(text) : text;
}

export function renderConfigTable(
  result: ResolveResult,
  command: string,
  environment?: EnvironmentDisplay,
): string {
  const rows = keysFor(command).map((key) => [key, display(key, result), sourceText(key, command, result)]);
  const width = (i: number): number => Math.max(0, ...rows.map((r) => (r[i] as string).length));
  const [w0, w1] = [width(0), width(1)];
  const lines = rows.map(
    ([k, v, s]) => `${(k as string).padEnd(w0)}  ${(v as string).padEnd(w1)}  ${s as string}`,
  );
  return `${environmentBlock(environment)}${lines.join('\n')}\n`;
}

/** Machine-readable value: masked when secret, `null` when no layer supplied
 *  one — never the table's em-dash, which is a display artifact, not data. */
function jsonValue(key: string, result: ResolveResult): unknown {
  if (!(key in result.values)) return null;
  const value = result.values[key];
  // A `json`-typed secret (llmExtraBody) has to be masked from its JSON text,
  // the way the table does it: `String(anObject)` is `[object Object]`, which
  // masks to something that reads like a real, short value.
  return settingByKey(key)?.secret ? maskSecret(displayText(value)) : value;
}

export function renderConfigJson(
  result: ResolveResult,
  command: string,
  environment?: EnvironmentDisplay,
): string {
  const settings: Record<string, { value: unknown; source: string }> = {};
  for (const key of keysFor(command)) {
    settings[key] = { value: jsonValue(key, result), source: sourceText(key, command, result) };
  }
  const sourceLabel =
    environment?.source === 'flag' ? '--env' : environment?.source === 'env' ? 'HANDBOOK_ENV' : null;
  return `${JSON.stringify(
    {
      command,
      environment: environment?.name ? { name: environment.name, source: sourceLabel } : null,
      envFiles: environment?.envFiles ?? [],
      configFile: environment?.configFile ?? null,
      // Separate from `errors`, which is per-setting: these two describe the
      // file itself, and a consumer that only checked `errors` would call a
      // config file that never loaded a clean run.
      configFileError: environment?.configFileError ?? null,
      configFileWarnings: environment?.configFileWarnings ?? [],
      settings,
      errors: result.errors,
    },
    null,
    2,
  )}\n`;
}
