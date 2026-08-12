/**
 * The one transformation shared by all three surfaces, so nothing has to be
 * remembered: `readWorkers` ⇄ `HANDBOOK_READ_WORKERS` ⇄ `readWorkers:` in the
 * config file, and adding a command prefix is the same operation on each.
 */
import type { Setting } from './types.js';

const PREFIX = 'HANDBOOK';

/** `readWorkers` → `READ_WORKERS` */
function screamingSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
}

/** `readWorkers` → `HANDBOOK_READ_WORKERS` */
export function envName(key: string): string {
  return `${PREFIX}_${screamingSnake(key)}`;
}

/** `generate`, `readWorkers` → `HANDBOOK_GENERATE_READ_WORKERS` */
export function scopedEnvName(command: string, key: string): string {
  return `${PREFIX}_${command.toUpperCase()}_${screamingSnake(key)}`;
}

/**
 * Config-file lookup keys, most specific first. The file is flattened by
 * camelCase join (`generate: { readWorkers: 4 }` → `generateReadWorkers`), which
 * is why command scoping needs no special case here.
 */
export function fileKeyCandidates(command: string, setting: Setting): string[] {
  const scoped = joinKey(command, setting.key);
  return setting.scopedOnly ? [scoped] : [scoped, setting.key];
}

/**
 * The camelCase join every surface uses: `generate` + `readWorkers` →
 * `generateReadWorkers`. An empty prefix leaves the key alone, which is what
 * makes the config file's nesting and its flat form the same lookup.
 */
export function joinKey(prefix: string, key: string): string {
  return prefix ? `${prefix}${key[0]?.toUpperCase() ?? ''}${key.slice(1)}` : key;
}

/** Levenshtein distance. Small inputs only — these are identifiers, not files. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * Nearest key in `known`, or `undefined` when nothing is close enough.
 *
 * A suggestion that is merely the least wrong of a hundred candidates is worse
 * than no suggestion at all — it sends the reader to rewrite a key that was
 * never the one they meant — so the threshold scales with length and is capped
 * at three edits. Case is folded first, so `readworkers` reads as zero edits
 * from `readWorkers` rather than one, and a capitalisation slip ranks ahead of
 * a genuine misspelling.
 */
export function nearestKey(key: string, known: Iterable<string>): string | undefined {
  const needle = key.toLowerCase();
  const limit = Math.min(3, Math.max(1, Math.floor(needle.length / 4)));
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const candidate of known) {
    if (Math.abs(candidate.length - needle.length) >= bestDistance) continue;
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
