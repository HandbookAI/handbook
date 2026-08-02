/** Minimal promise-concurrency primitives (no external dependencies). */

export type LimitFn = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Create a concurrency limiter: at most `concurrency` tasks run at once,
 * excess tasks queue in FIFO order.
 */
export function pLimit(concurrency: number): LimitFn {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  // A finishing task hands its slot DIRECTLY to the next waiter (active is not
  // decremented in between) — otherwise a task arriving in the gap could slip
  // in alongside the woken waiter and exceed the cap.
  const release = (): void => {
    const waiter = queue.shift();
    if (waiter) waiter();
    else active -= 1;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve)); // slot inherited
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Map `items` through an async `fn` with bounded concurrency, preserving input
 * order in the result. Rejections propagate after all in-flight tasks settle.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(concurrency);
  const settled = await Promise.allSettled(items.map((item, i) => limit(() => fn(item, i))));
  const firstRejection = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (firstRejection) throw firstRejection.reason;
  return (settled as PromiseFulfilledResult<R>[]).map((s) => s.value);
}
