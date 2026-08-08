/**
 * Studio state: the repository registry, persisted as one JSON file so the
 * server is stateless across restarts. Everything else (handbook artifacts,
 * evolution history) lives in each repo's work dir.
 */
import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { fileExists, readValidatedJson, writeJsonFile } from '@handbook/core';

/**
 * URL-safe repo name: alphanumeric start, then letters/digits/`. _ -`. Shared
 * with the server so it can reject a bad name with a friendly message BEFORE
 * zod's `.parse()` throws (a ZodError whose `.message` is a raw JSON array).
 */
export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const repoEntrySchema = z.object({
  /** URL-safe unique name. */
  name: z.string().regex(REPO_NAME_RE),
  /** Absolute path of the source tree. */
  sourceRoot: z.string(),
  /** Absolute path of the work dir holding handbook artifacts. */
  workDir: z.string(),
  addedAt: z.string(),
  /** Handbook title chosen at generate time; resync re-renders under it. */
  title: z.string().optional(),
  /**
   * Last-used job parameters, by job kind — what lets the UI pre-fill a dialog
   * with the values that actually produced this repo's handbook instead of the
   * registry defaults. Never contains a secret: the server strips `llmApiKey`
   * (and rejects it outright) before anything reaches this file, because
   * studio.json is exactly the kind of file that ends up in a backup.
   */
  lastParams: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
export type RepoEntry = z.infer<typeof repoEntrySchema>;

const stateSchema = z.object({
  version: z.literal(1),
  repos: z.array(repoEntrySchema),
});
export type StudioState = z.infer<typeof stateSchema>;

/** realpath when possible so two spellings of one tree compare equal. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export class StateStore {
  private readonly path: string;
  private state: StudioState;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'studio.json');
    this.state = fileExists(this.path)
      ? readValidatedJson(this.path, stateSchema)
      : { version: 1, repos: [] };
  }

  list(): RepoEntry[] {
    return [...this.state.repos];
  }

  get(name: string): RepoEntry | undefined {
    return this.state.repos.find((r) => r.name === name);
  }

  add(entry: Omit<RepoEntry, 'addedAt'>): RepoEntry {
    const parsed = repoEntrySchema.omit({ addedAt: true }).parse(entry);
    if (this.get(parsed.name)) throw new Error(`repo "${parsed.name}" already exists`);
    if (!fileExists(parsed.sourceRoot) || !statSync(parsed.sourceRoot).isDirectory()) {
      throw new Error(`sourceRoot is not a directory: ${parsed.sourceRoot}`);
    }
    const inside = (child: string, parent: string): boolean =>
      child === parent || child.startsWith(`${parent}/`);
    if (inside(parsed.workDir, parsed.sourceRoot)) {
      throw new Error('workDir must live outside sourceRoot (generated artifacts would be re-analyzed)');
    }
    for (const other of this.state.repos) {
      if (inside(parsed.workDir, other.workDir) || inside(other.workDir, parsed.workDir)) {
        throw new Error(
          `workDir overlaps repo "${other.name}" (${other.workDir}) — artifacts would clobber each other`,
        );
      }
      // Two entries sharing a source tree would let concurrent jobs patch the
      // same files (the job mutex is keyed on repo name).
      const mine = realOf(parsed.sourceRoot);
      const theirs = realOf(other.sourceRoot);
      if (inside(mine, theirs) || inside(theirs, mine)) {
        throw new Error(
          `sourceRoot overlaps repo "${other.name}" (${other.sourceRoot}) — one tree, one repo`,
        );
      }
    }
    const full: RepoEntry = { ...parsed, addedAt: new Date().toISOString() };
    this.state.repos.push(full);
    this.save();
    return full;
  }

  setTitle(name: string, title: string): void {
    const repo = this.state.repos.find((r) => r.name === name);
    if (repo) {
      repo.title = title;
      this.save();
    }
  }

  /** Remember the parameters a job kind was last run with (secrets already stripped). */
  setLastParams(name: string, kind: string, params: Record<string, unknown>): void {
    const repo = this.state.repos.find((r) => r.name === name);
    if (repo) {
      repo.lastParams = { ...repo.lastParams, [kind]: params };
      this.save();
    }
  }

  remove(name: string): boolean {
    const before = this.state.repos.length;
    this.state.repos = this.state.repos.filter((r) => r.name !== name);
    const removed = this.state.repos.length < before;
    if (removed) this.save();
    return removed;
  }

  private save(): void {
    writeJsonFile(this.path, this.state);
  }
}
