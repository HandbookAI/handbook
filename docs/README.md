# Handbook documentation site

The public documentation for [Handbook](../README.md) — a Next.js app using
[Fumadocs](https://fumadocs.dev). Content is MDX under `content/docs/`.

This directory is **not** part of the repo's pnpm workspace (it has its own
`pnpm-workspace.yaml`), so a root `pnpm install` ignores it entirely and library
consumers never pull in React or Next.

## Running it

```bash
cd docs
pnpm install
pnpm dev          # → http://localhost:3000
pnpm build        # static-ish production build
pnpm start        # serve the production build
pnpm types:check
```

## Layout

```
content/docs/            the documentation, as MDX + one meta.json per folder
  reference/configuration.md   GENERATED — see below
app/                     routes, plus every SEO surface
  layout.tsx             root layout; renders <PlatformMeta/>
  (home)/page.tsx        the landing page
  docs/[[...slug]]/      every docs page
  og/docs/[...slug]/     a per-page Open Graph image
  sitemap.ts robots.ts manifest.ts rss.xml/ oembed.json/  llms.txt/ llms-full.txt/
lib/
  shared.ts              site name, URLs, verification tokens, brand colours
  seo.tsx                the Metadata object + the long-tail platform tags
  source.ts              the fumadocs content source
components/mdx.tsx       components every MDX page may use without importing
public/                  og.png, og-square.png, favicons, browserconfig.xml
public/diagrams/         GENERATED — copied from ../assets by prebuild
scripts/sync-generated.mjs
```

## Two generated inputs

**`content/docs/reference/configuration.md`** is generated from the settings registry by
`pnpm run config:docs` **in the repo root**, and a drift test compares it byte for byte.
Do not hand-edit it; change `packages/core/src/config/registry.ts` and regenerate.

**`public/diagrams/*.svg`** are copied from `../assets` by `scripts/sync-generated.mjs`,
which `pnpm dev` and `pnpm build` run automatically. The diagrams live at the repo root
because both READMEs reference them from there; the copy here is gitignored so it cannot
drift.

## Deploying

Set these in the deployment environment — everything else has a sensible default:

| Variable                                              | Purpose                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`                                | **Required in production.** The absolute origin. Every canonical URL, OG image URL, sitemap entry and JSON-LD id is built from it                                                                                                            |
| `NEXT_PUBLIC_GITHUB_USER` / `NEXT_PUBLIC_GITHUB_REPO` | The "edit this page" and GitHub links                                                                                                                                                                                                        |
| `NEXT_PUBLIC_TWITTER_HANDLE`                          | Adds `twitter:site` / `twitter:creator`                                                                                                                                                                                                      |
| `NEXT_PUBLIC_VERIFY_*`                                | Search-console verification tokens (Google, Bing, Yandex, Baidu, Sogou, 360, Naver, Pinterest, Facebook). An unset one renders **no tag at all**, which is correct — an empty `content=""` reads as a failed claim rather than an absent one |

Any Node host works (`pnpm build && pnpm start`), as does Vercel, and the output is
static enough for most CDNs.

## SEO surfaces

`lib/seo.tsx` is the single place all of this lives:

- **Open Graph** — Facebook, LinkedIn, Slack, Discord, Telegram, WhatsApp, Signal, Teams,
  Reddit, Pinterest, Notion, Confluence, Line, Viber, Skype, Mastodon, Bluesky, iMessage
- **Twitter/X cards** — `summary_large_image`
- **JSON-LD** — `SoftwareApplication`, `WebSite` with a `SearchAction`, `Organization`
- **WeChat / QQ / Weibo** — `itemprop` fallbacks plus `applicable-device` and
  `Cache-Control: no-transform`, which Baidu's transcoder respects
- **Apple / Microsoft** — touch icons, web-app hints, tile colour, `browserconfig.xml`
- **oEmbed** — `/oembed.json`, which Discord and others discover from the `<link>`
- **Feeds and agents** — `/rss.xml`, `/llms.txt`, `/llms-full.txt`, and a markdown twin of
  every page under `/llms.mdx/docs/…`
- **Crawlers** — `sitemap.xml`, `robots.txt` (GPTBot, ClaudeBot, PerplexityBot and
  Google-Extended explicitly allowed), `manifest.webmanifest`

Every docs page also gets its own generated Open Graph image at
`/og/docs/<slug>/image.png`.
