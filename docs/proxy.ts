import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { i18n } from '@/lib/i18n';
import { docsContentRoute, docsRoute } from '@/lib/shared';

/**
 * Two jobs, in a deliberate order.
 *
 * 1. Serve the markdown twin of a docs page when the caller asked for markdown
 *    (`Accept: text/markdown`, or a `.md` suffix). Agents do; browsers do not.
 * 2. Otherwise hand off to locale routing.
 *
 * Markdown first: those rewrites target `/llms.mdx/...`, which is NOT under
 * `app/[lang]` and must never be given a locale prefix. Running i18n first
 * would rewrite the path out from under them.
 */
const { rewrite: rewriteDocs } = rewritePath(
  `${docsRoute}{/*path}`,
  `${docsContentRoute}{/*path}/content.md`,
);
const { rewrite: rewriteSuffix } = rewritePath(
  `${docsRoute}{/*path}.md`,
  `${docsContentRoute}{/*path}/content.md`,
);

const localeMiddleware = createI18nMiddleware(i18n);

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const suffix = rewriteSuffix(request.nextUrl.pathname);
  if (suffix) return NextResponse.rewrite(new URL(suffix, request.nextUrl));

  if (isMarkdownPreferred(request)) {
    const negotiated = rewriteDocs(request.nextUrl.pathname);
    if (negotiated) {
      return NextResponse.rewrite(new URL(negotiated, request.nextUrl), {
        // The same URL has two representations, chosen by `Accept`.
        headers: { Vary: 'Accept' },
      });
    }
  }

  return localeMiddleware(request, event);
}

export const config = {
  // Everything except Next internals and the machine-readable surfaces, which
  // are locale-independent by design: one sitemap, one robots.txt, one feed.
  //
  // `_next` is excluded WHOLESALE, not just `_next/static` and `_next/image`.
  // Locale routing has no business anywhere under it, and the paths that live
  // there are not a fixed list: `next dev` serves its hot-reload socket from
  // `/_next/hmr`, which this matcher used to claim — the i18n middleware then
  // rewrote it to `/en/_next/hmr`, the upgrade never reached the dev server and
  // the handshake failed with ERR_INVALID_HTTP_RESPONSE on every page load.
  matcher: [
    '/((?!api|_next|favicon|og\\.png|og-square\\.png|sitemap\\.xml|robots\\.txt|rss\\.xml|oembed\\.json|manifest\\.webmanifest|llms\\.txt|llms-full\\.txt|llms\\.mdx|og/|diagrams/|browserconfig\\.xml|apple-touch-icon|favicon-).*)',
  ],
};
