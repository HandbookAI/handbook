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
} from '@handbook/core';
import { readFileSync } from 'node:fs';

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
    return readValidatedJson(this.graphPath, codeGraphSchema);
  }

  // ---- cards ----

  /** Card path mirrors the source tree: `cards/<rel>.json`. */
  cardPath(relFile: string): string {
    return join(this.cardsDir, `${relFile}.json`);
  }

  saveCard(card: FileCard): void {
    writeJsonFile(this.cardPath(card.file), card);
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
        if (error instanceof ArtifactValidationError) continue; // legacy/foreign json
        throw error;
      }
    }
    return cards;
  }

  saveCardCoverage(coverage: CardCoverage): void {
    writeJsonFile(join(this.cardsDir, '_coverage.json'), coverage);
  }

  loadCardCoverage(): CardCoverage | undefined {
    const path = join(this.cardsDir, '_coverage.json');
    return fileExists(path) ? readValidatedJson(path, cardCoverageSchema) : undefined;
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
    const parsed = skeletonSchema.safeParse(parseYaml(text));
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
    return readValidatedJson(this.assignmentPath, assignmentSchema);
  }

  saveOrganization(organization: Organization): void {
    writeFileAtomic(this.organizationPath, stringifyYaml(organization, { lineWidth: 0 }));
  }

  loadOrganization(): Organization {
    if (!fileExists(this.organizationPath)) {
      throw new MissingArtifactError('phase2/organization.yaml', 'run phase 2 first');
    }
    const parsed = organizationSchema.safeParse(parseYaml(readFileSync(this.organizationPath, 'utf8')));
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
    return readValidatedJson(this.narrationPath, narrationSchema);
  }

  saveRegisters(registers: Registers): void {
    writeJsonFile(this.registersPath, registers);
  }

  loadRegisters(): Registers {
    if (!fileExists(this.registersPath)) return { version: 1, registers: [] };
    return readValidatedJson(this.registersPath, registersSchema);
  }
}
