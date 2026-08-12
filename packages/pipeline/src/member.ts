/**
 * Member-granularity strategy (for smaller codebases).
 *
 * The user authors the stage skeleton; the pipeline classifies individual
 * FUNCTIONS/METHODS ("members") into those stages, then derives the file-level
 * artifacts (assignment + organization) from the member map so the rest of
 * the toolchain — narration, rendering, skill packaging — works unchanged.
 * A file whose members span stages goes to the stage owning most of its
 * members; its per-function notes keep the fine-grained story.
 */
import { z } from 'zod';
import type { ChatClient } from '@handbooks/llm';
import {
  Progress,
  isInternalNode,
  mapLimit,
  silentLogger,
  truncate,
  writeJsonFile,
  type Assignment,
  type CodeGraph,
  type FileCard,
  type Logger,
  type Organization,
  type OrganizedFile,
  type Skeleton,
  describeJsonShape,
  extractEntryList,
  replyExcerpt,
} from '@handbooks/core';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { stageShortDescriptions } from './skeleton.js';
import { fileCallAdjacency, suggestOrder } from './organize.js';
import type { WorkDir } from './workdir.js';
import type { ProgressSink } from '@handbooks/core';

export const memberAssignmentSchema = z.object({
  version: z.literal(1),
  /** function id → stage id (or `unassigned`). */
  memberStage: z.record(z.string(), z.string()),
  buckets: z.record(z.string(), z.array(z.string())),
  coverage: z.object({
    nMembers: z.number().int(),
    nAssigned: z.number().int(),
    unassigned: z.array(z.string()),
  }),
});
export type MemberAssignment = z.infer<typeof memberAssignmentSchema>;

const CLASSIFY_RULES = `You are assigning individual FUNCTIONS/METHODS of a codebase to the stages of a system handbook.
The stage skeleton was written by the project's maintainer — treat it as authoritative.
For each member below, pick the ONE stage whose description best matches what the member does at
runtime (use its signature, file, and call relations). Cross-cutting helpers go to the best-fit
crosscut stage. "stage" MUST be an ID from the menu; a member that genuinely fits nowhere gets
"unassigned".
Output ONLY one JSON block:
\`\`\`json
{"assignments": [{"member": "<exact member id>", "stage": "<stage-id|unassigned>"}]}
\`\`\``;

export interface ClassifyMembersOptions {
  batchSize?: number;
  maxWorkers?: number;
  cards?: Record<string, FileCard>;
  /** Cooperative cancellation: checked per batch and passed into every LLM call. */
  signal?: AbortSignal;
  logger?: Logger;
  /** Machine-readable progress, for a UI drawing a bar. */
  onProgress?: ProgressSink;
}

interface MemberDescriptor {
  id: string;
  qualname: string;
  file: string;
  signature: string;
  lineStart: number;
  calls: string[];
  calledBy: string[];
}

function collectMembers(graph: CodeGraph): MemberDescriptor[] {
  const calls = new Map<string, string[]>();
  const calledBy = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const callee = graph.nodes[edge.calleeId];
    if (callee && isInternalNode(callee)) {
      (calls.get(edge.callerId) ?? calls.set(edge.callerId, []).get(edge.callerId))?.push(callee.qualname);
      (calledBy.get(edge.calleeId) ?? calledBy.set(edge.calleeId, []).get(edge.calleeId))?.push(
        edge.callerId,
      );
    }
  }
  return Object.values(graph.nodes)
    .filter(
      (n): n is Extract<CodeGraph['nodes'][string], { kind: 'internal' }> =>
        isInternalNode(n) && !n.synthetic && n.lineStart > 0,
    )
    .map((n) => ({
      id: n.id,
      qualname: n.qualname,
      file: n.file,
      signature: truncate(n.signature, 120),
      lineStart: n.lineStart,
      calls: (calls.get(n.id) ?? []).slice(0, 6),
      calledBy: (calledBy.get(n.id) ?? []).slice(0, 6),
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.lineStart - b.lineStart);
}

export async function classifyMembers(
  client: ChatClient,
  graph: CodeGraph,
  skeleton: Skeleton,
  options: ClassifyMembersOptions = {},
): Promise<MemberAssignment> {
  const { batchSize = 40, maxWorkers = 8, cards = {}, signal } = options;
  const logger = options.logger ?? silentLogger;
  const members = collectMembers(graph);
  const validIds = new Set(skeleton.stages.map((s) => s.id));
  const menu = stageShortDescriptions(skeleton);
  const menuBlock = [
    '## Stage menu (valid IDs)',
    ...[...menu.entries()].map(([id, t]) => `- ${id} — ${t}`),
  ].join('\n');

  const memberStage: Record<string, string> = {};
  const batches: MemberDescriptor[][] = [];
  for (let i = 0; i < members.length; i += batchSize) batches.push(members.slice(i, i + batchSize));

  const progress = new Progress(logger, 'members', members.length, options.onProgress);
  await mapLimit(batches, maxWorkers, async (batch) => {
    signal?.throwIfAborted(); // cooperative checkpoint: no new batch after abort
    const rows = batch.map((m) => {
      const filePurpose = cards[m.file]?.purpose ? `  (file: ${cards[m.file]?.purpose})` : '';
      const rels = [
        m.calls.length ? `calls: ${m.calls.join(', ')}` : '',
        m.calledBy.length ? `called by: ${m.calledBy.map((c) => c.split(/[.:]/).pop()).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      return `- ${m.id}\n    ${m.signature}  in ${m.file}${filePurpose}${rels ? `\n    ${rels}` : ''}`;
    });
    const prompt = [CLASSIFY_RULES, menuBlock, `## Members to assign (${batch.length})`, ...rows].join(
      '\n\n',
    );
    try {
      const response = await client.complete(prompt, { temperature: 0, signal });
      const entries = extractEntryList(response.json, ['assignments', 'members'], {
        single: { fields: ['member', 'stage'] },
      });
      const batchIds = new Set(batch.map((m) => m.id));
      let usable = 0;
      // Only a batch of ONE is unambiguous. Pinning an unrecognised entry onto
      // batch[0] would file a member the model never mentioned into a stage.
      const soleMember = batch.length === 1 && entries.length === 1 ? batch[0]?.id : undefined;
      for (const entry of entries) {
        const named = typeof entry.member === 'string' ? entry.member : undefined;
        const member = named ? (batchIds.has(named) ? named : undefined) : soleMember;
        if (!member) continue;
        usable += 1;
        memberStage[member] =
          typeof entry.stage === 'string' && validIds.has(entry.stage) ? entry.stage : 'unassigned';
      }
      // Warn on a mostly-lost batch too, not only a fully lost one: 1 usable
      // entry out of 40 members is a failed call wearing a success costume.
      if (usable * 2 < batch.length) {
        logger.warn(
          `[members] batch of ${batch.length} yielded only ${usable} usable assignment(s) (${describeJsonShape(
            response.json,
          )}) — reply: ${replyExcerpt(response.text)}`,
        );
      }
    } catch (error) {
      signal?.throwIfAborted(); // cancellation ends the pass, never degrades
      logger.warn(`[members] batch failed: ${String(error)}`);
    }
    progress.tick(batch.length);
  });
  progress.finish('member');

  for (const member of members) memberStage[member.id] ??= 'unassigned';

  const buckets: Record<string, string[]> = {};
  const unassigned: string[] = [];
  for (const [id, stage] of Object.entries(memberStage)) {
    if (stage === 'unassigned') unassigned.push(id);
    else (buckets[stage] ??= []).push(id);
  }
  for (const bucket of Object.values(buckets)) bucket.sort();
  return {
    version: 1,
    memberStage,
    buckets,
    coverage: {
      nMembers: members.length,
      nAssigned: members.length - unassigned.length,
      unassigned: unassigned.sort(),
    },
  };
}

/**
 * Derive the file-level assignment + organization from a member assignment:
 * a file's primary stage = majority stage of its members (ties → earliest
 * stage in skeleton order); per stage, groups = one group per file, ordered
 * by the call-graph order of files.
 */
export function deriveFileArtifacts(
  graph: CodeGraph,
  skeleton: Skeleton,
  memberAssignment: MemberAssignment,
  cards: Record<string, FileCard>,
): { assignment: Assignment; organization: Organization } {
  const stageOrder = new Map(skeleton.stages.map((s, i) => [s.id, i]));
  const membersByFile = new Map<string, string[]>();
  for (const node of Object.values(graph.nodes)) {
    if (!isInternalNode(node) || node.synthetic || node.lineStart <= 0) continue;
    (membersByFile.get(node.file) ?? membersByFile.set(node.file, []).get(node.file))?.push(node.id);
  }

  const fileStage: Record<string, { stage: string; also: string[] }> = {};
  for (const file of graph.metadata.scannedFiles) {
    const members = membersByFile.get(file) ?? [];
    const votes = new Map<string, number>();
    for (const id of members) {
      const stage = memberAssignment.memberStage[id];
      if (stage && stage !== 'unassigned') votes.set(stage, (votes.get(stage) ?? 0) + 1);
    }
    if (votes.size === 0) {
      fileStage[file] = { stage: 'unassigned', also: [] };
      continue;
    }
    const ranked = [...votes.entries()].sort(
      (a, b) => b[1] - a[1] || (stageOrder.get(a[0]) ?? 0) - (stageOrder.get(b[0]) ?? 0),
    );
    const primary = ranked[0]?.[0] ?? 'unassigned';
    const also = ranked.slice(1, 3).map(([sid]) => sid);
    fileStage[file] = { stage: primary, also };
  }

  const buckets: Record<string, string[]> = {};
  const unassigned: string[] = [];
  for (const [file, entry] of Object.entries(fileStage)) {
    if (entry.stage === 'unassigned') unassigned.push(file);
    else (buckets[entry.stage] ??= []).push(file);
  }
  const assignment: Assignment = {
    version: 1,
    fileStage,
    buckets,
    coverage: {
      nFiles: Object.keys(fileStage).length,
      nAssigned: Object.keys(fileStage).length - unassigned.length,
      unassigned: unassigned.sort(),
    },
  };

  const adjacency = fileCallAdjacency(graph);
  const stages: Organization['stages'] = {};
  for (const stage of skeleton.stages) {
    const bucket = buckets[stage.id];
    if (!bucket || bucket.length === 0) continue;
    const ordered = suggestOrder(bucket, adjacency);
    const toOrganized = (file: string): OrganizedFile => ({
      file,
      purpose: cards[file]?.purpose ?? '',
      role: cards[file]?.role ?? 'other',
      nFunctions: (membersByFile.get(file) ?? []).length,
    });
    stages[stage.id] = {
      title: stage.title,
      groups: [
        {
          title: stage.title,
          summary: `Members of this stage, in call order (${bucket.length} files).`,
          files: ordered.map(toOrganized),
        },
      ],
      orderedFiles: ordered,
    };
  }
  const organization: Organization = {
    metadata: { version: 1, nStages: Object.keys(stages).length },
    stages,
    coverage: {
      nFiles: new Set(Object.values(buckets).flat()).size,
      nOrganized: Object.values(stages).reduce((sum, s) => sum + s.orderedFiles.length, 0),
    },
  };
  return { assignment, organization };
}

export function saveMemberAssignment(work: WorkDir, memberAssignment: MemberAssignment): void {
  writeJsonFile(join(work.phase2Dir, 'members.json'), memberAssignment);
}

/** Load `phase2/members.json`, or undefined when absent/invalid. */
export function loadMemberAssignment(work: WorkDir): MemberAssignment | undefined {
  try {
    const parsed = memberAssignmentSchema.safeParse(
      JSON.parse(readFileSync(join(work.phase2Dir, 'members.json'), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
