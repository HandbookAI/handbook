/**
 * The planner's read-only tool belt. The planner NEVER writes: it emits a plan.
 * All paths are resolved inside the sandbox root; escapes are rejected.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { listFilesRecursive, toPosix, truncate } from '@handbook/core';

export interface ToolResult {
  ok: boolean;
  content: string;
}

const MAX_READ_CHARS = 60_000;
const MAX_GREP_HITS = 100;

export class ReadOnlyTools {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Resolve a relative path inside the sandbox; throws on escape attempts. */
  private resolveInside(relPath: string): string {
    const full = resolve(this.root, normalize(relPath));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`path escapes the workspace: ${relPath}`);
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
          text = readFileSync(this.resolveInside(file), 'utf8');
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
