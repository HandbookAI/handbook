/**
 * One place for every value the site, its metadata and its SEO surfaces need.
 *
 * Nothing here is duplicated into a component: the OG image route, the sitemap,
 * the RSS feed, the JSON-LD block and the per-platform meta tags all read these,
 * so changing the deployed URL or the tagline is a one-line edit that cannot
 * leave a stale absolute URL behind in one of thirty head tags.
 */

export const appName = 'Handbook';

export const tagline = 'Turn any codebase into a handbook your agent can actually route with.';

export const description =
  'Handbook parses your repository with tree-sitter, builds a typed call graph, and turns it into a ' +
  'navigable handbook — a location index for humans and coding agents. 18 languages, any ' +
  'OpenAI-compatible endpoint, byte-exact change plans, and an incremental resync that keeps the ' +
  'documentation current as the code moves.';

/** Short form for cards that truncate hard (Twitter/X, WeChat, Slack unfurls). */
export const shortDescription =
  'Parse any repo into a typed call graph, generate a navigable handbook, and let your coding agent route with it. 18 languages. Any OpenAI-compatible endpoint.';

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
  repo: process.env.NEXT_PUBLIC_GITHUB_REPO ?? 'handbook',
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
