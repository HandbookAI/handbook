/**
 * Phase 2b (step C) — the skeleton doctor: an actor–critic convergence loop
 * that repairs the drafted skeleton against the observed file distribution.
 *
 * One round = actor proposes ≤3 structural changes (add/remove/merge/split),
 * a parallel critic panel (engineer/architect/reader) reviews them against
 * ground-truth stats, validated changes are applied mechanically, and the
 * affected files are re-assigned. The loop converges when nothing is
 * unassigned and the actor proposes no further changes; two consecutive
 * no-progress rounds trip the stuck detector.
 */
import { actorCriticLoop, type ChatClient, type CriticRole } from '@handbook/llm';
import {
  PIPELINE_DEFAULTS,
  silentLogger,
  type Assignment,
  type CodeGraph,
  type FileCard,
  type Logger,
  type NarrateLang,
  type Skeleton,
} from '@handbook/core';
import { assignFiles, reassignSubset, rebuildAssignment } from './assign.js';
import { normalizeSkeleton, synthesizeSkeleton } from './skeleton.js';
import { buildNavPack } from '@handbook/analyzer';

export interface StageStats {
  perStage: Record<string, { nFiles: number; overloaded: boolean }>;
  nUnassigned: number;
  unassigned: string[];
  nFiles: number;
  overloadFloor: number;
}

export function computeStageStats(skeleton: Skeleton, assignment: Assignment): StageStats {
  const sizes = Object.values(assignment.buckets)
    .map((b) => b.length)
    .filter((n) => n > 0);
  const mean = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
  const overloadFloor = Math.max(20, 2.5 * mean);
  const perStage: StageStats['perStage'] = {};
  for (const stage of skeleton.stages) {
    const nFiles = assignment.buckets[stage.id]?.length ?? 0;
    perStage[stage.id] = { nFiles, overloaded: nFiles > overloadFloor };
  }
  return {
    perStage,
    nUnassigned: assignment.coverage.unassigned.length,
    unassigned: assignment.coverage.unassigned,
    nFiles: assignment.coverage.nFiles,
    overloadFloor,
  };
}

/** Ground-truth evidence shared by the actor and every critic. */
export function renderStats(skeleton: Skeleton, stats: StageStats, cards: Record<string, FileCard>): string {
  const lines: string[] = [];
  lines.push(
    `Skeleton: ${skeleton.stages.length} stages, ${stats.nFiles} files total, ${stats.nUnassigned} UNASSIGNED.`,
  );
  lines.push('', '## Current skeleton');
  for (const stage of skeleton.stages) {
    const flags = stage.crosscut ? ' [crosscut]' : '';
    const firstSentence = (stage.description.split(/(?<=\.)\s|。/)[0] ?? '').slice(0, 80);
    lines.push(
      `- ${stage.id} parent=${stage.parent ?? 'null'} children=${stage.children.length}${flags} — ${firstSentence}`,
    );
  }
  lines.push('', '## File distribution per stage');
  for (const stage of skeleton.stages) {
    const s = stats.perStage[stage.id];
    lines.push(`- ${stage.id} files=${s?.nFiles ?? 0}${s?.overloaded ? '  <OVERLOADED>' : ''}`);
  }
  if (stats.unassigned.length > 0) {
    lines.push('', '## Unassigned files (these MUST be given a home)');
    for (const file of stats.unassigned.slice(0, 40)) {
      const purpose = cards[file]?.purpose ?? '';
      lines.push(`- ${file}${purpose ? `  — ${purpose}` : ''}`);
    }
    if (stats.unassigned.length > 40) lines.push(`... and ${stats.unassigned.length - 40} more`);
  }
  return lines.join('\n');
}

const ACTOR_RULES = `You are the SKELETON DOCTOR for a system handbook whose leaf node is the SOURCE FILE.
Propose AT MOST 3 structural changes to the skeleton, prioritized:
1. UNASSIGNED FILES — add_stage for a coherent group, or widen an existing stage's description.
2. STAGE OVERLOAD (<OVERLOADED> flag) — split_stage into coherent substages.
3. STARVATION (sibling substages with 0-1 files) — merge_stages.
4. DEAD STAGES (0 files, no children) — remove_stage.
Do NOT make cosmetic changes; do not touch healthy stages; prefer widening scope over creating
near-duplicate stages. Members are FILE PATHS. Action schemas:
{"action":"add_stage","new_stage":{"id":"...","title":"...","description":"...","parent":"<id|null>","crosscut":false},
 "move_files":[{"file":"<path>","from_stage":"<id|unassigned>"}]}
{"action":"remove_stage","stage_id":"...","move_to":"<id|null>"}
{"action":"merge_stages","stages_to_merge":["sid1","sid2"],"into":"<target id>"}
{"action":"split_stage","source_stage":"...",
 "new_stages":[{"id":"...","title":"...","description":"...","parent":"<usually source>","files":["p1","p2"]}]}
Output ONLY one JSON block: {"changes":[...], "rationale":"<one paragraph>"}.
A healthy, fully-covered skeleton gets {"changes": [], "rationale": "..."}.`;

const SCHEMA_HINT = `{"changes": [<add_stage|remove_stage|merge_stages|split_stage objects>], "rationale": "..."}`;

export interface DoctorChange {
  action: string;
  [key: string]: unknown;
}

/** Validate one change against the current skeleton + buckets. Returns an error string or null. */
export function validateChange(
  change: DoctorChange,
  skeleton: Skeleton,
  assignment: Assignment,
): string | null {
  const ids = new Set(skeleton.stages.map((s) => s.id));
  switch (change.action) {
    case 'add_stage': {
      const ns = change.new_stage as Record<string, unknown> | undefined;
      if (!ns || typeof ns.id !== 'string' || !ns.id.trim()) return 'add_stage: missing new_stage.id';
      if (ids.has(ns.id)) return `add_stage: id ${ns.id} already exists`;
      const moves = Array.isArray(change.move_files) ? change.move_files : [];
      for (const move of moves) {
        if (typeof move !== 'object' || move === null) return 'add_stage: malformed move_files entry';
        const m = move as Record<string, unknown>;
        if (typeof m.file !== 'string' || !m.file) return 'add_stage: move_files entry missing file';
        const from = typeof m.from_stage === 'string' ? m.from_stage : 'unassigned';
        if (from === 'unassigned') {
          if (!assignment.coverage.unassigned.includes(m.file))
            return `add_stage: ${m.file} is not unassigned`;
        } else if (!(assignment.buckets[from] ?? []).includes(m.file)) {
          return `add_stage: ${m.file} is not in stage ${from}`;
        }
      }
      return null;
    }
    case 'remove_stage': {
      const sid = change.stage_id;
      if (typeof sid !== 'string' || !ids.has(sid)) return 'remove_stage: unknown stage_id';
      const bucket = assignment.buckets[sid] ?? [];
      const moveTo = change.move_to;
      if (bucket.length > 0) {
        if (typeof moveTo !== 'string' || !ids.has(moveTo))
          return 'remove_stage: non-empty stage needs a valid move_to';
        if (moveTo === sid) return 'remove_stage: move_to equals stage_id';
      }
      return null;
    }
    case 'merge_stages': {
      const sources = Array.isArray(change.stages_to_merge) ? change.stages_to_merge : [];
      if (sources.length === 0) return 'merge_stages: empty stages_to_merge';
      for (const s of sources)
        if (typeof s !== 'string' || !ids.has(s)) return `merge_stages: unknown source ${String(s)}`;
      const into = change.into;
      if (typeof into !== 'string') return 'merge_stages: missing into';
      if (!ids.has(into) && !sources.includes(into)) return 'merge_stages: unknown target';
      // A merge whose only sources are the target itself moves nothing — apply
      // would no-op yet count as progress, wasting a normalize/reassign round.
      if (sources.every((s) => s === into))
        return 'merge_stages: nothing to merge (sources equal the target)';
      return null;
    }
    case 'split_stage': {
      const source = change.source_stage;
      if (typeof source !== 'string' || !ids.has(source)) return 'split_stage: unknown source_stage';
      const newStages = Array.isArray(change.new_stages) ? change.new_stages : [];
      if (newStages.length === 0) return 'split_stage: no new_stages';
      const bucket = new Set(assignment.buckets[source] ?? []);
      let movesSomething = false;
      const newIds = new Set<string>();
      for (const raw of newStages) {
        if (typeof raw !== 'object' || raw === null) return 'split_stage: malformed new_stages entry';
        const ns = raw as Record<string, unknown>;
        if (typeof ns.id !== 'string' || !ns.id.trim()) return 'split_stage: new stage missing id';
        if (ns.id !== source) {
          if (ids.has(ns.id) || newIds.has(ns.id)) return `split_stage: id collision ${ns.id}`;
          newIds.add(ns.id);
        }
        const files = Array.isArray(ns.files) ? ns.files : [];
        for (const f of files) {
          if (typeof f !== 'string' || !bucket.has(f))
            return `split_stage: ${String(f)} not in source bucket`;
        }
        if (ns.id !== source && files.length > 0) movesSomething = true;
      }
      if (!movesSomething) return 'split_stage: no non-source stage moves any files';
      return null;
    }
    default:
      return `unknown action ${String(change.action)}`;
  }
}

/**
 * Apply one validated change in place. Returns the affected files (which the
 * caller re-assigns — moves are advisory, assignment stays purpose-aware).
 */
export function applyChange(skeleton: Skeleton, change: DoctorChange, assignment: Assignment): string[] {
  switch (change.action) {
    case 'add_stage': {
      const ns = change.new_stage as Record<string, unknown>;
      skeleton.stages.push({
        id: String(ns.id),
        title: typeof ns.title === 'string' ? ns.title : String(ns.id),
        description: typeof ns.description === 'string' ? ns.description : '',
        parent: typeof ns.parent === 'string' && ns.parent !== 'null' ? ns.parent : null,
        children: [],
        crosscut: ns.crosscut === true,
      });
      const moves = Array.isArray(change.move_files) ? change.move_files : [];
      return moves
        .map((m) =>
          typeof m === 'object' && m !== null ? String((m as Record<string, unknown>).file ?? '') : '',
        )
        .filter(Boolean);
    }
    case 'remove_stage': {
      const sid = String(change.stage_id);
      const affected = [...(assignment.buckets[sid] ?? [])];
      const removed = skeleton.stages.find((s) => s.id === sid);
      skeleton.stages = skeleton.stages.filter((s) => s.id !== sid);
      for (const stage of skeleton.stages) {
        if (stage.parent === sid) stage.parent = removed?.parent ?? null;
      }
      return affected;
    }
    case 'merge_stages': {
      const sources = (change.stages_to_merge as string[]).filter((s) => s !== change.into);
      const target = String(change.into);
      const affected = sources.flatMap((s) => assignment.buckets[s] ?? []);
      skeleton.stages = skeleton.stages.filter((s) => !sources.includes(s.id));
      for (const stage of skeleton.stages) {
        if (stage.parent !== null && sources.includes(stage.parent)) stage.parent = target;
      }
      return affected;
    }
    case 'split_stage': {
      const source = String(change.source_stage);
      const affected = new Set(assignment.buckets[source] ?? []);
      const newStages = change.new_stages as Array<Record<string, unknown>>;
      for (const ns of newStages) {
        const id = String(ns.id);
        if (id === source) {
          const existing = skeleton.stages.find((s) => s.id === source);
          if (existing && typeof ns.description === 'string') existing.description = ns.description;
          continue;
        }
        skeleton.stages.push({
          id,
          title: typeof ns.title === 'string' ? ns.title : id,
          description: typeof ns.description === 'string' ? ns.description : '',
          parent: typeof ns.parent === 'string' ? ns.parent : source,
          children: [],
          crosscut: false,
        });
        for (const f of (Array.isArray(ns.files) ? ns.files : []) as string[]) affected.add(f);
      }
      return [...affected];
    }
    default:
      return [];
  }
}

export interface DoctorRoundResult {
  skeletonChanged: boolean;
  affectedFiles: string[];
  nApplied: number;
  nProposed: number;
  nRejected: number;
}

const CRITIC_ROLES: CriticRole[] = ['engineer', 'architect', 'reader'];

export async function runDoctorRound(
  client: ChatClient,
  skeleton: Skeleton,
  assignment: Assignment,
  cards: Record<string, FileCard>,
  logger: Logger = silentLogger,
): Promise<DoctorRoundResult> {
  const stats = computeStageStats(skeleton, assignment);
  const evidence = renderStats(skeleton, stats, cards);
  const actorPrompt = `${ACTOR_RULES}\n\n## Ground truth\n${evidence}`;
  const result = await actorCriticLoop(client, actorPrompt, {
    roles: CRITIC_ROLES,
    taskContext: `File-level skeleton doctor. ${skeleton.stages.length} stages, ${stats.nFiles} files, ${stats.nUnassigned} unassigned.`,
    schemaHint: SCHEMA_HINT,
    evidence,
    logger,
  });

  if (!result.accepted || typeof result.proposal !== 'object' || result.proposal === null) {
    return { skeletonChanged: false, affectedFiles: [], nApplied: 0, nProposed: 0, nRejected: 0 };
  }
  const changes = Array.isArray((result.proposal as Record<string, unknown>).changes)
    ? ((result.proposal as Record<string, unknown>).changes as DoctorChange[])
    : [];
  const affected = new Set<string>();
  let applied = 0;
  let rejected = 0;
  for (const change of changes) {
    const error = validateChange(change, skeleton, assignment);
    if (error) {
      rejected += 1;
      logger.warn(`[doctor] rejected ${String(change.action)}: ${error}`);
      continue;
    }
    for (const file of applyChange(skeleton, change, assignment)) affected.add(file);
    applied += 1;
  }
  if (applied > 0) {
    // Re-normalize ids/parents/children after structural edits.
    const normalized = normalizeSkeleton(
      { metadata: skeleton.metadata, stages: skeleton.stages },
      skeleton.metadata.draftedBy ?? 'skeleton-doctor',
    );
    normalized.metadata.archetype = skeleton.metadata.archetype;
    skeleton.stages = normalized.stages;
  }
  return {
    skeletonChanged: applied > 0,
    affectedFiles: [...affected],
    nApplied: applied,
    nProposed: changes.length,
    nRejected: rejected,
  };
}

export interface SynthLoopOptions {
  maxRounds?: number;
  lang?: NarrateLang;
  assignBatchSize?: number;
  assignWorkers?: number;
  /** Cooperative cancellation: checked between doctor rounds and threaded into the assignment passes. */
  signal?: AbortSignal;
  logger?: Logger;
  /** Keep a synthesis reply that produced no usable stages, for inspection. */
  onRejectedReply?: (reply: string) => void;
}

/** Draft → assign → doctor rounds until convergence (doctor synth mode). */
export async function synthesizeWithDoctor(
  client: ChatClient,
  graph: CodeGraph,
  cards: Record<string, FileCard>,
  options: SynthLoopOptions = {},
): Promise<{ skeleton: Skeleton; assignment: Assignment; rounds: number }> {
  const {
    maxRounds = PIPELINE_DEFAULTS.maxDoctorRounds,
    lang = PIPELINE_DEFAULTS.narrateLang,
    signal,
  } = options;
  const logger = options.logger ?? silentLogger;
  const assignOptions = {
    batchSize: options.assignBatchSize,
    maxWorkers: options.assignWorkers,
    cards,
    signal,
    logger,
  };

  const nav = buildNavPack(graph);
  const skeleton = await synthesizeSkeleton(client, nav, cards, lang, options.onRejectedReply, signal);
  let assignment = await assignFiles(client, graph, skeleton, assignOptions);

  let noProgressStreak = 0;
  let roundsRun = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    signal?.throwIfAborted(); // cooperative checkpoint between doctor rounds
    roundsRun = round + 1;
    const before = computeStageStats(skeleton, assignment);
    const overloadedBefore = Object.values(before.perStage).filter((s) => s.overloaded).length;

    const doctor = await runDoctorRound(client, skeleton, assignment, cards, logger);
    if (doctor.skeletonChanged) {
      const subset = [...new Set([...doctor.affectedFiles, ...assignment.coverage.unassigned])];
      assignment = await reassignSubset(client, graph, skeleton, subset, assignment, assignOptions);
    } else {
      // Reconcile buckets against the (possibly unchanged) skeleton anyway.
      assignment = rebuildAssignment(assignment.fileStage, skeleton);
    }

    const after = computeStageStats(skeleton, assignment);
    const overloadedAfter = Object.values(after.perStage).filter((s) => s.overloaded).length;
    logger.info(
      `[doctor] round ${round + 1}: applied=${doctor.nApplied} rejected=${doctor.nRejected} unassigned=${after.nUnassigned} overloaded=${overloadedAfter}`,
    );

    if (after.nUnassigned === 0 && !doctor.skeletonChanged) break;
    const progress = after.nUnassigned < before.nUnassigned || overloadedAfter < overloadedBefore;
    noProgressStreak = progress ? 0 : noProgressStreak + 1;
    if (noProgressStreak >= 2) {
      logger.warn(`[doctor] stuck after ${round + 1} rounds; ${after.nUnassigned} files remain unassigned`);
      break;
    }
  }
  return { skeleton, assignment, rounds: roundsRun };
}
