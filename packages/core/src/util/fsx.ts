/** Filesystem helpers: atomic writes, validated JSON I/O, recursive discovery. */
import {
  mkdirSync,
  renameSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, posix, relative, sep, win32 } from 'node:path';
import type { z } from 'zod';
import { ArtifactValidationError } from '../errors.js';

/** Convert a path to POSIX separators (all artifact paths are POSIX). */
export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * True when `path` is absolute under **either** platform's rules.
 *
 * Untrusted paths — an EDIT block's filename, a manifest entry, a path scraped
 * out of a diff — are validated on whatever machine happens to be running, but
 * they can have been written anywhere. `isAbsolute` alone answers only for the
 * host: on Linux it calls `C:/evil` relative, which then resolves outside the
 * source root on a Windows machine. Asking both algorithms makes the answer the
 * same everywhere, which is the only useful answer for a security check.
 */
export function isAbsoluteAnyPlatform(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path);
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

/**
 * Read a text file, refusing one that is implausibly large for its purpose.
 *
 * `readFileSync` has no ceiling below Node's ~2 GB string limit, so a file
 * between "big" and "impossible" is read in full and the process dies of memory
 * exhaustion — reported as an out-of-memory crash rather than as the input
 * problem it is. `what` names the thing in the error, because "a file was too
 * big" is not actionable and "the diff at path X is 900 MiB" is.
 */
export function readTextFileBounded(path: string, maxBytes: number, what: string): string {
  const bytes = statSync(path).size;
  if (bytes > maxBytes) {
    const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
    throw new Error(
      `${what} at ${path} is ${mib(bytes)}, above the ${mib(maxBytes)} limit — refusing to read it`,
    );
  }
  return readFileSync(path, 'utf8');
}

/**
 * How deep the walk will go before it refuses.
 *
 * Symlinks are never followed, so a link loop cannot produce infinite depth —
 * but a real tree can still be deeper than the JS stack, and the recursion
 * below would then die of `RangeError` and take the whole run with it. Real
 * source trees are single digits deep; anything past this is a generated or
 * pathological layout, and skipping it with a report is better than crashing.
 */
const MAX_WALK_DEPTH = 64;

export interface DiscoverOptions {
  /** Directory names to skip anywhere in the tree. */
  skipDirs?: ReadonlySet<string>;
  /** Keep only files with one of these extensions (with dot, e.g. `.ts`). */
  extensions?: readonly string[];
  /** Additional per-file filter on the relative POSIX path. */
  filter?: (relPath: string) => boolean;
  /**
   * Called for a directory the walk could not enter or refused to descend into.
   *
   * Discovery silently swallowing an unreadable directory is the same defect as
   * silently swallowing an unreadable file: every path beneath it disappears
   * from the analysis, and nothing downstream can tell "no files there" from "we
   * were not allowed to look". `path` is relative POSIX, like the results.
   */
  onSkip?: (path: string, reason: string) => void;
  /** Override the depth ceiling. Present for tests; the default is right. */
  maxDepth?: number;
}

/**
 * Recursively list files under `root`, returning **relative POSIX paths**
 * sorted lexicographically. Symlinks are not followed.
 */
export function listFilesRecursive(root: string, options: DiscoverOptions = {}): string[] {
  const skipDirs = options.skipDirs ?? new Set<string>();
  const maxDepth = options.maxDepth ?? MAX_WALK_DEPTH;
  const results: string[] = [];
  const rel = (full: string): string => toPosix(relative(root, full)) || '.';
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      options.onSkip?.(rel(dir), `deeper than ${maxDepth} directories — not descended`);
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      options.onSkip?.(rel(dir), (error as Error).message);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (options.extensions && !options.extensions.some((ext) => entry.name.endsWith(ext))) continue;
        const relPath = rel(full);
        if (options.filter && !options.filter(relPath)) continue;
        results.push(relPath);
      }
    }
  };
  walk(root, 0);
  return results.sort();
}
