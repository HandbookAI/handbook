/**
 * Phase 2c — organize each stage's files into 2–8 ordered sub-groups.
 * The call graph supplies the prior (callers before callees, Kahn's sort);
 * the LLM only groups and titles. Every failure degrades to a deterministic
 * flat group — a stage's files are never dropped.
 */
import type { ChatClient } from '@handbook/llm';
import {
  Progress,
  isInternalNode,
  mapLimit,
  silentLogger,
  type Assignment,
  type CodeGraph,
  type FileCard,
  type Logger,
  type NarrateLang,
  type Organization,
  type OrganizedFile,
  type Skeleton,
  describeJsonShape,
  extractEntryList,
  replyExcerpt,
} from '@handbook/core';

/** file → set of files it calls into (internal→internal edges, self edges dropped). */
export function fileCallAdjacency(graph: CodeGraph): Map<string, Set<string>> {
  const fileOf = new Map<string, string>();
  for (const node of Object.values(graph.nodes)) {
    if (isInternalNode(node)) fileOf.set(node.id, node.file);
  }
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const from = fileOf.get(edge.callerId);
    const to = fileOf.get(edge.calleeId);
    if (!from || !to || from === to) continue;
    const set = adjacency.get(from) ?? new Set<string>();
    set.add(to);
    adjacency.set(from, set);
  }
  return adjacency;
}

/** Kahn's topological order over the in-stage subgraph: callers before callees. */
export function suggestOrder(files: readonly string[], adjacency: Map<string, Set<string>>): string[] {
  const inStage = new Set(files);
  const outDegree = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const file of files) {
    incoming.set(file, 0);
    outDegree.set(file, 0);
  }
  for (const file of files) {
    for (const callee of adjacency.get(file) ?? []) {
      if (!inStage.has(callee) || callee === file) continue;
      outDegree.set(file, (outDegree.get(file) ?? 0) + 1);
      incoming.set(callee, (incoming.get(callee) ?? 0) + 1);
    }
  }
  const tiebreak = (a: string, b: string): number =>
    (outDegree.get(b) ?? 0) - (outDegree.get(a) ?? 0) || a.localeCompare(b);
  const ready = files.filter((f) => (incoming.get(f) ?? 0) === 0).sort(tiebreak);
  const order: string[] = [];
  const placed = new Set<string>();
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);
    placed.add(next);
    for (const callee of adjacency.get(next) ?? []) {
      if (!inStage.has(callee) || placed.has(callee)) continue;
      const remaining = (incoming.get(callee) ?? 1) - 1;
      incoming.set(callee, remaining);
      if (remaining === 0) {
        ready.push(callee);
        ready.sort(tiebreak);
      }
    }
  }
  // Cycle leftovers, orchestrators first.
  const leftovers = files.filter((f) => !placed.has(f)).sort(tiebreak);
  return [...order, ...leftovers];
}

const ORGANIZE_RULES_EN = `You are organizing the files of ONE stage of a system handbook into a readable structure.
You get the stage's files (with a one-line purpose each) in suggested execution order.
Jobs:
1. Group them into 2-8 coherent SUB-GROUPS.
2. Order files within each group as a narrative (entry/setup → core work → finalization),
   respecting the suggested order and the "calls into" hints.
3. Order the groups the same way.
Rules: every file appears in EXACTLY ONE group; use exact paths; short noun-phrase group titles;
one-sentence group summaries.
Output ONLY one JSON block:
\`\`\`json
{"groups": [{"title": "...", "summary": "...", "files": ["<exact path>"]}]}
\`\`\``;

const ORGANIZE_RULES_ZH = `你在把系统手册中一个阶段的文件组织成可读结构。输入是该阶段文件清单（每个带一句用途），已按建议执行顺序排列。
任务：分成 2-8 个连贯的小组；组内与组间都按叙事顺序（入口/准备 → 核心工作 → 收尾）排列，尊重建议顺序与调用提示。
规则：每个文件恰好出现在一个组；使用精确路径；组标题用简短名词短语（中文）；每组一句话摘要（中文）。
只输出一个 JSON 块（schema 同英文版）。`;

export interface OrganizeOptions {
  workers?: number;
  lang?: NarrateLang;
  logger?: Logger;
}

interface StageOrganization {
  title: string;
  groups: Array<{ title: string; summary: string; files: OrganizedFile[] }>;
  orderedFiles: string[];
}

function toOrganizedFile(file: string, cards: Record<string, FileCard>): OrganizedFile {
  const card = cards[file];
  return {
    file,
    purpose: card?.purpose ?? '',
    role: card?.role ?? 'other',
    nFunctions: card?.functions?.length ?? 0,
  };
}

async function organizeOneStage(
  client: ChatClient,
  stageId: string,
  title: string,
  description: string,
  orderedInput: string[],
  adjacency: Map<string, Set<string>>,
  cards: Record<string, FileCard>,
  lang: NarrateLang,
  logger: Logger,
): Promise<StageOrganization> {
  const flat = (summary: string): StageOrganization => ({
    title,
    groups: [{ title: '(ungrouped)', summary, files: orderedInput.map((f) => toOrganizedFile(f, cards)) }],
    orderedFiles: [...orderedInput],
  });
  if (orderedInput.length <= 1) {
    return {
      title,
      groups: [{ title, summary: '', files: orderedInput.map((f) => toOrganizedFile(f, cards)) }],
      orderedFiles: [...orderedInput],
    };
  }

  const inStage = new Set(orderedInput);
  const rows = orderedInput.map((file) => {
    const card = cards[file];
    const callees = [...(adjacency.get(file) ?? [])].filter((c) => inStage.has(c)).slice(0, 4);
    const meta = card ? `  [${card.role}, ${card.functions?.length ?? 0} fn]` : '';
    const calls = callees.length ? `  calls→ [${callees.join(', ')}]` : '';
    return `- ${file}${meta}\n    ${card?.purpose ?? ''}${calls}`;
  });
  const prompt = [
    lang === 'zh' ? ORGANIZE_RULES_ZH : ORGANIZE_RULES_EN,
    `## Stage: ${stageId} — ${title}`,
    description,
    `## Files in this stage (${orderedInput.length}, suggested execution order)`,
    ...rows,
  ].join('\n\n');

  let rawGroups: Array<Record<string, unknown>> = [];
  try {
    const response = await client.complete(prompt, { temperature: 0 });
    rawGroups = extractEntryList(response.json, ['groups', 'sections'], {
      single: { fields: ['title', 'files'] },
    });
    if (rawGroups.length === 0) {
      logger.warn(
        `[organize] ${stageId} returned no usable groups (${describeJsonShape(
          response.json,
        )}) — reply: ${replyExcerpt(response.text)}`,
      );
    }
  } catch (error) {
    logger.warn(`[organize] ${stageId} LLM failed: ${String(error)}`);
    return flat('(organize failed; flat call-graph order)');
  }
  if (rawGroups.length === 0) {
    return flat('(organize returned no groups; flat call-graph order)');
  }

  const seen = new Set<string>();
  const groups: StageOrganization['groups'] = [];
  for (const raw of rawGroups) {
    if (typeof raw !== 'object' || raw === null) continue;
    const g = raw as Record<string, unknown>;
    const files: OrganizedFile[] = [];
    for (const f of Array.isArray(g.files) ? g.files : []) {
      if (typeof f !== 'string' || !inStage.has(f) || seen.has(f)) continue;
      seen.add(f);
      files.push(toOrganizedFile(f, cards));
    }
    if (files.length === 0) continue;
    groups.push({
      title: typeof g.title === 'string' && g.title.trim() ? g.title.trim() : 'Group',
      summary: typeof g.summary === 'string' ? g.summary : '',
      files,
    });
  }
  const unplaced = orderedInput.filter((f) => !seen.has(f));
  if (unplaced.length > 0) {
    groups.push({
      title: 'Other',
      summary: '(not placed by the model)',
      files: unplaced.map((f) => toOrganizedFile(f, cards)),
    });
  }
  if (groups.length === 0) return flat('(organize produced nothing usable; flat call-graph order)');
  return { title, groups, orderedFiles: groups.flatMap((g) => g.files.map((f) => f.file)) };
}

export async function organizeStages(
  client: ChatClient,
  graph: CodeGraph,
  skeleton: Skeleton,
  assignment: Assignment,
  cards: Record<string, FileCard>,
  options: OrganizeOptions = {},
): Promise<Organization> {
  const { workers = 8, lang = 'en' } = options;
  const logger = options.logger ?? silentLogger;
  const adjacency = fileCallAdjacency(graph);

  const work = skeleton.stages.filter((s) => (assignment.buckets[s.id]?.length ?? 0) > 0);
  const progress = new Progress(logger, 'organize', work.length);
  const results = new Map<string, StageOrganization>();
  await mapLimit(work, workers, async (stage) => {
    const bucket = assignment.buckets[stage.id] ?? [];
    const ordered = suggestOrder(bucket, adjacency);
    try {
      results.set(
        stage.id,
        await organizeOneStage(client, stage.id, stage.title, stage.description, ordered, adjacency, cards, lang, logger),
      );
    } catch (error) {
      logger.warn(`[organize] ${stage.id} failed hard: ${String(error)}`);
      results.set(stage.id, {
        title: stage.title,
        groups: [
          {
            title: '(ungrouped)',
            summary: '(organize failed; flat call-graph order)',
            files: ordered.map((f) => toOrganizedFile(f, cards)),
          },
        ],
        orderedFiles: ordered,
      });
    }
    progress.tick(1, stage.id);
  });
  progress.finish('stage');

  // Re-key in skeleton order.
  const stages: Organization['stages'] = {};
  for (const stage of skeleton.stages) {
    const entry = results.get(stage.id);
    if (entry) stages[stage.id] = entry;
  }
  const nFiles = new Set(Object.values(assignment.buckets).flat()).size;
  const nOrganized = Object.values(stages).reduce((sum, s) => sum + s.orderedFiles.length, 0);
  return {
    metadata: { version: 1, nStages: Object.keys(stages).length },
    stages,
    coverage: { nFiles, nOrganized },
  };
}
