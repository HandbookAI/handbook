import { describe, expect, it } from 'vitest';
import { mapLimit, pLimit } from './concurrency.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('pLimit', () => {
  it('never exceeds the concurrency cap', async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(10);
      active -= 1;
    };
    await Promise.all(Array.from({ length: 8 }, () => limit(task)));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('rejects invalid concurrency', () => {
    expect(() => pLimit(0)).toThrow(RangeError);
  });
});

describe('mapLimit', () => {
  it('preserves input order', async () => {
    const result = await mapLimit([3, 1, 2], 2, async (n) => {
      await sleep(n * 5);
      return n * 10;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it('propagates the first rejection after all tasks settle', async () => {
    let completed = 0;
    await expect(
      mapLimit([1, 2, 3], 3, async (n) => {
        await sleep(5);
        if (n === 2) throw new Error('boom');
        completed += 1;
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(completed).toBe(2);
  });
});
