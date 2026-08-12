import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { docsContentRoute, docsImageRoute, docsRoute } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { i18n } from './i18n';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    // Real per-file dates, read from git. The sitemap used to stamp every one of
    // 273 URLs with the build time — one distinct value across the whole file —
    // which tells a crawler that all 273 pages changed on every deploy. Google
    // drops `lastmod` it cannot correlate with actual change, so a fabricated
    // one is worse than none: it spends the signal instead of using it.
    //
    // Needs git history at build time. Vercel clones shallowly by default, so
    // the project also sets VERCEL_DEEP_CLONE=true; where the history is absent
    // this yields undefined and the sitemap omits the field rather than lying.
    lastModified: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  i18n,
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

/**
 * The social card's URL, with the locale INSIDE the route rather than in front
 * of it.
 *
 * It used to be `/<locale>/og/docs/<slug…>/image.png`, but the route lives at
 * `app/og/docs/[...slug]` with no `[lang]` segment — so only the default locale
 * resolved, and then only because the i18n middleware had already stripped its
 * prefix. Every other locale's card 404'd: an English docs link unfurled in
 * Slack or WeChat and a Chinese one showed nothing. The card is also
 * locale-independent as a ROUTE (one implementation, eight languages of copy),
 * so the locale belongs in its parameters, not in its path prefix.
 */
export function getPageImageUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: '/' + [...docsImageRoute.split('/'), page.locale, ...segments].filter(Boolean).join('/'),
  };
}

export function getPageMarkdownUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'content.md'];

  return {
    segments,
    url: '/' + [page.locale, ...docsContentRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

export async function getLLMText(page: (typeof source)['$inferPage']) {
  const processed = await page.data.getText('processed');

  return `# ${page.data.title} (${page.url})

${processed}`;
}
