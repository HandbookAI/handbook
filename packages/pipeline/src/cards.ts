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
  PIPELINE_DEFAULTS,
  Progress,
  coerceRole,
  describeJsonShape,
  extractEntryList,
  replyExcerpt,
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
  type TypeNote,
} from '@handbook/core';
import { buildInventory, buildTypeInventory } from './inventory.js';
import type { WorkDir } from './workdir.js';
import { rulesFor as rulesForLang } from './prompt-lang.js';
import type { ProgressSink } from '@handbook/core';

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
  /** Cooperative cancellation: checked per batch and passed into every LLM call. */
  signal?: AbortSignal;
  logger?: Logger;
  /** Machine-readable progress, for a UI drawing a bar. */
  onProgress?: ProgressSink;
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
  return detail === 'deep'
    ? rulesForLang(lang, DEEP_RULES_EN, DEEP_RULES_ZH)
    : rulesForLang(lang, BRIEF_RULES_EN, BRIEF_RULES_ZH);
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
        lines.push(
          `      calls: ${fn.calls.slice(0, 8).map(leafName).join(', ')}${fn.calls.length > 8 ? ` (+${fn.calls.length - 8} more)` : ''}`,
        );
      }
      if (fn.calledBy.length > 0) {
        lines.push(
          `      called by: ${fn.calledBy.slice(0, 8).map(leafName).join(', ')}${fn.calledBy.length > 8 ? ` (+${fn.calledBy.length - 8} more)` : ''}`,
        );
      }
    }
  }
  return lines.join('\n');
}

/**
 * Pull the card entries out of a reply, tolerating the shapes models actually
 * emit. Only `{"purposes":[…]}` is asked for, but a model that answers with a
 * bare array — or names the array `files`/`cards`/`results` — has still done the
 * work, and rejecting that silently is how 90 files end up with empty cards.
 */
/**
 * Resolve a loosely-named path against the batch: `./a/b.ts` or a path carrying
 * an extra leading segment name the same file unambiguously. A BARE basename is
 * deliberately not accepted — `src/b/config.ts` must not resolve onto
 * `src/a/config.ts` and overwrite a correct card with prose about another file.
 */
function matchLoosely(named: string, valid: ReadonlySet<string>): string | undefined {
  const cleaned = named
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/^`+|`+$/g, '');
  if (valid.has(cleaned)) return cleaned;
  const suffixHits = [...valid].filter((f) => f === cleaned || f.endsWith(`/${cleaned}`));
  return suffixHits.length === 1 ? suffixHits[0] : undefined;
}

/** Keys that mark an object as a FUNCTION note rather than a file card. */
const FUNCTION_NOTE_KEYS = ['qualname', 'data_flow', 'dataFlow', 'relations'] as const;

/** A function note promoted to a file card would silently replace a real card. */
function isFunctionNote(entry: Record<string, unknown>): boolean {
  const looksLikeNote = FUNCTION_NOTE_KEYS.some((key) => key in entry);
  const looksLikeCard = ['file', 'description', 'role', 'lifecycle', 'functions'].some((key) => key in entry);
  return looksLikeNote && !looksLikeCard;
}

export function extractCardEntries(json: unknown): RawEntry[] {
  const entries = (
    extractEntryList(json, ['purposes', 'files', 'cards'], {
      // `purpose` alone is too generic to identify a card: a function note has
      // one too. Require a field only a file card carries.
      single: { fields: ['file', 'description', 'role', 'lifecycle', 'functions'] },
    }) as RawEntry[]
  ).filter((entry) => !isFunctionNote(entry as Record<string, unknown>));
  if (entries.length > 0) return entries;
  // Keyed by path: {"a/b.ts": {"purpose": "…"}, …}.
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return [];
  const keyed = Object.entries(json as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
  if (keyed.length > 0 && keyed.every(([k]) => k.includes('/') || k.includes('.'))) {
    return keyed.map(([file, v]) => ({ ...(v as RawEntry), file }));
  }
  return [];
}

/**
 * Below this many files, "nothing was described" is more likely one flaky call
 * than a broken configuration, so the run continues with honest partial
 * coverage instead of aborting.
 */
const SYSTEMIC_FAILURE_FLOOR = 3;

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
  // Models answer either with a list of `{qualname, …}` objects or with a map
  // keyed by the function name. Both are the same information.
  const list = Array.isArray(llmFns)
    ? llmFns
    : typeof llmFns === 'object' && llmFns !== null
      ? Object.entries(llmFns as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'object' && v !== null)
          .map(([qualname, v]) => ({ qualname, ...(v as Record<string, unknown>) }))
      : undefined;
  if (Array.isArray(list)) {
    for (const raw of list) {
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
  types: TypeNote[] | undefined,
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
  // Outside the `deep` branch on purpose: a type note is a parser fact with no
  // prose to wait for, so gating it on the LLM detail level would withhold it for
  // nothing. Only attached when non-empty — see `FileCard.types`.
  if (types && types.length > 0) card.types = types;
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
    batchSize = PIPELINE_DEFAULTS.readBatchSize,
    maxWorkers = PIPELINE_DEFAULTS.readWorkers,
    maxCharsPerFile = PIPELINE_DEFAULTS.maxCharsPerFile,
    detail = PIPELINE_DEFAULTS.detail,
    chunkChars = 60_000,
    resume = false,
    lang = PIPELINE_DEFAULTS.narrateLang,
    signal,
  } = options;
  const logger = options.logger ?? silentLogger;

  const nav = buildNavPack(graph);
  const files = allFileDescriptors(graph, nav);
  const inventory = detail === 'deep' ? buildInventory(graph) : {};
  // Built in both detail modes: unlike the function inventory, this is not raw
  // material for a prompt — it is the finished fact, and the model is never asked
  // about it. `undefined` when the graph has no `types` at all.
  const typeInventory = buildTypeInventory(graph);

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

  /** LLM calls actually issued — the guard must not blame a model never called. */
  let attempted = 0;
  work.clearRejectedReplies(); // a diagnosis must read THIS run's replies

  const describeBatch = async (batch: NavFileDescriptor[]): Promise<Record<string, FileCard>> => {
    // Here, not only at the mapLimit checkpoint: the degradation tiers below
    // call this in a loop, once per dropped file, and a client that does not
    // honour the signal itself (a cache hit, a mock) would let a cancelled pass
    // buy every one of those retries.
    signal?.throwIfAborted();
    attempted += 1;
    const blocks = batch.map((d) => fileBlock(d, readSource(d.file), maxCharsPerFile, inventory[d.file]));
    const prompt = [
      rules,
      `## Files to describe (${batch.length})`,
      ...blocks,
      'Return the JSON block only — no commentary.',
    ].join('\n\n');
    const result: Record<string, FileCard> = {};
    try {
      const response = await client.complete(prompt, { temperature: 0, signal });
      const entries = extractCardEntries(response.json);
      const valid = new Set(batch.map((d) => d.file));
      const soleFile = batch.length === 1 && entries.length === 1 ? batch[0]?.file : undefined;
      const exact = new Set<string>();
      for (const entry of entries) {
        const named = typeof entry.file === 'string' ? entry.file.trim() : undefined;
        // An entry that NAMES a file must resolve to one in this batch. Falling
        // back to "the only file we asked about" would accept a card written for
        // something else entirely — a wrong answer, not a loosely named one.
        const file = named ? (valid.has(named) ? named : matchLoosely(named, valid)) : soleFile;
        if (!file) continue;
        // First exact naming wins: a loose match must never overwrite the card
        // the model explicitly wrote for that path.
        if (exact.has(file)) continue;
        if (named && valid.has(named)) exact.add(file);
        const card = entryToCard(entry, file, detail, inventory[file], typeInventory?.[file]);
        // An entry that produced no purpose is not a description. Leaving it out
        // keeps the file in `dropped` so the single-file and chunk fallbacks
        // still run for it.
        if (card.purpose.trim() === '') continue;
        result[file] = card;
      }
      if (Object.keys(result).length === 0) {
        // The call SUCCEEDED but nothing usable came back — a shape mismatch or
        // a refusal. Never let that look the same as "the model said nothing":
        // report what arrived and keep the reply for inspection.
        const excerpt = replyExcerpt(response.text);
        const keys = describeJsonShape(response.json);
        logger.warn(
          `[cards] batch of ${batch.length} returned no usable entries (${keys}) — reply: ${excerpt}`,
        );
        work.saveRejectedReply(batch[0]?.file ?? 'batch', response.text);
      }
    } catch (error) {
      // A cancellation is not a per-batch failure to degrade around — it must
      // end the whole pass, so it propagates instead of becoming a warning.
      signal?.throwIfAborted();
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
      signal?.throwIfAborted(); // a cancel mid-file must not buy the rest of it
      const chunkBlocks = chunk.map((fn) => {
        const body = sourceLines.slice(fn.lineRange[0] - 1, fn.lineRange[1]).join('\n');
        return [
          `#### ${fn.qualname} (lines ${fn.lineRange[0]}-${fn.lineRange[1]})`,
          '```',
          truncate(body, chunkChars),
          '```',
        ].join('\n');
      });
      const prompt = [
        rules,
        `## File (too large for one pass — processing a CHUNK of its functions): ${descriptor.file}`,
        ...chunkBlocks,
        `Return ONE "purposes" entry for ${descriptor.file} covering exactly these functions.`,
      ].join('\n\n');
      try {
        attempted += 1;
        const response = await client.complete(prompt, { temperature: 0, signal });
        const entry = extractCardEntries(response.json)[0];
        if (!entry) continue;
        if (!base) {
          base = entryToCard(
            entry,
            descriptor.file,
            detail,
            inventory[descriptor.file],
            typeInventory?.[descriptor.file],
          );
        } else if (typeof entry.description === 'string' && entry.description) {
          base.description = `${base.description ?? ''} ${entry.description}`.trim();
        }
        if (Array.isArray(entry.functions)) annotations.push(...entry.functions);
      } catch (error) {
        signal?.throwIfAborted(); // cancellation ends the pass, never degrades
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

  const progress = new Progress(logger, 'cards', todo.length, options.onProgress);
  await mapLimit(batches, maxWorkers, async (batch) => {
    signal?.throwIfAborted(); // cooperative checkpoint: no new batch after abort
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
    // A backfilled card is an honest empty card, not an incomplete one: the prose
    // is missing because the model failed, and every parser fact the run DID
    // produce still belongs on it. Dropping the types here would make a file the
    // LLM could not describe also unfindable by name.
    const backfilledTypes = typeInventory?.[descriptor.file];
    if (backfilledTypes && backfilledTypes.length > 0) card.types = backfilledTypes;
    cards[descriptor.file] = card;
    work.saveCard(card);
  }
  // Cards for files that no longer exist are removed here.
  //
  // Keyed on `files` — every file in the GRAPH — and deliberately not on `todo`,
  // which `onlyFiles` narrows to the handful a resync touched. Those are the two
  // easy-to-confuse lists, and confusing them deletes the whole handbook and
  // reports success. `files` is authoritative because phase 1 built the graph by
  // walking the source tree: a deleted file is not in it.
  //
  // This runs on a subset pass too, precisely because the key is the full set —
  // gating it on `!onlyFiles` would buy nothing and would leave a deleted file's
  // card alive until somebody happened to run a full pass.
  //
  // Reported, not silent: a handbook that quietly lost pages between runs is
  // indistinguishable from one whose generation partly failed.
  const evicted = work.evictCardsOutside(files.map((d) => d.file));
  if (evicted.length > 0) {
    for (const file of evicted) delete cards[file];
    logger.info(
      `[cards] removed ${evicted.length} card(s) for files no longer in the codebase: ${evicted.slice(0, 5).join(', ')}${evicted.length > 5 ? `, +${evicted.length - 5} more` : ''}`,
    );
  }

  const coverage: CardCoverage = {
    nFiles: files.length,
    nDescribed: files.length - missing.length,
    missing: missing.sort(),
  };
  work.saveCardCoverage(coverage);
  if (missing.length > 0) logger.warn(`[cards] ${missing.length} files backfilled with empty cards`);
  // Degrading SOME files to empty cards is honest partial coverage. Degrading
  // EVERY file is a broken LLM configuration wearing a success costume: the
  // handbook that follows would be pure scaffolding, and narration would burn
  // the same failing calls again. Stop — but only when the evidence is
  // systemic. One flaky call on a 1-file repo is not a broken configuration,
  // and a scope that made no calls at all is not the model's fault.
  if (coverage.nDescribed === 0 && files.length >= SYSTEMIC_FAILURE_FLOOR && attempted > 0) {
    const kept = work.rejectedReplyCount();
    throw new Error(
      `[cards] all ${files.length} files failed to be described after ${attempted} LLM call(s) — ` +
        `${kept > 0 ? `${kept} reply/replies kept under cards/_rejected for inspection; ` : 'no reply was usable; '}` +
        'check the warnings above, OPENAI_MODEL/OPENAI_BASE_URL, and OPENAI_MAX_TOKENS for reasoning models.',
    );
  }
  return { cards, coverage };
}
