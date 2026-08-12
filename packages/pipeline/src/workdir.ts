/**
 * Work-directory layout and typed artifact I/O.
 *
 * Every phase reads only its upstream artifacts from here and writes its own,
 * so any phase can be re-run independently and a crashed run resumes where it
 * stopped. All reads are schema-validated: a corrupted artifact fails loudly.
 *
 * ```
 * <work>/
 *   phase1/graph.json | functions.csv | graph.dot | dropped-calls.json
 *   phase1/scan-coverage.json         files that could not be read or parsed
 *   phase2/cards/<rel>.json           one card per source file
 *   phase2/cards/_coverage.json
 *   phase2/skeleton.yaml              stage skeleton (canonical form)
 *   phase2/assignment.json            file → stage
 *   phase2/organization.yaml          intra-stage groups + reading order
 *   phase3/narration.json             stage + system prose
 *   phase3/registers.json             cross-stage state registers
 *   phase3/cache/                     content-hash caches (rollup/registers)
 * ```
 */
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  ArtifactValidationError,
  MissingArtifactError,
  assignmentSchema,
  cardCoverageSchema,
  codeGraphSchema,
  ensureDir,
  fileCardSchema,
  fileExists,
  listFilesRecursive,
  narrationSchema,
  organizationSchema,
  readJsonFile,
  readValidatedJson,
  registersSchema,
  skeletonSchema,
  writeFileAtomic,
  writeJsonFile,
  type Assignment,
  type CardCoverage,
  type CodeGraph,
  type FileCard,
  type Narration,
  type Organization,
  type Registers,
  type Skeleton,
  sha256Hex,
} from '@handbooks/core';
import { readFileSync, rmSync } from 'node:fs';
import type { ZodType } from 'zod';

/**
 * Read + schema-validate a JSON artifact, upgrading a raw parse failure into an
 * {@link ArtifactValidationError} that names the file. `readValidatedJson`
 * already raises that for schema mismatches, but a truncated / empty / non-JSON
 * artifact surfaces a bare `SyntaxError` ("Unexpected end of JSON input") with
 * no path — unactionable where these loads happen (CLI, studio request
 * handlers, resync). Every load here promises to fail loudly AND legibly.
 */
function readJsonArtifact<T>(path: string, schema: ZodType<T>): T {
  try {
    return readValidatedJson(path, schema);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ArtifactValidationError(path, `not valid JSON — ${error.message}`);
    }
    throw error;
  }
}

/** Parse YAML, upgrading a raw `YAMLParseError` into a located ArtifactValidationError. */
function parseYamlArtifact(text: string, path: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new ArtifactValidationError(path, `not valid YAML — ${(error as Error).message}`);
  }
}

export class WorkDir {
  constructor(readonly root: string) {}

  get phase1Dir(): string {
    return join(this.root, 'phase1');
  }
  get graphPath(): string {
    return join(this.phase1Dir, 'graph.json');
  }
  get phase2Dir(): string {
    return join(this.root, 'phase2');
  }
  get cardsDir(): string {
    return join(this.phase2Dir, 'cards');
  }
  get skeletonPath(): string {
    return join(this.phase2Dir, 'skeleton.yaml');
  }
  get assignmentPath(): string {
    return join(this.phase2Dir, 'assignment.json');
  }
  get organizationPath(): string {
    return join(this.phase2Dir, 'organization.yaml');
  }
  get phase3Dir(): string {
    return join(this.root, 'phase3');
  }
  get narrationPath(): string {
    return join(this.phase3Dir, 'narration.json');
  }
  get registersPath(): string {
    return join(this.phase3Dir, 'registers.json');
  }
  get cacheDir(): string {
    return join(this.phase3Dir, 'cache');
  }

  // ---- graph ----

  loadGraph(): CodeGraph {
    if (!fileExists(this.graphPath)) {
      throw new MissingArtifactError('phase1/graph.json', 'run phase 1 first');
    }
    return readJsonArtifact(this.graphPath, codeGraphSchema);
  }

  // ---- cards ----

  /** Card path mirrors the source tree: `cards/<rel>.json`. */
  cardPath(relFile: string): string {
    return join(this.cardsDir, `${relFile}.json`);
  }

  saveCard(card: FileCard): void {
    writeJsonFile(this.cardPath(card.file), card);
  }

  /**
   * Delete cards for files that are no longer part of the codebase.
   *
   * A card is written per file and, until this existed, never removed — so a
   * file deleted by a refactor kept its card for the life of the work dir. That
   * is not merely stale data: everything downstream that enumerates
   * `model.cards` then emits a path that does not exist, and a path that does
   * not exist is the worst possible defect in an artifact whose entire promise
   * is "this path is where the thing is". Measured on this repo's own work dir:
   * 182 cards for 180 assigned files, the extras being `cli/src/args.ts` and
   * its test, deleted by the config refactor.
   *
   * `keep` must be the AUTHORITATIVE full file set. A subset — a resync pass
   * over three changed files — would delete every other card in the work dir,
   * so callers that work on a subset must not call this at all. That is why
   * there is no "prune to the files I just processed" convenience here.
   *
   * Returns the paths removed, so the caller can report them rather than
   * silently shrinking the handbook.
   */
  evictCardsOutside(keep: readonly string[]): string[] {
    if (!fileExists(this.cardsDir)) return [];
    const wanted = new Set(keep);
    const removed: string[] = [];
    for (const rel of listFilesRecursive(this.cardsDir, { extensions: ['.json'] })) {
      if (rel === '_coverage.json') continue;
      // The path is derived from the card's own `file` field rather than from
      // the filename, because `cardPath` mirrors the source tree and a
      // Windows-authored work dir can differ in separators.
      let card;
      try {
        card = readValidatedJson(join(this.cardsDir, rel), fileCardSchema);
      } catch {
        // Unreadable or foreign json: `loadCards` skips it, so it is not a card
        // and deleting it is not ours to do.
        continue;
      }
      if (wanted.has(card.file)) continue;
      rmSync(join(this.cardsDir, rel), { force: true });
      removed.push(card.file);
    }
    return removed.sort();
  }

  /** Load all cards, keyed by relative file path. Unparseable files are skipped. */
  loadCards(): Record<string, FileCard> {
    const cards: Record<string, FileCard> = {};
    if (!fileExists(this.cardsDir)) return cards;
    for (const rel of listFilesRecursive(this.cardsDir, { extensions: ['.json'] })) {
      if (rel === '_coverage.json') continue;
      try {
        const card = readValidatedJson(join(this.cardsDir, rel), fileCardSchema);
        cards[card.file] = card;
      } catch (error) {
        // A single unreadable file must not abort the whole load. Skip a foreign
        // or legacy json (schema mismatch → ArtifactValidationError) AND a corrupt
        // or partially-synced one (invalid JSON → SyntaxError): both are the
        // "unparseable files are skipped" this method promises. One such file
        // sitting in the cards dir would otherwise crash resume, phase 2b/2c/3
        // and every model load, all of which call this. Genuine I/O errors
        // (permissions, etc.) still surface.
        if (error instanceof ArtifactValidationError || error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return cards;
  }

  /** How many replies this run kept for inspection. */
  private rejectedReplies = 0;

  /** Cap the kept replies: a large repo at batchSize 1 would keep one per file. */
  private static readonly MAX_REJECTED_REPLIES = 20;

  /**
   * Keep a reply that produced no usable card, so a shape mismatch or refusal
   * can be read after the run instead of being guessed at. Diagnostics must
   * never break a run: failures here are swallowed.
   *
   * The name is derived from the file but disambiguated with a hash — sanitising
   * alone collapses every CJK path onto the same name, so one file's reply would
   * overwrite another's.
   */
  saveRejectedReply(file: string, text: string): void {
    if (this.rejectedReplies >= WorkDir.MAX_REJECTED_REPLIES) return;
    try {
      const dir = join(this.cardsDir, '_rejected');
      ensureDir(dir);
      const stem = file
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
      const name = `${stem || 'reply'}-${sha256Hex(file).slice(0, 8)}.txt`;
      writeFileAtomic(join(dir, name), text);
      this.rejectedReplies += 1;
    } catch {
      // diagnostics are best-effort
    }
  }

  /** Replies kept this run — reported when a run aborts for lack of coverage. */
  rejectedReplyCount(): number {
    return this.rejectedReplies;
  }

  /**
   * Drop replies kept by an earlier run. Without this, a diagnosis reads stale
   * replies from a previous generation with nothing to tell them apart.
   */
  clearRejectedReplies(): void {
    this.rejectedReplies = 0;
    try {
      rmSync(join(this.cardsDir, '_rejected'), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  saveCardCoverage(coverage: CardCoverage): void {
    writeJsonFile(join(this.cardsDir, '_coverage.json'), coverage);
  }

  loadCardCoverage(): CardCoverage | undefined {
    const path = join(this.cardsDir, '_coverage.json');
    return fileExists(path) ? readJsonArtifact(path, cardCoverageSchema) : undefined;
  }

  // ---- skeleton / assignment / organization ----

  saveSkeleton(skeleton: Skeleton): void {
    ensureDir(this.phase2Dir);
    writeFileAtomic(this.skeletonPath, stringifyYaml(skeleton, { lineWidth: 0 }));
  }

  loadSkeleton(): Skeleton {
    if (!fileExists(this.skeletonPath)) {
      throw new MissingArtifactError('phase2/skeleton.yaml', 'run phase 2 (or supply --skeleton) first');
    }
    return this.parseSkeletonYaml(readFileSync(this.skeletonPath, 'utf8'), this.skeletonPath);
  }

  parseSkeletonYaml(text: string, sourcePath: string): Skeleton {
    const parsed = skeletonSchema.safeParse(parseYamlArtifact(text, sourcePath));
    if (!parsed.success) {
      throw new ArtifactValidationError(
        sourcePath,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    return parsed.data;
  }

  saveAssignment(assignment: Assignment): void {
    writeJsonFile(this.assignmentPath, assignment);
  }

  loadAssignment(): Assignment {
    if (!fileExists(this.assignmentPath)) {
      throw new MissingArtifactError('phase2/assignment.json', 'run phase 2 first');
    }
    return readJsonArtifact(this.assignmentPath, assignmentSchema);
  }

  saveOrganization(organization: Organization): void {
    writeFileAtomic(this.organizationPath, stringifyYaml(organization, { lineWidth: 0 }));
  }

  loadOrganization(): Organization {
    if (!fileExists(this.organizationPath)) {
      throw new MissingArtifactError('phase2/organization.yaml', 'run phase 2 first');
    }
    const parsed = organizationSchema.safeParse(
      parseYamlArtifact(readFileSync(this.organizationPath, 'utf8'), this.organizationPath),
    );
    if (!parsed.success) {
      throw new ArtifactValidationError(
        this.organizationPath,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    return parsed.data;
  }

  // ---- strategy marker ----

  get strategyMarkerPath(): string {
    return join(this.phase2Dir, 'strategy.json');
  }

  /** Which strategy generated this work dir's phase-2 artifacts (recorded at 2b). */
  loadStrategy(): 'file' | 'member' | undefined {
    if (!fileExists(this.strategyMarkerPath)) return undefined;
    try {
      const raw = readJsonFile(this.strategyMarkerPath) as { strategy?: unknown };
      return raw.strategy === 'member' || raw.strategy === 'file' ? raw.strategy : undefined;
    } catch {
      return undefined;
    }
  }

  saveStrategy(strategy: 'file' | 'member'): void {
    writeJsonFile(this.strategyMarkerPath, { version: 1, strategy });
  }

  // ---- phase 3 ----

  saveNarration(narration: Narration): void {
    writeJsonFile(this.narrationPath, narration);
  }

  loadNarration(): Narration {
    if (!fileExists(this.narrationPath)) {
      throw new MissingArtifactError('phase3/narration.json', 'run phase 3 first');
    }
    return readJsonArtifact(this.narrationPath, narrationSchema);
  }

  saveRegisters(registers: Registers): void {
    writeJsonFile(this.registersPath, registers);
  }

  loadRegisters(): Registers {
    if (!fileExists(this.registersPath)) return { version: 1, registers: [] };
    return readJsonArtifact(this.registersPath, registersSchema);
  }
}
