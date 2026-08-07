/**
 * Agent locator site (deterministic, no LLM).
 *
 * Writes `how_to_use.md`, `index.md`, `disambiguation.md` and one `<sid>.md`
 * per content-bearing stage into `outDir`. Every stage page is a fixed-schema
 * locator block; the data-gating invariant is that a field is emitted iff its
 * structural signal exists — an empty field is information.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, firstSentence, truncate, writeFileAtomic } from '@handbook/core';
import type { FileRole, HandbookModel, NarrateLang, RegisterEntry } from '@handbook/core';
import { renderFileCardMd } from './file-card.js';
import { HandbookView, genericTierLanguages, fileDir, fileStem, mdLinkText } from './shared.js';
import type { FidelityOptions } from './shared.js';

/** File stems too generic to serve as entry concepts. */
const GENERIC_TOKENS = new Set([
  'mod',
  'lib',
  'main',
  'index',
  'src',
  'app',
  'core',
  'base',
  'common',
  'misc',
  'error',
  'errors',
  'test',
  'tests',
  'testing',
  'util',
  'utils',
  'helper',
  'helpers',
  'types',
  'type',
  'model',
  'models',
  'init',
  'setup',
  'shared',
  'internal',
  'impl',
]);

/** Register-id words that carry no stage-matching signal. */
const REGISTER_STOPWORDS = new Set([
  'reg',
  'state',
  'status',
  'stack',
  'catalog',
  'flags',
  'flag',
  'global',
  'shared',
  'current',
  'active',
  'live',
  'main',
  'info',
  'data',
]);

/** Role priority for core-file ranking (unknown roles sort last). */
const ROLE_PRIORITY: readonly FileRole[] = [
  'entrypoint',
  'orchestration',
  'domain_logic',
  'data_model',
  'io_transport',
  'config',
  'util',
  'test',
];

const ENTRY_CONCEPTS_CAP = 8;
const CORE_FILES_CAP = 6;
const MAX_COLLISION_DF = 6;

interface AgentLabels {
  duty: string;
  entryConcepts: string;
  state: string;
  inherited: (via: string) => string;
  collides: string;
  exemplar: string;
  strongCochange: string;
  related: string;
  coreFiles: string;
  fns: (n: number) => string;
  files: (n: number) => string;
  hits: (n: number) => string;
  indexTitle: string;
  indexIntro: string;
  disambiguationTitle: string;
  disambiguationIntro: string;
}

const LABELS: Record<NarrateLang, AgentLabels> = {
  en: {
    duty: '**Duty**: ',
    entryConcepts: '**Entry concepts**: ',
    state: '**State**: ',
    inherited: (via) => ` (inherited, via ${via})`,
    collides:
      '**⚠️ Name collides — searching these words also lands elsewhere; see [disambiguation.md](disambiguation.md)**',
    exemplar: '**Exemplar** (copy this when adding a new one):',
    strongCochange: '**⚠️ Strong co-change (change src → change its test)**:',
    related: '**Related (same sub-group — topical, verify before editing)**:',
    coreFiles: '**Core files**:',
    fns: (n) => `${n} fns`,
    files: (n) => `${n} files`,
    hits: (n) => `${n} hits`,
    indexTitle: 'Agent Locator Index',
    indexIntro:
      'Read [how_to_use.md](how_to_use.md) first: it defines the operating protocol for this index.',
    disambiguationTitle: 'Disambiguation',
    disambiguationIntro: 'Words whose search hits land in several stages. Pick by duty line.',
  },
  zh: {
    duty: '**职责**：',
    entryConcepts: '**入口概念**：',
    state: '**状态**：',
    inherited: (via) => `（继承自父级，按概念词 ${via}）`,
    collides: '**⚠️ 名称冲突 — 搜索这些词也会命中其他阶段；见 [disambiguation.md](disambiguation.md)**',
    exemplar: '**范本**（新增同类时可参照）：',
    strongCochange: '**⚠️ 强共变（改动源文件 → 同步改动其测试）**：',
    related: '**相关（同一子组 — 主题相关，编辑前请核实）**：',
    coreFiles: '**核心文件**：',
    fns: (n) => `${n} 个函数`,
    files: (n) => `${n} 个文件`,
    hits: (n) => `${n} 处命中`,
    indexTitle: '智能体定位索引',
    indexIntro: '请先阅读 [how_to_use.md](how_to_use.md)：它定义了使用本索引的操作规程。',
    disambiguationTitle: '消歧',
    disambiguationIntro: '以下词的搜索会命中多个阶段，请按职责行选择。',
  },
};

/** Lowercase title tokens, generic and short tokens dropped. */
function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((tok) => tok.length > 2 && !GENERIC_TOKENS.has(tok));
}

/** Distinctive entry-concept stems of a stage's direct files (org order, deduped, capped). */
function entryConcepts(view: HandbookView, sid: string): string[] {
  const out: string[] = [];
  for (const file of view.directFiles(sid)) {
    const stem = fileStem(file);
    if (GENERIC_TOKENS.has(stem.toLowerCase())) continue;
    if (!out.includes(stem)) out.push(stem);
    if (out.length >= ENTRY_CONCEPTS_CAP) break;
  }
  return out;
}

/** Concept vocabulary of a stage: entry stems + title tokens, split on `_`/`-`. */
function conceptSubwords(view: HandbookView, sid: string): Set<string> {
  const vocab = new Set<string>();
  const feed = (word: string): void => {
    for (const sub of word.toLowerCase().split(/[_-]+/)) if (sub.length > 2) vocab.add(sub);
  };
  for (const stem of entryConcepts(view, sid)) feed(stem);
  for (const tok of titleTokens(view.tree.title(sid))) feed(tok);
  return vocab;
}

/** Concept words of a register id (`reg-` prefix and stopwords dropped). */
function registerWords(reg: RegisterEntry): string[] {
  return reg.id
    .replace(/^reg-/, '')
    .split('-')
    .filter((word) => word.length > 2 && !REGISTER_STOPWORDS.has(word));
}

interface StageRegisterHit {
  reg: RegisterEntry;
  via: string | null;
}

/** Direct register hits plus inherited-via-concept-word hits for leaf stages. */
function stageRegisters(view: HandbookView, sid: string): StageRegisterHit[] {
  const hits: StageRegisterHit[] = view.directRegisters(sid).map((reg) => ({ reg, via: null }));
  const seen = new Set(hits.map((h) => h.reg.id));
  const isLeaf = view.contentChildren(sid).length === 0;
  if (isLeaf) {
    const ancestors = new Set(view.ancestors(sid));
    const vocab = conceptSubwords(view, sid);
    for (const reg of view.model.registers) {
      if (seen.has(reg.id)) continue;
      if (!reg.stages.some((s) => ancestors.has(s))) continue;
      const via = registerWords(reg).find((word) => vocab.has(word));
      if (via !== undefined) {
        hits.push({ reg, via });
        seen.add(reg.id);
      }
    }
  }
  return hits;
}

/**
 * Test twins of `rel` — the file whose NAME marks it as the tests for this one.
 *
 * Every shipped language has its own convention, and missing one makes the whole
 * field silently render nowhere: `<stem>.test.*` / `<stem>.spec.*` is how TS/JS
 * name tests, so a TypeScript repo used to produce zero co-change lines while
 * sitting next to its own tests. Covered: `<stem>_test(s).*` (Go, Python, Shell),
 * `test_<stem>.*` (Python), `<stem>.test.*` / `<stem>.tests.*` / `<stem>.spec.*`
 * (TS/JS), `<stem>_spec.*` (spec-style suites). Looked for beside the file and in
 * a sibling `__tests__/` directory.
 */
export function strongTwins(rel: string, allFiles: readonly string[]): string[] {
  const stem = escapeRegExp(fileStem(rel));
  const patterns = [
    new RegExp(`^${stem}_tests?\\.[^.]+$`),
    new RegExp(`^${stem}_spec\\.[^.]+$`),
    new RegExp(`^test_${stem}\\.[^.]+$`),
    new RegExp(`^${stem}\\.(?:tests?|spec)\\.[^.]+$`),
  ];
  const dir = fileDir(rel);
  const twinDirs = new Set([dir, dir === '' ? '__tests__' : `${dir}/__tests__`]);
  return allFiles.filter(
    (f) => f !== rel && twinDirs.has(fileDir(f)) && patterns.some((p) => p.test(f.split('/').pop() ?? f)),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionCount(view: HandbookView, sid: string, rel: string): number {
  const organized = view.model.organization.stages[sid]?.groups
    .flatMap((g) => g.files)
    .find((f) => f.file === rel);
  if (organized && organized.nFunctions > 0) return organized.nFunctions;
  return view.card(rel).functions?.length ?? 0;
}

/** Core files: role priority, then function count desc, capped. */
function coreFiles(view: HandbookView, sid: string): { file: string; role: FileRole; nFns: number }[] {
  const ranked = view.directFiles(sid).map((file) => {
    const card = view.card(file);
    const priority = ROLE_PRIORITY.indexOf(card.role);
    return {
      file,
      role: card.role,
      nFns: functionCount(view, sid, file),
      priority: priority < 0 ? ROLE_PRIORITY.length : priority,
    };
  });
  ranked.sort((a, b) => a.priority - b.priority || b.nFns - a.nFns || a.file.localeCompare(b.file));
  return ranked.slice(0, CORE_FILES_CAP).map(({ file, role, nFns }) => ({ file, role, nFns }));
}

/** Title-token collision index: word → stage ids, df in [2, 6], no pure ancestor chains. */
export function buildCollisionIndex(view: HandbookView): Map<string, string[]> {
  const byToken = new Map<string, string[]>();
  for (const sid of view.contentStages()) {
    for (const tok of new Set(titleTokens(view.tree.title(sid)))) {
      const list = byToken.get(tok) ?? [];
      list.push(sid);
      byToken.set(tok, list);
    }
  }
  const collisions = new Map<string, string[]>();
  for (const [tok, sids] of byToken) {
    if (sids.length < 2 || sids.length > MAX_COLLISION_DF) continue;
    if (isPureAncestorChain(view, sids)) continue;
    const order = new Map(view.tree.order.map((s, i) => [s, i]));
    collisions.set(
      tok,
      [...sids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    );
  }
  return new Map(
    [...collisions.entries()].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0])),
  );
}

/** True when every stage in the set lies on one root-to-leaf path. */
function isPureAncestorChain(view: HandbookView, sids: readonly string[]): boolean {
  const deepest = [...sids].sort((a, b) => view.tree.depth(b) - view.tree.depth(a))[0];
  if (deepest === undefined) return true;
  const chain = new Set([deepest, ...view.ancestors(deepest)]);
  return sids.every((sid) => chain.has(sid));
}

interface LocatorContext {
  view: HandbookView;
  lang: NarrateLang;
  collisions: Map<string, string[]>;
  fileStage: Map<string, string>;
}

function locatorBlock(ctx: LocatorContext, sid: string, level: number, linkHeading: boolean): string {
  const { view, lang } = ctx;
  const L = LABELS[lang];
  const title = view.tree.title(sid);
  const headingText = `${sid} · ${title}`;
  const heading = `${'#'.repeat(Math.min(level, 6))} ${linkHeading ? `[${mdLinkText(headingText)}](${sid}.md)` : headingText}`;
  const parts: string[] = [heading];

  // Duty: the summary's full first paragraph, newlines flattened.
  const paragraph = view.summary(sid).split(/\n\s*\n/)[0] ?? '';
  const duty = paragraph.replace(/\s*\n\s*/g, ' ').trim();
  if (duty.length > 0) parts.push(`${L.duty}${duty}`);

  const concepts = entryConcepts(view, sid);
  if (concepts.length > 0) parts.push(`${L.entryConcepts}${concepts.map((c) => `\`${c}\``).join(' / ')}`);

  const regs = stageRegisters(view, sid);
  if (regs.length > 0) {
    const rendered = regs.map((h) => `\`${h.reg.id}\`${h.via !== null ? L.inherited(h.via) : ''}`);
    parts.push(`${L.state}${rendered.join(', ')}`);
  }

  const collidingWords = [...ctx.collisions.entries()]
    .filter(([, sids]) => sids.includes(sid))
    .map(([word]) => word);
  if (collidingWords.length > 0) {
    parts.push(`${L.collides} (${collidingWords.map((w) => `\`${w}\``).join(', ')})`);
  }

  const { groups } = view.groups(sid);
  const exemplars: string[] = [];
  for (const group of groups) {
    let best: { file: string; nFns: number } | null = null;
    for (const file of group.files) {
      const nFns = functionCount(view, sid, file);
      if (nFns > 0 && (best === null || nFns > best.nFns)) best = { file, nFns };
    }
    if (best !== null) exemplars.push(`- \`${best.file}\` [${group.title}] (${L.fns(best.nFns)})`);
  }
  if (exemplars.length > 0) parts.push(`${L.exemplar}\n${exemplars.join('\n')}`);

  const allFiles = [...ctx.fileStage.keys()];
  const twins: string[] = [];
  for (const file of view.directFiles(sid)) {
    for (const twin of strongTwins(file, allFiles)) {
      twins.push(`- \`${file}\` ↔ \`${twin}\` [${ctx.fileStage.get(twin) ?? '?'}]`);
    }
  }
  if (twins.length > 0) parts.push(`${L.strongCochange}\n${twins.join('\n')}`);

  if (groups.length > 0) {
    const related = groups.map((g) => `- ${g.title} (${L.files(g.files.length)})`);
    parts.push(`${L.related}\n${related.join('\n')}`);
  }

  const core = coreFiles(view, sid);
  if (core.length > 0) {
    const bullets = core.map((c) => `- \`${c.file}\` \`${c.role}\` (${L.fns(c.nFns)})`);
    parts.push(`${L.coreFiles}\n${bullets.join('\n')}`);
  }

  return parts.join('\n\n');
}

function howToUseMd(lang: NarrateLang, genericLanguages: readonly string[] = []): string {
  // The agent reads this page before it trusts anything else, so a weaker
  // analysis tier is disclosed HERE — not only in the human overview.
  const caveat =
    genericLanguages.length === 0
      ? ''
      : lang === 'zh'
        ? `\n- **${genericLanguages.join('、')} 的调用关系是尽力而为的**（通用分析器）：文件清单与阶段归属是精确的，但"谁调用谁"可能不全。对这些语言，把调用事实当线索而非结论，务必回源码核对。\n`
        : `\n- **Call relations for ${genericLanguages.join(', ')} are best-effort** (generic analyzer): the file inventory and stage assignment are exact, but "who calls whom" may be incomplete. Treat call facts for these languages as leads, not conclusions — confirm against the source.\n`;
  if (lang === 'zh') {
    return `# 如何使用本手册（智能体操作规程）

## 本手册是什么

- 一份**定位索引**：告诉你东西在哪里、下一步该读什么。
- 每条事实都锚定到文件路径、阶段 id 或寄存器 id。

## 本手册不是什么

- 不是代码的替代品。跳转过去并 Read 真实文件 — 手册可能过时；代码是唯一的事实来源。${caveat}

## 查找配方

- **改 X 该去哪里？** → 找 **入口概念** 提到 X 的阶段，打开它的 **范本**，照抄形状。
- **改这个文件还会牵动什么？** → 先看 **强共变**，再看 **相关**。
- **一个词命中太多阶段？** → 打开 [disambiguation.md](disambiguation.md)，按职责行选择。
- **涉及状态变更？** → 沿 **状态** 里的 \`reg-*\` id 去主手册的寄存器表（register.md）。

## 空字段即信息

字段只在结构信号存在时输出：没有列出强共变，就是没有检测到 — 不要凭空发明。

## 信任边界

- 锚点（路径、id、计数）是确定性生成的 → 可以信任。
- 叙述文字（职责行）只指方向 → 一切以代码为准。
`;
  }
  return `# How to use this handbook (agent operating protocol)

## What this handbook IS

- A **locator index**: it tells you where things live and what to read next.
- Every fact is anchored to a file path, a stage id, or a register id.

## What this handbook IS NOT

- Not a replacement for the code. Jump there and Read the real file — the handbook can be stale; the code is the only source of truth.${caveat}

## Lookup recipes

- **Where do I change X?** → find the stage whose **Entry concepts** mention X, open its **Exemplar**, copy the shape.
- **What else changes with this file?** → check **Strong co-change** first, then **Related**.
- **One word hits many stages?** → open [disambiguation.md](disambiguation.md) and pick by duty line.
- **State changes?** → follow the \`reg-*\` ids in **State** to the register table of the main handbook (register.md).

## An empty field is information

Fields are emitted only when the structural signal exists: if a stage lists no Strong co-change, none was detected — do not invent one.

## Trust boundary

- Anchors (paths, ids, counts) are deterministic → trust them.
- Prose (duty lines) gives direction only → verify in the code.
`;
}

function disambiguationMd(ctx: LocatorContext, written: ReadonlySet<string>): string {
  const { view, lang } = ctx;
  const L = LABELS[lang];
  const parts: string[] = [`# ${L.disambiguationTitle}`, L.disambiguationIntro];
  for (const [word, sids] of ctx.collisions) {
    parts.push(`## \`${word}\` (${L.hits(sids.length)})`);
    const bullets = sids.map((sid) => {
      const title = view.tree.title(sid);
      const oneLiner = truncate(firstSentence(view.summary(sid).split(/\n\s*\n/)[0] ?? title), 160);
      return written.has(sid)
        ? `- [\`${sid}\`](${sid}.md) ${title} — ${oneLiner}`
        : `- \`${sid}\` ${title} — ${oneLiner}`;
    });
    parts.push(bullets.join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

function agentIndexMd(ctx: LocatorContext): string {
  const L = LABELS[ctx.lang];
  const parts: string[] = [`# ${ctx.view.model.title} — ${L.indexTitle}`, L.indexIntro];
  const walk = (sid: string): void => {
    if (!ctx.view.hasContent(sid)) return;
    parts.push(locatorBlock(ctx, sid, Math.min(ctx.view.tree.depth(sid) + 2, 6), true));
    for (const child of ctx.view.tree.children(sid)) walk(child);
  };
  for (const root of ctx.view.contentRoots()) walk(root);
  return `${parts.join('\n\n')}\n`;
}

function agentStagePageMd(ctx: LocatorContext, sid: string): string {
  const parts: string[] = [locatorBlock(ctx, sid, 1, false), '---'];
  for (const file of ctx.view.directFiles(sid)) {
    parts.push(renderFileCardMd(file, ctx.view.card(file), ctx.lang));
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * Render the agent locator site into `outDir`.
 * Returns the number of stage pages and title-token collisions.
 */
export function renderAgentSite(
  model: HandbookModel,
  outDir: string,
  options: FidelityOptions = {},
): { nStagePages: number; nCollisions: number } {
  const view = new HandbookView(model);
  const ctx: LocatorContext = {
    view,
    lang: model.lang,
    collisions: buildCollisionIndex(view),
    fileStage: view.fileStageIndex(),
  };
  ensureDir(outDir);
  // The agent dir is fully renderer-owned: clear pages from previous renders.
  for (const stale of readdirSync(outDir)) {
    if (stale.endsWith('.md')) rmSync(join(outDir, stale), { force: true });
  }

  const contentStages = view.contentStages();
  const written = new Set(contentStages);
  for (const sid of contentStages) {
    writeFileAtomic(join(outDir, `${sid}.md`), agentStagePageMd(ctx, sid));
  }
  writeFileAtomic(
    join(outDir, 'how_to_use.md'),
    howToUseMd(model.lang, genericTierLanguages(options.languages)),
  );
  writeFileAtomic(join(outDir, 'index.md'), agentIndexMd(ctx));
  writeFileAtomic(join(outDir, 'disambiguation.md'), disambiguationMd(ctx, written));

  return { nStagePages: contentStages.length, nCollisions: ctx.collisions.size };
}
