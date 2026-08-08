/** Minimal leveled logger. Everything goes to stderr so stdout stays clean for data. */

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(prefix: string): Logger;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Every level this logger implements, in ascending verbosity order — the one
 *  place that enumerates `LogLevel`'s members at runtime, so the registry's
 *  `logLevel.choices` can reference it instead of restating its own list
 *  (which is exactly how a `warn`/`silent` HANDBOOK_LOG_LEVEL used to get
 *  rejected by the resolver for a level this logger already handled). */
export const LOG_LEVELS: readonly LogLevel[] = [
  ...(Object.keys(LEVEL_ORDER) as Exclude<LogLevel, 'silent'>[]),
  'silent',
];

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export function createLogger(prefix = '', level: LogLevel = 'info'): Logger {
  const threshold = level === 'silent' ? Number.POSITIVE_INFINITY : LEVEL_ORDER[level];
  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const tag = lvl.toUpperCase().padStart(5);
    process.stderr.write(`[${timestamp()}][${tag}]${prefix ? ` ${prefix}` : ''} ${message}\n`);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    child: (childPrefix) => createLogger(prefix ? `${prefix}${childPrefix}` : childPrefix, level),
  };
}

/** A logger that swallows everything (for tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
