/**
 * Cross-process directory lock, re-entrant within one process. Guards a work
 * dir's read-modify-write window: two `generate`/`resync` runs on one work
 * dir would otherwise interleave and corrupt each other's artifacts.
 *
 * Liveness rules match the patcher's tree lock: an unreadable or foreign-host
 * owner counts as ALIVE (fail closed — a pid table is per-machine); only a
 * provably dead local pid is reclaimed.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { Logger } from '../logger.js';

const HELD = new Set<string>();

interface LockOwner {
  pid?: number;
  host?: string;
  startedAt?: string;
}

export async function withDirLock<T>(
  dir: string,
  label: string,
  logger: Logger,
  work: () => Promise<T>,
): Promise<T> {
  const key = resolve(dir);
  if (HELD.has(key)) return work(); // re-entrant: an outer caller already owns it
  mkdirSync(key, { recursive: true });
  const lockPath = join(key, '.lock');

  const claim = (): boolean => {
    try {
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })}\n`,
        { flag: 'wx' }, // exclusive create: atomic claim + owner record
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`cannot take the ${label} lock at ${lockPath}: ${(error as Error).message}`);
      }
      return false;
    }
  };

  const readOwner = (): LockOwner | undefined => {
    try {
      const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
      return {
        pid: typeof raw.pid === 'number' ? raw.pid : undefined,
        host: typeof raw.host === 'string' ? raw.host : undefined,
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
      };
    } catch {
      return undefined; // unreadable or half-written
    }
  };

  const ownerAlive = (owner: LockOwner | undefined): boolean => {
    if (!owner || owner.pid === undefined) return true; // fail closed
    if (owner.host !== undefined && owner.host !== hostname()) return true; // cannot probe foreign pids
    if (owner.pid === process.pid) return true;
    try {
      process.kill(owner.pid, 0); // signal 0 = liveness probe
      return true;
    } catch (error) {
      // EPERM means the process EXISTS but belongs to another user.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };

  if (!claim()) {
    const owner = readOwner();
    if (ownerAlive(owner)) {
      const who =
        owner?.pid !== undefined
          ? ` (pid ${owner.pid}${owner.host ? ` on ${owner.host}` : ''}${owner.startedAt ? `, started ${owner.startedAt}` : ''})`
          : '';
      throw new Error(
        `another ${label} run is using ${key}${who} — retry when it finishes, or delete ${lockPath} if that process is gone`,
      );
    }
    logger.warn(`[lock] reclaiming a stale ${label} lock (its owner is gone)`);
    rmSync(lockPath, { force: true });
    if (!claim()) throw new Error(`another ${label} run took the lock while it was being reclaimed`);
  }

  HELD.add(key);
  try {
    return await work();
  } finally {
    HELD.delete(key);
    rmSync(lockPath, { force: true });
  }
}
