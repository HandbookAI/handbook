/**
 * The job runner in isolation: what it keeps in memory, and what it refuses.
 *
 * Everything the pipeline logs lands in a buffer this process holds for the
 * life of the run, and is replayed to every SSE subscriber. A run whose model
 * returned a megabyte where a sentence was expected must not be able to grow
 * that buffer without limit — studio is one process, and the drawer showing the
 * log is the same process doing the work.
 */
import { describe, expect, it } from 'vitest';
import { JobRunner } from './jobs.js';

/** Resolve once a job reaches a terminal state. */
async function settle(runner: JobRunner, id: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (runner.get(id)?.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never finished');
}

describe('JobRunner log buffer', () => {
  it('truncates a single runaway line instead of storing it whole', async () => {
    const runner = new JobRunner();
    const job = runner.start('repo', 'plan', async (logger) => {
      logger.info(`reply: ${'x'.repeat(500_000)}`);
      return null;
    });
    await settle(runner, job.id);
    const line = job.log.find((l) => l.startsWith('reply:')) as string;
    expect(line.length).toBeLessThan(4_000);
    // Truncation is disclosed, never silent: a reader has to be able to tell a
    // short reply from a long one that was cut.
    expect(line).toMatch(/truncated/);
    expect(line).toMatch(/500\d{3}|4\d{5}/); // the count of characters dropped
  });

  it('keeps the whole buffer bounded across many long lines', async () => {
    const runner = new JobRunner();
    const job = runner.start('repo', 'plan', async (logger) => {
      for (let i = 0; i < 5_000; i += 1) logger.info('y'.repeat(10_000));
      return null;
    });
    await settle(runner, job.id);
    const bytes = job.log.reduce((sum, l) => sum + l.length, 0);
    expect(job.log.length).toBeLessThanOrEqual(2_000);
    expect(bytes).toBeLessThan(10_000_000);
  });

  it('does not truncate an ordinary line', async () => {
    const runner = new JobRunner();
    const job = runner.start('repo', 'render', async (logger) => {
      logger.info('rendering the multi-page HTML site…');
      return null;
    });
    await settle(runner, job.id);
    expect(job.log).toContain('rendering the multi-page HTML site…');
  });
});

describe('JobRunner cancellation bookkeeping', () => {
  it('never records a cancelled run as succeeded, even when the work resolved', async () => {
    // The shape this guards against: work that does not observe the signal
    // plays out to the end and returns normally. The pipeline once let a
    // cancelled doctor round read as "healthy", so a cancelled generate wrote
    // its manifest and came back green — telling the user their cancel worked
    // AND that the run is good, when it did neither.
    const runner = new JobRunner();
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    const job = runner.start('repo', 'generate', async () => {
      await held;
      return { manifest: 'written' }; // deaf to the signal, on purpose
    });
    expect(runner.cancel(job.id)).toBe(true);
    release();
    await settle(runner, job.id);
    expect(job.status).toBe('cancelled');
    // The result is kept — it exists on disk either way — and the log says what
    // happened. It is the STATUS that must not claim a run the user stopped.
    expect(job.result).toEqual({ manifest: 'written' });
    expect(job.log.join('\n')).toMatch(/not a success/);
  });

  it('still records an uncancelled run as succeeded', async () => {
    const runner = new JobRunner();
    const job = runner.start('repo', 'render', async () => ({ pages: 3 }));
    await settle(runner, job.id);
    expect(job.status).toBe('succeeded');
  });
});

describe('JobRunner concurrency', () => {
  it('refuses a second job on the same repo', () => {
    const runner = new JobRunner();
    runner.start('repo', 'plan', () => new Promise(() => {}));
    expect(() => runner.start('repo', 'plan', async () => null)).toThrow(/already has a running job/);
  });

  it('refuses a job beyond the global cap, and frees the slot when one ends', async () => {
    // Per-repo exclusion says nothing about how many repos run together, and a
    // generate holds a call graph, a grammar and a fan-out of LLM calls each.
    const runner = new JobRunner(2);
    runner.start('a', 'generate', () => new Promise(() => {}));
    const b = runner.start('b', 'generate', async () => null);
    expect(() => runner.start('c', 'generate', async () => null)).toThrow(/at once/);
    await settle(runner, b.id);
    expect(() => runner.start('c', 'generate', async () => null)).not.toThrow();
  });

  it('reports the cap as a capacity problem, not a malformed request', () => {
    const runner = new JobRunner(1);
    runner.start('a', 'generate', () => new Promise(() => {}));
    try {
      runner.start('b', 'generate', async () => null);
      expect.unreachable('the cap must refuse');
    } catch (error) {
      expect((error as { status?: number }).status).toBe(429);
    }
  });
});
