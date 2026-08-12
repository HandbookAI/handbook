/**
 * The pipeline orchestrator: phase selection, prerequisite checks, artifact
 * persistence, and loading a completed work directory into a
 * {@link HandbookModel} for the renderer.
 */
import { LanguageReport, type ChatClient } from '@handbooks/llm';
import { RunProgress, type ProgressSink } from '@handbooks/core';
import {
  MissingArtifactError,
  PIPELINE_DEFAULTS,
  silentLogger,
  withDirLock,
  writeJsonFile,
  type HandbookModel,
  type Logger,
  type NarrateLang,
  type Skeleton,
} from '@handbooks/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { runPhase1, type Phase1Stats } from './phase1.js';
import { generateCards, type CardDetail } from './cards.js';
import { normalizeSkeleton, synthesizeSkeleton } from './skeleton.js';
import { assignFiles } from './assign.js';
import { synthesizeWithDoctor } from './doctor.js';
import { organizeStages } from './organize.js';
import { extractRegisters, narrate } from './narrate.js';
import { classifyMembers, deriveFileArtifacts, saveMemberAssignment } from './member.js';
import { buildNavPack } from '@handbooks/analyzer';
import { WorkDir } from './workdir.js';

export type Phase = '1' | '2a' | '2b' | '2c' | '3';

const ALL_PHASES: readonly Phase[] = ['1', '2a', '2b', '2c', '3'];

/** `all` | `1` | `2` (= 2a+2b+2c) | `2a` … | comma list (e.g. `2c,3`). */
export function expandPhases(spec: string): Set<Phase> {
  const out = new Set<Phase>();
  for (const token of spec
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)) {
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
  /**
   * Cooperative cancellation: checked between phases and at each batch/worker
   * checkpoint, and passed into every LLM call so in-flight requests abort.
   * An aborted run rejects with the signal's reason (`name === 'AbortError'`);
   * partial artifacts already saved stay on disk and no run manifest is written.
   */
  signal?: AbortSignal;
  logger?: Logger;
  /**
   * Machine-readable progress for a UI. Each pass reports its own units, and
   * `overall` carries the fraction of the WHOLE run — computed from the unit
   * counts the call graph makes knowable, not from counting phase boundaries,
   * which would claim 20% for a phase that takes seconds.
   */
  onProgress?: ProgressSink;
  /** Internal: the run-wide language report `generateHandbook` threads through. */
  languageReport?: LanguageReport;
}

export interface GenerateStats {
  phasesRun: Phase[];
  phase1?: Phase1Stats;
  nCards?: number;
  nStages?: number;
  nUnassignedFiles?: number;
  nRegisters?: number;
}

/**
 * Provenance record for a work directory: which model, phases and stats
 * produced the artifacts sitting next to it. Describes the LAST successful
 * run — a failed run leaves the previous manifest untouched.
 */
export const runManifestSchema = z.object({
  version: z.literal(1),
  /** Model identifier of the client used, or null for an LLM-less run. */
  model: z.string().nullable(),
  phases: z.array(z.enum(['1', '2a', '2b', '2c', '3'])),
  startedAt: z.string(),
  finishedAt: z.string(),
  /** Whatever the client's optional usage() reported, or null if it has none. */
  usage: z.record(z.string(), z.unknown()).nullable(),
  stats: z.record(z.string(), z.unknown()),
  /**
   * Passages that came back in the wrong language and stayed wrong after a
   * retry. Empty is the normal case and the common one.
   *
   * This is the fourth layer of the language guard, and the only one that is a
   * promise rather than an attempt: the run may ship prose in the wrong
   * language — dropping it would lose content that is merely mislabelled — but
   * it will never claim a language it did not deliver. Without a record on
   * disk, `--narrate-lang ja` could produce a mostly-English handbook stamped
   * `lang: "ja"` with no trace anywhere.
   */
  languageLapses: z
    .array(
      z.object({
        where: z.string(),
        wanted: z.string(),
        gotLanguage: z.string().optional(),
        detail: z.string(),
      }),
    )
    .default([]),
});

export type RunManifest = z.infer<typeof runManifestSchema>;

export function runManifestPath(workDir: string): string {
  return join(workDir, 'run-manifest.json');
}

/** ChatClient deliberately does not declare usage(); discover it by shape. */
function readClientUsage(client: ChatClient | undefined): Record<string, unknown> | null {
  const usage = (client as { usage?: unknown } | undefined)?.usage;
  if (typeof usage !== 'function') return null;
  const reported: unknown = usage.call(client);
  return typeof reported === 'object' && reported !== null ? (reported as Record<string, unknown>) : null;
}

export async function generateHandbook(options: GenerateOptions): Promise<GenerateStats> {
  // One run per work dir at a time — a concurrent CLI/studio run on the same
  // artifacts would interleave writes (re-entrant, so runPhase1 nests fine).
  return withDirLock(options.workDir, 'handbook', options.logger ?? silentLogger, async () => {
    const startedAt = new Date().toISOString();
    // One report for the whole run, so a lapse in stage 12 and one in the
    // system overview are counted together rather than reported twice.
    const languageReport = new LanguageReport();
    const stats = await generateLocked({ ...options, languageReport });
    const summary = languageReport.summary();
    if (summary) (options.logger ?? silentLogger).warn(`[lang] ${summary}`);
    const manifest: RunManifest = {
      version: 1,
      model: options.client?.model ?? null,
      phases: stats.phasesRun,
      startedAt,
      finishedAt: new Date().toISOString(),
      usage: readClientUsage(options.client),
      stats: stats as unknown as Record<string, unknown>,
      languageLapses: languageReport.lapses.map((lapse) => ({
        where: lapse.where,
        wanted: lapse.wanted,
        gotLanguage: lapse.gotLanguage,
        detail: lapse.detail,
      })),
    };
    writeJsonFile(runManifestPath(options.workDir), manifest);
    return stats;
  });
}

async function generateLocked(options: GenerateOptions): Promise<GenerateStats> {
  const logger = options.logger ?? silentLogger;
  const signal = options.signal;
  // Cooperative checkpoints: once between phases is enough for promptness —
  // each phase pass re-checks per batch and aborts its in-flight LLM calls.
  signal?.throwIfAborted();
  const phases = expandPhases(options.phase ?? 'all');
  /**
   * Phase timing at debug. "Which step is it stuck in" is the first question a
   * long run raises, and until now the answer was invisible: the info lines
   * report what a phase FOUND, never that it started or how long it took. A
   * phase that produces nothing produced no line at all.
   */
  const phaseTimer = (name: string): (() => void) => {
    const startedAt = Date.now();
    logger.debug(`[${name}] start`);
    return () => logger.debug(`[${name}] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  };
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
  const narrateLang = options.narrateLang ?? PIPELINE_DEFAULTS.narrateLang;
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
    const donePhase = phaseTimer('1');
    stats.phase1 = await runPhase1({
      sourceRoot: options.sourceRoot,
      workDir: options.workDir,
      lang: options.lang,
      logger,
    });
    donePhase();
  }

  if ([...phases].every((p) => p === '1')) return stats;
  const client = options.client as ChatClient;
  const graph = work.loadGraph();

  // Overall progress, reported two ways because neither alone is honest:
  //
  //  - the COARSE bar is which phase of the planned set is running. Always
  //    correct, and it never moves backwards.
  //  - the FINE bar is units of real work. Each pass announces its own total
  //    when it starts, so the denominator grows as the run proceeds — a card
  //    pass cannot know how many stages phase 2b will invent. Growing is the
  //    truth; a fixed denominator would be a number made up in advance.
  //
  // The alternative — weighting phases 20% each — claims a fifth of the run for
  // phase 1, which finishes in seconds on a repo where phase 2a takes an hour.
  const run = new RunProgress(options.onProgress, [...phases].sort());
  const progressFor = (scope: string): ProgressSink | undefined =>
    options.onProgress ? run.sinkFor(scope) : undefined;

  if (phases.has('2a')) {
    const donePhase = phaseTimer('2a');
    run.enterPhase('2a');
    signal?.throwIfAborted();
    const result = await generateCards({
      client,
      graph,
      sourceRoot: options.sourceRoot,
      work,
      batchSize: options.readBatchSize ?? (options.detail === 'deep' ? 1 : PIPELINE_DEFAULTS.readBatchSize),
      maxWorkers: options.readWorkers,
      maxCharsPerFile: options.maxCharsPerFile,
      detail: options.detail,
      resume: options.resume,
      lang: narrateLang,
      signal,
      logger,
      onProgress: progressFor('cards'),
    });
    stats.nCards = result.coverage.nFiles;
    donePhase();
  }

  if (phases.has('2b')) {
    const donePhase = phaseTimer('2b');
    run.enterPhase('2b');
    signal?.throwIfAborted();
    const cards = work.loadCards();
    if (Object.keys(cards).length === 0) {
      throw new MissingArtifactError('phase2/cards', 'run phase 2a first');
    }
    if (strategy === 'member') {
      const skeleton = loadUserSkeleton(work, options.skeletonPath as string);
      const members = await classifyMembers(client, graph, skeleton, { cards, signal, logger });
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
        signal,
        logger,
        onProgress: progressFor('assign'),
      });
      work.saveSkeleton(skeleton);
      work.saveAssignment(assignment);
      stats.nStages = skeleton.stages.length;
      stats.nUnassignedFiles = assignment.coverage.unassigned.length;
    } else if ((options.synthMode ?? PIPELINE_DEFAULTS.synthMode) === 'doctor') {
      const { skeleton, assignment } = await synthesizeWithDoctor(client, graph, cards, {
        maxRounds: options.maxDoctorRounds,
        lang: narrateLang,
        assignBatchSize: options.assignBatchSize,
        assignWorkers: options.assignWorkers,
        signal,
        logger,
        onRejectedReply: (reply) => work.saveRejectedReply('skeleton-synth-doctor', reply),
      });
      work.saveSkeleton(skeleton);
      work.saveAssignment(assignment);
      stats.nStages = skeleton.stages.length;
      stats.nUnassignedFiles = assignment.coverage.unassigned.length;
    } else {
      const nav = buildNavPack(graph);
      const skeleton = await synthesizeSkeleton(
        client,
        nav,
        cards,
        narrateLang,
        (reply) => work.saveRejectedReply('skeleton-synth', reply),
        signal,
      );
      const assignment = await assignFiles(client, graph, skeleton, {
        batchSize: options.assignBatchSize,
        maxWorkers: options.assignWorkers,
        cards,
        signal,
        logger,
        onProgress: progressFor('assign'),
      });
      work.saveSkeleton(skeleton);
      work.saveAssignment(assignment);
      stats.nStages = skeleton.stages.length;
      stats.nUnassignedFiles = assignment.coverage.unassigned.length;
    }
    work.saveStrategy(strategy);
    logger.info(`[2b] ${stats.nStages} stages; ${stats.nUnassignedFiles} files unassigned`);
    donePhase();
  }

  if (phases.has('2c') && strategy === 'member') {
    logger.info('[2c] member strategy: organization was derived deterministically in 2b — nothing to do');
  }
  if (phases.has('2c') && strategy === 'file') {
    const donePhase = phaseTimer('2c');
    run.enterPhase('2c');
    signal?.throwIfAborted();
    const skeleton = work.loadSkeleton();
    const assignment = work.loadAssignment();
    const cards = work.loadCards();
    const organization = await organizeStages(client, graph, skeleton, assignment, cards, {
      workers: options.organizeWorkers,
      lang: narrateLang,
      signal,
      logger,
      onProgress: progressFor('organize'),
    });
    work.saveOrganization(organization);
    donePhase();
  }

  if (phases.has('3')) {
    const donePhase = phaseTimer('3');
    run.enterPhase('3');
    signal?.throwIfAborted();
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
        signal,
        logger,
        onProgress: progressFor('narrate'),
        languageReport: options.languageReport,
      },
    );
    work.saveNarration(narration);
    const registers = await extractRegisters(client, skeleton, narration, cards, {
      refresh: options.refresh,
      cacheDir: work.cacheDir,
      lang: narrateLang,
      signal,
      logger,
    });
    work.saveRegisters({ version: 1, registers });
    stats.nRegisters = registers.length;
    donePhase();
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
    // Read from the run manifest rather than stamped here: `Date.now()` at load
    // time would say when the handbook was RENDERED, and the question a reader
    // has is when the facts were extracted. A work dir with no manifest — one
    // that predates it, or a phase-1-only run — leaves the field absent, and
    // the agent index says so rather than inventing a date.
    provenance: readProvenance(workDir),
  };
}

/** When this work dir's facts were produced, from the run manifest if there is one. */
function readProvenance(workDir: string): HandbookModel['provenance'] {
  try {
    const raw = JSON.parse(readFileSync(runManifestPath(workDir), 'utf8')) as {
      finishedAt?: unknown;
      commit?: unknown;
    };
    if (typeof raw.finishedAt !== 'string' || raw.finishedAt === '') return undefined;
    return {
      generatedAt: raw.finishedAt,
      ...(typeof raw.commit === 'string' && raw.commit !== '' ? { commit: raw.commit } : {}),
    };
  } catch {
    // No manifest, unreadable, or not JSON. Absent provenance is a fact the
    // header states plainly; a guessed timestamp would not be.
    return undefined;
  }
}
