/**
 * Markdown handbook renderer (no LLM).
 *
 * Writes into `outDir`: one `<sid>.md` per content-bearing stage, plus
 * `overview.md`, `register.md` (when registers exist) and `index.md`.
 * Stage pages touched by a register get an appended, idempotently-markered
 * "State Registers Touched" section.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensureDir, writeFileAtomic } from '@handbook/core';
import type { HandbookModel, NarrateLang, RegisterEntry } from '@handbook/core';
import { renderFileCardMd } from './file-card.js';
import { HandbookView, genericTierLanguages, mdLinkText, stageMapMermaid } from './shared.js';
import type { RenderOptions, SourceLinkOptions } from './shared.js';

interface MdLabels {
  subStages: string;
  filesInStage: string;
  systemOverview: string;
  stageMap: string;
  seeAlso: string;
  seeAlsoRegister: string;
  seeAlsoIndex: string;
  stateFlowSuffix: string;
  stageIndexSuffix: string;
  indexIntro: string;
  crosscutBadge: string;
  crosscutInline: string;
  files: (n: number) => string;
  registerTableHeading: string;
  registerTableHeader: string;
  noRegisters: string;
  stageRegisterMarker: string;
  /** Disclosure for languages analyzed by the generic engine (see genericTierLanguages). */
  fidelityNote: (languages: readonly string[]) => string;
}

const LABELS: Record<NarrateLang, MdLabels> = {
  en: {
    subStages: 'Sub-stages',
    filesInStage: 'Files in this stage',
    systemOverview: '## 🗺️ System Overview',
    stageMap: '## 🧭 Stage Map',
    seeAlso: 'See also',
    seeAlsoRegister: '- [State-flow registers](register.md) — global state that flows across stages.',
    seeAlsoIndex: '- [Stage index](index.md) — every stage and what it does.',
    stateFlowSuffix: 'State Flow',
    stageIndexSuffix: 'Stage Index',
    indexIntro:
      "Each stage below links to its full page; the paragraph is the stage's role in the system.",
    crosscutBadge: ' (cross-cutting infrastructure)',
    crosscutInline: ' · (cross-cutting)',
    files: (n) => `${n} files`,
    registerTableHeading: '## 🔄 State Flow Overview',
    registerTableHeader: '| State register | Semantics | Stages touched |\n| --- | --- | --- |',
    noRegisters: '_(No state registers extracted.)_',
    stageRegisterMarker: '## 📊 State Registers Touched',
    fidelityNote: (languages) =>
      `> **Analysis fidelity** — call relations for ${languages.join(', ')} come from the generic (config-driven) analyzer: they are best-effort and may be incomplete. The file inventory and the structure of these languages are exact.`,
  },
  zh: {
    subStages: '子阶段',
    filesInStage: '本阶段的文件',
    systemOverview: '## 🗺️ 系统总览',
    stageMap: '## 🧭 阶段地图',
    seeAlso: '另见',
    seeAlsoRegister: '- [状态流动登记表](register.md) — 跨阶段流动的全局状态。',
    seeAlsoIndex: '- [阶段索引](index.md) — 每个阶段及其职责。',
    stateFlowSuffix: '状态流动',
    stageIndexSuffix: '阶段索引',
    indexIntro: '下面每个阶段都链接到其完整页面；段落描述该阶段在系统中的职责。',
    crosscutBadge: '（横切基础设施）',
    crosscutInline: ' ·（横切）',
    files: (n) => `${n} 个文件`,
    registerTableHeading: '## 🔄 状态流动总览',
    registerTableHeader: '| 状态寄存器 | 语义 | 涉及阶段 |\n| --- | --- | --- |',
    noRegisters: '_（未提取到状态寄存器。）_',
    stageRegisterMarker: '## 📊 本阶段涉及的状态',
    fidelityNote: (languages) =>
      `> **保真度说明** —— ${languages.join('、')} 的调用关系来自通用（配置驱动）分析器：尽力而为，可能不完整。这些语言的文件清单与结构仍是精确的。`,
  },
};

/** The per-stage register-section marker used for idempotent appends. */
export function stageSectionMarker(lang: NarrateLang): string {
  return LABELS[lang].stageRegisterMarker;
}

/**
 * Make a value safe inside a markdown table cell: flatten row-breaking
 * newlines to spaces and escape `|` so it can't open an extra column. Both
 * register semantics and stage titles are LLM/free text.
 */
function tableCell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function renderRegisterTable(
  registers: readonly RegisterEntry[],
  titleOf: (sid: string) => string,
  lang: NarrateLang,
  hasPage: (sid: string) => boolean,
): string {
  const L = LABELS[lang];
  if (registers.length === 0) return `${L.registerTableHeading}\n\n${L.noRegisters}\n`;
  const rows = registers.map((reg) => {
    const semantics = tableCell(reg.semantics);
    // Only content-bearing stages get pages; anything else renders as plain
    // text so the table never emits a dead link (register ids are LLM output).
    const stages = reg.stages
      .map((sid) => (hasPage(sid) ? `[${tableCell(mdLinkText(titleOf(sid)))}](${sid}.md)` : `\`${sid}\``))
      .join(', ');
    return `| \`${reg.id}\` | ${semantics} | ${stages} |`;
  });
  return `${L.registerTableHeading}\n\n${L.registerTableHeader}\n${rows.join('\n')}\n`;
}

function renderStageRegisters(registers: readonly RegisterEntry[], lang: NarrateLang): string {
  if (registers.length === 0) return '';
  const bullets = registers.map((reg) => `- \`${reg.id}\` — ${reg.semantics}`);
  return `${LABELS[lang].stageRegisterMarker}\n\n${bullets.join('\n')}\n`;
}

function stagePageMd(
  view: HandbookView,
  sid: string,
  lang: NarrateLang,
  options: SourceLinkOptions,
): string {
  const L = LABELS[lang];
  const { tree } = view;
  const crosscut = tree.isCrosscut(sid) ? L.crosscutBadge : '';
  const parts: string[] = [`# ${tree.title(sid)} \`${sid}\`${crosscut}`, view.summary(sid)];

  const children = view.contentChildren(sid);
  if (children.length > 0) {
    const bullets = children.map(
      (child) => `- [${mdLinkText(tree.title(child))}](${child}.md) \`${child}\` — ${L.files(view.subtreeFileCount(child))}`,
    );
    parts.push(`## ${L.subStages}\n\n${bullets.join('\n')}`);
  }

  const direct = view.directFiles(sid);
  if (direct.length > 0) {
    const section: string[] = [`## ${L.filesInStage}`];
    const { groups, leftovers } = view.groups(sid);
    for (const group of groups) {
      section.push(`### ${group.title}`);
      if (group.summary.trim().length > 0) section.push(group.summary.trim());
      for (const file of group.files) section.push(renderFileCardMd(file, view.card(file), lang, options));
    }
    for (const file of leftovers) section.push(renderFileCardMd(file, view.card(file), lang, options));
    parts.push(section.join('\n\n'));
  }

  return `${parts.join('\n\n')}\n`;
}

function overviewMd(view: HandbookView, lang: NarrateLang, options: RenderOptions): string {
  const L = LABELS[lang];
  const parts = [`# ${view.model.title}`, L.systemOverview, view.model.narration.systemOverview.trim()];
  // Disclose mixed fidelity right under the overview prose, where a reader (or an
  // agent) forms its trust in the call facts — and nowhere at all when every
  // language is full-tier, so the common case stays noise-free.
  const generic = genericTierLanguages(options.languages);
  if (generic.length > 0) parts.push(L.fidelityNote(generic));
  const mermaid = stageMapMermaid(view.tree);
  if (mermaid.length > 0) parts.push(L.stageMap, mermaid);
  parts.push('---', `## ${L.seeAlso}`);
  const links: string[] = [];
  if (view.model.registers.length > 0) links.push(L.seeAlsoRegister);
  links.push(L.seeAlsoIndex);
  parts.push(links.join('\n'));
  return `${parts.join('\n\n')}\n`;
}

function indexMd(view: HandbookView, lang: NarrateLang): string {
  const L = LABELS[lang];
  const parts: string[] = [`# ${view.model.title} — ${L.stageIndexSuffix}`, L.indexIntro];
  const walk = (sid: string): void => {
    if (!view.hasContent(sid)) return;
    const level = Math.min(view.tree.depth(sid) + 2, 6);
    const crosscut = view.tree.isCrosscut(sid) ? L.crosscutInline : '';
    parts.push(
      `${'#'.repeat(level)} [${mdLinkText(view.tree.title(sid))}](${sid}.md) \`${sid}\`${crosscut} — ${L.files(view.subtreeFileCount(sid))}`,
    );
    parts.push(view.summary(sid));
    for (const child of view.tree.children(sid)) walk(child);
  };
  for (const root of view.contentRoots()) walk(root);
  return `${parts.join('\n\n')}\n`;
}

/**
 * Render the full markdown handbook into `outDir`.
 * Returns the number of stage pages and every file written (absolute paths).
 * `options.sourceBaseUrl` (opt-in) turns every file-card path into a link to
 * the source file; without it the output contains no external URLs.
 * `options.languages` (opt-in) discloses per-language analysis fidelity in the
 * overview; without it the output is unchanged.
 */
export function renderMarkdownHandbook(
  model: HandbookModel,
  outDir: string,
  options: RenderOptions = {},
): { nStagePages: number; files: string[] } {
  const view = new HandbookView(model);
  const lang = model.lang;
  ensureDir(outDir);
  // Remove pages written by a PREVIOUS render (tracked in a manifest): stage
  // ids change between generations, and stale pages would linger forever —
  // polluting the handbook dir and getting scooped up by the skill packager.
  cleanupPreviousRender(outDir);
  const written: string[] = [];
  const write = (name: string, content: string): void => {
    const path = join(outDir, name);
    writeFileAtomic(path, content);
    written.push(path);
  };

  const contentStages = view.contentStages();
  for (const sid of contentStages) write(`${sid}.md`, stagePageMd(view, sid, lang, options));

  write('overview.md', overviewMd(view, lang, options));
  if (model.registers.length > 0) {
    const table = renderRegisterTable(model.registers, (sid) => view.tree.title(sid), lang, (sid) =>
      view.hasContent(sid),
    );
    const suffix = LABELS[lang].stateFlowSuffix;
    write('register.md', `# ${model.title} — ${suffix}\n\n${table}`);
  }
  write('index.md', indexMd(view, lang));

  // Idempotent per-stage register annotation: append only when the marker is absent.
  const marker = stageSectionMarker(lang);
  const touched = new Set(model.registers.flatMap((reg) => reg.stages));
  for (const sid of contentStages) {
    if (!touched.has(sid)) continue;
    const path = join(outDir, `${sid}.md`);
    const current = readFileSync(path, 'utf8');
    if (current.includes(marker)) continue;
    const section = renderStageRegisters(view.directRegisters(sid), lang);
    if (section.length > 0) writeFileAtomic(path, `${current}\n${section}`);
  }

  writeRenderManifest(outDir, written);
  return { nStagePages: contentStages.length, files: written };
}

const MANIFEST_NAME = '.render-manifest.json';

function cleanupPreviousRender(outDir: string): void {
  const manifestPath = join(outDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: unknown };
    for (const rel of Array.isArray(raw.files) ? raw.files : []) {
      if (typeof rel !== 'string' || rel.includes('/') || rel.includes('..')) continue;
      rmSync(join(outDir, rel), { force: true });
    }
  } catch {
    // an unreadable manifest must never block a render
  }
}

function writeRenderManifest(outDir: string, absoluteFiles: readonly string[]): void {
  const files = absoluteFiles.map((p) => basename(p));
  writeFileAtomic(join(outDir, MANIFEST_NAME), `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}
