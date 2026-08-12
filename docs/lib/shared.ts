/**
 * One place for every value the site, its metadata and its SEO surfaces need.
 *
 * Nothing here is duplicated into a component: the OG image route, the sitemap,
 * the RSS feed, the JSON-LD block and the per-platform meta tags all read these,
 * so changing the deployed URL or the tagline is a one-line edit that cannot
 * leave a stale absolute URL behind in one of thirty head tags.
 */

import { i18n, type Locale } from './i18n';

export const appName = 'Handbook';

/**
 * The three pieces of prose that end up in `<title>`, the meta description, and
 * every social card — per locale.
 *
 * `siteMetadata(locale)` used to take a locale and spend it only on canonical
 * and alternate URLs, reading these three from module-level English constants.
 * So a Chinese reader's tab said "Turn any codebase into a handbook…", the OG
 * card a WeChat or Slack link unfurled was English, and so was what a search
 * engine indexed for `/zh`. Eight localised routes advertising themselves in one
 * language is a loss that only shows up outside the site, which is why nothing
 * on the site ever flagged it.
 *
 * Kept as one table for the same reason `ui-strings.ts` is: it is small, and a
 * missing locale should be a type error rather than a silent fallback.
 */
interface SiteCopy {
  /** One line, used as the title suffix and the OG card headline. */
  tagline: string;
  /** Two or three sentences for the meta description. */
  description: string;
  /** For cards that truncate hard — Twitter/X, WeChat, Slack unfurls. */
  shortDescription: string;
}

const COPY: Record<Locale, SiteCopy> = {
  en: {
    tagline: 'One codebase in, two handbooks out — one your team reads, one your agent routes with.',
    description:
      'Handbook parses your repository with tree-sitter, builds a typed call graph, and turns it into a ' +
      'navigable handbook — a location index for humans and coding agents. 18 languages, any ' +
      'OpenAI-compatible endpoint, byte-exact change plans, and an incremental resync that keeps the ' +
      'documentation current as the code moves.',
    shortDescription:
      'Parse any repo into a typed call graph, generate a navigable handbook, and let your coding agent route with it. 18 languages. Any OpenAI-compatible endpoint.',
  },
  zh: {
    tagline: '一个代码库进去，两本手册出来——一本给团队读，一本给智能体定位。',
    description:
      'Handbook 用 tree-sitter 解析仓库，建出带类型的调用图，再把它变成一本可导航的手册——' +
      '一份给人也给编码 agent 用的位置索引。支持 18 种语言、任意 OpenAI 兼容端点、' +
      '字节级精确的改动计划，以及一套增量 resync：代码往前走，文档跟着走。',
    shortDescription:
      '把任意仓库解析成带类型的调用图，生成可导航的手册，让你的编码 agent 照它定位。18 种语言，任意 OpenAI 兼容端点。',
  },
  hi: {
    tagline: 'एक codebase अंदर, दो handbooks बाहर — एक टीम पढ़ती है, एक से agent रास्ता निकालता है।',
    description:
      'Handbook आपकी repository को tree-sitter से parse करता है, एक typed call graph बनाता है, और उसे ' +
      'एक navigable handbook में बदल देता है — इंसानों और coding agents, दोनों के लिए एक location index। ' +
      '18 भाषाएँ, कोई भी OpenAI-compatible endpoint, byte-exact बदलाव की योजनाएँ, और एक incremental ' +
      'resync जो कोड आगे बढ़ने पर documentation को साथ रखता है।',
    shortDescription:
      'किसी भी repo को typed call graph में parse कीजिए, navigable handbook बनाइए, और अपने coding agent को उससे रास्ता दिखाने दीजिए। 18 भाषाएँ। कोई भी OpenAI-compatible endpoint।',
  },
  es: {
    tagline:
      'Entra una base de código, salen dos handbooks: uno que lee tu equipo, otro con el que se orienta tu agente.',
    description:
      'Handbook analiza tu repositorio con tree-sitter, construye un grafo de llamadas tipado y lo ' +
      'convierte en un handbook navegable: un índice de ubicaciones para personas y para agentes de ' +
      'programación. 18 lenguajes, cualquier endpoint compatible con OpenAI, planes de cambio exactos ' +
      'byte a byte, y un resync incremental que mantiene la documentación al día mientras el código avanza.',
    shortDescription:
      'Analiza cualquier repo en un grafo de llamadas tipado, genera un handbook navegable y deja que tu agente se guíe por él. 18 lenguajes. Cualquier endpoint compatible con OpenAI.',
  },
  pt: {
    tagline:
      'Entra uma base de código, saem dois handbooks: um que a equipe lê, outro pelo qual o agente se orienta.',
    description:
      'O Handbook analisa o seu repositório com tree-sitter, constrói um grafo de chamadas tipado e o ' +
      'transforma num handbook navegável: um índice de localizações para pessoas e para agentes de ' +
      'programação. 18 linguagens, qualquer endpoint compatível com OpenAI, planos de mudança exatos ' +
      'byte a byte, e um resync incremental que mantém a documentação atual enquanto o código avança.',
    shortDescription:
      'Analise qualquer repo num grafo de chamadas tipado, gere um handbook navegável e deixe o seu agente se orientar por ele. 18 linguagens. Qualquer endpoint compatível com OpenAI.',
  },
  ru: {
    tagline:
      'Одна кодовая база на входе — два руководства на выходе: одно читает команда, по другому ориентируется агент.',
    description:
      'Handbook разбирает репозиторий с помощью tree-sitter, строит типизированный граф вызовов и ' +
      'превращает его в навигируемое руководство — указатель мест для людей и для кодовых агентов. ' +
      '18 языков, любая OpenAI-совместимая точка доступа, побайтово точные планы изменений и ' +
      'инкрементальный resync, который держит документацию в ногу с кодом.',
    shortDescription:
      'Разберите любой репозиторий в типизированный граф вызовов, соберите навигируемое руководство и дайте агенту ориентироваться по нему. 18 языков. Любая OpenAI-совместимая точка доступа.',
  },
  ja: {
    tagline: 'ひとつのコードベースから二冊のハンドブック——一冊はチームが読み、一冊はエージェントが辿る。',
    description:
      'Handbook はリポジトリを tree-sitter で解析し、型付きの呼び出しグラフを構築して、辿れる' +
      'ハンドブックに変えます——人間とコーディングエージェントの両方のための位置インデックスです。' +
      '18 言語、任意の OpenAI 互換エンドポイント、バイト単位で正確な変更計画、そしてコードが' +
      '進んでもドキュメントを追随させる増分 resync。',
    shortDescription:
      '任意のリポジトリを型付き呼び出しグラフに解析し、辿れるハンドブックを生成して、コーディングエージェントにそれで位置を特定させます。18 言語、任意の OpenAI 互換エンドポイント。',
  },
  de: {
    tagline:
      'Eine Codebasis rein, zwei Handbücher raus: eines liest dein Team, mit dem anderen findet dein Agent den Weg.',
    description:
      'Handbook parst dein Repository mit tree-sitter, baut einen typisierten Aufrufgraphen und macht ' +
      'daraus ein navigierbares Handbuch — ein Ortsverzeichnis für Menschen und für Coding-Agenten. ' +
      '18 Sprachen, jeder OpenAI-kompatible Endpunkt, byte-genaue Änderungspläne und ein ' +
      'inkrementelles Resync, das die Dokumentation aktuell hält, während der Code weiterläuft.',
    shortDescription:
      'Parse jedes Repo in einen typisierten Aufrufgraphen, erzeuge ein navigierbares Handbuch und lass deinen Coding-Agenten sich daran orientieren. 18 Sprachen. Jeder OpenAI-kompatible Endpunkt.',
  },
};

/** The copy for one locale, falling back to English for an unknown code. */
export function siteCopy(locale: string): SiteCopy {
  return COPY[locale as Locale] ?? COPY[i18n.defaultLanguage as Locale];
}

/** English copy, for the places that are locale-less by construction (the manifest, oEmbed). */
export const tagline = COPY.en.tagline;
export const description = COPY.en.description;
export const shortDescription = COPY.en.shortDescription;

export const keywords = [
  'codebase documentation',
  'code map',
  'call graph',
  'tree-sitter',
  'AI coding agent',
  'agent skill',
  'llms.txt',
  'code comprehension',
  'static analysis',
  'developer onboarding',
  'monorepo documentation',
  'code navigation',
  'LLM documentation',
  'automatic documentation',
  'repository handbook',
];

export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

/**
 * Absolute origin of the deployed site.
 *
 * Set `NEXT_PUBLIC_SITE_URL` in the deployment environment. Falling back to the
 * Vercel-provided host keeps preview deploys self-consistent; the localhost
 * fallback is only ever hit in development, where an absolute URL is not
 * meaningful anyway.
 */
export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

/**
 * The repository the site links to: "edit this page", the header's GitHub icon,
 * the oEmbed author URL.
 *
 * The default is the real upstream, not a placeholder. It used to be
 * `handbook-tools/handbook`, which does not exist — so every GitHub link the
 * site rendered led to a 404, on 358 pages, and nothing failed a build to say
 * so. A wrong link is worse than a missing one: a reader who clicks it concludes
 * the project is gone rather than that the docs are misconfigured.
 *
 * The env vars stay, so a fork points at itself without a code change.
 */
export const gitConfig = {
  user: process.env.NEXT_PUBLIC_GITHUB_USER ?? 'HandbookAI',
  repo: process.env.NEXT_PUBLIC_GITHUB_REPO ?? 'handbooks',
  branch: 'main',
};

export const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/** Social handles used by the platform-specific meta tags. Blank = tag omitted. */
export const social = {
  twitter: process.env.NEXT_PUBLIC_TWITTER_HANDLE ?? '',
};

/**
 * Search-engine verification tokens. Every one of these is optional: an empty
 * string means the tag is not rendered at all, which is correct — a `content=""`
 * verification tag is worse than no tag, because some consoles read it as a
 * failed claim rather than an absent one.
 */
export const verification = {
  google: process.env.NEXT_PUBLIC_VERIFY_GOOGLE ?? '',
  bing: process.env.NEXT_PUBLIC_VERIFY_BING ?? '',
  yandex: process.env.NEXT_PUBLIC_VERIFY_YANDEX ?? '',
  baidu: process.env.NEXT_PUBLIC_VERIFY_BAIDU ?? '',
  sogou: process.env.NEXT_PUBLIC_VERIFY_SOGOU ?? '',
  so360: process.env.NEXT_PUBLIC_VERIFY_360 ?? '',
  naver: process.env.NEXT_PUBLIC_VERIFY_NAVER ?? '',
  pinterest: process.env.NEXT_PUBLIC_VERIFY_PINTEREST ?? '',
  facebook: process.env.NEXT_PUBLIC_VERIFY_FACEBOOK ?? '',
};

/** Brand colours, shared by the theme-color tags, the manifest and the OG art. */
export const brand = {
  /** Deep navy — the background of every generated card. */
  background: '#0b1020',
  /** Teal: deterministic, no-LLM parts of the toolchain. */
  accent: '#2dd4bf',
  /** Amber: the LLM-backed parts. */
  warm: '#fbbf24',
  /** Violet: the agent-facing parts. */
  agent: '#a78bfa',
};
