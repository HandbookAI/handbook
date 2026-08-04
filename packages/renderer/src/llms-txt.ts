/**
 * llms.txt outputs (no LLM, no network).
 *
 * Writes the two AI-agent entry files into `outDir`:
 * - `llms.txt` — the llms.txt convention: H1 title, one-sentence summary
 *   blockquote, then a `## Handbook` section linking the markdown handbook
 *   pages produced by `renderMarkdownHandbook` (overview, top-level stages,
 *   register page), one short description per line.
 * - `llms-full.txt` — the whole handbook flattened into one plain-markdown
 *   document in reading order: overview prose (plus the mermaid stage map),
 *   each content stage's narration and organized file listing, registers.
 *
 * Both outputs are fully self-contained and honor `model.lang`.
 */
import { join } from 'node:path';
import { ensureDir, firstSentence, truncate, writeFileAtomic } from '@handbook/core';
import type { HandbookModel, NarrateLang } from '@handbook/core';
import { fileOneLiner } from './file-card.js';
import { HandbookView, stageMapMermaid } from './shared.js';

/** Longest summary blockquote emitted into llms.txt. */
const SUMMARY_MAX = 240;
/** Longest per-link description emitted into llms.txt. */
const DESCRIPTION_MAX = 160;

interface LlmsLabels {
  handbookSection: string;
  overviewTitle: string;
  overviewDesc: string;
  registerTitle: string;
  registerDesc: string;
  sep: string;
  systemOverview: string;
  stageMap: string;
  stateFlow: string;
  crosscutSuffix: string;
  stages: (names: string) => string;
}

const LABELS: Record<NarrateLang, LlmsLabels> = {
  en: {
    handbookSection: 'Handbook',
    overviewTitle: 'Overview',
    overviewDesc: 'System overview and stage map.',
    registerTitle: 'State-flow registers',
    registerDesc: 'Global state that flows across stages.',
    sep: ': ',
    systemOverview: 'System Overview',
    stageMap: 'Stage Map',
    stateFlow: 'State Flow',
    crosscutSuffix: ' (cross-cutting infrastructure)',
    stages: (names) => `(stages: ${names})`,
  },
  zh: {
    handbookSection: '手册',
    overviewTitle: '总览',
    overviewDesc: '系统总览与阶段地图。',
    registerTitle: '状态流动登记表',
    registerDesc: '跨阶段流动的全局状态。',
    sep: '：',
    systemOverview: '系统总览',
    stageMap: '阶段地图',
    stateFlow: '状态流动',
    crosscutSuffix: '（横切基础设施）',
    stages: (names) => `（涉及阶段：${names}）`,
  },
};

/** First sentence of `text`, newlines flattened, truncated to `max`. */
function oneLine(text: string, max: number): string {
  return truncate(firstSentence(text.replace(/\s+/g, ' ').trim()), max);
}

/** Link-line description of a stage: skeleton description, else narration. */
function stageDescription(view: HandbookView, sid: string): string {
  const description = view.tree.description(sid).trim();
  return oneLine(description.length > 0 ? description : view.summary(sid), DESCRIPTION_MAX);
}

function llmsTxt(view: HandbookView, lang: NarrateLang): string {
  const L = LABELS[lang];
  const entry = (title: string, href: string, desc: string): string =>
    `- [${title}](${href})${L.sep}${desc}`;
  const links: string[] = [entry(L.overviewTitle, 'overview.md', L.overviewDesc)];
  for (const sid of view.contentRoots()) {
    links.push(entry(view.tree.title(sid), `${sid}.md`, stageDescription(view, sid)));
  }
  if (view.model.registers.length > 0) {
    links.push(entry(L.registerTitle, 'register.md', L.registerDesc));
  }
  const parts = [
    `# ${view.model.title}`,
    `> ${oneLine(view.model.narration.systemOverview, SUMMARY_MAX)}`,
    `## ${L.handbookSection}`,
    links.join('\n'),
  ];
  return `${parts.join('\n\n')}\n`;
}

function llmsFull(view: HandbookView, lang: NarrateLang): string {
  const L = LABELS[lang];
  const parts: string[] = [
    `# ${view.model.title}`,
    `## ${L.systemOverview}`,
    view.model.narration.systemOverview.trim(),
  ];
  const mermaid = stageMapMermaid(view.tree);
  if (mermaid.length > 0) parts.push(`## ${L.stageMap}`, mermaid);

  for (const sid of view.contentStages()) {
    const crosscut = view.tree.isCrosscut(sid) ? L.crosscutSuffix : '';
    parts.push(`## ${view.tree.title(sid)} (\`${sid}\`)${crosscut}`, view.summary(sid));
    const { groups, leftovers } = view.groups(sid);
    for (const group of groups) {
      parts.push(`### ${group.title}`);
      if (group.summary.trim().length > 0) parts.push(group.summary.trim());
      parts.push(group.files.map((file) => fileOneLiner(file, view.card(file))).join('\n'));
    }
    if (leftovers.length > 0) {
      parts.push(leftovers.map((file) => fileOneLiner(file, view.card(file))).join('\n'));
    }
  }

  if (view.model.registers.length > 0) {
    const bullets = view.model.registers.map((reg) => {
      const names = reg.stages.map((sid) => view.tree.title(sid)).join(', ');
      return `- \`${reg.id}\` — ${reg.semantics} ${L.stages(names)}`;
    });
    parts.push(`## ${L.stateFlow}`, bullets.join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * Render `llms.txt` and `llms-full.txt` into `outDir`.
 * Returns the two files written (absolute paths, llms.txt first). Expects the
 * markdown handbook to be rendered into the same directory so the llms.txt
 * links resolve.
 */
export function renderLlmsTxt(model: HandbookModel, outDir: string): { files: string[] } {
  const view = new HandbookView(model);
  ensureDir(outDir);
  const llmsPath = join(outDir, 'llms.txt');
  const fullPath = join(outDir, 'llms-full.txt');
  writeFileAtomic(llmsPath, llmsTxt(view, model.lang));
  writeFileAtomic(fullPath, llmsFull(view, model.lang));
  return { files: [llmsPath, fullPath] };
}
