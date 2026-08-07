/** Filesystem helpers: atomic writes, validated JSON I/O, recursive discovery. */
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { z } from 'zod';
import { ArtifactValidationError } from '../errors.js';

/** Convert a path to POSIX separators (all artifact paths are POSIX). */
export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** Create a directory (and parents) if it does not exist. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Write a file atomically: write to a sibling temp file, then rename over the
 * target. Prevents readers from ever observing a half-written artifact.
 */
export function writeFileAtomic(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/** Pretty-print and atomically write JSON. */
export function writeJsonFile(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read and parse a JSON file (throws on missing file / bad JSON). */
export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Read a JSON file and validate it against a zod schema. */
export function readValidatedJson<T>(path: string, schema: z.ZodType<T>): T {
  const raw = readJsonFile(path);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ArtifactValidationError(
      path,
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return result.data;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export interface DiscoverOptions {
  /** Directory names to skip anywhere in the tree. */
  skipDirs?: ReadonlySet<string>;
  /** Keep only files with one of these extensions (with dot, e.g. `.ts`). */
  extensions?: readonly string[];
  /** Additional per-file filter on the relative POSIX path. */
  filter?: (relPath: string) => boolean;
}

/**
 * Recursively list files under `root`, returning **relative POSIX paths**
 * sorted lexicographically. Symlinks are not followed.
 */
export function listFilesRecursive(root: string, options: DiscoverOptions = {}): string[] {
  const skipDirs = options.skipDirs ?? new Set<string>();
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        if (options.extensions && !options.extensions.some((ext) => entry.name.endsWith(ext))) continue;
        const rel = toPosix(relative(root, full));
        if (options.filter && !options.filter(rel)) continue;
        results.push(rel);
      }
    }
  };
  walk(root);
  return results.sort();
}
