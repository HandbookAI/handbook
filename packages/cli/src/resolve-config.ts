/**
 * Resolve one subcommand's configuration at action time.
 *
 * Called from inside each action handler — never at module load — so that the
 * env file loaded by the preAction hook is already in `process.env` and the
 * config file discovered alongside it is in scope.
 */
import { resolveConfig, type ConfigFileData } from '@handbook/core';

let configFile: ConfigFileData | undefined;

/** Set once by the preAction hook, before any action runs. */
export function setConfigFile(file: ConfigFileData | undefined): void {
  configFile = file;
}

export function resolveOrThrow(command: string, flags: Record<string, unknown>): Record<string, unknown> {
  const result = resolveConfig({ command, flags, env: process.env, file: configFile });
  if (result.errors.length > 0) {
    throw new Error(`invalid configuration:\n  - ${result.errors.join('\n  - ')}`);
  }
  return result.values;
}
