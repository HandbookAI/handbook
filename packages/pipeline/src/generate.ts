/**
 * The pipeline orchestrator: phase selection, prerequisite checks, artifact
 * persistence, and loading a completed work directory into a
 * {@link HandbookModel} for the renderer.
 */
import type { ChatClient } from '@handbook/llm';
import {
  MissingArtifactError,
  silentLogger,
  withDirLock,
  type HandbookModel,
  type Logger,
  type NarrateLang,
  type Skeleton,
} from '@handbook/core';
import { readFileSync } from 'node:fs';
import { runPhase1, type Phase1Stats } from './phase1.js';
import { generateCards, type CardDetail } from './cards.js';
import { normalizeSkeleton, synthesizeSkeleton } from './skeleton.js';
import { assignFiles } from './assign.js';
import { synthesizeWithDoctor } from './doctor.js';
import { organizeStages } from './organize.js';
import { extractRegisters, narrate } from './narrate.js';
import { classifyMembers, deriveFileArtifacts, saveMemberAssignment } from './member.js';
import { buildNavPack } from '@handbook/analyzer';
import { WorkDir } from './workdir.js';

export type Phase = '1' | '2a' | '2b' | '2c' | '3';

const ALL_PHASES: readonly Phase[] = ['1', '2a', '2b', '2c', '3'];

/** `all` | `1` | `2` (= 2a+2b+2c) | `2a` … | comma list (e.g. `2c,3`). */
export function expandPhases(spec: string): Set<Phase> {
  const out = new Set<Phase>();
  for (const token of spec.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean)) {
    if (token === 'all') for (const p of ALL_PHASES) out.add(p);
    else if (token === '2') for (const p of ['2a', '2b', '2c'] as const) out.add(p);
    else if ((ALL_PHASES as readonly string[]).includes(token)) out.add(token as Phase);
    else throw new Error(`unknown phase "${token}" (expected all|1|2|2a|2b|2c|3 or a comma list)`);
  }
  if (out.size === 0) throw new Error('no phases selected');
  return out;
}

export type Strategy = 'file' | 'member';

export interface GenerateOptions {
  sourceRoot: string;
  workDir: string;
  /** Required for any phase beyond 1. */
  client?: ChatClient;
  /** Phase spec, default `all`. */
  phase?: string;
  /** `file` (default): auto skeleton, file leaf. `member`: authored skeleton, function-level classification. */
  strategy?: Strategy;
  /** Path to a user-authored skeleton.yaml (required for member strategy). */
  skeletonPath?: string;
  lang?: string;
  narrateLang?: NarrateLang;
  detail?: CardDetail;
  readBatchSize?: number;
  readWorkers?: number;
  maxCharsPerFile?: number;
  resume?: boolean;
  synthMode?: 'oneshot' | 'doctor';
  maxDoctorRounds?: number;
  assignBatchSize?: number;
  assignWorkers?: number;
  organizeWorkers?: number;
  narrateWorkers?: number;
  refresh?: boolean;
  logger?: Logger;
}

export interface GenerateStats {
  phasesRun: Phase[];
  phase1?: Phase1Stats;
  nCards?: number;
  nStages?: number;
  nUnassignedFiles?: number;
  nRegisters?: number;
}

export async function generateHandbook(options: GenerateOptions): Promise<GenerateStats> {
  // One run per work dir at a time — a concurrent CLI/studio run on the same
  // artifacts would interleave writes (re-entrant, so runPhase1 nests fine).
  return withDirLock(options.workDir, 'handbook', options.logger ?? silentLogger, () =>
    generateLocked(options),
  );
}

async function generateLocked(options: GenerateOptions): Promise<GenerateStats> {
  const logger = options.logger ?? silentLogger;
  const phases = expandPhases(options.phase ?? 'all');
  const work = new WorkDir(options.workDir);

  // The strategy chosen at 2b is recorded in the work dir, so partial re-runs
  // (`--phase 2c`, `--phase 3`) cannot accidentally cross strategies — e.g.
  // the file-strategy default silently overwriting a member-derived
  // organization with LLM grouping.
  const stored = work.loadStrategy();
  const strategy: Strategy = options.strategy ?? stored ?? 'file';
  if (options.strategy && stored && options.strategy !== stored && !phases.has('2b')) {
    throw new Error(
      `work dir was generated with strategy "${stored}" but --strategy ${options.strategy} was given; ` +
        're-run phase 2b to switch strategies',
    );
  }
  const narrateLang = options.narrateLang ?? 'en';
  const stats: GenerateStats = { phasesRun: [...phases].sort() as Phase[] };

  // Member strategy derives its organization deterministically at 2b — a bare
  // 2c run then needs no LLM at all.
  const needsLlm = [...phases].some((p) => p !== '1' && !(p === '2c' && strategy === 'member'));
  if (needsLlm && !options.client) {
    throw new Error('phases 2/3 need an LLM client (set OPENAI_API_KEY or pass --phase 1)');
  }
  if (strategy === 'member' && phases.has('2b') && !options.skeletonPath) {
    throw new Error('member strategy requires --skeleton <path to skeleton.yaml>');
  }

  if (phases.has('1')) {
    stats.phase1 = await runPhase1({
      sourceRoot: options.sourceRoot,
      workDir: options.workDir,
      lang: options.lang,
      logger,
    });
  }

  if ([...phases].every((p) => p === '1')) return stats;
  const client = options.client as ChatClient;
  const graph = work.loadGraph();

  if (phases.has('2a')) {
    const result = await generateCards({
      client,
      graph,
      sourceRoot: options.sourceRoot,
      work,
      batchSize: options.readBatchSize ?? (options.detail === 'deep' ? 1 : 8),
      maxWorkers: options.readWorkers,
      maxCharsPerFile: options.maxCharsPerFile,
      detail: options.detail,
      resume: options.resume,
      lang: narrateLang,
      logger,
    });
    stats.nCards = result.coverage.nFiles;
  }

  if (phases.has('2b')) {
    const cards = work.loadCards();
    if (Object.keys(cards).length === 0) {
      throw new MissingArtifactError('phase2/cards', 'run phase 2a first');
    }
    if (strategy === 'member') {
      const skeleton = loadUserSkeleton(work, options.skeletonPath as string);
      const members = await classifyMembers(client, graph, skeleton, { cards, logger });
      saveMemberAssignment(work, members);
      const derived = deriveFileArtifacts(graph, skeleton, members, cards);
      work.saveSkeleton(skeleton);
      work.saveAssignment(derived.assignment);
      // Member organization is deterministic — write it now so 2c becomes a no-op.
      work.saveOrganization(derived.organization);
      stats.nStages = skeleton.stages.length;
      stats.nUnassignedFiles = derived.assignment.coverage.unassigned.length;
    } else if (options.skeletonPath) {
      const skeleton = loadUserSkeleton(work, options.skeletonPath);
      const assignment = await assignFiles(client, graph, skeleton, {
        batchSize: options.assignBatchSize,
        maxWorkers: options.assignWorkers,
        cards,
        logger,
      });
      work.saveSkeleton(skeleton);
      work.saveAssignment(assignment);
      stats.nStages = skeleton.stages.length;
      stats.nUnassignedFiles = assignment.coverage.unassigned.length;
    } else if ((options.synthMode ?? 'oneshot') === 'doctor') {
      const { skeleton, assignment } = await synthesizeWithDoctor(client, graph, cards, {
        maxRounds: options.maxDoctorRounds,
        lang: narrateLang,
        assignBatchSize: options.assignBatchSize,
        assignWorkers: options.assignWorkers,
        logger,
        onRejectedReply: (reply) => work.saveRejectedReply('skeleton-synth-doctor', reply),
      });
      work.saveSkeleton(skeleton);
      work.saveAssignment(assignment);
      stats.nStages = skeleton.stages.length;
      stats.nUnassignedFiles = assignment.coverage.unassigned.length;
    } else {
      const nav = buildNavPack(graph);
      const skeleton = await synthesizeSkeleton(client, nav, cards, narrateLang, (reply) =>
        work.saveRejectedReply('skeleton-synth', reply),
      );
      const assignment = await assignFiles(client, graph, skeleton, {
        batchSize: options.assignBatchSize,
        maxWorkers: options.assignWorkers,
        cards,
        logger,
      });
      work.saveSkeleton(skeleton);
      work.saveAssignment(assignment);
      stats.nStages = skeleton.stages.length;
      stats.nUnassignedFiles = assignment.coverage.unassigned.length;
    }
    work.saveStrategy(strategy);
    logger.info(`[2b] ${stats.nStages} stages; ${stats.nUnassignedFiles} files unassigned`);
  }

  if (phases.has('2c') && strategy === 'member') {
    logger.info('[2c] member strategy: organization was derived deterministically in 2b — nothing to do');
  }
  if (phases.has('2c') && strategy === 'file') {
    const skeleton = work.loadSkeleton();
    const assignment = work.loadAssignment();
    const cards = work.loadCards();
    const organization = await organizeStages(client, graph, skeleton, assignment, cards, {
      workers: options.organizeWorkers,
      lang: narrateLang,
      logger,
    });
    work.saveOrganization(organization);
  }

  if (phases.has('3')) {
    const skeleton = work.loadSkeleton();
    const assignment = work.loadAssignment();
    const organization = work.loadOrganization();
    const cards = work.loadCards();
    const narration = await narrate(
      client,
      { skeleton, assignment, organization, cards },
      {
        workers: options.narrateWorkers,
        refresh: options.refresh,
        lang: narrateLang,
        cacheDir: work.cacheDir,
        logger,
      },
    );
    work.saveNarration(narration);
    const registers = await extractRegisters(client, skeleton, narration, cards, {
      refresh: options.refresh,
      cacheDir: work.cacheDir,
      lang: narrateLang,
      logger,
    });
    work.saveRegisters({ version: 1, registers });
    stats.nRegisters = registers.length;
  }

  return stats;
}

function loadUserSkeleton(work: WorkDir, skeletonPath: string): Skeleton {
  const raw = work.parseSkeletonYaml(readFileSync(skeletonPath, 'utf8'), skeletonPath);
  // Normalize to repair children lists / dangling parents in hand-written files.
  const normalized = normalizeSkeleton(raw, raw.metadata.draftedBy ?? 'user');
  normalized.metadata.archetype = raw.metadata.archetype;
  return normalized;
}

/** Load a completed work directory into the renderer's input model. */
export function loadHandbookModel(workDir: string, title: string): HandbookModel {
  const work = new WorkDir(workDir);
  const narration = work.loadNarration();
  return {
    title,
    lang: narration.lang,
    skeleton: work.loadSkeleton(),
    cards: work.loadCards(),
    assignment: work.loadAssignment(),
    organization: work.loadOrganization(),
    narration,
    registers: work.loadRegisters().registers,
  };
}
