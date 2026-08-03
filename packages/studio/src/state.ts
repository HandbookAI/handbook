/**
 * Studio state: the repository registry, persisted as one JSON file so the
 * server is stateless across restarts. Everything else (handbook artifacts,
 * evolution history) lives in each repo's work dir.
 */
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { z } from 'zod';
import { fileExists, readValidatedJson, writeJsonFile } from '@handbook/core';

export const repoEntrySchema = z.object({
  /** URL-safe unique name. */
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  /** Absolute path of the source tree. */
  sourceRoot: z.string(),
  /** Absolute path of the work dir holding handbook artifacts. */
  workDir: z.string(),
  addedAt: z.string(),
});
export type RepoEntry = z.infer<typeof repoEntrySchema>;

const stateSchema = z.object({
  version: z.literal(1),
  repos: z.array(repoEntrySchema),
});
export type StudioState = z.infer<typeof stateSchema>;

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
    const full: RepoEntry = { ...parsed, addedAt: new Date().toISOString() };
    this.state.repos.push(full);
    this.save();
    return full;
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
