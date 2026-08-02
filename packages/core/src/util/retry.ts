import { PermanentError } from '../errors.js';

export interface RetryOptions {
  /** Total attempts including the first one. Default 6. */
  attempts?: number;
  /** Linear backoff base in ms: sleep `backoffMs * attempt` between tries. Default 3000. */
  backoffMs?: number;
  /** Uniform random extra sleep in ms added to each backoff. Default 500. */
  jitterMs?: number;
  /** Called before each re-attempt with the error that caused it. */
  onRetry?: (error: unknown, attempt: number) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with linear backoff + jitter. A {@link PermanentError} aborts
 * immediately; any other error is retried until attempts are exhausted, then
 * the last error is rethrown.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const safe = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) ? (value as number) : fallback;
  // Always run at least once — attempts<=0/NaN would otherwise `throw undefined`.
  const attempts = Math.max(1, Math.trunc(safe(options.attempts, 6)));
  const backoffMs = Math.max(0, safe(options.backoffMs, 3000));
  const jitterMs = Math.max(0, safe(options.jitterMs, 500));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (error instanceof PermanentError) throw error;
      lastError = error;
      if (attempt < attempts) {
        options.onRetry?.(error, attempt);
        await sleep(backoffMs * attempt + Math.random() * jitterMs);
      }
    }
  }
  throw lastError;
}
