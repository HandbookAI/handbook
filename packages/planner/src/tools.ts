/**
 * The planner's read-only tool belt. The planner NEVER writes: it emits a plan.
 * All paths are resolved inside the sandbox root; escapes are rejected.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { listFilesRecursive, toPosix, truncate } from '@handbook/core';

export interface ToolResult {
  ok: boolean;
  content: string;
}

const MAX_READ_CHARS = 60_000;
const MAX_GREP_HITS = 100;
/** grep skips files larger than this — a giant file must not be slurped whole. */
const MAX_GREP_FILE_BYTES = 5_000_000;

/**
 * Reject regexes whose worst-case match time is exponential in the input
 * length: an unbounded quantifier applied to a group that itself contains an
 * unbounded quantifier (`(a+)+`, `(a*)+`, `(.*)*`, `([a-z]+)+`, `(\d+){2,}`, …).
 * Such a pattern turns one long line into a multi-second — then multi-hour —
 * hang, so grep refuses it instead of blocking the whole planner. Character
 * classes and escaped metacharacters are skipped so `[+*]` and `\+` are not
 * misread as quantifiers. Conservative by design: it may reject a rare benign
 * pattern, which is a graceful tool error, never a freeze.
 */
export function hasNestedUnboundedQuantifier(src: string): boolean {
  const isUnboundedQuant = (i: number): boolean => {
    const c = src[i];
    if (c === '+' || c === '*') return true;
    if (c === '{') {
      const close = src.indexOf('}', i);
      if (close === -1) return false;
      return /^\d*,\s*$/.test(src.slice(i + 1, close)); // {n,} / {,} — no upper bound
    }
    return false;
  };
  const groupHasUnbounded: boolean[] = []; // one flag per currently-open group
  let inClass = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') {
      i += 1; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      groupHasUnbounded.push(false);
      continue;
    }
    if (c === ')') {
      const inner = groupHasUnbounded.pop() ?? false;
      const quantified = isUnboundedQuant(i + 1);
      if (inner && quantified) return true; // (…unbounded…)+  → catastrophic
      // A repeated group makes its PARENT contain an unbounded quantifier too.
      if (quantified && groupHasUnbounded.length > 0) groupHasUnbounded[groupHasUnbounded.length - 1] = true;
      continue;
    }
    if (isUnboundedQuant(i) && groupHasUnbounded.length > 0) {
      groupHasUnbounded[groupHasUnbounded.length - 1] = true;
    }
  }
  return false;
}

export class ReadOnlyTools {
  private readonly root: string;
  /** `root` with its own symlinks resolved, so containment compares like with like. */
  private readonly realRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    // Resolve symlinks in the root itself (e.g. macOS /var → /private/var) so the
    // realpath containment check below compares a resolved child against a
    // resolved root. Fall back to the lexical root if it cannot be resolved.
    let real: string;
    try {
      real = realpathSync(this.root);
    } catch {
      real = this.root;
    }
    this.realRoot = real;
  }

  /** Resolve a relative path inside the sandbox; throws on escape attempts. */
  private resolveInside(relPath: string): string {
    const full = resolve(this.root, normalize(relPath));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`path escapes the workspace: ${relPath}`);
    }
    // The lexical check above is defeated by symlinks: a link that lives inside
    // the root can point anywhere. Resolve the real path of whatever exists on
    // disk and require it to stay inside the (real) root — so a link to
    // /etc/passwd, or a symlinked directory, is rejected instead of followed.
    if (existsSync(full)) {
      const real = realpathSync(full);
      if (real !== this.realRoot && !real.startsWith(this.realRoot + sep)) {
        throw new Error(`path escapes the workspace via symlink: ${relPath}`);
      }
    }
    return full;
  }

  listDir(relPath = '.'): ToolResult {
    try {
      const full = this.resolveInside(relPath);
      const entries = readdirSync(full, { withFileTypes: true })
        .filter((e) => e.name !== '.git')
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return { ok: true, content: entries.join('\n') || '(empty directory)' };
    } catch (error) {
      return { ok: false, content: `list_dir failed: ${String(error)}` };
    }
  }

  readFile(relPath: string, startLine?: number, endLine?: number): ToolResult {
    try {
      const full = this.resolveInside(relPath);
      if (statSync(full).size > 5_000_000) return { ok: false, content: 'read_file failed: file too large' };
      const lines = readFileSync(full, 'utf8').split('\n');
      const from = Math.max(1, startLine ?? 1);
      const to = Math.min(lines.length, endLine ?? lines.length);
      const numbered = lines
        .slice(from - 1, to)
        .map((line, i) => `${String(from + i).padStart(5)}|${line}`)
        .join('\n');
      const clipped = truncate(numbered, MAX_READ_CHARS);
      const note = clipped.length < numbered.length ? '\n… (truncated — request a narrower line range)' : '';
      return { ok: true, content: `${relPath} lines ${from}-${to} of ${lines.length}:\n${clipped}${note}` };
    } catch (error) {
      return { ok: false, content: `read_file failed: ${String(error)}` };
    }
  }

  grep(pattern: string, dirOrFile = '.'): ToolResult {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      return { ok: false, content: `grep failed: invalid pattern — ${String(error)}` };
    }
    if (hasNestedUnboundedQuantifier(pattern)) {
      return {
        ok: false,
        content:
          'grep failed: pattern rejected — a nested unbounded quantifier (e.g. `(a+)+`) risks ' +
          'catastrophic backtracking; rewrite it without repetition inside a repeated group',
      };
    }
    try {
      const base = this.resolveInside(dirOrFile);
      const files = statSync(base).isDirectory()
        ? listFilesRecursive(base, { skipDirs: new Set(['.git', 'node_modules', 'target', 'dist', '__pycache__']) }).map(
            (rel) => join(dirOrFile, rel),
          )
        : [dirOrFile];
      const hits: string[] = [];
      outer: for (const file of files) {
        let text: string;
        try {
          const resolved = this.resolveInside(file);
          // Skip a file too large to hold in memory — readFile guards this the
          // same way; grep must not be the hole that slurps a 1 GB blob whole.
          if (statSync(resolved).size > MAX_GREP_FILE_BYTES) continue;
          text = readFileSync(resolved, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\0')) continue; // binary
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          if (regex.test(line)) {
            hits.push(`${toPosix(file)}:${i + 1}: ${truncate(line.trim(), 200)}`);
            if (hits.length >= MAX_GREP_HITS) break outer;
          }
        }
      }
      const suffix = hits.length >= MAX_GREP_HITS ? `\n… (capped at ${MAX_GREP_HITS} hits)` : '';
      return { ok: true, content: hits.length ? `${hits.join('\n')}${suffix}` : '(no matches)' };
    } catch (error) {
      return { ok: false, content: `grep failed: ${String(error)}` };
    }
  }
}
