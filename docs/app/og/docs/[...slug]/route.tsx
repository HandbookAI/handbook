import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';
import { getPageImageUrl, source } from '@/lib/source';
import { appName, brand, siteCopy } from '@/lib/shared';
import { i18n, LOCALES } from '@/lib/i18n';

export const revalidate = false;

/**
 * The per-page social card.
 *
 * Hand-drawn rather than the framework default, because the default renders in
 * its own palette: a link to a docs page unfurled next to a link to the site
 * looked like two different products. Everything here reads its colours from
 * `lib/shared`, so the cards and the site cannot drift apart.
 *
 * Satori (what `ImageResponse` renders with) supports a deliberately small slice
 * of CSS — flexbox, no grid, no `gap` shorthand quirks, and every element that
 * has more than one child needs an explicit `display: flex`. Keep it plain.
 */
export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  const { slug } = await params;
  // `getPageImageUrl` builds `/og/docs/<locale>/<slug…>/image.png`, so the
  // locale is the FIRST slug segment and `image.png` the last.
  //
  // Two defects met here. The URL used to put the locale in FRONT of the route
  // (`/zh/og/docs/…`) while the route has no `[lang]` segment, so every
  // non-default locale 404'd — an English docs link unfurled a card in Slack or
  // WeChat and a Chinese one showed nothing. And `getPage` was called with no
  // locale, so the card that did render was always the English page's title and
  // the English tagline. A wrong card is worse than a missing one.
  //
  // The locale is trusted only when it names one we actually have; anything else
  // is treated as part of the slug, so a stray segment cannot silently select
  // the default language.
  const [first, ...restOfSlug] = slug;
  const locale = LOCALES.some((l) => l.code === first) ? first : undefined;
  const pageSlugs = (locale ? restOfSlug : slug).slice(0, -1);
  const page = source.getPage(pageSlugs, locale);
  if (!page) notFound();
  const copy = siteCopy(locale ?? i18n.defaultLanguage);

  // The breadcrumb a reader would see in the sidebar: "Reference · CLI reference".
  const section = page.slugs.length > 1 ? (page.slugs[0] as string).replace(/-/g, ' ') : 'docs';

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        backgroundColor: brand.background,
        backgroundImage: `radial-gradient(900px 520px at 85% -15%, ${brand.agent}33, transparent 60%), radial-gradient(760px 480px at 5% 110%, ${brand.accent}2b, transparent 60%)`,
        fontFamily: 'sans-serif',
        color: '#F2F5FF',
      }}
    >
      {/* section eyebrow */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          fontSize: 20,
          letterSpacing: 2,
          textTransform: 'uppercase',
          color: brand.accent,
          fontWeight: 700,
        }}
      >
        {section}
      </div>

      {/* title + description */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            fontSize: page.data.title.length > 34 ? 62 : 76,
            fontWeight: 800,
            letterSpacing: -2,
            lineHeight: 1.08,
            maxWidth: 1000,
          }}
        >
          {page.data.title}
        </div>
        {page.data.description ? (
          <div
            style={{
              marginTop: 26,
              fontSize: 28,
              lineHeight: 1.4,
              color: '#AAB8E0',
              maxWidth: 980,
              display: 'flex',
            }}
          >
            {page.data.description.length > 165
              ? `${page.data.description.slice(0, 162)}…`
              : page.data.description}
          </div>
        ) : null}
      </div>

      {/* footer: wordmark + the one-line pitch */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          paddingTop: 26,
        }}
      >
        <div style={{ display: 'flex', marginRight: 14 }}>
          <div
            style={{
              width: 18,
              height: 40,
              borderRadius: 5,
              backgroundColor: brand.accent,
              marginRight: 5,
            }}
          />
          <div style={{ width: 18, height: 40, borderRadius: 5, backgroundColor: brand.agent }} />
        </div>
        <div style={{ fontSize: 30, fontWeight: 800, marginRight: 22 }}>{appName}</div>
        <div style={{ fontSize: 21, color: '#8C9AC4', display: 'flex' }}>{copy.tagline}</div>
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImageUrl(page).segments,
  }));
}
