/**
 * Studio state: the repository registry, persisted as one JSON file so the
 * server is stateless across restarts. Everything else (handbook artifacts,
 * evolution history) lives in each repo's work dir.
 */
import { dirname, join, resolve, sep } from 'node:path';
import { readlinkSync, realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { fileExists, readValidatedJson, writeJsonFile } from '@handbooks/core';

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

/**
 * How many links `realOf` follows by hand before giving up.
 *
 * `realpath` reports ELOOP for a cycle; the manual walk below has to count for
 * itself, or `link -> link` spins until the stack ends.
 */
const MAX_LINK_HOPS = 32;

/** The target of `path` if it is a symlink, else undefined (EINVAL, ENOENT). */
function readlinkOrUndefined(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The real path of `path`, resolved as far as the filesystem allows.
 *
 * `realpathSync` throws for anything that does not exist yet, which is the
 * normal case for a work dir: studio creates it AFTER the entry is accepted.
 * Resolving the nearest existing ancestor and re-attaching the rest is what
 * makes the containment checks below symlink-aware for a directory that is
 * still hypothetical — without it, `/w/link/handbook` (where `link` points at
 * another repo's work dir) compares as a string nobody has seen before.
 */
function realOf(path: string, hops = 0): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : join(realpathSync(head), ...tail);
    } catch {
      // A link `realpath` cannot resolve still NAMES the directory the run
      // would write to, and reading it is the only way to see that. Two real
      // cases reach here: a work dir link whose target does not exist yet
      // (`link -> src/generated`, created by the first run — the interesting
      // one, because that first run is what puts artifacts inside the source
      // tree), and on Windows a file-typed symlink pointing at a directory,
      // which that platform will not resolve at all. Both fell through to the
      // lexical fallback below, which turns every containment check in this
      // file back into the string comparison it exists to replace.
      const link = hops < MAX_LINK_HOPS ? readlinkOrUndefined(head) : undefined;
      if (link !== undefined) return join(realOf(resolve(dirname(head), link), hops + 1), ...tail);
      const parent = dirname(head);
      if (parent === head) return resolve(path); // reached the root: nothing resolves
      tail.unshift(head.slice(parent.length + 1));
      head = parent;
    }
  }
}

/**
 * Whether `child` is `parent` or sits under it.
 *
 * The separator matters: without it `/w/handbook-2` reads as living inside
 * `/w/handbook`, and a second repo whose work dir merely shares a name prefix
 * gets refused.
 */
function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export class StateStore {
  private readonly path: string;
  private state: StudioState;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'studio.json');
    this.state = fileExists(this.path) ? this.load() : { version: 1, repos: [] };
  }

  /**
   * Read the registry, or refuse to start with a message a person can act on.
   *
   * Starting fresh on a file that will not parse is the wrong recovery: the
   * registry is the only record of which trees studio knows about and where
   * their handbooks live, and silently replacing it with an empty one loses
   * that while looking like success. Refusing names the file — a bare
   * "Unterminated string in JSON at position 28" does not.
   */
  private load(): StudioState {
    try {
      return readValidatedJson(this.path, stateSchema);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(
        `studio state file is unreadable: ${this.path} — ${why}. ` +
          'Fix it, or remove the file to start with an empty repository list ' +
          '(work dirs are untouched; each repo can be added back).',
      );
    }
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
    // Every containment test below compares REAL paths. A lexical comparison
    // asks whether two strings look alike; what actually decides whether two
    // runs collide is whether they reach the same directory, and a symlink is
    // how one directory gets two names. The job mutex is keyed on repo NAME, so
    // a pair that slips past here has nothing else standing between it and two
    // writers in one set of phase dirs.
    const myWork = realOf(parsed.workDir);
    const mySource = realOf(parsed.sourceRoot);
    if (inside(myWork, mySource)) {
      throw new Error('workDir must live outside sourceRoot (generated artifacts would be re-analyzed)');
    }
    for (const other of this.state.repos) {
      const theirWork = realOf(other.workDir);
      if (inside(myWork, theirWork) || inside(theirWork, myWork)) {
        throw new Error(
          `workDir overlaps repo "${other.name}" (${other.workDir}) — artifacts would clobber each other`,
        );
      }
      // Two entries sharing a source tree would let concurrent jobs patch the
      // same files (the job mutex is keyed on repo name).
      const theirSource = realOf(other.sourceRoot);
      if (inside(mySource, theirSource) || inside(theirSource, mySource)) {
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

  /**
   * `writeJsonFile` writes a sibling temp file and renames it over the target,
   * which is the property this file depends on: a studio killed mid-write must
   * leave the previous registry intact, not a truncated one that stops the next
   * launch. Do not swap this for a plain write.
   */
  private save(): void {
    writeJsonFile(this.path, this.state);
  }
}
