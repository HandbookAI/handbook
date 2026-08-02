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
  fileExists,
  isInternalNode,
  silentLogger,
  writeJsonFile,
  type CodeGraph,
  type Logger,
  type NarrateLang,
} from '@handbook/core';
import {
  WorkDir,
  buildInventory,
  extractRegisters,
  fileCallAdjacency,
  generateCards,
  mergeFunctionNotes,
  narrate,
  rebuildAssignment,
  reassignSubset,
  runPhase1,
  suggestOrder,
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
  return { editedRoot, planText, declarations: planText ? parsePlanDeclarations(planText) : undefined, diffText };
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
    if (path && path !== 'dev/null') files.add(path);
  }
  return [...files].sort();
}

export interface GraphDelta {
  changed: string[];
  added: string[];
  deleted: string[];
}

/** Per-file structural fingerprints → changed/added/deleted file sets. */
export function diffGraphs(before: CodeGraph, after: CodeGraph): GraphDelta {
  const fingerprint = (graph: CodeGraph): Map<string, string> => {
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
  };
  const beforeFp = fingerprint(before);
  const afterFp = fingerprint(after);
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
  caseDir: string;
  /** Work dir holding the handbook artifacts to roll forward (updated in place). */
  workDir: string;
  client?: ChatClient;
  /** Refresh structural facts only; keep old prose and mark cards stale. */
  noLlm?: boolean;
  lang?: NarrateLang;
  detail?: 'brief' | 'deep';
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
}

export async function resyncHandbook(options: ResyncOptions): Promise<ResyncReport> {
  const logger = options.logger ?? silentLogger;
  const work = new WorkDir(options.workDir);
  const noLlm = options.noLlm ?? false;
  if (!noLlm && !options.client) throw new Error('resync needs an LLM client (or pass noLlm: true)');

  const resyncCase = loadCase(options.caseDir);
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
  report.changedFiles = delta.changed;
  report.addedFiles = delta.added;
  report.deletedFiles = delta.deleted;
  logger.info(
    `[resync] delta: ${delta.changed.length} changed, ${delta.added.length} added, ${delta.deleted.length} deleted`,
  );

  // 3. Refresh cards for changed+added files.
  const refreshTargets = [...delta.changed, ...delta.added];
  if (refreshTargets.length > 0) {
    if (noLlm) {
      const inventory = buildInventory(after);
      const oldCards = work.loadCards();
      for (const file of refreshTargets) {
        const old = oldCards[file];
        const stalePurpose =
          old && old.purpose && !old.purpose.endsWith(STALE_SUFFIX) ? `${old.purpose}${STALE_SUFFIX}` : (old?.purpose ?? '');
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
        detail: options.detail ?? 'deep',
        batchSize: 1,
        lang: options.lang ?? 'en',
        logger,
      });
      report.cardsRegenerated = refreshTargets.filter((f) => !result.coverage.missing.includes(f)).length;
    }
  }

  // 4. Assignment: drop deleted files, re-assign added ones, reconcile buckets.
  const skeleton = work.loadSkeleton();
  let assignment = work.loadAssignment();
  // Deleted files' FORMER stages are affected too — capture before deletion.
  const deletedStages = delta.deleted
    .map((file) => assignment.fileStage[file]?.stage)
    .filter((stage): stage is string => Boolean(stage) && stage !== 'unassigned');
  const fileStage = { ...assignment.fileStage };
  for (const file of delta.deleted) {
    delete fileStage[file];
    // Remove the dead card too — a ghost card would keep feeding narration and
    // register extraction with code that no longer exists.
    rmSync(work.cardPath(file), { force: true });
  }
  for (const file of delta.added) fileStage[file] ??= { stage: 'unassigned', also: [] };
  assignment = rebuildAssignment(fileStage, skeleton);
  if (delta.added.length > 0 && !noLlm) {
    assignment = await reassignSubset(options.client as ChatClient, after, skeleton, delta.added, assignment, {
      cards: work.loadCards(),
      logger,
    });
  }
  work.saveAssignment(assignment);

  // Affected stages = stages owning any touched file.
  const touched = new Set([...delta.changed, ...delta.added, ...delta.deleted]);
  const affectedStages = new Set<string>(deletedStages);
  for (const [file, entry] of Object.entries(assignment.fileStage)) {
    if (touched.has(file) && entry.stage !== 'unassigned') affectedStages.add(entry.stage);
  }
  report.affectedStages = [...affectedStages].sort();

  // 5. Organization: rebuild affected stages deterministically (call order).
  const organization = work.loadOrganization();
  const adjacency = fileCallAdjacency(after);
  const cards = work.loadCards();
  for (const sid of Object.keys(organization.stages)) {
    const bucket = assignment.buckets[sid] ?? [];
    const entry = organization.stages[sid];
    if (!entry) continue;
    const known = new Set(entry.orderedFiles);
    const bucketSet = new Set(bucket);
    const dirty = affectedStages.has(sid) || bucket.some((f) => !known.has(f)) || entry.orderedFiles.some((f) => !bucketSet.has(f));
    if (!dirty) continue;
    const ordered = suggestOrder(bucket, adjacency);
    organization.stages[sid] = {
      title: entry.title,
      groups: [
        {
          title: '(resynced)',
          summary: 'Reordered after a code change (deterministic call order).',
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

  // 6. Narration + registers (content-hash cache keeps unchanged stages free).
  if (!noLlm) {
    const narration = await narrate(
      options.client as ChatClient,
      { skeleton, assignment, organization, cards },
      { lang: options.lang ?? work.loadNarration().lang, cacheDir: work.cacheDir, logger },
    );
    work.saveNarration(narration);
    const registers = await extractRegisters(options.client as ChatClient, skeleton, narration, cards, {
      cacheDir: work.cacheDir,
      lang: narration.lang,
      logger,
    });
    work.saveRegisters({ version: 1, registers });
    report.narrated = true;
  }

  // 7. Promote the staged phase-1 artifacts LAST — only a fully-completed
  // resync moves the delta baseline forward.
  cpSync(staging.phase1Dir, work.phase1Dir, { recursive: true });
  rmSync(stagingRoot, { recursive: true, force: true });

  writeJsonFile(join(options.caseDir, 'resync-report.json'), report);
  return report;
}
