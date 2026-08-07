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
  const scoped = `${command}${setting.key[0]?.toUpperCase() ?? ''}${setting.key.slice(1)}`;
  return setting.scopedOnly ? [scoped] : [scoped, setting.key];
}
