/**
 * Leaf rendering: one markdown fragment per source file (no LLM).
 *
 * `renderFileCardMd` is the leaf content of both the markdown handbook and the
 * agent locator site; the HTML renderers rebuild the same structure with tags.
 */
import { capList, leafName } from '@handbooks/core';
import type { FileCard, FunctionNote, NarrateLang } from '@handbooks/core';
import { sourceFileUrl } from './shared.js';
import type { SourceLinkOptions } from './shared.js';

/** Names shown per call-relation list before collapsing to `(+K more)`. */
export const REL_NAMES_CAP = 10;

interface CardLabels {
  functionDetails: string;
  lines: (a: number, b: number) => string;
  purpose: string;
  dataFlow: string;
  relations: string;
  callGraph: string;
  sep: string;
  join: string;
  end: string;
  nameJoin: string;
  calls: (n: number) => string;
  calledBy: (n: number) => string;
  extCalls: (n: number) => string;
  noDescription: string;
}

const LABELS: Record<NarrateLang, CardLabels> = {
  en: {
    functionDetails: 'Function details',
    lines: (a, b) => `(lines ${a}–${b})`,
    purpose: 'Purpose',
    dataFlow: 'Data flow',
    relations: 'Call relations',
    callGraph: 'Call graph',
    sep: ': ',
    join: '; ',
    end: '.',
    nameJoin: ', ',
    calls: (n) => `calls ${n} internal`,
    calledBy: (n) => `called by ${n}`,
    extCalls: (n) => `${n} external calls`,
    noDescription: '_(This file has no description yet.)_',
  },
  zh: {
    functionDetails: '函数细节',
    lines: (a, b) => `（行 ${a}–${b}）`,
    purpose: '作用',
    dataFlow: '数据流',
    relations: '调用关系',
    callGraph: '调用图',
    sep: '：',
    join: '；',
    end: '。',
    nameJoin: '、',
    calls: (n) => `调用 ${n} 个内部函数`,
    calledBy: (n) => `被 ${n} 处调用`,
    extCalls: (n) => `${n} 次外部调用`,
    noDescription: '_（该文件暂无描述。）_',
  },
  hi: {
    functionDetails: 'फ़ंक्शन विवरण',
    lines: (a, b) => `(लाइनें ${a}–${b})`,
    purpose: 'उद्देश्य',
    dataFlow: 'डेटा प्रवाह',
    relations: 'Call relations',
    callGraph: 'कॉल ग्राफ़',
    sep: ': ',
    join: '; ',
    end: '।',
    nameJoin: ', ',
    calls: (n) => `${n} आंतरिक फ़ंक्शन कॉल करता है`,
    calledBy: (n) => `${n} जगह से कॉल होता है`,
    extCalls: (n) => `${n} बाहरी कॉल`,
    noDescription: '_(इस फ़ाइल का विवरण अभी नहीं है।)_',
  },
  es: {
    functionDetails: 'Detalle de funciones',
    lines: (a, b) => `(líneas ${a}–${b})`,
    purpose: 'Propósito',
    dataFlow: 'Flujo de datos',
    relations: 'Relaciones de llamada',
    callGraph: 'Grafo de llamadas',
    sep: ': ',
    join: '; ',
    end: '.',
    nameJoin: ', ',
    calls: (n) => `llama a ${n} internas`,
    calledBy: (n) => `llamada desde ${n}`,
    extCalls: (n) => `${n} llamadas externas`,
    noDescription: '_(Este archivo aún no tiene descripción.)_',
  },
  pt: {
    functionDetails: 'Detalhes das funções',
    lines: (a, b) => `(linhas ${a}–${b})`,
    purpose: 'Propósito',
    dataFlow: 'Fluxo de dados',
    relations: 'Relações de chamada',
    callGraph: 'Grafo de chamadas',
    sep: ': ',
    join: '; ',
    end: '.',
    nameJoin: ', ',
    calls: (n) => `chama ${n} internas`,
    calledBy: (n) => `chamada por ${n}`,
    extCalls: (n) => `${n} chamadas externas`,
    noDescription: '_(Este arquivo ainda não tem descrição.)_',
  },
  ru: {
    functionDetails: 'Подробности функций',
    lines: (a, b) => `(строки ${a}–${b})`,
    purpose: 'Назначение',
    dataFlow: 'Поток данных',
    relations: 'Связи вызовов',
    callGraph: 'Граф вызовов',
    sep: ': ',
    join: '; ',
    end: '.',
    nameJoin: ', ',
    calls: (n) => `вызывает ${n} внутренних`,
    calledBy: (n) => `вызывается из ${n}`,
    extCalls: (n) => `${n} внешних вызовов`,
    noDescription: '_(У этого файла пока нет описания.)_',
  },
  ja: {
    functionDetails: '関数の詳細',
    lines: (a, b) => `（${a}–${b} 行）`,
    purpose: '目的',
    dataFlow: 'データフロー',
    relations: '呼び出し関係',
    callGraph: 'コールグラフ',
    sep: '：',
    join: '；',
    end: '。',
    nameJoin: '、',
    calls: (n) => `内部関数を ${n} 件呼び出し`,
    calledBy: (n) => `${n} 箇所から呼び出される`,
    extCalls: (n) => `外部呼び出し ${n} 件`,
    noDescription: '_（このファイルの説明はまだありません。）_',
  },
  de: {
    functionDetails: 'Funktionsdetails',
    lines: (a, b) => `(Zeilen ${a}–${b})`,
    purpose: 'Zweck',
    dataFlow: 'Datenfluss',
    relations: 'Aufrufbeziehungen',
    callGraph: 'Aufrufgraph',
    sep: ': ',
    join: '; ',
    end: '.',
    nameJoin: ', ',
    calls: (n) => `ruft ${n} interne auf`,
    calledBy: (n) => `aufgerufen von ${n}`,
    extCalls: (n) => `${n} externe Aufrufe`,
    noDescription: '_(Diese Datei hat noch keine Beschreibung.)_',
  },
};

/** `- \`rel\` — purpose [role]` one-liner used in stage evidence lists. */
export function fileOneLiner(rel: string, card: FileCard): string {
  return `- \`${rel}\` — ${card.purpose.trim()} [${card.role}]`;
}

/** The structural call-graph fact line for one function (leaf names, capped). */
export function callFactsLine(fn: FunctionNote, lang: NarrateLang): string {
  const L = LABELS[lang];
  const clauses: string[] = [];
  const part = (label: string, names: readonly string[]): string => {
    const leafs = names.map(leafName);
    return leafs.length > 0 ? `${label} (${capList(leafs, REL_NAMES_CAP, L.nameJoin)})` : label;
  };
  if (fn.nCalls > 0) clauses.push(part(L.calls(fn.nCalls), fn.calls));
  if (fn.nCalledBy > 0) clauses.push(part(L.calledBy(fn.nCalledBy), fn.calledBy));
  if (fn.nExtCalls > 0) clauses.push(part(L.extCalls(fn.nExtCalls), fn.extCalls));
  if (clauses.length === 0) return '';
  return `*${L.callGraph}*${L.sep}${clauses.join(L.join)}${L.end}`;
}

/**
 * Wrap `code` in a fence whose backtick run is one longer than the longest run
 * inside it (min 3). A signature that itself contains a ``` line would
 * otherwise close a fixed 3-backtick fence early and inject the rest of the
 * signature into the handbook as live markdown (headings, tables, raw HTML).
 */
function fencedCode(code: string): string {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${code}\n${fence}`;
}

function renderFunctionMd(fn: FunctionNote, lang: NarrateLang): string {
  const L = LABELS[lang];
  const parts: string[] = [];
  parts.push(`##### \`${fn.qualname}\` ${L.lines(fn.lineRange[0], fn.lineRange[1])}`);
  if (fn.signature.trim().length > 0) parts.push(fencedCode(fn.signature.trim()));
  if (fn.purpose.trim().length > 0) parts.push(`**${L.purpose}**${L.sep}${fn.purpose.trim()}`);
  if (fn.dataFlow.trim().length > 0) parts.push(`**${L.dataFlow}**${L.sep}${fn.dataFlow.trim()}`);
  if (fn.relations.trim().length > 0) parts.push(`**${L.relations}**${L.sep}${fn.relations.trim()}`);
  const facts = callFactsLine(fn, lang);
  if (facts.length > 0) parts.push(facts);
  return parts.join('\n\n');
}

/**
 * Full markdown card for one file, starting at H3: badges, description
 * (falling back to purpose), then per-function details. When
 * `options.sourceBaseUrl` is set, the heading path links to the source file;
 * otherwise the output is byte-identical to the option-less call.
 */
export function renderFileCardMd(
  rel: string,
  card: FileCard,
  lang: NarrateLang,
  options: SourceLinkOptions = {},
): string {
  const L = LABELS[lang];
  const heading =
    options.sourceBaseUrl !== undefined
      ? `### [\`${rel}\`](${sourceFileUrl(options.sourceBaseUrl, rel)})`
      : `### \`${rel}\``;
  const parts: string[] = [heading];

  const lifecycle = card.lifecycle.trim();
  const badges =
    lifecycle.length > 0 && lifecycle !== 'none' ? `\`${card.role}\` · \`${lifecycle}\`` : `\`${card.role}\``;
  parts.push(badges);

  const prose = (card.description ?? '').trim() || card.purpose.trim() || L.noDescription;
  parts.push(prose);

  const functions = card.functions ?? [];
  if (functions.length > 0) {
    parts.push(`#### ${L.functionDetails}`);
    for (const fn of functions) parts.push(renderFunctionMd(fn, lang));
  }
  return parts.join('\n\n');
}
