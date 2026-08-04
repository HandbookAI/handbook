/**
 * CLI argument coercion helpers, kept in their own module so they can be
 * unit-tested without importing `main.ts` (which runs `parseAsync` on import).
 */

/** Parse a numeric CLI flag; garbage values fail loudly instead of NaN-ing a loop away. */
export function toInt(value: unknown, flag: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${flag} must be a number >= ${min}, got "${String(value)}"`);
  }
  return Math.trunc(parsed);
}

/**
 * Validate a closed-set (enum) CLI flag. A flag that was never supplied
 * (`undefined`) passes through as `undefined` so callers can apply their own
 * default or "use the recorded value" semantics. A flag that WAS supplied but
 * is not in `allowed` throws a loud, actionable error rather than being
 * silently coerced to a default — e.g. `--narrate-lang cn` (a typo for `zh`)
 * must not silently produce English prose.
 */
export function parseEnum<T extends string>(
  value: unknown,
  flag: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${flag} must be one of ${allowed.join(' | ')}, got "${String(value)}"`);
}
