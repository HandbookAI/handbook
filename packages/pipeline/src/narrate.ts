/**
 * Phase 3 — bottom-up narration and state-register extraction.
 *
 * Stage summaries are produced deepest-first (children before parents) so a
 * parent's overview is written from its children's overviews plus its own
 * files. Every LLM summary is content-hash cached; a failed call degrades to
 * deterministic fallback prose so the build never blocks.
 */
import { join } from 'node:path';
import type { ChatClient } from '@handbook/llm';
import {
  StageTree,
  ensureDir,
  fileExists,
  mapLimit,
  readJsonFile,
  shortHash,
  silentLogger,
  writeFileAtomic,
  writeJsonFile,
  type Assignment,
  type FileCard,
  type Logger,
  type NarrateLang,
  type Narration,
  type Organization,
  type RegisterEntry,
  type Skeleton,
  describeJsonShape,
  extractEntryList,
  replyExcerpt,
} from '@handbook/core';
import { readFileSync } from 'node:fs';

const PROMPT_VERSION = 'phase3-rollup-v1';
const REGISTERS_VERSION = 'phase3-registers-v1';

const STAGE_RULES_EN = `You are writing a system handbook for a codebase, aimed at a curious NON-EXPERT reader.
You are writing the OVERVIEW for one stage. You get the stage's title/description plus its
SUB-STAGES (each with its own overview) and/or its directly-owned SOURCE FILES (one-line purposes).
Write a 100-200 word plain-language overview: what the stage is for, where it fits in the system's
life (startup, main loop, shutdown, shared support), and how its parts cooperate — like parts of a
machine. Plain language, short sentences, explain terms on first use, an analogy is welcome, stay
concrete and accurate, no filler.
Output ONLY the prose — no title, no list, no markdown headers, no echo of the input.`;

const STAGE_RULES_ZH = `你在为一个代码库撰写面向普通读者的系统手册，现在写其中一个阶段的概述。
输入是该阶段的标题/描述、它的子阶段（各自带概述）和/或它直接拥有的源文件（每个一句用途）。
写 100-200 字的大白话概述：这个阶段是干什么的、处在系统生命周期的哪个位置（启动/主循环/收尾/公共支撑）、
各部分如何像机器零件一样协作。短句、术语首次出现要解释、欢迎一个类比、具体准确、不要空话。
只输出正文——不要标题、列表、markdown 标记，不要复述输入。`;

const SYSTEM_RULES_EN = `You are writing the top-level overview of a system handbook for a curious NON-EXPERT reader.
You get the system archetype and its top-level stages in execution order, each with its overview.
Write 200-350 words: what the system does and what kind of thing it is, the start-to-finish story
threading the key stages together, and the shared behind-the-scenes support. One clear story,
plain language. Output ONLY the prose.`;

const SYSTEM_RULES_ZH = `你在为普通读者撰写系统手册的顶层总览。输入是系统类型（archetype）与按执行顺序排列的顶层阶段（各带概述）。
写 200-350 字：这个系统是做什么的、是什么类型的东西；用一条从启动到收尾的故事线把关键阶段串起来；
说明幕后公共支撑。只输出正文。`;

export interface NarrateOptions {
  workers?: number;
  refresh?: boolean;
  lang?: NarrateLang;
  cacheDir?: string;
  title?: string;
  logger?: Logger;
}

interface NarrateInputs {
  skeleton: Skeleton;
  assignment: Assignment;
  organization: Organization;
  cards: Record<string, FileCard>;
}

async function cachedCall(
  cacheDir: string | undefined,
  key: string,
  refresh: boolean,
  produce: () => Promise<string>,
  fallback: () => string,
  logger: Logger,
): Promise<string> {
  const path = cacheDir ? join(cacheDir, `${key}.md`) : undefined;
  if (path && !refresh && fileExists(path)) {
    return readFileSync(path, 'utf8');
  }
  let text = '';
  let succeeded = false;
  try {
    text = (await produce()).trim();
    succeeded = text.length > 0;
  } catch (error) {
    logger.warn(`[narrate] LLM failed for ${key}: ${String(error)}`);
  }
  if (!succeeded) text = fallback();
  // Only SUCCESSFUL prose is cached — caching the fallback would pin degraded
  // text under the same key forever (one transient outage → permanent damage).
  if (path && succeeded) {
    ensureDir(cacheDir as string);
    writeFileAtomic(path, text);
  }
  return text;
}

export async function narrate(
  client: ChatClient,
  inputs: NarrateInputs,
  options: NarrateOptions = {},
): Promise<Narration> {
  const { workers = 8, refresh = false, lang = 'en' } = options;
  const logger = options.logger ?? silentLogger;
  const tree = new StageTree(inputs.skeleton);
  const rules = lang === 'zh' ? STAGE_RULES_ZH : STAGE_RULES_EN;

  const hasContent = (sid: string): boolean =>
    tree.children(sid).length > 0 || (inputs.assignment.buckets[sid]?.length ?? 0) > 0;

  const directFiles = (sid: string): string[] =>
    inputs.organization.stages[sid]?.orderedFiles ?? inputs.assignment.buckets[sid] ?? [];

  // Group by depth, deepest first, so children are summarized before parents.
  const byDepth = new Map<number, string[]>();
  for (const sid of tree.order) {
    if (!hasContent(sid)) continue;
    const depth = tree.depth(sid);
    (byDepth.get(depth) ?? byDepth.set(depth, []).get(depth))?.push(sid);
  }
  const depths = [...byDepth.keys()].sort((a, b) => b - a);

  const summaries: Record<string, string> = {};
  for (const depth of depths) {
    const stages = byDepth.get(depth) ?? [];
    await mapLimit(stages, workers, async (sid) => {
      const stage = tree.byId.get(sid);
      if (!stage) return;
      const parts: string[] = [rules, `## Stage title: ${stage.title}`];
      if (stage.description) parts.push(`## Stage description: ${stage.description}`);
      const childSummaries = tree
        .children(sid)
        .filter((c) => summaries[c])
        .map((c) => `### ${tree.title(c)}\n${summaries[c]}`);
      if (childSummaries.length > 0) {
        parts.push(`## Sub-stages it contains (with their overviews)\n${childSummaries.join('\n\n')}`);
      }
      const fileLines = directFiles(sid)
        .map((f) => {
          const card = inputs.cards[f];
          return `- \`${f}\` — ${card?.purpose ?? ''}${card ? `  [${card.role}]` : ''}`;
        })
        .join('\n');
      if (fileLines) parts.push(`## Source files assigned directly to this stage\n${fileLines}`);
      parts.push(lang === 'zh' ? '现在用中文输出本阶段的概述：' : "Now output this stage's overview:");
      const prompt = parts.join('\n\n');
      const key = `${sid.replaceAll(/[^a-zA-Z0-9_.-]/g, '_')}_${shortHash(`${PROMPT_VERSION}|${lang}|stage|${sid}|${prompt}`)}`;
      summaries[sid] = await cachedCall(
        options.cacheDir,
        key,
        refresh,
        async () => (await client.complete(prompt, { temperature: 0 })).text,
        () => stage.description || stage.title,
        logger,
      );
    });
  }

  // System overview from top-level stage summaries.
  const archetype = inputs.skeleton.metadata.archetype ?? '';
  const topBlocks = tree.topLevel
    .filter((sid) => summaries[sid])
    .map((sid) => `### ${tree.title(sid)}\n${summaries[sid]}`);
  const systemPrompt = [
    lang === 'zh' ? SYSTEM_RULES_ZH : SYSTEM_RULES_EN,
    archetype ? `## System shape: ${archetype}` : '',
    `## Top-level stages (in execution order, with their overviews)\n${topBlocks.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const systemKey = `system_${shortHash(`${PROMPT_VERSION}|${lang}|system|${archetype}|${systemPrompt}`)}`;
  const systemOverview = await cachedCall(
    options.cacheDir,
    systemKey,
    refresh,
    async () => (await client.complete(systemPrompt, { temperature: 0 })).text,
    () => archetype || '(system overview generation failed.)',
    logger,
  );

  return { version: 1, lang, systemOverview, stageSummaries: summaries };
}

// ---------------------------------------------------------------------------
// State registers — loop-until-dry extraction.
// ---------------------------------------------------------------------------

const REGISTER_RULES_EN = `Identify this system's STATE REGISTERS — pieces of global/shared state that flow ACROSS multiple
stages and are read/written repeatedly (config stacks and flags, credentials, live session state,
tool/plugin catalogs, sandbox/exec policy, queues, caches, telemetry buffers, …).
Requirements:
- stable id "reg-xxx" (lowercase words joined by hyphens);
- one-line plain-language "semantics";
- "stages": ONLY stage ids from the given list that genuinely touch this state;
- only genuinely cross-stage state; the count should reflect the system's real scale.
Output ONLY one JSON block:
\`\`\`json
{"registers": [{"id": "reg-xxx", "semantics": "one-line semantics", "stages": ["stage-5"]}]}
\`\`\``;

const REGISTER_GAP_RULES_EN = `You are COMPLETING a list of state registers. Given the already-identified registers, find ONLY the
missing ones — do not repeat or rename existing ids. Focus on easily-overlooked state: background
jobs/queues, caches, connection pools, rate limits, token budgets, memory/goal state, telemetry
buffers, update-check state. Return an empty array if nothing is missing.
Output the same JSON schema as before, containing NEW registers only.`;

const REGISTER_RULES_ZH = `找出这个系统的"状态寄存器"——在多个阶段之间流动、被反复读写的全局/共享状态。
要求：稳定 id "reg-xxx"（小写连字符，保持英文）；一句话中文语义；"stages" 只能用给定的阶段 id 且确实触及；
只收真正跨阶段的状态；数量反映系统真实规模。只输出一个 JSON 块（schema 同英文版）。`;

const REGISTER_GAP_RULES_ZH = `你在补全状态寄存器清单。给定已识别的寄存器，只找"缺失"的——不要重复或改名。
关注易被忽略的状态：后台任务/队列、缓存、连接池、限流、token 预算、记忆/目标状态、遥测缓冲、更新检查。
没有缺失就返回空数组。只输出新增项，schema 同前。`;

const REGISTER_FILL_RULES_EN = `For each state register below, list WHICH of the given stages read or write it.
"stages" MUST contain only IDs from the stage menu — never invent one; pick 1-5 per register.
Output ONLY one JSON block:
\`\`\`json
{"assignments": [{"id": "reg-xxx", "stages": ["<stage-id>"]}]}
\`\`\``;

const REGISTER_FILL_RULES_ZH = `为下面每个状态寄存器标注：给定阶段中哪些会读/写它。
"stages" 只能使用阶段菜单里的 ID（不得编造），每个寄存器选 1-5 个。
只输出一个 JSON 块（schema 同英文版）。`;

export interface RegistersOptions {
  maxRounds?: number;
  dryStreak?: number;
  refresh?: boolean;
  cacheDir?: string;
  lang?: NarrateLang;
  dataModelCap?: number;
  logger?: Logger;
}

export async function extractRegisters(
  client: ChatClient,
  skeleton: Skeleton,
  narration: Narration,
  cards: Record<string, FileCard>,
  options: RegistersOptions = {},
): Promise<RegisterEntry[]> {
  const { maxRounds = 5, dryStreak = 2, refresh = false, lang = 'en', dataModelCap = 120 } = options;
  const logger = options.logger ?? silentLogger;
  const tree = new StageTree(skeleton);
  const validIds = new Set(skeleton.stages.map((s) => s.id));

  const evidenceLines: string[] = ['## Top-level stages (with overviews)'];
  for (const sid of tree.topLevel) {
    const summary = narration.stageSummaries[sid];
    if (summary) evidenceLines.push(`- ${sid} · ${tree.title(sid)}: ${summary}`);
  }
  const dataModelFiles = Object.values(cards).filter((c) => c.role === 'data_model');
  evidenceLines.push(`## data_model files (total ${dataModelFiles.length}, excerpt)`);
  for (const card of dataModelFiles.slice(0, dataModelCap)) {
    evidenceLines.push(`- \`${card.file}\`: ${card.purpose}`);
  }
  if (dataModelFiles.length > dataModelCap) {
    evidenceLines.push(`(another ${dataModelFiles.length - dataModelCap} data_model files not listed)`);
  }
  const evidence = evidenceLines.join('\n');

  const cachePath = options.cacheDir
    ? join(
        options.cacheDir,
        `registers_${shortHash(`${REGISTERS_VERSION}|${lang}|${evidence}|r${maxRounds}s${dryStreak}`)}.json`,
      )
    : undefined;
  if (cachePath && !refresh && fileExists(cachePath)) {
    const cached = readJsonFile(cachePath);
    if (Array.isArray(cached)) return cached as RegisterEntry[];
  }

  const found = new Map<string, RegisterEntry>();
  let dry = 0;
  for (let round = 1; round <= maxRounds && dry < dryStreak; round += 1) {
    const rules =
      round === 1
        ? lang === 'zh'
          ? REGISTER_RULES_ZH
          : REGISTER_RULES_EN
        : lang === 'zh'
          ? REGISTER_GAP_RULES_ZH
          : REGISTER_GAP_RULES_EN;
    const alreadyBlock =
      round === 1
        ? ''
        : `\n\n## Already-identified registers (do NOT repeat these)\n${[...found.values()]
            .map((r) => `- ${r.id}: ${r.semantics}`)
            .join('\n')}`;
    let added = 0;
    try {
      const response = await client.complete(`${rules}\n\n${evidence}${alreadyBlock}`, { temperature: 0 });
      // Tolerate the shape drift real endpoints produce (bare array, other
      // container names, a lone register) plus name/description spelled instead
      // of id/semantics.
      const entries = extractEntryList(response.json, ['registers', 'state', 'variables'], {
        single: { fields: ['id', 'name', 'semantics'] },
      });
      if (entries.length === 0) {
        logger.warn(
          `[registers] round returned no usable registers (${describeJsonShape(
            response.json,
          )}) — reply: ${replyExcerpt(response.text)}`,
        );
      }
      for (const r of entries) {
        // Coerce near-miss ids (`reg_task_queue`, `Task Queue`) into the
        // canonical form instead of silently dropping the register.
        const rawId = typeof r.id === 'string' ? r.id : typeof r.name === 'string' ? r.name : '';
        let id = rawId.trim().toLowerCase().replace(/[_\s]+/g, '-');
        if (id && !id.startsWith('reg-')) id = `reg-${id.replace(/^-+/, '')}`;
        const semantics =
          typeof r.semantics === 'string'
            ? r.semantics.trim()
            : typeof r.description === 'string'
              ? r.description.trim()
              : '';
        if (!/^reg-[a-z0-9-]+$/.test(id) || !semantics) continue;
        const stages = Array.isArray(r.stages)
          ? r.stages.filter((s): s is string => typeof s === 'string' && validIds.has(s))
          : [];
        const existing = found.get(id);
        if (existing) {
          // Same register seen again: upgrade an empty stage list (some
          // response shapes omit stages entirely) but never count it as new.
          if (existing.stages.length === 0 && stages.length > 0) {
            found.set(id, { ...existing, stages });
          }
          continue;
        }
        found.set(id, { id, semantics, stages });
        added += 1;
      }
    } catch (error) {
      logger.warn(`[registers] round ${round} failed: ${String(error)}`);
    }
    dry = added === 0 ? dry + 1 : 0;
  }

  // Stage-fill pass: some response shapes omit `stages` entirely. For those
  // registers, one menu-constrained mapping call fills them in — validated
  // against real stage ids like every other closed-menu prompt.
  const needy = [...found.values()].filter((r) => r.stages.length === 0);
  if (needy.length > 0) {
    const menu = skeleton.stages.map((s) => `- ${s.id} — ${s.title}`).join('\n');
    const list = needy.map((r) => `- ${r.id}: ${r.semantics}`).join('\n');
    const fillPrompt = `${
      lang === 'zh' ? REGISTER_FILL_RULES_ZH : REGISTER_FILL_RULES_EN
    }\n\n## Stage menu (valid IDs)\n${menu}\n\n## Registers to map\n${list}`;
    try {
      const response = await client.complete(fillPrompt, { temperature: 0 });
      const entries = extractEntryList(response.json, ['assignments', 'registers'], {
        single: { fields: ['id', 'stages'] },
      });
      for (const a of entries) {
        const id = typeof a.id === 'string' ? a.id.trim() : '';
        const target = found.get(id);
        if (!target || target.stages.length > 0) continue;
        const stages = Array.isArray(a.stages)
          ? a.stages.filter((s): s is string => typeof s === 'string' && validIds.has(s))
          : [];
        if (stages.length > 0) found.set(id, { ...target, stages });
      }
    } catch (error) {
      logger.warn(`[registers] stage-fill pass failed: ${String(error)}`);
    }
  }

  const registers = [...found.values()];
  if (cachePath) {
    ensureDir(options.cacheDir as string);
    writeJsonFile(cachePath, registers);
  }
  return registers;
}
