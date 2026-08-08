/**
 * Resync — roll a handbook's derived layer forward after a real code change,
 * without re-running the full pipeline.
 *
 * The case contract:
 * ```
 * <case>/
 *   edited/      the changed source tree            (required)
 *   plan.md      description of the change; its ```json declarations block
 *                (will_modify/will_add/will_remove) sharpens the scope (optional)
 *   change.diff  unified diff vs the previous tree  (optional; empty = skip)
 * ```
 *
 * Algorithm:
 * 1. re-analyze the edited tree (fresh phase-1 graph);
 * 2. diff old vs new graph → changed / added / deleted files (declarations and
 *    the unified diff can only WIDEN this set, never narrow it);
 * 3. regenerate cards for changed+added files (LLM; `noLlm` keeps old prose and
 *    marks it stale while structural facts are refreshed);
 * 4. re-assign added files, drop deleted ones, reconcile buckets;
 * 5. rebuild organization entries for affected stages (deterministic order);
 * 6. re-narrate affected stages + system overview (content-hash cache does the
 *    minimal work) and refresh registers.
 */
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatClient } from '@handbook/llm';
import {
  MissingArtifactError,
  PIPELINE_DEFAULTS,
  fileExists,
  isAbsoluteAnyPlatform,
  isInternalNode,
  silentLogger,
  withDirLock,
  writeJsonFile,
  type CodeGraph,
  type FileCard,
  type Logger,
  type NarrateLang,
  type Organization,
} from '@handbook/core';
import { archiveCorrections, correctionFiles, loadCorrections } from './corrections.js';
import {
  WorkDir,
  buildInventory,
  classifyMembers,
  deriveFileArtifacts,
  extractRegisters,
  fileCallAdjacency,
  generateCards,
  loadMemberAssignment,
  mergeFunctionNotes,
  narrate,
  rebuildAssignment,
  reassignSubset,
  runPhase1,
  saveMemberAssignment,
  suggestOrder,
  type MemberAssignment,
} from '@handbook/pipeline';

/** Appended once to a card's purpose when noLlm resync refreshes its facts. */
const STALE_SUFFIX = ' (stale: code changed since narration)';

export interface ResyncCase {
  editedRoot: string;
  planText?: string;
  declarations?: { willModify: string[]; willAdd: string[]; willRemove: string[] };
  diffText?: string;
}

/** Load and validate a case directory. Returns undefined when there is nothing to resync. */
export function loadCase(caseDir: string): ResyncCase | undefined {
  const editedRoot = join(caseDir, 'edited');
  if (!fileExists(editedRoot)) {
    throw new MissingArtifactError(`${caseDir}/edited`, 'a resync case needs the edited source tree');
  }
  const diffPath = join(caseDir, 'change.diff');
  let diffText: string | undefined;
  if (fileExists(diffPath)) {
    diffText = readFileSync(diffPath, 'utf8');
    if (diffText.trim() === '') return undefined; // empty diff — nothing to resync
  }
  const planPath = join(caseDir, 'plan.md');
  const planText = fileExists(planPath) ? readFileSync(planPath, 'utf8') : undefined;
  return {
    editedRoot,
    planText,
    declarations: planText ? parsePlanDeclarations(planText) : undefined,
    diffText,
  };
}

export function parsePlanDeclarations(
  planText: string,
): { willModify: string[]; willAdd: string[]; willRemove: string[] } | undefined {
  for (const match of [...planText.matchAll(/```json\s*\n([\s\S]*?)```/g)].reverse()) {
    try {
      const parsed = JSON.parse(match[1] ?? '') as Record<string, unknown>;
      if ('will_modify' in parsed || 'will_add' in parsed || 'will_remove' in parsed) {
        const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
        return {
          willModify: list(parsed.will_modify),
          willAdd: list(parsed.will_add),
          willRemove: list(parsed.will_remove),
        };
      }
    } catch {
      // try earlier blocks
    }
  }
  return undefined;
}

/** Files named in a unified diff (`+++ b/<path>` headers, `/dev/null` skipped). */
export function filesFromDiff(diffText: string): string[] {
  const files = new Set<string>();
  for (const match of diffText.matchAll(/^[+-]{3} [ab]\/(.+)$/gm)) {
    const path = match[1]?.trim();
    if (!path || path === 'dev/null') continue;
    // A unified diff's paths are always repo-relative. An absolute path or one
    // with a `..` segment is malformed or hostile — a diff cannot legitimately
    // reference outside the tree. Drop it so the returned list can never steer
    // a caller (this one guards with scannedFiles, but the export is public)
    // to a path outside the workspace.
    // `isAbsoluteAnyPlatform`, not a leading-slash test: `C:/evil` is absolute
    // on Windows and would otherwise resolve outside the workspace there.
    if (isAbsoluteAnyPlatform(path) || path.split(/[\\/]/).includes('..')) continue;
    files.add(path);
  }
  return [...files].sort();
}

export interface GraphDelta {
  changed: string[];
  added: string[];
  deleted: string[];
}

/**
 * Changed/added/deleted file sets. Uses per-file CONTENT hashes when both
 * graphs carry them (catches in-place body edits that keep line numbers and
 * signatures identical). Structural fingerprints remain as the fallback —
 * for whole graphs written before hashes existed, and per file for entries
 * that were unreadable during either analysis (a missing hash is NOT a new
 * or changed file; membership comes from scannedFiles).
 */
export function diffGraphs(before: CodeGraph, after: CodeGraph): GraphDelta {
  const beforeHashes = before.metadata.fileHashes;
  const afterHashes = after.metadata.fileHashes;
  if (!beforeHashes || !afterHashes) return diffGraphsStructural(before, after);

  let fps: { before: Map<string, string>; after: Map<string, string> } | undefined;
  const structurallyChanged = (file: string): boolean => {
    fps ??= { before: fingerprintByFile(before), after: fingerprintByFile(after) };
    return fps.before.get(file) !== fps.after.get(file);
  };
  const beforeSet = new Set(before.metadata.scannedFiles);
  const changed: string[] = [];
  const added: string[] = [];
  for (const file of after.metadata.scannedFiles) {
    if (!beforeSet.has(file)) {
      added.push(file);
      continue;
    }
    const beforeHash = beforeHashes[file];
    const afterHash = afterHashes[file];
    const isChanged =
      beforeHash !== undefined && afterHash !== undefined
        ? beforeHash !== afterHash
        : structurallyChanged(file);
    if (isChanged) changed.push(file);
  }
  const afterSet = new Set(after.metadata.scannedFiles);
  const deleted = before.metadata.scannedFiles.filter((f) => !afterSet.has(f));
  return { changed: changed.sort(), added: added.sort(), deleted: deleted.sort() };
}

/** Line/signature fingerprint per file (blind to body-only edits). */
function fingerprintByFile(graph: CodeGraph): Map<string, string> {
  const byFile = new Map<string, string[]>();
  for (const node of Object.values(graph.nodes)) {
    if (!isInternalNode(node) || node.synthetic) continue;
    (byFile.get(node.file) ?? byFile.set(node.file, []).get(node.file))?.push(
      `${node.qualname}@${node.lineStart}-${node.lineEnd}:${node.signature}`,
    );
  }
  const result = new Map<string, string>();
  for (const file of graph.metadata.scannedFiles) {
    result.set(file, (byFile.get(file) ?? []).sort().join('|'));
  }
  return result;
}

/**
 * The depth a handbook was built with: deep cards carry per-function notes
 * and a description; brief cards never do.
 */
export function detectCardDetail(cards: Record<string, FileCard>): 'brief' | 'deep' {
  const isDeep = Object.values(cards).some(
    (card) => (card.functions?.length ?? 0) > 0 || Boolean(card.description),
  );
  return isDeep ? 'deep' : 'brief';
}

/** Legacy fallback for graphs without content hashes. */
function diffGraphsStructural(before: CodeGraph, after: CodeGraph): GraphDelta {
  const beforeFp = fingerprintByFile(before);
  const afterFp = fingerprintByFile(after);
  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const [file, fp] of afterFp) {
    if (!beforeFp.has(file)) added.push(file);
    else if (beforeFp.get(file) !== fp) changed.push(file);
  }
  for (const file of beforeFp.keys()) {
    if (!afterFp.has(file)) deleted.push(file);
  }
  return { changed: changed.sort(), added: added.sort(), deleted: deleted.sort() };
}

export interface ResyncOptions {
  /** Case directory (holds edited/, plan.md, diff, and receives the report). */
  caseDir: string;
  /**
   * Use this LIVE source tree as the edited root instead of `caseDir/edited`
   * (Studio's in-place flow). `caseDir` is still where the report and the
   * phase-1 staging area are written.
   */
  editedRoot?: string;
  /** Change description (with optional declarations block) when no plan.md exists. */
  planText?: string;
  /** Work dir holding the handbook artifacts to roll forward (updated in place). */
  workDir: string;
  client?: ChatClient;
  /** Refresh structural facts only; keep old prose and mark cards stale. */
  noLlm?: boolean;
  lang?: NarrateLang;
  detail?: 'brief' | 'deep';
  /**
   * Path to a `corrections.jsonl` written by handbook-consuming agents. Its
   * file list WIDENS the refresh set (a claim contradicted by the source is a
   * reason to redescribe that file even when its bytes never changed), and the
   * file is archived once the resync completes.
   */
  correctionsPath?: string;
  /**
   * Cooperative cancellation. Checked between steps and passed into every LLM
   * pass; an aborted run rejects with the signal's reason (`name === 'AbortError'`).
   */
  signal?: AbortSignal;
  logger?: Logger;
}

export interface ResyncReport {
  skipped: boolean;
  changedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  affectedStages: string[];
  cardsRegenerated: number;
  narrated: boolean;
  /** Corrections folded into this run, and where the consumed file was archived. */
  corrections?: { applied: number; files: string[]; problems: string[]; archivedTo?: string };
}

export async function resyncHandbook(options: ResyncOptions): Promise<ResyncReport> {
  // One run per work dir at a time — same lock as generateHandbook, so a
  // resync can never interleave with a concurrent generate on these artifacts.
  return withDirLock(options.workDir, 'handbook', options.logger ?? silentLogger, async () => {
    const stagingRoot = join(options.caseDir, '.resync-phase1');
    try {
      return await resyncHandbookInner(options);
    } finally {
      // The staging area must never outlive the call — success or failure.
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  });
}

async function resyncHandbookInner(options: ResyncOptions): Promise<ResyncReport> {
  const logger = options.logger ?? silentLogger;
  const signal = options.signal;
  signal?.throwIfAborted();
  const work = new WorkDir(options.workDir);
  const noLlm = options.noLlm ?? false;
  if (!noLlm && !options.client) throw new Error('resync needs an LLM client (or pass noLlm: true)');

  const resyncCase: ResyncCase | undefined = options.editedRoot
    ? {
        editedRoot: options.editedRoot,
        planText: options.planText,
        declarations: options.planText ? parsePlanDeclarations(options.planText) : undefined,
      }
    : loadCase(options.caseDir);
  const report: ResyncReport = {
    skipped: false,
    changedFiles: [],
    addedFiles: [],
    deletedFiles: [],
    affectedStages: [],
    cardsRegenerated: 0,
    narrated: false,
  };
  if (!resyncCase) {
    logger.info('[resync] empty diff — nothing to resync');
    report.skipped = true;
    writeJsonFile(join(options.caseDir, 'resync-report.json'), report);
    return report;
  }

  // 1-2. Fresh graph over the edited tree + delta vs the stored graph.
  // The fresh analysis goes to a STAGING dir first: the stored graph is the
  // delta baseline, and overwriting it before steps 3-6 complete would make a
  // crashed resync re-run against an empty delta (permanent silent staleness).
  const before = work.loadGraph();
  const stagingRoot = join(options.caseDir, '.resync-phase1');
  rmSync(stagingRoot, { recursive: true, force: true });
  await runPhase1({
    sourceRoot: resyncCase.editedRoot,
    workDir: stagingRoot,
    lang: before.metadata.language === 'multi' ? 'auto' : before.metadata.language,
    logger,
  });
  signal?.throwIfAborted();
  const staging = new WorkDir(stagingRoot);
  const after = staging.loadGraph();
  const delta = diffGraphs(before, after);

  // Widen with diff-named files that still exist (e.g. prose-only doc edits are ignored;
  // source files whose functions kept identical fingerprints still refresh their card).
  if (resyncCase.diffText) {
    const scanned = new Set(after.metadata.scannedFiles);
    for (const file of filesFromDiff(resyncCase.diffText)) {
      if (scanned.has(file) && !delta.added.includes(file) && !delta.changed.includes(file)) {
        delta.changed.push(file);
      }
    }
    delta.changed.sort();
  }
  // Declarations widen too: every declared function name maps (via the OLD
  // graph) to its file, so a plan's will_modify/will_add/will_remove can only
  // ADD refresh targets, never narrow them.
  if (resyncCase.declarations) {
    const declared = new Set(
      [
        ...resyncCase.declarations.willModify,
        ...resyncCase.declarations.willAdd,
        ...resyncCase.declarations.willRemove,
      ].map((name) => name.trim()),
    );
    const scanned = new Set(after.metadata.scannedFiles);
    for (const node of Object.values(before.nodes)) {
      if (!isInternalNode(node)) continue;
      if (!declared.has(node.qualname) && !declared.has(node.name) && !declared.has(node.id)) continue;
      if (scanned.has(node.file) && !delta.added.includes(node.file) && !delta.changed.includes(node.file)) {
        delta.changed.push(node.file);
      }
    }
    delta.changed.sort();
  }
  // Agent-reported corrections widen too: a handbook claim contradicted by the
  // source is a reason to redescribe that file even when its bytes never moved.
  let correctionsToArchive: string | undefined;
  if (options.correctionsPath) {
    const { corrections, problems } = loadCorrections(options.correctionsPath);
    const scanned = new Set(after.metadata.scannedFiles);
    const files = correctionFiles(corrections);
    const applied: string[] = [];
    for (const file of files) {
      if (!scanned.has(file)) {
        problems.push(`${file}: not in the analyzed file set — correction ignored`);
        continue;
      }
      applied.push(file);
      if (!delta.added.includes(file) && !delta.changed.includes(file)) delta.changed.push(file);
    }
    delta.changed.sort();
    for (const problem of problems) logger.warn(`[resync] corrections: ${problem}`);
    report.corrections = { applied: applied.length, files: applied, problems };
    if (corrections.length > 0) correctionsToArchive = options.correctionsPath;
    logger.info(`[resync] corrections: ${applied.length} file(s) widened the refresh set`);
  }
  report.changedFiles = delta.changed;
  report.addedFiles = delta.added;
  report.deletedFiles = delta.deleted;
  logger.info(
    `[resync] delta: ${delta.changed.length} changed, ${delta.added.length} added, ${delta.deleted.length} deleted`,
  );

  // 3. Refresh cards for changed+added files, at the depth the handbook was
  // built with unless the caller overrides it — a brief handbook must not
  // silently upgrade to deep (and re-read every file) on its first resync.
  const detail = options.detail ?? detectCardDetail(work.loadCards());
  const refreshTargets = [...delta.changed, ...delta.added];
  if (refreshTargets.length > 0) {
    if (noLlm) {
      const inventory = buildInventory(after);
      const oldCards = work.loadCards();
      for (const file of refreshTargets) {
        const old = oldCards[file];
        const stalePurpose =
          old && old.purpose && !old.purpose.endsWith(STALE_SUFFIX)
            ? `${old.purpose}${STALE_SUFFIX}`
            : (old?.purpose ?? '');
        const card = old
          ? { ...old, purpose: stalePurpose }
          : { version: 1 as const, file, purpose: '', role: 'other' as const, lifecycle: 'none' };
        if (old?.functions || !old) {
          // Refresh structural facts but KEEP the old per-function prose —
          // mergeFunctionNotes matches by qualname and reads dataFlow/relations.
          card.functions = mergeFunctionNotes(inventory[file] ?? [], old?.functions ?? []);
        }
        work.saveCard(card);
        report.cardsRegenerated += 1;
      }
    } else {
      const result = await generateCards({
        client: options.client as ChatClient,
        graph: after,
        sourceRoot: resyncCase.editedRoot,
        work,
        onlyFiles: refreshTargets,
        detail,
        batchSize: 1,
        signal,
        lang: options.lang ?? PIPELINE_DEFAULTS.narrateLang,
        logger,
      });
      report.cardsRegenerated = refreshTargets.filter((f) => !result.coverage.missing.includes(f)).length;
    }
  }

  signal?.throwIfAborted();

  // 4. Assignment: drop deleted files, re-assign added ones, reconcile buckets.
  const skeleton = work.loadSkeleton();
  const strategy = work.loadStrategy() ?? 'file';
  let assignment = work.loadAssignment();
  // Deleted files' FORMER stages are affected too — capture before deletion.
  const deletedStages = delta.deleted
    .map((file) => assignment.fileStage[file]?.stage)
    .filter((stage): stage is string => Boolean(stage) && stage !== 'unassigned');
  for (const file of delta.deleted) {
    // Remove the dead card — a ghost card would keep feeding narration and
    // register extraction with code that no longer exists.
    rmSync(work.cardPath(file), { force: true });
  }

  let memberOrganization: Organization | undefined;
  if (strategy === 'member') {
    // Member work dirs roll forward at MEMBER granularity: re-classify against
    // the fresh graph (member repos are small), or prune structurally in noLlm
    // mode, then re-derive the file-level artifacts the same way 2b did.
    const cardsNow = work.loadCards();
    let members: MemberAssignment;
    if (noLlm) {
      const previous = loadMemberAssignment(work);
      const liveIds = new Set(
        Object.values(after.nodes)
          .filter((n) => n.kind === 'internal' && !n.synthetic && n.lineStart > 0)
          .map((n) => n.id),
      );
      const memberStage: Record<string, string> = {};
      for (const id of liveIds) memberStage[id] = previous?.memberStage[id] ?? 'unassigned';
      const buckets: Record<string, string[]> = {};
      const unassigned: string[] = [];
      for (const [id, stage] of Object.entries(memberStage)) {
        if (stage === 'unassigned') unassigned.push(id);
        else (buckets[stage] ??= []).push(id);
      }
      for (const bucket of Object.values(buckets)) bucket.sort();
      members = {
        version: 1,
        memberStage,
        buckets,
        coverage: {
          nMembers: liveIds.size,
          nAssigned: liveIds.size - unassigned.length,
          unassigned: unassigned.sort(),
        },
      };
    } else {
      members = await classifyMembers(options.client as ChatClient, after, skeleton, {
        cards: cardsNow,
        signal,
        logger,
      });
    }
    saveMemberAssignment(work, members);
    const derived = deriveFileArtifacts(after, skeleton, members, cardsNow);
    assignment = derived.assignment;
    memberOrganization = derived.organization;
  } else {
    const fileStage = { ...assignment.fileStage };
    for (const file of delta.deleted) delete fileStage[file];
    for (const file of delta.added) fileStage[file] ??= { stage: 'unassigned', also: [] };
    assignment = rebuildAssignment(fileStage, skeleton);
    if (delta.added.length > 0 && !noLlm) {
      assignment = await reassignSubset(
        options.client as ChatClient,
        after,
        skeleton,
        delta.added,
        assignment,
        {
          cards: work.loadCards(),
          logger,
        },
      );
    }
  }
  work.saveAssignment(assignment);

  // Affected stages = stages owning any touched file.
  const touched = new Set([...delta.changed, ...delta.added, ...delta.deleted]);
  const affectedStages = new Set<string>(deletedStages);
  for (const [file, entry] of Object.entries(assignment.fileStage)) {
    if (touched.has(file) && entry.stage !== 'unassigned') affectedStages.add(entry.stage);
  }
  report.affectedStages = [...affectedStages].sort();

  signal?.throwIfAborted();

  // 5. Organization: member strategy already re-derived it; file strategy
  // rebuilds affected stages deterministically (call order).
  const organization = memberOrganization ?? work.loadOrganization();
  const adjacency = fileCallAdjacency(after);
  const cards = work.loadCards();
  if (memberOrganization) {
    work.saveOrganization(memberOrganization);
  } else {
    const fileEntry = (file: string) => ({
      file,
      purpose: cards[file]?.purpose ?? '',
      role: cards[file]?.role ?? 'other',
      nFunctions: cards[file]?.functions?.length ?? 0,
    });
    for (const sid of Object.keys(organization.stages)) {
      const bucket = assignment.buckets[sid] ?? [];
      const entry = organization.stages[sid];
      if (!entry) continue;
      const known = new Set(entry.orderedFiles);
      const bucketSet = new Set(bucket);
      const gained = bucket.filter((f) => !known.has(f));
      const lostAny = entry.orderedFiles.some((f) => !bucketSet.has(f));
      if (!affectedStages.has(sid) && gained.length === 0 && !lostAny) continue;
      // Minimal mechanical edit: prune files that left the bucket, refresh the
      // per-file facts from the current cards, and append newcomers in one
      // deterministic group — the LLM's surviving grouping is never discarded.
      const groups = entry.groups
        .map((group) => ({
          ...group,
          files: group.files.filter((f) => bucketSet.has(f.file)).map((f) => fileEntry(f.file)),
        }))
        .filter((group) => group.files.length > 0);
      const grouped = new Set(groups.flatMap((g) => g.files.map((f) => f.file)));
      const newcomers = suggestOrder(
        bucket.filter((f) => !grouped.has(f)),
        adjacency,
      );
      if (newcomers.length > 0) {
        groups.push({
          title: '(resynced)',
          summary: 'Files added by a code change (deterministic call order).',
          files: newcomers.map(fileEntry),
        });
      }
      organization.stages[sid] = {
        title: entry.title,
        groups,
        orderedFiles: [...entry.orderedFiles.filter((f) => bucketSet.has(f)), ...newcomers],
      };
    }
    // Stages that appeared in the assignment but never organized (new stages) get entries too.
    for (const sid of Object.keys(assignment.buckets)) {
      if (!organization.stages[sid]) {
        const bucket = assignment.buckets[sid] ?? [];
        const ordered = suggestOrder(bucket, adjacency);
        organization.stages[sid] = {
          title: skeleton.stages.find((s) => s.id === sid)?.title ?? sid,
          groups: [
            {
              title: '(resynced)',
              summary: 'New stage content after a code change.',
              files: ordered.map((file) => ({
                file,
                purpose: cards[file]?.purpose ?? '',
                role: cards[file]?.role ?? 'other',
                nFunctions: cards[file]?.functions?.length ?? 0,
              })),
            },
          ],
          orderedFiles: ordered,
        };
      }
    }
    organization.coverage = {
      nFiles: new Set(Object.values(assignment.buckets).flat()).size,
      nOrganized: Object.values(organization.stages).reduce((sum, s) => sum + s.orderedFiles.length, 0),
    };
    work.saveOrganization(organization);
  }

  signal?.throwIfAborted();

  // 6. Narration + registers (content-hash cache keeps unchanged stages free).
  if (!noLlm) {
    const narration = await narrate(
      options.client as ChatClient,
      { skeleton, assignment, organization, cards },
      { lang: options.lang ?? work.loadNarration().lang, cacheDir: work.cacheDir, signal, logger },
    );
    work.saveNarration(narration);
    const registers = await extractRegisters(options.client as ChatClient, skeleton, narration, cards, {
      cacheDir: work.cacheDir,
      lang: narration.lang,
      signal,
      logger,
    });
    work.saveRegisters({ version: 1, registers });
    report.narrated = true;
  }

  // 7. Promote the staged phase-1 artifacts LAST — only a fully-completed
  // resync moves the delta baseline forward.
  cpSync(staging.phase1Dir, work.phase1Dir, { recursive: true });

  // 8. Consumed corrections are archived LAST: an aborted or failed resync
  // leaves them pending so the next run still folds them in.
  if (correctionsToArchive && report.corrections) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    report.corrections.archivedTo = archiveCorrections(correctionsToArchive, stamp);
  }

  writeJsonFile(join(options.caseDir, 'resync-report.json'), report);
  return report;
}
