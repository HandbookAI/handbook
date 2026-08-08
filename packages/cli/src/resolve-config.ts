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

/** The file layer, for the `config` action — which inspects another command's
 *  settings and so cannot go through `resolveOrThrow`'s throw-on-error path. */
export function currentConfigFile(): ConfigFileData | undefined {
  return configFile;
}

/**
 * `--env`/`HANDBOOK_ENV` and the cascade it selected — bootstrap state, same
 * shape of problem as `configFile` above: computed once in the preAction
 * hook (before any action runs), and the `config` action is the one place
 * that needs to read it back, to make the cascade auditable instead of
 * guessed at (see config-command.ts).
 */
export interface EnvironmentInfo {
  readonly name?: string;
  /** Where `name` came from — absent when neither was set. */
  readonly source?: 'flag' | 'env';
  /** Env files actually loaded, highest precedence first. */
  readonly envFiles: readonly string[];
}

let environment: EnvironmentInfo = { envFiles: [] };

/** Set once by the preAction hook, before any action runs. */
export function setEnvironment(info: EnvironmentInfo): void {
  environment = info;
}

export function currentEnvironment(): EnvironmentInfo {
  return environment;
}

export function resolveOrThrow(command: string, flags: Record<string, unknown>): Record<string, unknown> {
  const result = resolveConfig({ command, flags, env: process.env, file: configFile });
  if (result.errors.length > 0) {
    throw new Error(`invalid configuration:\n  - ${result.errors.join('\n  - ')}`);
  }
  return result.values;
}
