import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { withDirLock } from './lock.js';

const dir = () => mkdtempSync(join(tmpdir(), 'hb-lock-'));

describe('withDirLock', () => {
  it('runs the work and releases the lock afterwards', async () => {
    const d = dir();
    const result = await withDirLock(d, 'handbook', silentLogger, async () => 42);
    expect(result).toBe(42);
    expect(existsSync(join(d, '.lock'))).toBe(false);
  });

  it('is re-entrant within one process', async () => {
    const d = dir();
    const result = await withDirLock(d, 'handbook', silentLogger, () =>
      withDirLock(d, 'handbook', silentLogger, async () => 'nested'),
    );
    expect(result).toBe('nested');
  });

  it('refuses while a live process holds the lock, naming owner and remedy', async () => {
    const d = dir();
    writeFileSync(
      join(d, '.lock'),
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: '2026-08-04T00:00:00Z' }),
    );
    await expect(withDirLock(d, 'handbook', silentLogger, async () => 1)).rejects.toThrow(
      /another handbook run[\s\S]*2026-08-04T00:00:00Z[\s\S]*\.lock/,
    );
  });

  it('treats a foreign-host owner as alive even when its pid is dead locally', async () => {
    const d = dir();
    writeFileSync(
      join(d, '.lock'),
      JSON.stringify({ pid: 2147483646, host: 'some-other-machine', startedAt: 'x' }),
    );
    await expect(withDirLock(d, 'handbook', silentLogger, async () => 1)).rejects.toThrow(
      /another handbook run/,
    );
  });

  it('treats an unreadable owner record as alive (fails closed)', async () => {
    const d = dir();
    writeFileSync(join(d, '.lock'), 'NOT JSON');
    await expect(withDirLock(d, 'handbook', silentLogger, async () => 1)).rejects.toThrow(
      /another handbook run/,
    );
  });

  it('reclaims a lock whose local owner is provably dead', async () => {
    const d = dir();
    writeFileSync(join(d, '.lock'), JSON.stringify({ pid: 2147483646, host: hostname(), startedAt: 'x' }));
    const result = await withDirLock(d, 'handbook', silentLogger, async () => 'reclaimed');
    expect(result).toBe('reclaimed');
    expect(existsSync(join(d, '.lock'))).toBe(false);
  });

  it('releases the lock when the work throws', async () => {
    const d = dir();
    await expect(
      withDirLock(d, 'handbook', silentLogger, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(join(d, '.lock'))).toBe(false);
  });
});
