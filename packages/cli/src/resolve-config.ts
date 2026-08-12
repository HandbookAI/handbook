/**
 * Resolve one subcommand's configuration at action time.
 *
 * Called from inside each action handler — never at module load — so that the
 * env file loaded by the preAction hook is already in `process.env` and the
 * config file discovered alongside it is in scope.
 */
import { resolveConfig, settingByKey, type ConfigFileData, type Logger, type Source } from '@handbook/core';

let configFile: ConfigFileData | undefined;
let configFileFailure: ConfigFileFailure | undefined;

/** A config file that exists but could not be turned into settings at all. */
export interface ConfigFileFailure {
  readonly path: string;
  readonly message: string;
}

/** Set once by the preAction hook, before any action runs. Passing a `failure`
 *  (and no file) records a file that could not be loaded, which is bootstrap
 *  state: it belongs to no single setting, so `resolveConfig` has nowhere to
 *  report it and `resolveOrThrow` below has to. */
export function setConfigFile(file: ConfigFileData | undefined, failure?: ConfigFileFailure): void {
  configFile = file;
  configFileFailure = failure;
}

/** The file layer, for the `config` action — which inspects another command's
 *  settings and so cannot go through `resolveOrThrow`'s throw-on-error path. */
export function currentConfigFile(): ConfigFileData | undefined {
  return configFile;
}

export function currentConfigFileFailure(): ConfigFileFailure | undefined {
  return configFileFailure;
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

export interface ResolveOptions {
  /**
   * Report a config file that could not be loaded instead of refusing to run.
   * Only `handbook config` may set it: showing broken configuration is that
   * command's entire job, and it is the command a user reaches for BECAUSE the
   * file is broken. Everywhere else, a file that could not be read must not
   * degrade into a silent fall-back to defaults.
   */
  readonly tolerateBrokenConfigFile?: boolean;
  /**
   * Builds the logger from the values just resolved, so the summary below is
   * emitted at the level the run is ACTUALLY using.
   *
   * A caller cannot pass a ready-made logger: `logLevel` has no flag — it comes
   * from the environment or the config file — so its value is not known until
   * this function has resolved it. Passing a logger built from raw flags made
   * `HANDBOOK_LOG_LEVEL=debug` silently never reach this line, while `-v`
   * happened to work; that is the kind of half-working that is worse than
   * nothing. Optional because `handbook config` renders the same information as
   * its entire output and would print it twice.
   */
  readonly makeLogger?: (values: Record<string, unknown>) => Logger;
  /**
   * The level `-v`/`-q` forced, if either was given.
   *
   * Those are top-level flags, so they are known before resolution — unlike
   * `logLevel` itself. Passed in rather than read off the logger because
   * `Logger` deliberately does not expose its level, and widening that interface
   * would break every hand-written fake logger in the test suite for one
   * cosmetic field.
   */
  readonly shorthandLevel?: string;
}

export function resolveOrThrow(
  command: string,
  flags: Record<string, unknown>,
  options: ResolveOptions = {},
): Record<string, unknown> {
  const result = resolveConfig({ command, flags, env: process.env, file: configFile });
  const errors =
    configFileFailure && !options.tolerateBrokenConfigFile
      ? [configFileFailure.message, ...result.errors]
      : result.errors;
  if (errors.length > 0) {
    throw new Error(`invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  if (options.makeLogger) {
    logResolved(
      command,
      result.values,
      result.sources,
      options.makeLogger(result.values),
      options.shorthandLevel,
    );
  }
  return result.values;
}

/**
 * The effective configuration and where each value came from, at debug level.
 *
 * This is the first question anyone debugging a run has — "is it even using the
 * setting I think it is?" — and `handbook config` answers it only for a separate
 * invocation, which resolves in a different cwd, a different env, or after the
 * file was edited. Logging it on the run itself removes the "it works when I
 * check it" gap.
 *
 * A `secret` setting is printed as `***` and a non-secret one verbatim. The
 * masking is driven by the registry rather than a key-name list, so a setting
 * marked secret later is masked here without anyone remembering to come back.
 */
function logResolved(
  command: string,
  values: Record<string, unknown>,
  sources: Record<string, Source>,
  logger: Logger,
  shorthandLevel?: string,
): void {
  // `-v`/`-q` are shorthand that override `logLevel` AFTER resolution, so the
  // resolved value would print `info` on a run that is demonstrably logging at
  // debug — the one line in this summary a reader would immediately disbelieve,
  // which costs the whole line its credibility. Report what the logger is
  // actually doing.
  const effective = shorthandLevel ? { ...values, logLevel: shorthandLevel } : values;
  const shown = Object.keys(effective)
    .sort()
    .map((key) => {
      const value = effective[key];
      if (value === undefined) return undefined;
      const masked = settingByKey(key)?.secret === true;
      const text = masked ? '***' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      const from = key === 'logLevel' && shorthandLevel ? '-v/-q' : sourceLabel(sources[key]);
      return `${key}=${text}(${from})`;
    })
    .filter(Boolean);
  logger.debug(`[config] ${command}: ${shown.join(' ')}`);
}

/** One short token per source, so a whole run's configuration fits on a line. */
function sourceLabel(source: Source | undefined): string {
  if (!source) return '?';
  switch (source.kind) {
    // `flagName()` already returns the dashed spelling — prefixing produced
    // `----source`.
    case 'flag':
      return source.name;
    case 'env':
      return source.name;
    // The path matters: two config files in a monorepo is the situation this
    // line exists to disambiguate.
    case 'file':
      return `${source.path}:${source.keyPath}`;
    default:
      return 'default';
  }
}
