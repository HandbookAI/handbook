/**
 * Phase 2b (step B) — assign every file to exactly one primary stage
 * (batched LLM calls against a fixed stage menu, with an `unassigned` escape).
 */
import { allFileDescriptors, buildNavPack, type NavFileDescriptor } from '@handbooks/analyzer';
import type { ChatClient } from '@handbooks/llm';
import {
  PIPELINE_DEFAULTS,
  Progress,
  mapLimit,
  silentLogger,
  truncate,
  type Assignment,
  type CodeGraph,
  type FileCard,
  type Logger,
  type Skeleton,
  describeJsonShape,
  extractEntryList,
  replyExcerpt,
} from '@handbooks/core';
import { stageShortDescriptions } from './skeleton.js';
import type { ProgressSink } from '@handbooks/core';

const ASSIGN_RULES = `You are assigning whole SOURCE FILES to stages of a system handbook.
Pick the ONE stage whose description best matches each file's PRIMARY responsibility; genuinely
cross-cutting utilities go to the best-fit crosscut stage.
Rules:
- "stage" MUST be an ID from the stage menu — never invent one.
- Assign by PRIMARY identity. Optionally add "also": 0-2 extra stage IDs, only for files that
  genuinely span stages — do not pad it.
- Files that genuinely belong nowhere (generated/vendored/dead code) get "stage": "unassigned".
Output ONLY one JSON block:
\`\`\`json
{"assignments": [{"file": "<exact path>", "stage": "<stage-id|unassigned>", "also": []}]}
\`\`\``;

export interface AssignOptions {
  batchSize?: number;
  maxWorkers?: number;
  cards?: Record<string, FileCard>;
  /** Cooperative cancellation: checked per batch and passed into every LLM call. */
  signal?: AbortSignal;
  logger?: Logger;
  /** Machine-readable progress, for a UI drawing a bar. */
  onProgress?: ProgressSink;
}

function fileDescriptorLine(descriptor: NavFileDescriptor, card: FileCard | undefined): string {
  const classes = descriptor.classes.length ? ` classes=[${descriptor.classes.join(', ')}]` : '';
  const lines = [`- ${descriptor.file}  (${descriptor.nFunctions} fn)${classes}`];
  if (card?.purpose) {
    lines.push(`    purpose: ${card.purpose}  [role=${card.role}, lifecycle=${card.lifecycle}]`);
  }
  const samples = descriptor.sampleFunctions
    .slice(0, 8)
    .map((f) => truncate(`${f.qualname} ${f.signature}`, 90));
  lines.push(`    fns: ${samples.length ? samples.join('; ') : '(none sampled)'}`);
  return lines.join('\n');
}

function buildMenuBlock(skeleton: Skeleton): string {
  const menu = stageShortDescriptions(skeleton);
  return ['## Stage menu (valid IDs)', ...[...menu.entries()].map(([id, text]) => `- ${id} — ${text}`)].join(
    '\n',
  );
}

async function assignBatch(
  client: ChatClient,
  batch: NavFileDescriptor[],
  menuBlock: string,
  validIds: ReadonlySet<string>,
  cards: Record<string, FileCard>,
  logger: Logger,
  signal?: AbortSignal,
): Promise<Record<string, { stage: string; also: string[] }>> {
  const prompt = [
    ASSIGN_RULES,
    menuBlock,
    `## Files to assign (${batch.length})`,
    ...batch.map((d) => fileDescriptorLine(d, cards[d.file])),
  ].join('\n\n');
  const out: Record<string, { stage: string; also: string[] }> = {};
  try {
    const response = await client.complete(prompt, { temperature: 0, signal });
    const entries = extractEntryList(response.json, ['assignments', 'files'], {
      single: { fields: ['stage', 'file'] },
    });
    const batchFiles = new Set(batch.map((d) => d.file));
    const soleFile = batch.length === 1 && entries.length === 1 ? batch[0]?.file : undefined;
    for (const entry of entries) {
      const named = typeof entry.file === 'string' ? entry.file.trim() : undefined;
      // A named file must be one we asked about; only an entry with NO file at
      // all inherits the single-file batch's identity.
      const file = named ? (batchFiles.has(named) ? named : undefined) : soleFile;
      if (!file) continue;
      const stage = typeof entry.stage === 'string' && validIds.has(entry.stage) ? entry.stage : 'unassigned';
      const also = Array.isArray(entry.also)
        ? entry.also
            .filter((a): a is string => typeof a === 'string' && validIds.has(a) && a !== stage)
            .slice(0, 2)
        : [];
      out[file] = { stage, also };
    }
    if (Object.keys(out).length === 0) {
      logger.warn(
        `[assign] batch of ${batch.length} returned no usable assignments (${describeJsonShape(
          response.json,
        )}) — reply: ${replyExcerpt(response.text)}`,
      );
    }
  } catch (error) {
    signal?.throwIfAborted(); // cancellation ends the pass, never degrades
    logger.warn(`[assign] batch of ${batch.length} failed: ${String(error)}`);
  }
  return out;
}

/** Rebuild buckets/coverage from a fileStage map against the CURRENT stage ids. */
export function rebuildAssignment(
  fileStage: Record<string, { stage: string; also: string[] }>,
  skeleton: Skeleton,
): Assignment {
  const validIds = new Set(skeleton.stages.map((s) => s.id));
  const buckets: Record<string, string[]> = {};
  const unassigned: string[] = [];
  const cleaned: Record<string, { stage: string; also: string[] }> = {};
  for (const [file, entry] of Object.entries(fileStage)) {
    const stage = validIds.has(entry.stage) ? entry.stage : 'unassigned';
    const also = entry.also.filter((a) => validIds.has(a) && a !== stage);
    cleaned[file] = { stage, also };
    if (stage === 'unassigned') unassigned.push(file);
    else (buckets[stage] ??= []).push(file);
  }
  for (const bucket of Object.values(buckets)) bucket.sort();
  return {
    version: 1,
    fileStage: cleaned,
    buckets,
    coverage: {
      nFiles: Object.keys(cleaned).length,
      nAssigned: Object.keys(cleaned).length - unassigned.length,
      unassigned: unassigned.sort(),
    },
  };
}

export async function assignFiles(
  client: ChatClient,
  graph: CodeGraph,
  skeleton: Skeleton,
  options: AssignOptions = {},
): Promise<Assignment> {
  const {
    batchSize = PIPELINE_DEFAULTS.assignBatchSize,
    maxWorkers = PIPELINE_DEFAULTS.assignWorkers,
    cards = {},
    signal,
  } = options;
  const logger = options.logger ?? silentLogger;
  const nav = buildNavPack(graph);
  const files = allFileDescriptors(graph, nav);
  const menuBlock = buildMenuBlock(skeleton);
  const validIds = new Set(skeleton.stages.map((s) => s.id));

  const batches: NavFileDescriptor[][] = [];
  for (let i = 0; i < files.length; i += batchSize) batches.push(files.slice(i, i + batchSize));

  const fileStage: Record<string, { stage: string; also: string[] }> = {};
  const progress = new Progress(logger, 'assign', files.length, options.onProgress);
  await mapLimit(batches, maxWorkers, async (batch) => {
    signal?.throwIfAborted(); // cooperative checkpoint: no new batch after abort
    const result = await assignBatch(client, batch, menuBlock, validIds, cards, logger, signal);
    Object.assign(fileStage, result);
    progress.tick(batch.length);
  });
  progress.finish('file');

  // Backfill files the LLM dropped.
  for (const descriptor of files) {
    fileStage[descriptor.file] ??= { stage: 'unassigned', also: [] };
  }
  return rebuildAssignment(fileStage, skeleton);
}

/** Re-assign only `subset`, merged over a previous assignment. */
export async function reassignSubset(
  client: ChatClient,
  graph: CodeGraph,
  skeleton: Skeleton,
  subset: readonly string[],
  previous: Assignment,
  options: AssignOptions = {},
): Promise<Assignment> {
  const {
    batchSize = PIPELINE_DEFAULTS.assignBatchSize,
    maxWorkers = PIPELINE_DEFAULTS.assignWorkers,
    cards = {},
    signal,
  } = options;
  const logger = options.logger ?? silentLogger;
  const nav = buildNavPack(graph);
  const files = allFileDescriptors(graph, nav).filter((d) => subset.includes(d.file));
  const menuBlock = buildMenuBlock(skeleton);
  const validIds = new Set(skeleton.stages.map((s) => s.id));

  const merged: Record<string, { stage: string; also: string[] }> = { ...previous.fileStage };
  const batches: NavFileDescriptor[][] = [];
  for (let i = 0; i < files.length; i += batchSize) batches.push(files.slice(i, i + batchSize));
  await mapLimit(batches, maxWorkers, async (batch) => {
    signal?.throwIfAborted(); // cooperative checkpoint: no new batch after abort
    Object.assign(merged, await assignBatch(client, batch, menuBlock, validIds, cards, logger, signal));
  });
  return rebuildAssignment(merged, skeleton);
}
