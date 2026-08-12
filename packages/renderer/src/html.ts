/**
 * HTML renderers (no LLM, no network).
 *
 * `renderHtmlSite` writes a multi-page site (index/overview/register/<sid>.html)
 * with a shared shell: sidebar stage tree, sticky breadcrumb bar, per-page table
 * of contents with scroll-spy, ⌘K search over stages/files/functions/registers,
 * tri-state theme, previous/next pager and a mobile drawer.
 * `renderSinglePageHtml` writes the same shell as ONE self-contained file, with
 * numbered sections and every stage as a collapsed `<details>`.
 *
 * All CSS/JS is inlined and every link is relative, so both work over `file://`.
 * The one exception is the cross-page search index, which the multi-page site
 * writes as a sibling `search-index.js` — inlining it into each of N pages would
 * multiply it by N. A page opened on its own simply hides the search affordance;
 * the single-file render inlines the same index and keeps it.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { MarkdownIt as Markdown } from 'markdown-it';
import { ensureDir, firstSentence, truncate, writeFileAtomic } from '@handbooks/core';
import type { FileCard, FunctionNote, HandbookModel, NarrateLang } from '@handbooks/core';
import { callFactsLine } from './file-card.js';
import { CSS, ICONS, SCRIPT, THEME_BOOT } from './html-assets.js';
import { HandbookView, genericTierLanguages, sourceFileUrl } from './shared.js';
import type { FidelityOptions, RenderOptions } from './shared.js';

interface HtmlLabels {
  systemOverview: string;
  stages: string;
  subStages: string;
  filesInStage: string;
  functions: string;
  registers: string;
  registersTouched: string;
  registerHeader: [string, string, string];
  overview: string;
  expandAll: string;
  collapseAll: string;
  system: string;
  crosscut: string;
  files: (n: number) => string;
  functionCount: (n: number) => string;
  lines: (a: number, b: number) => string;
  purpose: string;
  dataFlow: string;
  relations: string;
  runsWhen: string;
  noProse: string;
  fidelityLead: string;
  /** Disclosure for languages analyzed by the generic engine (see genericTierLanguages). */
  fidelityNote: (languages: readonly string[]) => string;
  /**
   * The global file count when some file landed in no stage. `files(n)` states
   * a total the pages then contradict by showing fewer; this one shows the
   * split instead (see fileCountChip).
   */
  filesPartial: (assigned: number, total: number) => string;
  /** Heading of the overview's list of files no stage claims. */
  unassigned: string;
  /** Why that list is there, with the assigned/total split spelled out. */
  unassignedNote: (nUnassigned: number, nAssigned: number, nFiles: number) => string;
  /** Shell chrome. */
  onThisPage: string;
  search: string;
  searchPlaceholder: string;
  noHits: string;
  navigateHint: string;
  openHint: string;
  closeHint: string;
  kinds: [string, string, string, string];
  themeAuto: string;
  themeLight: string;
  themeDark: string;
  menu: string;
  backToTop: string;
  copy: string;
  copied: string;
  previous: string;
  next: string;
  reference: string;
  anchorTitle: string;
}

const LABELS: Record<NarrateLang, HtmlLabels> = {
  en: {
    systemOverview: 'System Overview',
    stages: 'Stages',
    subStages: 'Sub-stages',
    filesInStage: 'Files in this stage',
    functions: 'Functions',
    registers: 'State Flow Overview',
    registersTouched: 'State Registers Touched',
    registerHeader: ['State register', 'Semantics', 'Stages touched'],
    overview: 'Overview',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    system: 'System',
    crosscut: 'cross-cutting',
    files: (n) => `${n} ${n === 1 ? 'file' : 'files'}`,
    functionCount: (n) => `${n} ${n === 1 ? 'function' : 'functions'}`,
    lines: (a, b) => `lines ${a}–${b}`,
    purpose: 'Purpose',
    dataFlow: 'Data flow',
    relations: 'Call relations',
    runsWhen: 'Runs',
    noProse: '(This file has no description yet.)',
    fidelityLead: 'Analysis fidelity',
    fidelityNote: (languages) =>
      `call relations for ${languages.join(', ')} come from the generic (config-driven) analyzer: they are best-effort and may be incomplete. The file inventory and the structure of these languages are exact.`,
    filesPartial: (assigned, total) => `${assigned} of ${total} files in a stage`,
    unassigned: 'Files in no stage',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} of ${nFiles} files were placed in a stage. The ${nUnassigned} below were found by the parser but placed in none, so no stage page describes them.`,
    onThisPage: 'On this page',
    search: 'Search',
    searchPlaceholder: 'Search stages, files, functions…',
    noHits: 'Nothing matches that.',
    navigateHint: '↑↓ to move',
    openHint: '↵ to open',
    closeHint: 'esc to close',
    kinds: ['Stage', 'File', 'Function', 'State'],
    themeAuto: 'Theme: follow system',
    themeLight: 'Theme: light',
    themeDark: 'Theme: dark',
    menu: 'Open navigation',
    backToTop: 'Back to top',
    copy: 'Copy',
    copied: 'Copied',
    previous: 'Previous',
    next: 'Next',
    reference: 'Reference',
    anchorTitle: 'Link to this section',
  },
  zh: {
    systemOverview: '系统总览',
    stages: '阶段',
    subStages: '子阶段',
    filesInStage: '本阶段的文件',
    functions: '函数',
    registers: '状态流动总览',
    registersTouched: '本阶段涉及的状态',
    registerHeader: ['状态寄存器', '语义', '涉及阶段'],
    overview: '总览',
    expandAll: '展开全部',
    collapseAll: '收起全部',
    system: '系统',
    crosscut: '横切',
    files: (n) => `${n} 个文件`,
    functionCount: (n) => `${n} 个函数`,
    lines: (a, b) => `行 ${a}–${b}`,
    purpose: '作用',
    dataFlow: '数据流',
    relations: '调用关系',
    runsWhen: '运行时机',
    noProse: '（该文件暂无描述。）',
    fidelityLead: '保真度说明',
    fidelityNote: (languages) =>
      `${languages.join('、')} 的调用关系来自通用（配置驱动）分析器：尽力而为，可能不完整。这些语言的文件清单与结构仍是精确的。`,
    filesPartial: (assigned, total) => `${total} 个文件中 ${assigned} 个已归入阶段`,
    unassigned: '未归入任何阶段的文件',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nFiles} 个文件中有 ${nAssigned} 个已归入阶段。下面这 ${nUnassigned} 个是解析器扫到、但没有归入任何阶段的文件，因此没有任何阶段页面会描述它们。`,
    onThisPage: '本页目录',
    search: '搜索',
    searchPlaceholder: '搜索阶段、文件、函数…',
    noHits: '没有匹配的结果。',
    navigateHint: '↑↓ 选择',
    openHint: '↵ 打开',
    closeHint: 'esc 关闭',
    kinds: ['阶段', '文件', '函数', '状态'],
    themeAuto: '主题：跟随系统',
    themeLight: '主题：浅色',
    themeDark: '主题：深色',
    menu: '打开导航',
    backToTop: '回到顶部',
    copy: '复制',
    copied: '已复制',
    previous: '上一页',
    next: '下一页',
    reference: '参考',
    anchorTitle: '链接到本节',
  },
  hi: {
    systemOverview: 'सिस्टम अवलोकन',
    stages: 'Stages',
    subStages: 'उप-stages',
    filesInStage: 'इस stage की फ़ाइलें',
    functions: 'फ़ंक्शन',
    registers: 'State flow अवलोकन',
    registersTouched: 'इस stage से जुड़े state registers',
    registerHeader: ['State register', 'अर्थ', 'संबंधित stages'],
    overview: 'अवलोकन',
    expandAll: 'सब खोलें',
    collapseAll: 'सब बंद करें',
    system: 'सिस्टम',
    crosscut: 'क्रॉसकट',
    files: (n) => `${n} ${n === 1 ? 'फ़ाइल' : 'फ़ाइलें'}`,
    functionCount: (n) => `${n} फ़ंक्शन`,
    lines: (a, b) => `लाइनें ${a}–${b}`,
    purpose: 'उद्देश्य',
    dataFlow: 'डेटा प्रवाह',
    relations: 'Call relations',
    runsWhen: 'कब चलता है',
    noProse: '(इस फ़ाइल का विवरण अभी नहीं है।)',
    fidelityLead: 'Analysis fidelity',
    fidelityNote: (languages) =>
      `${languages.join(', ')} के लिए call relations सामान्य (कॉन्फ़िग-आधारित) विश्लेषक से आते हैं: ये यथासंभव हैं और अधूरे हो सकते हैं। इन भाषाओं की फ़ाइल सूची और संरचना सटीक हैं।`,
    filesPartial: (assigned, total) => `${total} में से ${assigned} फ़ाइलें किसी stage में`,
    unassigned: 'किसी stage में न रखी गई फ़ाइलें',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nFiles} में से ${nAssigned} फ़ाइलें किसी stage में रखी गईं। नीचे दी गई ${nUnassigned} फ़ाइलें parser को मिलीं पर किसी stage में नहीं रखी गईं, इसलिए किसी stage पेज पर इनका ब्यौरा नहीं है।`,
    onThisPage: 'इस पेज पर',
    search: 'खोजें',
    searchPlaceholder: 'Stages, फ़ाइलें, फ़ंक्शन खोजें…',
    noHits: 'कुछ भी मेल नहीं खाता।',
    navigateHint: '↑↓ चुनें',
    openHint: '↵ खोलें',
    closeHint: 'esc बंद करें',
    kinds: ['Stage', 'फ़ाइल', 'फ़ंक्शन', 'State'],
    themeAuto: 'थीम: सिस्टम के अनुसार',
    themeLight: 'थीम: लाइट',
    themeDark: 'थीम: डार्क',
    menu: 'नेविगेशन खोलें',
    backToTop: 'ऊपर जाएँ',
    copy: 'कॉपी',
    copied: 'कॉपी हो गया',
    previous: 'पिछला',
    next: 'अगला',
    reference: 'संदर्भ',
    anchorTitle: 'इस अनुभाग का लिंक',
  },
  es: {
    systemOverview: 'Resumen del sistema',
    stages: 'Etapas',
    subStages: 'Subetapas',
    filesInStage: 'Archivos de esta etapa',
    functions: 'Funciones',
    registers: 'Resumen del flujo de estado',
    registersTouched: 'Registros de estado implicados',
    registerHeader: ['Registro de estado', 'Semántica', 'Etapas implicadas'],
    overview: 'Resumen',
    expandAll: 'Expandir todo',
    collapseAll: 'Contraer todo',
    system: 'Sistema',
    crosscut: 'transversal',
    files: (n) => `${n} ${n === 1 ? 'archivo' : 'archivos'}`,
    functionCount: (n) => `${n} ${n === 1 ? 'función' : 'funciones'}`,
    lines: (a, b) => `líneas ${a}–${b}`,
    purpose: 'Propósito',
    dataFlow: 'Flujo de datos',
    relations: 'Relaciones de llamada',
    runsWhen: 'Se ejecuta',
    noProse: '(Este archivo aún no tiene descripción.)',
    fidelityLead: 'Fidelidad del análisis',
    fidelityNote: (languages) =>
      `las relaciones de llamada de ${languages.join(', ')} vienen del analizador genérico (guiado por configuración): son de mejor esfuerzo y pueden estar incompletas. El inventario de archivos y la estructura de estos lenguajes son exactos.`,
    filesPartial: (assigned, total) => `${assigned} de ${total} archivos en una etapa`,
    unassigned: 'Archivos sin etapa',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} de ${nFiles} archivos se asignaron a una etapa. Los ${nUnassigned} de abajo los encontró el analizador pero no quedaron en ninguna, así que ninguna página de etapa los describe.`,
    onThisPage: 'En esta página',
    search: 'Buscar',
    searchPlaceholder: 'Buscar etapas, archivos, funciones…',
    noHits: 'No hay coincidencias.',
    navigateHint: '↑↓ para moverse',
    openHint: '↵ para abrir',
    closeHint: 'esc para cerrar',
    kinds: ['Etapa', 'Archivo', 'Función', 'Estado'],
    themeAuto: 'Tema: seguir al sistema',
    themeLight: 'Tema: claro',
    themeDark: 'Tema: oscuro',
    menu: 'Abrir navegación',
    backToTop: 'Volver arriba',
    copy: 'Copiar',
    copied: 'Copiado',
    previous: 'Anterior',
    next: 'Siguiente',
    reference: 'Referencia',
    anchorTitle: 'Enlace a esta sección',
  },
  pt: {
    systemOverview: 'Visão geral do sistema',
    stages: 'Etapas',
    subStages: 'Subetapas',
    filesInStage: 'Arquivos desta etapa',
    functions: 'Funções',
    registers: 'Visão geral do fluxo de estado',
    registersTouched: 'Registradores de estado envolvidos',
    registerHeader: ['Registrador de estado', 'Semântica', 'Etapas envolvidas'],
    overview: 'Visão geral',
    expandAll: 'Expandir tudo',
    collapseAll: 'Recolher tudo',
    system: 'Sistema',
    crosscut: 'transversal',
    files: (n) => `${n} ${n === 1 ? 'arquivo' : 'arquivos'}`,
    functionCount: (n) => `${n} ${n === 1 ? 'função' : 'funções'}`,
    lines: (a, b) => `linhas ${a}–${b}`,
    purpose: 'Propósito',
    dataFlow: 'Fluxo de dados',
    relations: 'Relações de chamada',
    runsWhen: 'Executa',
    noProse: '(Este arquivo ainda não tem descrição.)',
    fidelityLead: 'Fidelidade da análise',
    fidelityNote: (languages) =>
      `as relações de chamada de ${languages.join(', ')} vêm do analisador genérico (guiado por configuração): são de melhor esforço e podem estar incompletas. O inventário de arquivos e a estrutura dessas linguagens são exatos.`,
    filesPartial: (assigned, total) => `${assigned} de ${total} arquivos em uma etapa`,
    unassigned: 'Arquivos sem etapa',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} de ${nFiles} arquivos foram atribuídos a uma etapa. Os ${nUnassigned} abaixo foram encontrados pelo analisador mas não ficaram em nenhuma, portanto nenhuma página de etapa os descreve.`,
    onThisPage: 'Nesta página',
    search: 'Buscar',
    searchPlaceholder: 'Buscar etapas, arquivos, funções…',
    noHits: 'Nada corresponde a isso.',
    navigateHint: '↑↓ para navegar',
    openHint: '↵ para abrir',
    closeHint: 'esc para fechar',
    kinds: ['Etapa', 'Arquivo', 'Função', 'Estado'],
    themeAuto: 'Tema: seguir o sistema',
    themeLight: 'Tema: claro',
    themeDark: 'Tema: escuro',
    menu: 'Abrir navegação',
    backToTop: 'Voltar ao topo',
    copy: 'Copiar',
    copied: 'Copiado',
    previous: 'Anterior',
    next: 'Próximo',
    reference: 'Referência',
    anchorTitle: 'Link para esta seção',
  },
  ru: {
    systemOverview: 'Обзор системы',
    stages: 'Этапы',
    subStages: 'Подэтапы',
    filesInStage: 'Файлы этого этапа',
    functions: 'Функции',
    registers: 'Обзор потока состояния',
    registersTouched: 'Затронутые регистры состояния',
    registerHeader: ['Регистр состояния', 'Семантика', 'Затронутые этапы'],
    overview: 'Обзор',
    expandAll: 'Развернуть все',
    collapseAll: 'Свернуть все',
    system: 'Система',
    crosscut: 'сквозной',
    files: (n) => `${n} ${n === 1 ? 'файл' : 'файлов'}`,
    functionCount: (n) => `${n} ${n === 1 ? 'функция' : 'функций'}`,
    lines: (a, b) => `строки ${a}–${b}`,
    purpose: 'Назначение',
    dataFlow: 'Поток данных',
    relations: 'Связи вызовов',
    runsWhen: 'Когда выполняется',
    noProse: '(У этого файла пока нет описания.)',
    fidelityLead: 'Достоверность анализа',
    fidelityNote: (languages) =>
      `связи вызовов для ${languages.join(', ')} получены обобщённым (основанным на конфигурации) анализатором: по мере возможностей и, вероятно, неполно. Перечень файлов и структура этих языков точны.`,
    filesPartial: (assigned, total) => `${assigned} из ${total} файлов в этапах`,
    unassigned: 'Файлы вне этапов',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} из ${nFiles} файлов отнесены к этапу. Перечисленные ниже ${nUnassigned} анализатор нашёл, но ни к одному этапу не отнёс, поэтому ни одна страница этапа их не описывает.`,
    onThisPage: 'На этой странице',
    search: 'Поиск',
    searchPlaceholder: 'Искать этапы, файлы, функции…',
    noHits: 'Ничего не найдено.',
    navigateHint: '↑↓ — перемещение',
    openHint: '↵ — открыть',
    closeHint: 'esc — закрыть',
    kinds: ['Этап', 'Файл', 'Функция', 'Состояние'],
    themeAuto: 'Тема: как в системе',
    themeLight: 'Тема: светлая',
    themeDark: 'Тема: тёмная',
    menu: 'Открыть навигацию',
    backToTop: 'Наверх',
    copy: 'Копировать',
    copied: 'Скопировано',
    previous: 'Назад',
    next: 'Вперёд',
    reference: 'Справка',
    anchorTitle: 'Ссылка на этот раздел',
  },
  ja: {
    systemOverview: 'システム概要',
    stages: 'ステージ',
    subStages: 'サブステージ',
    filesInStage: 'このステージのファイル',
    functions: '関数',
    registers: '状態フロー概要',
    registersTouched: 'このステージが触れる状態レジスタ',
    registerHeader: ['状態レジスタ', '意味', '関係するステージ'],
    overview: '概要',
    expandAll: 'すべて展開',
    collapseAll: 'すべて折りたたむ',
    system: 'システム',
    crosscut: '横断',
    files: (n) => `${n} ファイル`,
    functionCount: (n) => `${n} 関数`,
    lines: (a, b) => `${a}–${b} 行`,
    purpose: '目的',
    dataFlow: 'データフロー',
    relations: '呼び出し関係',
    runsWhen: '実行時期',
    noProse: '（このファイルの説明はまだありません。）',
    fidelityLead: '解析忠実度',
    fidelityNote: (languages) =>
      `${languages.join('、')} の呼び出し関係は汎用（設定駆動）アナライザーによるものです：ベストエフォートのため不完全な場合があります。これらの言語のファイル一覧と構造は正確です。`,
    filesPartial: (assigned, total) => `${total} 個中 ${assigned} 個のファイルがステージに所属`,
    unassigned: 'どのステージにも属さないファイル',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nFiles} 個のうち ${nAssigned} 個のファイルがステージに配置されました。以下の ${nUnassigned} 個はパーサーが見つけたものの、どのステージにも配置されていないため、どのステージのページにも説明がありません。`,
    onThisPage: 'このページの目次',
    search: '検索',
    searchPlaceholder: 'ステージ・ファイル・関数を検索…',
    noHits: '一致するものがありません。',
    navigateHint: '↑↓ で移動',
    openHint: '↵ で開く',
    closeHint: 'esc で閉じる',
    kinds: ['ステージ', 'ファイル', '関数', '状態'],
    themeAuto: 'テーマ：システムに従う',
    themeLight: 'テーマ：ライト',
    themeDark: 'テーマ：ダーク',
    menu: 'ナビゲーションを開く',
    backToTop: 'トップへ戻る',
    copy: 'コピー',
    copied: 'コピーしました',
    previous: '前へ',
    next: '次へ',
    reference: 'リファレンス',
    anchorTitle: 'このセクションへのリンク',
  },
  de: {
    systemOverview: 'Systemüberblick',
    stages: 'Etappen',
    subStages: 'Unteretappen',
    filesInStage: 'Dateien in dieser Etappe',
    functions: 'Funktionen',
    registers: 'Überblick über den Zustandsfluss',
    registersTouched: 'Berührte Zustandsregister',
    registerHeader: ['Zustandsregister', 'Semantik', 'Berührte Etappen'],
    overview: 'Überblick',
    expandAll: 'Alle ausklappen',
    collapseAll: 'Alle einklappen',
    system: 'System',
    crosscut: 'querschnittlich',
    files: (n) => `${n} ${n === 1 ? 'Datei' : 'Dateien'}`,
    functionCount: (n) => `${n} ${n === 1 ? 'Funktion' : 'Funktionen'}`,
    lines: (a, b) => `Zeilen ${a}–${b}`,
    purpose: 'Zweck',
    dataFlow: 'Datenfluss',
    relations: 'Aufrufbeziehungen',
    runsWhen: 'Läuft',
    noProse: '(Diese Datei hat noch keine Beschreibung.)',
    fidelityLead: 'Analysetreue',
    fidelityNote: (languages) =>
      `Aufrufbeziehungen für ${languages.join(', ')} stammen aus dem generischen (konfigurationsgesteuerten) Analyzer: nach bestem Bemühen und möglicherweise unvollständig. Dateiinventar und Struktur dieser Sprachen sind exakt.`,
    filesPartial: (assigned, total) => `${assigned} von ${total} Dateien in einer Etappe`,
    unassigned: 'Dateien ohne Etappe',
    unassignedNote: (nUnassigned, nAssigned, nFiles) =>
      `${nAssigned} von ${nFiles} Dateien wurden einer Etappe zugeordnet. Die ${nUnassigned} unten hat der Parser gefunden, aber keiner Etappe zugeordnet — daher beschreibt sie keine Etappenseite.`,
    onThisPage: 'Auf dieser Seite',
    search: 'Suchen',
    searchPlaceholder: 'Etappen, Dateien, Funktionen suchen…',
    noHits: 'Dazu passt nichts.',
    navigateHint: '↑↓ zum Bewegen',
    openHint: '↵ zum Öffnen',
    closeHint: 'esc zum Schließen',
    kinds: ['Etappe', 'Datei', 'Funktion', 'Zustand'],
    themeAuto: 'Theme: dem System folgen',
    themeLight: 'Theme: hell',
    themeDark: 'Theme: dunkel',
    menu: 'Navigation öffnen',
    backToTop: 'Nach oben',
    copy: 'Kopieren',
    copied: 'Kopiert',
    previous: 'Zurück',
    next: 'Weiter',
    reference: 'Referenz',
    anchorTitle: 'Link zu diesem Abschnitt',
  },
};

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Embed a value inside a `<script>` as JS source.
 *
 * `JSON.stringify` alone is not enough: a title or file path containing
 * `</script>` would end the element and everything after it would be parsed as
 * markup. Escaping `<`, `>` and `&` to `\uXXXX` keeps the payload a string
 * literal no matter what the model wrote, and the two Unicode line separators
 * are escaped because they are literal line terminators in JS source.
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** A DOM id for a file or function row: stable, collision-free, selector-safe. */
function domId(prefix: string, key: string): string {
  const slug = key
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${prefix}-${slug.length > 0 ? slug : 'x'}`;
}

function makeMd(): Markdown {
  return new MarkdownIt({ html: false, linkify: false });
}

/** Hierarchical section numbers (1, 1.1, 1.1.1 …) over content stages. */
function numberMap(view: HandbookView): Map<string, string> {
  const numbers = new Map<string, string>();
  const walk = (sids: readonly string[], prefix: string): void => {
    sids.forEach((sid, i) => {
      const num = prefix.length > 0 ? `${prefix}.${i + 1}` : `${i + 1}`;
      numbers.set(sid, num);
      walk(view.contentChildren(sid), num);
    });
  };
  walk(view.contentRoots(), '');
  return numbers;
}

/** `<h2>`/`<h3>` with a hover anchor, and the id the table of contents targets. */
function heading(level: 2 | 3, id: string, text: string, L: HtmlLabels): string {
  return `<h${level} id="${esc(id)}">${esc(text)}<a class="anchor" href="#${esc(id)}" aria-label="${esc(L.anchorTitle)}" title="${esc(L.anchorTitle)}">${ICONS.link}</a></h${level}>`;
}

/** Anchor of the overview section listing the files no stage claims. */
const UNASSIGNED_ID = 'ov-unassigned';

/** One entry of the client-side search index: [kind, label, sublabel, url]. */
type IndexEntry = [0 | 1 | 2 | 3, string, string, string];

/**
 * Build the search index over everything a reader might look for by name.
 *
 * `href` maps a page-local target to a URL, so the same builder serves the
 * multi-page site (`stage-3.html#f-…`) and the single page (`#f-…`).
 */
function searchIndex(
  view: HandbookView,
  href: (sid: string, hash?: string) => string,
  L: HtmlLabels,
): IndexEntry[] {
  const numbers = numberMap(view);
  const entries: IndexEntry[] = [];
  for (const sid of view.contentStages()) {
    const number = numbers.get(sid) ?? '';
    entries.push([0, view.tree.title(sid), `${number} · ${sid}`, href(sid)]);
    for (const rel of view.directFiles(sid)) {
      entries.push([1, rel, view.tree.title(sid), href(sid, domId('f', rel))]);
      for (const fn of view.card(rel).functions ?? []) {
        entries.push([2, fn.qualname, rel, href(sid, domId('fn', `${rel}:${fn.qualname}`))]);
      }
    }
  }
  // Unassigned files are indexed too, pointing at the overview list. Searching a
  // path and getting nothing reads as "that file is not in this codebase" — the
  // one conclusion the handbook must never let a reader draw about a file the
  // parser did find.
  for (const rel of view.unassignedFiles()) {
    entries.push([1, rel, L.unassigned, href('overview', UNASSIGNED_ID)]);
  }
  for (const reg of view.model.registers) {
    entries.push([3, reg.id, truncate(reg.semantics, 70), href('register', domId('reg', reg.id))]);
  }
  return entries;
}

/**
 * The whole-handbook file count.
 *
 * `coverage.nFiles` counts every file the parser found, but every list on every
 * page comes from `assignment.buckets`, which excludes the unassigned ones — so
 * a bare total is a number the pages themselves contradict. When something is
 * unassigned, state the split instead; {@link unassignedSectionHtml} then names
 * the files.
 */
function fileCountChip(view: HandbookView, L: HtmlLabels): string {
  const { nFiles, nAssigned, unassigned } = view.model.assignment.coverage;
  return unassigned.length === 0 ? L.files(nFiles) : L.filesPartial(nAssigned, nFiles);
}

/**
 * The overview's list of files no stage claims, or '' when every file was
 * placed. Uncapped: truncating it would re-create, one level down, the omission
 * it exists to fix.
 */
function unassignedSectionHtml(view: HandbookView, lang: NarrateLang): string {
  const files = view.unassignedFiles();
  if (files.length === 0) return '';
  const L = LABELS[lang];
  const { nAssigned, nFiles } = view.model.assignment.coverage;
  const items = files.map((rel) => `<li><code class="path">${esc(rel)}</code></li>`).join('');
  return [
    heading(2, UNASSIGNED_ID, L.unassigned, L),
    `<div class="callout"><p>${esc(L.unassignedNote(files.length, nAssigned, nFiles))}</p></div>`,
    `<div class="prose"><ul>${items}</ul></div>`,
  ].join('\n');
}

/** The `<head>` contents shared by every page. */
function head(title: string, extraScript: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="handbook">
<title>${esc(title)}</title>
<style>${CSS}</style>
<script>${THEME_BOOT}</script>${extraScript}`;
}

/** The strings and icons the inlined script needs at runtime. */
function runtimeGlue(L: HtmlLabels): string {
  const strings = {
    copy: L.copy,
    copied: L.copied,
    noHits: L.noHits,
    kinds: L.kinds,
  };
  return `<script>var hbT=${jsLiteral(strings)};var hbIcon={copy:${jsLiteral(ICONS.copy)},check:${jsLiteral(ICONS.check)}};${SCRIPT}</script>`;
}

/** Sidebar search trigger + the search dialog markup. */
function searchUi(L: HtmlLabels): { trigger: string; dialog: string } {
  const trigger = `<button class="sb-find" type="button" data-find onclick="hbSearch(true)" aria-label="${esc(L.search)}">${ICONS.search}<span class="grow">${esc(L.search)}</span><kbd>⌘K</kbd></button>`;
  const dialog = `<div class="sdim" id="hb-dim" role="dialog" aria-modal="true" aria-label="${esc(L.search)}">
<div class="spanel">
<div class="srow">${ICONS.search}<input id="hb-q" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(L.searchPlaceholder)}" aria-label="${esc(L.search)}"><button class="btn btn-i" type="button" onclick="hbSearch(false)" aria-label="${esc(L.closeHint)}">${ICONS.close}</button></div>
<div class="sout" id="hb-out" role="listbox"></div>
<div class="sfoot"><span>${esc(L.navigateHint)}</span><span>${esc(L.openHint)}</span><span>${esc(L.closeHint)}</span></div>
</div></div>`;
  return { trigger, dialog };
}

/** The theme / expand / collapse controls in the sticky bar. */
function barControls(L: HtmlLabels): string {
  return `<button class="btn btn-i" id="hb-theme" type="button" onclick="hbTheme()" data-t-auto="${esc(L.themeAuto)}" data-t-light="${esc(L.themeLight)}" data-t-dark="${esc(L.themeDark)}" aria-label="${esc(L.themeAuto)}">${ICONS.auto.replace('<svg', '<svg data-m="auto"')}${ICONS.sun.replace('<svg', '<svg data-m="light" style="display:none"')}${ICONS.moon.replace('<svg', '<svg data-m="dark" style="display:none"')}</button>
<button class="btn" type="button" onclick="hbAll(true)" title="${esc(L.expandAll)}">${ICONS.expand}<span class="wide">${esc(L.expandAll)}</span></button>
<button class="btn" type="button" onclick="hbAll(false)" title="${esc(L.collapseAll)}">${ICONS.collapse}<span class="wide">${esc(L.collapseAll)}</span></button>`;
}

/** Nested sidebar list over content stages; `href` maps a sid to its link target. */
function sidebarTree(
  view: HandbookView,
  current: string,
  href: (sid: string) => string,
  numbers: Map<string, string>,
  L: HtmlLabels,
): string {
  const item = (sid: string): string => {
    const cur = sid === current ? ' class="cur"' : '';
    const children = view.contentChildren(sid);
    const nested = children.length > 0 ? `<ul>${children.map(item).join('')}</ul>` : '';
    const dot = view.tree.isCrosscut(sid) ? `<span class="sb-dot" title="${esc(L.crosscut)}"></span>` : '';
    return `<li><a${cur} href="${href(sid)}"><span class="sb-num">${esc(numbers.get(sid) ?? '')}</span><span>${esc(view.tree.title(sid))}</span>${dot}</a>${nested}</li>`;
  };
  return `<ul>${view.contentRoots().map(item).join('')}</ul>`;
}

function breadcrumb(view: HandbookView, sid: string | null, lang: NarrateLang): string {
  const L = LABELS[lang];
  const parts = [`<a href="overview.html">${esc(L.system)}</a>`];
  if (sid !== null) {
    const chain = [...view.ancestors(sid)].reverse();
    for (const ancestor of chain)
      parts.push(`<a href="${ancestor}.html">${esc(view.tree.title(ancestor))}</a>`);
    parts.push(esc(view.tree.title(sid)));
  }
  return parts.join(' / ');
}

/** Table of contents entries a page contributes: [id, text, depth]. */
type TocEntry = [string, string, 1 | 2];

function tocHtml(entries: readonly TocEntry[], L: HtmlLabels): string {
  if (entries.length === 0) return '';
  // A flat list with a depth class, not nested `<ul>`s: nesting would have to be
  // opened and closed around list items that arrive in document order, and the
  // markup only ever gets it right by accident. Indentation is a presentation
  // concern here, so CSS carries it.
  const items = entries.map(
    ([id, text, level]) => `<li class="d${level}"><a href="#${esc(id)}">${esc(text)}</a></li>`,
  );
  return `<aside class="toc"><p class="toc-t">${esc(L.onThisPage)}</p><ul>${items.join('')}</ul></aside>`;
}

/** Previous/next pager over the content stages in reading order. */
function pager(view: HandbookView, sid: string, lang: NarrateLang, numbers: Map<string, string>): string {
  const L = LABELS[lang];
  const order = view.contentStages();
  const at = order.indexOf(sid);
  if (at < 0) return '';
  const link = (target: string | undefined, kind: 'pv' | 'nx'): string => {
    if (target === undefined) return '';
    const label = `${numbers.get(target) ?? ''} ${view.tree.title(target)}`.trim();
    const icon = kind === 'pv' ? ICONS.prev : ICONS.next;
    const word = kind === 'pv' ? L.previous : L.next;
    const inner = `<span><span class="pg-n">${esc(word)}</span><span class="pg-t">${esc(label)}</span></span>`;
    return `<a class="${kind}" href="${target}.html">${kind === 'pv' ? icon + inner : inner + icon}</a>`;
  };
  const previous = link(at > 0 ? order[at - 1] : undefined, 'pv');
  const next = link(at + 1 < order.length ? order[at + 1] : undefined, 'nx');
  return previous.length + next.length > 0 ? `<nav class="pager">${previous}${next}</nav>` : '';
}

function page(
  view: HandbookView,
  lang: NarrateLang,
  title: string,
  current: string,
  crumbSid: string | null,
  body: string,
  toc: readonly TocEntry[] = [],
): string {
  const L = LABELS[lang];
  const numbers = numberMap(view);
  const { trigger, dialog } = searchUi(L);
  const regLink =
    view.model.registers.length > 0
      ? `<li><a${current === 'register' ? ' class="cur"' : ''} href="register.html"><span class="sb-num"></span><span>${esc(L.registers)}</span></a></li>`
      : '';
  // In the sidebar of EVERY page, not only the overview: a reader who never
  // opens the overview would otherwise never learn the gap exists.
  const unassignedLink =
    view.unassignedFiles().length > 0
      ? `<li><a href="overview.html#${UNASSIGNED_ID}"><span class="sb-num"></span><span>${esc(L.unassigned)}</span></a></li>`
      : '';
  const sidebar = `
<nav class="sidebar" id="hb-sidebar" aria-label="${esc(L.stages)}">
<div class="sb-head">
<a class="brand" href="overview.html">${ICONS.logo}<span>${esc(view.model.title)}</span></a>
<p class="sb-sub">${esc(fileCountChip(view, L))} · ${esc(L.overview)}</p>
${trigger}
</div>
<div class="sb-nav">
<p class="sb-label">${esc(L.reference)}</p>
<ul>
<li><a${current === 'overview' ? ' class="cur"' : ''} href="overview.html"><span class="sb-num"></span><span>${esc(L.overview)}</span></a></li>
${regLink}
${unassignedLink}
</ul>
<p class="sb-label">${esc(L.stages)}</p>
${sidebarTree(view, current, (sid) => `${sid}.html`, numbers, L)}
</div>
</nav>`;
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
${head(title, `<script src="search-index.js"></script>`)}
</head>
<body>
<div class="layout">
${sidebar}
<div class="doc">
<header class="topbar">
<button class="btn btn-i only-mobile" type="button" onclick="hbNav(true)" aria-label="${esc(L.menu)}">${ICONS.menu}</button>
<span class="crumb">${breadcrumb(view, crumbSid, lang)}</span>
<button class="btn btn-i only-mobile" type="button" data-find onclick="hbSearch(true)" aria-label="${esc(L.search)}">${ICONS.search}</button>
${barControls(L)}
</header>
<div class="doc-body">
<main class="content">
${body}
</main>
${tocHtml(toc, L)}
</div>
</div>
</div>
<div class="scrim" onclick="hbNav(false)"></div>
<button class="btn totop" id="hb-top" type="button" onclick="window.scrollTo({top:0})" aria-label="${esc(L.backToTop)}" title="${esc(L.backToTop)}">${ICONS.up}</button>
${dialog}
${runtimeGlue(L)}
</body>
</html>
`;
}

function stageCard(
  view: HandbookView,
  sid: string,
  lang: NarrateLang,
  href: string,
  numbers: Map<string, string>,
): string {
  const L = LABELS[lang];
  const badge = view.tree.isCrosscut(sid) ? ` <span class="chip crosscut">${esc(L.crosscut)}</span>` : '';
  const blurb = truncate(firstSentence(view.summary(sid)), 160);
  return `<li class="card"><a class="card-t" href="${href}"><span class="card-n">${esc(numbers.get(sid) ?? '')}</span><span>${esc(view.tree.title(sid))}</span></a><div class="card-m">${esc(sid)} · ${esc(L.files(view.subtreeFileCount(sid)))}${badge}</div><p>${esc(blurb)}</p></li>`;
}

function functionDetails(fn: FunctionNote, rel: string, lang: NarrateLang): string {
  const L = LABELS[lang];
  const fields: string[] = [];
  if (fn.signature.trim().length > 0) fields.push(`<pre><code>${esc(fn.signature.trim())}</code></pre>`);
  const field = (label: string, value: string): void => {
    if (value.trim().length > 0)
      fields.push(`<p class="field"><span class="field-l">${esc(label)}</span>${esc(value.trim())}</p>`);
  };
  field(L.purpose, fn.purpose);
  field(L.dataFlow, fn.dataFlow);
  field(L.relations, fn.relations);
  const facts = callFactsLine(fn, lang);
  if (facts.length > 0) fields.push(`<p class="facts">${esc(facts.replace(/\*/g, ''))}</p>`);
  return `<details class="fn" id="${domId('fn', `${rel}:${fn.qualname}`)}"><summary>${ICONS.caret}<span class="fn-n">${esc(fn.qualname)}</span><span class="spacer"></span><span class="fn-l">${esc(L.lines(fn.lineRange[0], fn.lineRange[1]))}</span></summary><div class="fn-body">${fields.join('')}</div></details>`;
}

/**
 * One file row.
 *
 * `lifecycle` is specified as a short hint ("startup", "main loop"), and a chip
 * is the right shape for that — but a model regularly answers with a whole
 * sentence, which turns the chip into an unreadable pill as wide as the row. So
 * anything longer than a hint is demoted to a labelled line in the body, where a
 * sentence belongs.
 */
function fileDetails(
  md: Markdown,
  rel: string,
  card: FileCard,
  lang: NarrateLang,
  sourceBaseUrl?: string,
): string {
  const L = LABELS[lang];
  const lifecycle = card.lifecycle.trim();
  const hasLifecycle = lifecycle.length > 0 && lifecycle !== 'none';
  const shortLifecycle = hasLifecycle && lifecycle.length <= 24;
  const prose = (card.description ?? '').trim() || card.purpose.trim() || L.noProse;
  const functions = card.functions ?? [];
  const body: string[] = [];
  if (hasLifecycle && !shortLifecycle) {
    body.push(`<p class="field"><span class="field-l">${esc(L.runsWhen)}</span>${esc(lifecycle)}</p>`);
  }
  body.push(`<div class="prose">${md.render(prose)}</div>`);
  if (functions.length > 0) {
    // A plain `<h4>`, not an anchored heading: this one sits inside a collapsed
    // disclosure, so an anchor to it would deep-link to a heading a reader
    // cannot see, and it has no place in the page's table of contents.
    body.push(
      `<div class="fns"><h4>${esc(L.functions)}</h4>${functions.map((fn) => functionDetails(fn, rel, lang)).join('')}</div>`,
    );
  }
  const path =
    sourceBaseUrl !== undefined
      ? `<a href="${esc(sourceFileUrl(sourceBaseUrl, rel))}"><code class="path">${esc(rel)}</code></a>`
      : `<code class="path">${esc(rel)}</code>`;
  const chips = [`<span class="chip role role-${esc(card.role)}">${esc(card.role)}</span>`];
  if (shortLifecycle) chips.push(`<span class="chip">${esc(lifecycle)}</span>`);
  if (functions.length > 0) chips.push(`<span class="chip">${esc(L.functionCount(functions.length))}</span>`);
  return `<details class="file" id="${domId('f', rel)}"><summary>${ICONS.caret}${path}<span class="spacer"></span>${chips.join('')}</summary><div class="file-body">${body.join('')}</div></details>`;
}

/**
 * The stage body shared by the multi-page stage page and the single-page section.
 * Returns the markup plus the headings it emitted, so the caller can build a
 * table of contents without re-deriving them.
 */
function stageBody(
  view: HandbookView,
  md: Markdown,
  sid: string,
  lang: NarrateLang,
  childHref: (child: string) => string,
  numbers: Map<string, string>,
  sourceBaseUrl?: string,
): { html: string; toc: TocEntry[] } {
  const L = LABELS[lang];
  const parts: string[] = [`<div class="prose">${md.render(view.summary(sid))}</div>`];
  const toc: TocEntry[] = [];
  const section = (id: string, text: string): void => {
    toc.push([id, text, 1]);
    parts.push(heading(2, id, text, L));
  };

  const children = view.contentChildren(sid);
  if (children.length > 0) {
    section(`${sid}-sub`, L.subStages);
    parts.push(
      `<ul class="cards">${children.map((c) => stageCard(view, c, lang, childHref(c), numbers)).join('')}</ul>`,
    );
  }
  const direct = view.directFiles(sid);
  if (direct.length > 0) {
    section(`${sid}-files`, L.filesInStage);
    const { groups, leftovers } = view.groups(sid);
    for (const group of groups) {
      const id = domId(`${sid}-g`, group.title);
      toc.push([id, group.title, 2]);
      parts.push(heading(3, id, group.title, L));
      if (group.summary.trim().length > 0)
        parts.push(`<div class="prose">${md.render(group.summary.trim())}</div>`);
      parts.push(
        `<div class="files">${group.files.map((file) => fileDetails(md, file, view.card(file), lang, sourceBaseUrl)).join('')}</div>`,
      );
    }
    if (leftovers.length > 0) {
      parts.push(
        `<div class="files">${leftovers.map((file) => fileDetails(md, file, view.card(file), lang, sourceBaseUrl)).join('')}</div>`,
      );
    }
  }
  const regs = view.directRegisters(sid);
  if (regs.length > 0) {
    section(`${sid}-state`, L.registersTouched);
    const bullets = regs.map((r) => `<li><code>${esc(r.id)}</code> — ${esc(r.semantics)}</li>`);
    parts.push(`<div class="prose"><ul>${bullets.join('')}</ul></div>`);
  }
  return { html: parts.join('\n'), toc };
}

/**
 * Overview disclosure that some languages were analyzed by the generic engine —
 * or '' when there is nothing to disclose (every language full-tier, or no
 * capability map was passed).
 */
function fidelityNoteHtml(lang: NarrateLang, options: FidelityOptions): string {
  const generic = genericTierLanguages(options.languages);
  if (generic.length === 0) return '';
  const L = LABELS[lang];
  return `<div class="callout"><p><strong>${esc(L.fidelityLead)}</strong> — ${esc(L.fidelityNote(generic))}</p></div>`;
}

function registerTableHtml(
  view: HandbookView,
  lang: NarrateLang,
  stageHref: (sid: string) => string,
): string {
  const L = LABELS[lang];
  const [h1, h2, h3] = L.registerHeader;
  const rows = view.model.registers.map((reg) => {
    // Link only stages that actually got a page; others render as plain code.
    const stages = reg.stages
      .map((sid) =>
        view.hasContent(sid)
          ? `<a href="${stageHref(sid)}">${esc(view.tree.title(sid))}</a>`
          : `<code>${esc(sid)}</code>`,
      )
      .join(', ');
    return `<tr id="${domId('reg', reg.id)}"><td><code>${esc(reg.id)}</code></td><td>${esc(reg.semantics)}</td><td>${stages}</td></tr>`;
  });
  return `<div class="tablewrap"><table><thead><tr><th>${esc(h1)}</th><th>${esc(h2)}</th><th>${esc(h3)}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/** The page head block: title, chips, optional lede. */
function pageHead(title: string, chips: readonly string[], lede?: string): string {
  const chipRow = chips.length > 0 ? `<div class="chips">${chips.join('')}</div>` : '';
  const sub = lede !== undefined && lede.length > 0 ? `<p class="lede">${esc(lede)}</p>` : '';
  return `<div class="head"><h1>${title}</h1>${sub}${chipRow}</div>`;
}

/**
 * Render the multi-page HTML site into `outDir`.
 * `options.sourceBaseUrl` (opt-in) links every file-card path to its source
 * file; without it the site references no external URL.
 * `options.languages` (opt-in) discloses per-language analysis fidelity on the
 * overview page; without it the site is unchanged.
 */
export function renderHtmlSite(
  model: HandbookModel,
  outDir: string,
  options: RenderOptions = {},
): { nPages: number } {
  const view = new HandbookView(model);
  const lang = model.lang;
  const L = LABELS[lang];
  const md = makeMd();
  const numbers = numberMap(view);
  ensureDir(outDir);
  // The html dir is fully renderer-owned: drop pages from previous renders so
  // stale stage ids never linger as orphan files.
  for (const stale of readdirSync(outDir)) {
    if (stale.endsWith('.html')) rmSync(join(outDir, stale), { force: true });
  }
  let nPages = 0;
  const write = (name: string, content: string): void => {
    writeFileAtomic(join(outDir, name), content);
    nPages += 1;
  };

  // The shared search index. Not counted as a page: it is an asset, and
  // `nPages` is what the CLI reports to a human.
  writeFileAtomic(
    join(outDir, 'search-index.js'),
    `window.HB_INDEX=${jsLiteral(
      searchIndex(view, (sid, hash) => `${sid}.html${hash !== undefined ? `#${hash}` : ''}`, L),
    )};\n`,
  );

  // index.html — meta-refresh redirect to overview.html.
  write(
    'index.html',
    `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=overview.html"><title>${esc(model.title)}</title></head>
<body><p><a href="overview.html">${esc(L.overview)}</a></p></body></html>
`,
  );

  // overview.html
  const overviewToc: TocEntry[] = [];
  const overviewParts: string[] = [
    pageHead(esc(L.systemOverview), [
      `<span class="chip chip-mono">${esc(fileCountChip(view, L))}</span>`,
      `<span class="chip">${esc(L.stages)}: ${view.contentStages().length}</span>`,
    ]),
    `<div class="prose">${md.render(model.narration.systemOverview.trim())}</div>`,
  ];
  const fidelity = fidelityNoteHtml(lang, options);
  if (fidelity.length > 0) overviewParts.push(fidelity);
  if (model.registers.length > 0) {
    overviewParts.push(`<p class="prose"><a href="register.html">${esc(L.registers)} →</a></p>`);
  }
  overviewToc.push(['ov-stages', L.stages, 1]);
  overviewParts.push(
    heading(2, 'ov-stages', L.stages, L),
    `<ul class="cards">${view
      .contentRoots()
      .map((sid) => stageCard(view, sid, lang, `${sid}.html`, numbers))
      .join('')}</ul>`,
  );
  // Last on the overview, because it is the exception to everything above it:
  // the stage cards are where the codebase went, this is what did not go there.
  const unassigned = unassignedSectionHtml(view, lang);
  if (unassigned.length > 0) {
    overviewToc.push([UNASSIGNED_ID, L.unassigned, 1]);
    overviewParts.push(unassigned);
  }
  write(
    'overview.html',
    page(view, lang, model.title, 'overview', null, overviewParts.join('\n'), overviewToc),
  );

  // register.html
  if (model.registers.length > 0) {
    const body = [
      pageHead(esc(L.registers), [
        `<span class="chip">${esc(L.registers)}: ${model.registers.length}</span>`,
      ]),
      registerTableHtml(view, lang, (sid) => `${sid}.html`),
    ].join('\n');
    write('register.html', page(view, lang, `${model.title} — ${L.registers}`, 'register', null, body));
  }

  // <sid>.html per content-bearing stage.
  for (const sid of view.contentStages()) {
    const chips = [
      `<span class="chip chip-mono">${esc(sid)}</span>`,
      `<span class="chip">${esc(L.files(view.subtreeFileCount(sid)))}</span>`,
    ];
    if (view.tree.isCrosscut(sid)) chips.push(`<span class="chip crosscut">${esc(L.crosscut)}</span>`);
    const stage = stageBody(view, md, sid, lang, (child) => `${child}.html`, numbers, options.sourceBaseUrl);
    const number = numbers.get(sid) ?? '';
    const body = [
      pageHead(`<span class="card-n">${esc(number)}</span> ${esc(view.tree.title(sid))}`, chips),
      stage.html,
      pager(view, sid, lang, numbers),
    ].join('\n');
    write(
      `${sid}.html`,
      page(view, lang, `${view.tree.title(sid)} — ${model.title}`, sid, sid, body, stage.toc),
    );
  }

  return { nPages };
}

/**
 * Render the whole handbook as one self-contained HTML page at `outPath`.
 * `options.languages` (opt-in) discloses per-language analysis fidelity next to
 * the system overview — the single page is a handbook in its own right, so it
 * must not be the one output where mixed fidelity goes unsaid.
 */
export function renderSinglePageHtml(
  model: HandbookModel,
  outPath: string,
  options: FidelityOptions = {},
): { bytes: number } {
  const view = new HandbookView(model);
  const lang = model.lang;
  const L = LABELS[lang];
  const md = makeMd();
  const numbers = numberMap(view);
  const { trigger, dialog } = searchUi(L);

  const tocItem = (sid: string): string => {
    const children = view.contentChildren(sid);
    const nested = children.length > 0 ? `<ul>${children.map(tocItem).join('')}</ul>` : '';
    return `<li><a href="#${sid}"><span class="sb-num">${esc(numbers.get(sid) ?? '')}</span><span>${esc(view.tree.title(sid))}</span></a>${nested}</li>`;
  };
  const regToc =
    model.registers.length > 0
      ? `<li><a href="#registers"><span class="sb-num"></span><span>${esc(L.registers)}</span></a></li>`
      : '';
  const unassignedToc =
    view.unassignedFiles().length > 0
      ? `<li><a href="#${UNASSIGNED_ID}"><span class="sb-num"></span><span>${esc(L.unassigned)}</span></a></li>`
      : '';
  const sidebar = `<nav class="sidebar" id="hb-sidebar" aria-label="${esc(L.stages)}">
<div class="sb-head">
<a class="brand" href="#top">${ICONS.logo}<span>${esc(model.title)}</span></a>
<p class="sb-sub">${esc(fileCountChip(view, L))}</p>
${trigger}
</div>
<div class="sb-nav">
<p class="sb-label">${esc(L.reference)}</p>
<ul><li><a href="#top"><span class="sb-num"></span><span>${esc(L.overview)}</span></a></li>${regToc}${unassignedToc}</ul>
<p class="sb-label">${esc(L.stages)}</p>
<ul>${view.contentRoots().map(tocItem).join('')}</ul>
</div>
</nav>`;

  const sections: string[] = [];
  const emit = (sid: string): void => {
    const badge = view.tree.isCrosscut(sid) ? ` <span class="chip crosscut">${esc(L.crosscut)}</span>` : '';
    const meta = `<span class="chip chip-mono">${esc(sid)}</span><span class="chip">${esc(L.files(view.subtreeFileCount(sid)))}</span>`;
    const body = stageBody(view, md, sid, lang, (child) => `#${child}`, numbers).html;
    sections.push(
      `<details class="stage" id="${sid}"><summary>${ICONS.caret}<span class="card-n">${esc(numbers.get(sid) ?? '')}</span><span>${esc(view.tree.title(sid))}</span>${badge}<span class="spacer"></span>${meta}</summary><div class="stage-b">${body}</div></details>`,
    );
    for (const child of view.contentChildren(sid)) emit(child);
  };
  for (const root of view.contentRoots()) emit(root);

  const registersSection =
    model.registers.length > 0
      ? `${heading(2, 'registers', L.registers, L)}${registerTableHtml(view, lang, (sid) => `#${sid}`)}`
      : '';

  const fidelity = fidelityNoteHtml(lang, options);
  // The single page is a handbook in its own right, so it must not be the one
  // output where the files nobody claimed go unmentioned.
  const unassigned = unassignedSectionHtml(view, lang);
  const body = [
    `<div class="head" id="top"><h1>${esc(model.title)}</h1><div class="chips"><span class="chip chip-mono">${esc(fileCountChip(view, L))}</span><span class="chip">${esc(L.stages)}: ${view.contentStages().length}</span></div></div>`,
    heading(2, 'system-overview', L.systemOverview, L),
    `<div class="prose">${md.render(model.narration.systemOverview.trim())}</div>`,
    ...(fidelity.length > 0 ? [fidelity] : []),
    `<ul class="cards">${view
      .contentRoots()
      .map((sid) => stageCard(view, sid, lang, `#${sid}`, numbers))
      .join('')}</ul>`,
    sections.join('\n'),
    registersSection,
    unassigned,
  ].join('\n');

  const index = `<script>window.HB_INDEX=${jsLiteral(
    searchIndex(view, (sid, hash) => `#${hash ?? sid}`, L),
  )};</script>`;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
${head(model.title, index)}
</head>
<body>
<div class="layout">
${sidebar}
<div class="doc">
<header class="topbar">
<button class="btn btn-i only-mobile" type="button" onclick="hbNav(true)" aria-label="${esc(L.menu)}">${ICONS.menu}</button>
<span class="crumb">${esc(L.system)}</span>
<button class="btn btn-i only-mobile" type="button" data-find onclick="hbSearch(true)" aria-label="${esc(L.search)}">${ICONS.search}</button>
${barControls(L)}
</header>
<div class="doc-body">
<main class="content">
${body}
</main>
</div>
</div>
</div>
<div class="scrim" onclick="hbNav(false)"></div>
<button class="btn totop" id="hb-top" type="button" onclick="window.scrollTo({top:0})" aria-label="${esc(L.backToTop)}" title="${esc(L.backToTop)}">${ICONS.up}</button>
${dialog}
${runtimeGlue(L)}
</body>
</html>
`;
  writeFileAtomic(outPath, html);
  return { bytes: statSync(outPath).size };
}
