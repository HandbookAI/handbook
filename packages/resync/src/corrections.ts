/**
 * Corrections — the agent → resync feedback channel.
 *
 * Handbook-consuming agents are quality sensors: when a handbook claim
 * contradicts the real source ("the handbook says X is in file A; it is
 * actually in B"), the agent appends one JSON line to `corrections.jsonl` at
 * the SKILL ROOT (deliberately not under `references/`, which planners mount
 * read-only). Resync later consumes those records to refresh exactly the
 * named files, then archives the batch as `corrections.<stamp>.applied.jsonl`
 * so no record is ever folded in twice.
 */
import { readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { fileExists } from '@handbook/core';

/**
 * One correction record. `file` (the repo-relative source path to refresh) is
 * the only required field; unknown extra keys are tolerated so an over-eager
 * reporter never poisons the batch.
 */
export const correctionSchema = z.object({
  /** Repo-relative source path the claim was about — the file resync refreshes. */
  file: z.string().min(1),
  /** The `references/…` page that carried the wrong claim. */
  page: z.string().optional(),
  /** What the handbook said. */
  claim: z.string().optional(),
  /** What the real source shows. */
  actual: z.string().optional(),
  /** ISO timestamp of the observation. */
  notedAt: z.string().optional(),
});

export type Correction = z.infer<typeof correctionSchema>;

export interface LoadCorrectionsResult {
  corrections: Correction[];
  problems: string[];
}

/**
 * Tolerant JSONL load: a missing file is an empty batch, malformed lines land
 * in `problems` with their 1-based line number, and no file CONTENT can ever
 * make this throw — agents append concurrently and unsupervised, so one
 * garbled line must never block the valid records around it.
 */
export function loadCorrections(path: string): LoadCorrectionsResult {
  if (!fileExists(path)) return { corrections: [], problems: [] };
  const corrections: Correction[] = [];
  const problems: string[] = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      problems.push(`line ${index + 1} is not valid JSON`);
      continue;
    }
    const parsed = correctionSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'entry'}: ${i.message}`)
        .join('; ');
      problems.push(`line ${index + 1} is not a valid correction (${detail})`);
      continue;
    }
    corrections.push(parsed.data);
  }
  return { corrections, problems };
}

/** Unique `file` values across a batch, sorted — the resync refresh targets. */
export function correctionFiles(corrections: readonly Correction[]): string[] {
  return [...new Set(corrections.map((c) => c.file))].sort();
}

/**
 * Rename a consumed `corrections.jsonl` to `corrections.<stamp>.applied.jsonl`
 * next to it, so late-arriving corrections start a fresh file and an applied
 * batch is never folded in twice. Returns the archive path, or undefined when
 * there is nothing to archive. The stamp is caller-provided (typically an ISO
 * timestamp with `[:.]` replaced by `-`, like patcher backup dirs) so callers
 * stay testable; an existing archive with the same stamp is never clobbered.
 */
export function archiveCorrections(path: string, stamp: string): string | undefined {
  if (!fileExists(path)) return undefined;
  const dir = dirname(path);
  const base = basename(path);
  const stem = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
  for (let attempt = 0; ; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const candidate = join(dir, `${stem}.${stamp}${suffix}.applied.jsonl`);
    if (fileExists(candidate)) {
      if (attempt > 500) throw new Error(`cannot archive ${path}: over 500 archives share stamp ${stamp}`);
      continue;
    }
    renameSync(path, candidate);
    return candidate;
  }
}
