/**
 * Phase 2a — read every source file and write one {@link FileCard} per file.
 *
 * Guarantees:
 * - coverage is complete by construction: every scanned file ends with a card
 *   (failed files get an honest empty card and are listed in `_coverage.json`);
 * - three-tier degradation: whole batch → single file → per-function chunks;
 * - cards are written incrementally (crash-safe) and `resume` skips files that
 *   already have a good card.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allFileDescriptors, buildNavPack, type NavFileDescriptor } from '@handbook/analyzer';
import type { ChatClient } from '@handbook/llm';
import {
  Progress,
  coerceRole,
  leafName,
  mapLimit,
  silentLogger,
  truncate,
  type CardCoverage,
  type CodeGraph,
  type FileCard,
  type FunctionNote,
  type Logger,
  type NarrateLang,
} from '@handbook/core';
import { buildInventory } from './inventory.js';
import type { WorkDir } from './workdir.js';

export type CardDetail = 'brief' | 'deep';

export interface CardsOptions {
  client: ChatClient;
  graph: CodeGraph;
  sourceRoot: string;
  work: WorkDir;
  /** Files per LLM call. Use 1 for deep mode. Default 8. */
  batchSize?: number;
  /** Concurrent LLM calls. Default 12. */
  maxWorkers?: number;
  /** Source cap per file; 0 = whole file. Default 0. */
  maxCharsPerFile?: number;
  detail?: CardDetail;
  /** Deep fallback: split an oversized file into function chunks of ~this size. */
  chunkChars?: number;
  /** Skip files that already have a completed card. */
  resume?: boolean;
  /** Restrict the pass to these files (used by resync). Coverage is still computed over all files. */
  onlyFiles?: readonly string[];
  lang?: NarrateLang;
  logger?: Logger;
}

export interface CardsResult {
  cards: Record<string, FileCard>;
  coverage: CardCoverage;
}

const ROLE_GLOSS = `Roles (pick exactly one):
- entrypoint: where execution starts (main, CLI, server bootstrap)
- orchestration: coordinates other parts, owns control flow
- domain_logic: the core business/behavior logic
- io_transport: network, files, protocols, external processes
- data_model: types, schemas, state containers
- config: configuration loading/validation
- util: generic helpers
- test: test code
- generated: machine-generated code
- other: none of the above`;

const BRIEF_RULES_EN = `You are reading SOURCE FILES one by one and writing a short, plain-language PURPOSE for each,
to drive a system handbook meant for a curious NON-EXPERT reader.
For every file below, return:
- "purpose": 1-2 plain sentences saying what the file is for (no implementation trivia).
- "role": exactly one of the role enum values.
- "lifecycle": a short hint like "startup", "config load", "main loop", "request handling", "teardown", "cross-cutting", or "none".
${ROLE_GLOSS}
Output ONLY one JSON block:
\`\`\`json
{"purposes": [{"file": "<exact path>", "purpose": "...", "role": "<role>", "lifecycle": "..."}]}
\`\`\``;

const DEEP_RULES_EN = `You are reading SOURCE FILES IN FULL and writing a plain-language, easy-to-follow description of each,
for a system handbook in which the FILE is the smallest unit (its leaf node). What you write IS the
handbook's content for this file.
Style: plain language; explain WHY and WHAT before mechanism; explain jargon inline on first use; an
everyday analogy is welcome; stay accurate; no filler like "this file handles".
Each file comes with its graph-derived FUNCTION LIST (qualname + line range). The inventory, line
ranges and call relations are FACTS — do NOT re-list them, write prose around them.
For every file return:
- "purpose": 1-2 plain sentences.
- "description": a ~120-300 word walkthrough of the file.
- "functions": one entry per listed function, referenced by its EXACT qualname, each with:
    "purpose" (1-3 sentences), "data_flow" (the IN → transform → OUT story),
    "relations" (who calls it and when / what it hands off, grounded in the given call facts).
- "role": exactly one of the role enum values.
- "lifecycle": a short hint as above.
${ROLE_GLOSS}
Output ONLY one JSON block:
\`\`\`json
{"purposes": [{"file": "<exact path>", "purpose": "...", "description": "...",
  "functions": [{"qualname": "...", "purpose": "...", "data_flow": "...", "relations": "..."}],
  "role": "<role>", "lifecycle": "..."}]}
\`\`\``;

const BRIEF_RULES_ZH = `你在逐个阅读源码文件，为每个文件写一句大白话的"用途"，服务于面向普通读者的系统手册。
JSON 的 key 与 role 枚举值保持英文，所有描述性文字用中文。
每个文件返回："purpose"（1-2 句大白话）、"role"（枚举值之一）、"lifecycle"（如 "startup"、"main loop"、"cross-cutting"、"none"）。
${ROLE_GLOSS}
只输出一个 JSON 块：
\`\`\`json
{"purposes": [{"file": "<exact path>", "purpose": "...", "role": "<role>", "lifecycle": "..."}]}
\`\`\``;

const DEEP_RULES_ZH = `你在完整阅读源码文件，为每个文件写一段通俗易懂的中文说明——手册以"文件"为最小单元，你写的就是手册正文。
风格：大白话、短句子；先讲"为什么/是什么"再讲机制；术语首次出现要顺手解释；欢迎一个生活化类比；必须准确；不要"本文件负责"这类空话。
每个文件附带来自调用图的函数清单（qualname + 行号范围），这些是事实——不要重新罗列，围绕它们写说明。
每个文件返回（JSON key 与 role 枚举值用英文，值用中文）：
- "purpose"：1-2 句；
- "description"：约 120-300 字的走读；
- "functions"：对清单中每个函数，按其精确 qualname 返回 "purpose"、"data_flow"（输入→加工→输出）、"relations"（谁在何时调用它/它交接给谁，以给定调用事实为准）；
- "role"、"lifecycle" 同上。
${ROLE_GLOSS}
只输出一个 JSON 块（schema 同英文版）。`;

function rulesFor(detail: CardDetail, lang: NarrateLang): string {
  if (detail === 'deep') return lang === 'zh' ? DEEP_RULES_ZH : DEEP_RULES_EN;
  return lang === 'zh' ? BRIEF_RULES_ZH : BRIEF_RULES_EN;
}

function fileBlock(
  descriptor: NavFileDescriptor,
  source: string,
  maxChars: number,
  inventory: FunctionNote[] | undefined,
): string {
  const lines: string[] = [];
  const classes = descriptor.classes.length ? ` classes=[${descriptor.classes.join(', ')}]` : '';
  lines.push(`### FILE: ${descriptor.file}  (${descriptor.nFunctions} fn)${classes}`);
  const body =
    maxChars > 0 && source.length > maxChars
      ? `${source.slice(0, maxChars)}\n... (truncated, ${source.length} chars total)`
      : source;
  lines.push('```', body, '```');
  if (inventory && inventory.length > 0) {
    lines.push('#### Functions to annotate (reference each by its qualname; call facts from the graph):');
    for (const fn of inventory) {
      lines.push(`  - ${fn.qualname}  (lines ${fn.lineRange[0]}-${fn.lineRange[1]})`);
      if (fn.calls.length > 0) {
        lines.push(`      calls: ${fn.calls.slice(0, 8).map(leafName).join(', ')}${fn.calls.length > 8 ? ` (+${fn.calls.length - 8} more)` : ''}`);
      }
      if (fn.calledBy.length > 0) {
        lines.push(`      called by: ${fn.calledBy.slice(0, 8).map(leafName).join(', ')}${fn.calledBy.length > 8 ? ` (+${fn.calledBy.length - 8} more)` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

interface RawEntry {
  file?: unknown;
  purpose?: unknown;
  description?: unknown;
  role?: unknown;
  lifecycle?: unknown;
  functions?: unknown;
  note?: unknown;
}

/** Merge LLM function prose onto the complete structural inventory. */
export function mergeFunctionNotes(graphFns: FunctionNote[], llmFns: unknown): FunctionNote[] {
  const byQualname = new Map<string, Record<string, unknown>>();
  const byName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(llmFns)) {
    for (const raw of llmFns) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const qual = typeof entry.qualname === 'string' ? entry.qualname : undefined;
      if (qual && !byQualname.has(qual)) byQualname.set(qual, entry);
      const name = qual ? leafName(qual) : undefined;
      if (name && !byName.has(name)) byName.set(name, entry);
    }
  }
  return graphFns.map((fn) => {
    const hit = byQualname.get(fn.qualname) ?? byName.get(fn.name);
    const text = (v: unknown): string => (typeof v === 'string' ? v : '');
    const purpose = text(hit?.purpose) || text(hit?.note);
    return {
      ...fn,
      purpose,
      dataFlow: text(hit?.data_flow ?? hit?.dataFlow),
      relations: text(hit?.relations),
    };
  });
}

function entryToCard(
  entry: RawEntry,
  file: string,
  detail: CardDetail,
  inventory: FunctionNote[] | undefined,
): FileCard {
  const card: FileCard = {
    version: 1,
    file,
    purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
    role: coerceRole(entry.role),
    lifecycle: typeof entry.lifecycle === 'string' ? entry.lifecycle : 'none',
  };
  if (detail === 'deep') {
    card.description = typeof entry.description === 'string' ? entry.description : '';
    card.functions = mergeFunctionNotes(inventory ?? [], entry.functions);
  }
  return card;
}

/** Is this card complete for the requested detail level (resume filter)? */
export function isCardDone(card: FileCard, detail: CardDetail): boolean {
  if (!card.purpose) return false;
  if (detail === 'brief') return true;
  return Boolean(card.description) || (card.functions ?? []).some((f) => f.purpose !== '');
}

export async function generateCards(options: CardsOptions): Promise<CardsResult> {
  const {
    client,
    graph,
    sourceRoot,
    work,
    batchSize = 8,
    maxWorkers = 12,
    maxCharsPerFile = 0,
    detail = 'brief',
    chunkChars = 60_000,
    resume = false,
    lang = 'en',
  } = options;
  const logger = options.logger ?? silentLogger;

  const nav = buildNavPack(graph);
  const files = allFileDescriptors(graph, nav);
  const inventory = detail === 'deep' ? buildInventory(graph) : {};

  const cards: Record<string, FileCard> = {};
  let todo = files;
  if (options.onlyFiles) {
    const wanted = new Set(options.onlyFiles);
    // Keep existing cards for out-of-scope files so coverage stays honest.
    for (const [file, card] of Object.entries(work.loadCards())) {
      if (!wanted.has(file)) cards[file] = card;
    }
    todo = files.filter((f) => wanted.has(f.file));
  }
  if (resume) {
    const existing = work.loadCards();
    for (const [file, card] of Object.entries(existing)) {
      if (isCardDone(card, detail)) cards[file] = card;
    }
    // Filter the CURRENT todo (which may already be onlyFiles-restricted).
    const before = todo.length;
    todo = todo.filter((f) => !cards[f.file]);
    logger.info(`[cards] resume: ${before - todo.length}/${before} already done, ${todo.length} to process`);
  }

  const readSource = (rel: string): string => {
    try {
      return readFileSync(join(sourceRoot, rel), 'utf8');
    } catch {
      return '(source unavailable)';
    }
  };

  const rules = rulesFor(detail, lang);

  const describeBatch = async (batch: NavFileDescriptor[]): Promise<Record<string, FileCard>> => {
    const blocks = batch.map((d) => fileBlock(d, readSource(d.file), maxCharsPerFile, inventory[d.file]));
    const prompt = [rules, `## Files to describe (${batch.length})`, ...blocks, 'Return the JSON block only — no commentary.'].join('\n\n');
    const result: Record<string, FileCard> = {};
    try {
      const response = await client.complete(prompt, { temperature: 0 });
      const parsed = response.json as { purposes?: unknown } | undefined;
      const entries = Array.isArray(parsed?.purposes) ? (parsed.purposes as RawEntry[]) : [];
      const valid = new Set(batch.map((d) => d.file));
      for (const entry of entries) {
        if (typeof entry.file !== 'string' || !valid.has(entry.file)) continue;
        result[entry.file] = entryToCard(entry, entry.file, detail, inventory[entry.file]);
      }
    } catch (error) {
      logger.warn(`[cards] batch of ${batch.length} failed: ${String(error)}`);
    }
    return result;
  };

  /** Deep fallback: describe one oversized file in function chunks. */
  const describeChunked = async (descriptor: NavFileDescriptor): Promise<FileCard | undefined> => {
    const fns = inventory[descriptor.file] ?? [];
    if (fns.length === 0) return undefined;
    const source = readSource(descriptor.file);
    const sourceLines = source.split('\n');
    const chunks: FunctionNote[][] = [];
    let current: FunctionNote[] = [];
    let currentSize = 0;
    for (const fn of fns) {
      const size = sourceLines.slice(fn.lineRange[0] - 1, fn.lineRange[1]).join('\n').length;
      if (current.length > 0 && currentSize + size > chunkChars) {
        chunks.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(fn);
      currentSize += size;
    }
    if (current.length > 0) chunks.push(current);

    let base: FileCard | undefined;
    const annotations: unknown[] = [];
    for (const chunk of chunks) {
      const chunkBlocks = chunk.map((fn) => {
        const body = sourceLines.slice(fn.lineRange[0] - 1, fn.lineRange[1]).join('\n');
        return [`#### ${fn.qualname} (lines ${fn.lineRange[0]}-${fn.lineRange[1]})`, '```', truncate(body, chunkChars), '```'].join('\n');
      });
      const prompt = [
        rules,
        `## File (too large for one pass — processing a CHUNK of its functions): ${descriptor.file}`,
        ...chunkBlocks,
        `Return ONE "purposes" entry for ${descriptor.file} covering exactly these functions.`,
      ].join('\n\n');
      try {
        const response = await client.complete(prompt, { temperature: 0 });
        const parsed = response.json as { purposes?: RawEntry[] } | undefined;
        const entry = parsed?.purposes?.[0];
        if (!entry) continue;
        if (!base) {
          base = entryToCard(entry, descriptor.file, detail, inventory[descriptor.file]);
        } else if (typeof entry.description === 'string' && entry.description) {
          base.description = `${base.description ?? ''} ${entry.description}`.trim();
        }
        if (Array.isArray(entry.functions)) annotations.push(...entry.functions);
      } catch (error) {
        logger.warn(`[cards] chunk of ${descriptor.file} failed: ${String(error)}`);
      }
    }
    if (base) base.functions = mergeFunctionNotes(inventory[descriptor.file] ?? [], annotations);
    return base;
  };

  const batches: NavFileDescriptor[][] = [];
  for (let i = 0; i < todo.length; i += Math.max(1, batchSize)) {
    batches.push(todo.slice(i, i + Math.max(1, batchSize)));
  }

  const progress = new Progress(logger, 'cards', todo.length);
  await mapLimit(batches, maxWorkers, async (batch) => {
    let described = await describeBatch(batch);
    // Tier 2: retry dropped files alone.
    const dropped = batch.filter((d) => !described[d.file]);
    if (dropped.length > 0 && batch.length > 1) {
      for (const d of dropped) {
        Object.assign(described, await describeBatch([d]));
      }
    }
    // Tier 3 (deep only): function-chunked fallback.
    if (detail === 'deep') {
      for (const d of batch.filter((x) => !described[x.file])) {
        const card = await describeChunked(d);
        if (card) described = { ...described, [d.file]: card };
      }
    }
    for (const [file, card] of Object.entries(described)) {
      cards[file] = card;
      try {
        work.saveCard(card);
      } catch (error) {
        logger.warn(`[cards] write failed for ${file}: ${String(error)}`);
      }
    }
    progress.tick(batch.length, `${Object.keys(described).length}/${batch.length} described`);
  });
  progress.finish('file');

  // Backfill: every file ends with a card; misses are recorded honestly.
  // A card with an EMPTY purpose is a previous backfill, not real coverage —
  // it stays in `missing` so the drift signal survives subset (resync) passes.
  const missing: string[] = [];
  for (const descriptor of files) {
    if (cards[descriptor.file]?.purpose) continue;
    if (cards[descriptor.file]) {
      missing.push(descriptor.file);
      continue;
    }
    missing.push(descriptor.file);
    const card: FileCard = {
      version: 1,
      file: descriptor.file,
      purpose: '',
      role: 'other',
      lifecycle: 'none',
    };
    if (detail === 'deep') {
      card.description = '';
      card.functions = inventory[descriptor.file] ?? [];
    }
    cards[descriptor.file] = card;
    work.saveCard(card);
  }
  const coverage: CardCoverage = {
    nFiles: files.length,
    nDescribed: files.length - missing.length,
    missing: missing.sort(),
  };
  work.saveCardCoverage(coverage);
  if (missing.length > 0) logger.warn(`[cards] ${missing.length} files backfilled with empty cards`);
  return { cards, coverage };
}
