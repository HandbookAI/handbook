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
import { HandbookView, mdLinkText, stageMapMermaid, genericTierLanguages } from './shared.js';
import type { FidelityOptions } from './shared.js';

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
  fidelityNote: (names: string) => string;
  /** Section title for the files no stage claims (see HandbookView.unassignedFiles). */
  unassignedTitle: string;
  /** The assigned/total split, stated wherever a reader might take the total on trust. */
  unassignedNote: (nUnassigned: number, nAssigned: number, nFiles: number) => string;
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
    fidelityNote: (names) =>
      `Analysis fidelity: call relations for ${names} are best-effort (generic analyzer); file inventory and stage assignment are exact.`,
    unassignedTitle: 'Files in no stage',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} of ${nFiles} files were placed in a stage; the remaining ${nUnassigned} were found by the parser but placed in none, so no stage section describes them.`,
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
    fidelityNote: (names) =>
      `保真度说明：${names} 的调用关系是尽力而为的（通用分析器）；文件清单与阶段归属是精确的。`,
    unassignedTitle: '未归入任何阶段的文件',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nFiles} 个文件中有 ${nAssigned} 个已归入阶段；其余 ${nUnassigned} 个是解析器扫到、但没有归入任何阶段的文件，因此没有任何阶段章节会描述它们。`,
  },
  hi: {
    handbookSection: 'Handbook',
    overviewTitle: 'अवलोकन',
    overviewDesc: 'सिस्टम अवलोकन और stage मानचित्र।',
    registerTitle: 'State-flow registers',
    registerDesc: 'Stages के आर-पार बहने वाला ग्लोबल state।',
    sep: ': ',
    systemOverview: 'सिस्टम अवलोकन',
    stageMap: 'Stage मानचित्र',
    stateFlow: 'State Flow',
    crosscutSuffix: ' (क्रॉसकट इन्फ़्रास्ट्रक्चर)',
    stages: (names) => `(stages: ${names})`,
    fidelityNote: (names) =>
      `Analysis fidelity: ${names} के लिए call relations यथासंभव हैं (सामान्य विश्लेषक); फ़ाइल सूची और stage असाइनमेंट सटीक हैं।`,
    unassignedTitle: 'किसी stage में न रखी गई फ़ाइलें',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nFiles} में से ${nAssigned} फ़ाइलें किसी stage में रखी गईं; बाकी ${nUnassigned} फ़ाइलें parser को मिलीं पर किसी stage में नहीं रखी गईं, इसलिए किसी stage खंड में इनका ब्यौरा नहीं है।`,
  },
  es: {
    handbookSection: 'Handbook',
    overviewTitle: 'Resumen',
    overviewDesc: 'Resumen del sistema y mapa de etapas.',
    registerTitle: 'Registros de flujo de estado',
    registerDesc: 'Estado global que fluye entre etapas.',
    sep: ': ',
    systemOverview: 'Resumen del sistema',
    stageMap: 'Mapa de etapas',
    stateFlow: 'Flujo de estado',
    crosscutSuffix: ' (infraestructura transversal)',
    stages: (names) => `(etapas: ${names})`,
    fidelityNote: (names) =>
      `Fidelidad del análisis: las relaciones de llamada de ${names} son de mejor esfuerzo (analizador genérico); el inventario de archivos y la asignación de etapas son exactos.`,
    unassignedTitle: 'Archivos sin etapa',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} de ${nFiles} archivos se asignaron a una etapa; los ${nUnassigned} restantes los encontró el analizador pero no quedaron en ninguna, así que ninguna sección de etapa los describe.`,
  },
  pt: {
    handbookSection: 'Handbook',
    overviewTitle: 'Visão geral',
    overviewDesc: 'Visão geral do sistema e mapa de etapas.',
    registerTitle: 'Registradores de fluxo de estado',
    registerDesc: 'Estado global que flui entre as etapas.',
    sep: ': ',
    systemOverview: 'Visão geral do sistema',
    stageMap: 'Mapa de etapas',
    stateFlow: 'Fluxo de estado',
    crosscutSuffix: ' (infraestrutura transversal)',
    stages: (names) => `(etapas: ${names})`,
    fidelityNote: (names) =>
      `Fidelidade da análise: as relações de chamada de ${names} são de melhor esforço (analisador genérico); o inventário de arquivos e a atribuição de etapas são exatos.`,
    unassignedTitle: 'Arquivos sem etapa',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} de ${nFiles} arquivos foram atribuídos a uma etapa; os ${nUnassigned} restantes foram encontrados pelo analisador mas não ficaram em nenhuma, portanto nenhuma seção de etapa os descreve.`,
  },
  ru: {
    handbookSection: 'Handbook',
    overviewTitle: 'Обзор',
    overviewDesc: 'Обзор системы и карта этапов.',
    registerTitle: 'Регистры потока состояния',
    registerDesc: 'Глобальное состояние, которое течёт между этапами.',
    sep: ': ',
    systemOverview: 'Обзор системы',
    stageMap: 'Карта этапов',
    stateFlow: 'Поток состояния',
    crosscutSuffix: ' (сквозная инфраструктура)',
    stages: (names) => `(этапы: ${names})`,
    fidelityNote: (names) =>
      `Достоверность анализа: связи вызовов для ${names} получены по мере возможностей (обобщённый анализатор); перечень файлов и распределение по этапам точны.`,
    unassignedTitle: 'Файлы вне этапов',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} из ${nFiles} файлов отнесены к этапу; остальные ${nUnassigned} анализатор нашёл, но ни к одному этапу не отнёс, поэтому ни один раздел этапа их не описывает.`,
  },
  ja: {
    handbookSection: 'Handbook',
    overviewTitle: '概要',
    overviewDesc: 'システム概要とステージマップ。',
    registerTitle: '状態フローのレジスタ',
    registerDesc: 'ステージをまたいで流れるグローバル状態。',
    sep: '：',
    systemOverview: 'システム概要',
    stageMap: 'ステージマップ',
    stateFlow: '状態フロー',
    crosscutSuffix: '（横断的インフラ）',
    stages: (names) => `（ステージ：${names}）`,
    fidelityNote: (names) =>
      `解析忠実度：${names} の呼び出し関係はベストエフォートです（汎用アナライザー）。ファイル一覧とステージ割り当ては正確です。`,
    unassignedTitle: 'どのステージにも属さないファイル',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nFiles} 個のうち ${nAssigned} 個のファイルがステージに配置されました。残る ${nUnassigned} 個はパーサーが見つけたものの、どのステージにも配置されていないため、どのステージの節にも説明がありません。`,
  },
  de: {
    handbookSection: 'Handbook',
    overviewTitle: 'Überblick',
    overviewDesc: 'Systemüberblick und Etappenkarte.',
    registerTitle: 'Zustandsfluss-Register',
    registerDesc: 'Globaler Zustand, der über Etappen hinweg fließt.',
    sep: ': ',
    systemOverview: 'Systemüberblick',
    stageMap: 'Etappenkarte',
    stateFlow: 'Zustandsfluss',
    crosscutSuffix: ' (querschnittliche Infrastruktur)',
    stages: (names) => `(Etappen: ${names})`,
    fidelityNote: (names) =>
      `Analysetreue: Aufrufbeziehungen für ${names} sind nach bestem Bemühen (generischer Analyzer); Dateiinventar und Etappenzuordnung sind exakt.`,
    unassignedTitle: 'Dateien ohne Etappe',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} von ${nFiles} Dateien wurden einer Etappe zugeordnet; die übrigen ${nUnassigned} hat der Parser gefunden, aber keiner Etappe zugeordnet — daher beschreibt sie kein Etappenabschnitt.`,
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

function llmsTxt(view: HandbookView, lang: NarrateLang, generic: readonly string[]): string {
  const L = LABELS[lang];
  const entry = (title: string, href: string, desc: string): string =>
    `- [${mdLinkText(title)}](${href})${L.sep}${desc}`;
  const links: string[] = [entry(L.overviewTitle, 'overview.md', L.overviewDesc)];
  for (const sid of view.contentRoots()) {
    links.push(entry(view.tree.title(sid), `${sid}.md`, stageDescription(view, sid)));
  }
  if (view.model.registers.length > 0) {
    links.push(entry(L.registerTitle, 'register.md', L.registerDesc));
  }
  const parts = [`# ${view.model.title}`, `> ${oneLine(view.model.narration.systemOverview, SUMMARY_MAX)}`];
  // An agent may read only the head of this file, so mixed fidelity is
  // disclosed before the link list rather than after it.
  if (generic.length > 0) parts.push(`> ${L.fidelityNote(generic.join(L === LABELS.zh ? '、' : ', '))}`);
  // Same reasoning, same place: the link list below reaches only stage pages, so
  // an agent that stops here would take it for the whole codebase. The paths
  // themselves are in llms-full.txt — a link list is the wrong shape for them.
  const unassigned = view.unassignedFiles();
  if (unassigned.length > 0) {
    const { nAssigned, nFiles } = view.model.assignment.coverage;
    parts.push(`> ${L.unassignedNote(unassigned.length, nAssigned, nFiles)}`);
  }
  parts.push(`## ${L.handbookSection}`, links.join('\n'));
  return `${parts.join('\n\n')}\n`;
}

function llmsFull(view: HandbookView, lang: NarrateLang, generic: readonly string[]): string {
  const L = LABELS[lang];
  const parts: string[] = [
    `# ${view.model.title}`,
    `## ${L.systemOverview}`,
    view.model.narration.systemOverview.trim(),
  ];
  if (generic.length > 0) parts.push(`> ${L.fidelityNote(generic.join(L === LABELS.zh ? '、' : ', '))}`);
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
  // This file claims to be the WHOLE handbook flattened, so the files no stage
  // claims belong in it by name. Everything above comes from the stage buckets,
  // which exclude them by construction.
  const unassigned = view.unassignedFiles();
  if (unassigned.length > 0) {
    const { nAssigned, nFiles } = view.model.assignment.coverage;
    parts.push(
      `## ${L.unassignedTitle}`,
      L.unassignedNote(unassigned.length, nAssigned, nFiles),
      unassigned.map((file) => `- \`${file}\``).join('\n'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * Render `llms.txt` and `llms-full.txt` into `outDir`.
 * Returns the two files written (absolute paths, llms.txt first). Expects the
 * markdown handbook to be rendered into the same directory so the llms.txt
 * links resolve.
 */
export function renderLlmsTxt(
  model: HandbookModel,
  outDir: string,
  options: FidelityOptions = {},
): { files: string[] } {
  const view = new HandbookView(model);
  ensureDir(outDir);
  const llmsPath = join(outDir, 'llms.txt');
  const fullPath = join(outDir, 'llms-full.txt');
  const generic = genericTierLanguages(options.languages);
  writeFileAtomic(llmsPath, llmsTxt(view, model.lang, generic));
  writeFileAtomic(fullPath, llmsFull(view, model.lang, generic));
  return { files: [llmsPath, fullPath] };
}
