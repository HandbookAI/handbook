/**
 * `handbook config` — print the resolved configuration and where each value
 * came from. This is what makes "flags and env are interchangeable" checkable
 * instead of merely claimed: run it twice, once with a flag and once with the
 * env var, and compare.
 */
import { keysFor, settingByKey, type ResolveResult, type Source } from '@handbook/core';

/** Enough of a key to recognise it, never enough to use it. */
export function maskSecret(value: string): string {
  if (value === '') return '';
  return value.length > 8 ? `${value.slice(0, 3)}…${value.slice(-4)}` : '***';
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

function display(key: string, result: ResolveResult): string {
  if (!(key in result.values)) return '—';
  const value = result.values[key];
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return settingByKey(key)?.secret ? maskSecret(text) : text;
}

export function renderConfigTable(result: ResolveResult, command: string): string {
  const rows = keysFor(command).map((key) => [key, display(key, result), sourceText(key, command, result)]);
  const width = (i: number): number => Math.max(0, ...rows.map((r) => (r[i] as string).length));
  const [w0, w1] = [width(0), width(1)];
  const lines = rows.map(
    ([k, v, s]) => `${(k as string).padEnd(w0)}  ${(v as string).padEnd(w1)}  ${s as string}`,
  );
  return `${lines.join('\n')}\n`;
}

/** Machine-readable value: masked when secret, `null` when no layer supplied
 *  one — never the table's em-dash, which is a display artifact, not data. */
function jsonValue(key: string, result: ResolveResult): unknown {
  if (!(key in result.values)) return null;
  const value = result.values[key];
  return settingByKey(key)?.secret ? maskSecret(String(value)) : value;
}

export function renderConfigJson(result: ResolveResult, command: string): string {
  const settings: Record<string, { value: unknown; source: string }> = {};
  for (const key of keysFor(command)) {
    settings[key] = { value: jsonValue(key, result), source: sourceText(key, command, result) };
  }
  return `${JSON.stringify({ command, settings, errors: result.errors }, null, 2)}\n`;
}
