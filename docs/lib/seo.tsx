/**
 * Every SEO surface, in one place.
 *
 * Two exports:
 *
 *   `siteMetadata()`  — the Next.js `Metadata` object: canonical URL, Open Graph,
 *                       Twitter/X cards, icons, manifest, robots directives and
 *                       search-console verification.
 *   `<PlatformMeta/>` — the tags Next's Metadata API has no field for, which is
 *                       where most of the long tail of platforms actually lives:
 *                       WeChat, Baidu, Sogou, 360, Naver, Pinterest rich pins,
 *                       Apple and Microsoft web-app hints, oEmbed discovery.
 *
 * Why bother with the long tail: an unfurl is the first impression for a link
 * pasted into Slack, Discord, Teams, WhatsApp, Telegram, LinkedIn, Reddit or a
 * WeChat chat, and each of those reads a slightly different subset. Getting one
 * right and the rest wrong means the link looks broken exactly where it travels.
 */
import type { Metadata } from 'next';
import { BCP47, i18n, LOCALES, type Locale } from './i18n';
import { appName, brand, keywords, repoUrl, siteUrl, social, siteCopy, verification } from './shared';

/**
 * Card art. The alt text is per locale because a screen reader in the reader's
 * language is the whole point of alt text, and these two objects are what every
 * Open Graph and Twitter card embeds.
 */
const ogImage = (locale: string) => ({
  url: '/og.png',
  width: 1200,
  height: 630,
  alt: `${appName} — ${siteCopy(locale).tagline}`,
  type: 'image/png',
});

/** Square art, for the platforms that crop a wide card into a thumbnail. */
const squareImage = (locale: string) => ({
  url: '/og-square.png',
  width: 1200,
  height: 1200,
  alt: `${appName} — ${siteCopy(locale).tagline}`,
  type: 'image/png',
});

/**
 * `locale` drives more than the `lang` attribute: the canonical URL, the
 * `hreflang` set and `og:locale` all change with it. Getting those wrong is how
 * eight translations of one page end up competing with each other in search
 * instead of each serving its own audience.
 */
export function siteMetadata(locale: string = i18n.defaultLanguage): Metadata {
  const home = (code: string): string => (code === i18n.defaultLanguage ? siteUrl : `${siteUrl}/${code}`);
  const bcp47 = BCP47[locale as Locale] ?? locale;
  // The locale was already in hand and spent only on URLs: `title` and
  // `description` read module-level English, so every non-English route
  // advertised itself in English to search engines and link unfurlers.
  const copy = siteCopy(locale);

  return {
    metadataBase: new URL(siteUrl),
    title: {
      default: `${appName} — ${copy.tagline}`,
      template: `%s · ${appName}`,
    },
    description: copy.description,
    keywords,
    applicationName: appName,
    category: 'technology',
    authors: [{ name: `${appName} contributors`, url: repoUrl }],
    creator: `${appName} contributors`,
    publisher: appName,
    generator: 'Next.js + Fumadocs',
    referrer: 'origin-when-cross-origin',

    alternates: {
      canonical: home(locale),
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [BCP47[l.code as Locale], home(l.code)])),
        'x-default': home(i18n.defaultLanguage),
      },
      types: {
        'application/rss+xml': [{ url: '/rss.xml', title: `${appName} — documentation updates` }],
        // Plain-markdown twins of every docs page, for agents that ask for them.
        'text/plain': [{ url: '/llms.txt', title: `${appName} — llms.txt` }],
      },
    },

    // Open Graph is the widest-reach format by far: Facebook, LinkedIn, Slack,
    // Discord, Telegram, WhatsApp, Signal, Teams, Reddit, Pinterest, Notion,
    // Confluence, Line, Viber, Skype, Mastodon, Bluesky and iMessage all read it.
    openGraph: {
      type: 'website',
      siteName: appName,
      title: `${appName} — ${copy.tagline}`,
      description: copy.description,
      url: home(locale),
      locale: bcp47.replace('-', '_'),
      alternateLocale: LOCALES.filter((l) => l.code !== locale).map((l) =>
        (BCP47[l.code as Locale] ?? l.code).replace('-', '_'),
      ),
      images: [ogImage(locale), squareImage(locale)],
    },

    twitter: {
      card: 'summary_large_image',
      title: `${appName} — ${copy.tagline}`,
      description: copy.shortDescription,
      images: [ogImage(locale).url],
      ...(social.twitter ? { site: social.twitter, creator: social.twitter } : {}),
    },

    icons: {
      icon: [
        { url: '/favicon.svg', type: 'image/svg+xml' },
        { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
        { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
      ],
      apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
      shortcut: ['/favicon.svg'],
    },

    manifest: '/manifest.webmanifest',

    appleWebApp: {
      capable: true,
      title: appName,
      statusBarStyle: 'black-translucent',
    },

    formatDetection: { telephone: false, address: false, email: false },

    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-image-preview': 'large',
        'max-snippet': -1,
        'max-video-preview': -1,
      },
    },

    verification: {
      ...(verification.google ? { google: verification.google } : {}),
      ...(verification.yandex ? { yandex: verification.yandex } : {}),
      other: {
        ...(verification.bing ? { 'msvalidate.01': verification.bing } : {}),
        ...(verification.baidu ? { 'baidu-site-verification': verification.baidu } : {}),
        ...(verification.sogou ? { sogou_site_verification: verification.sogou } : {}),
        ...(verification.so360 ? { '360-site-verification': verification.so360 } : {}),
        ...(verification.naver ? { 'naver-site-verification': verification.naver } : {}),
        ...(verification.pinterest ? { 'p:domain_verify': verification.pinterest } : {}),
        ...(verification.facebook ? { 'facebook-domain-verification': verification.facebook } : {}),
      },
    },
  };
}

/**
 * Tags with no Metadata-API field. Rendered inside `<head>` by the root layout.
 *
 * Grouped by who reads them so the next person can tell at a glance whether a
 * tag is load-bearing for a platform they care about, or safe to drop.
 */
export function PlatformMeta({ locale = i18n.defaultLanguage }: { locale?: string }) {
  return (
    <>
      {/* ── Chinese platforms ─────────────────────────────────────────────
          WeChat's in-app browser and Baidu both fall back to these rather
          than to Open Graph, and Baidu additionally wants an explicit
          statement that the page is responsive instead of having a separate
          mobile host. */}
      <meta name="applicable-device" content="pc,mobile" />
      <meta name="MobileOptimized" content="width" />
      <meta name="HandheldFriendly" content="true" />
      <meta httpEquiv="Cache-Control" content="no-transform" />
      <meta name="baidu-site-verification-type" content="html" />
      {/* WeChat / QQ share cards read itemprop, not og:, when the page is not
          registered with an official account. */}
      <meta itemProp="name" content={appName} />
      <meta itemProp="description" content={siteCopy(locale).shortDescription} />
      <meta itemProp="image" content={`${siteUrl}/og.png`} />

      {/* ── Pinterest ────────────────────────────────────────────────────── */}
      <meta name="pinterest-rich-pin" content="true" />

      {/* ── Microsoft: Windows tiles and the Edge/IE pinned-site UI ──────── */}
      <meta name="msapplication-TileColor" content={brand.background} />
      <meta name="msapplication-TileImage" content="/apple-touch-icon.png" />
      <meta name="msapplication-config" content="/browserconfig.xml" />
      <meta name="msapplication-tap-highlight" content="no" />

      {/* ── Apple ────────────────────────────────────────────────────────── */}
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="mobile-web-app-capable" content="yes" />

      {/* ── Discord, and anything else that follows oEmbed discovery ─────── */}
      <link rel="alternate" type="application/json+oembed" href={`${siteUrl}/oembed.json`} title={appName} />

      {/* ── Feed readers ─────────────────────────────────────────────────── */}
      <link rel="alternate" type="application/rss+xml" title={`${appName} updates`} href="/rss.xml" />

      {/* ── Language alternates ──────────────────────────────────────────────
          Deliberately NOT here. `siteMetadata()` already emits the full
          hreflang set through `alternates.languages`, and a second copy is not
          redundant-but-harmless: duplicate hreflang annotations for the same
          URL are a conflicting signal, and Google's own guidance is to drop the
          whole cluster when it finds them contradicting. One producer only. */}
    </>
  );
}

/**
 * Structured data (Google, Bing, DuckDuckGo rich results), rendered in `<body>`.
 *
 * NOT a React `<script>` element: React never executes client-rendered inline
 * scripts, and in development it says so with a `console.error` every time a
 * locale switch re-renders the layout — an error in every reader's console.
 * JSON-LD never needed executing in the first place; crawlers read its TEXT out
 * of the DOM. So the whole tag is injected as a string through a hidden `<div>`
 * with `dangerouslySetInnerHTML`: byte-identical on server and client (clean
 * hydration), inert everywhere, silent in the console, and exactly as visible
 * to a crawler as before. The payload is built from module constants — no user
 * input reaches it — and `<` is escaped so no content can close the tag early.
 */
export function StructuredData({ locale = i18n.defaultLanguage }: { locale?: string } = {}) {
  const json = JSON.stringify(structuredData(locale)).replace(/</g, '\\u003c');
  return (
    <div hidden dangerouslySetInnerHTML={{ __html: `<script type="application/ld+json">${json}</script>` }} />
  );
}

function structuredData(locale: string) {
  // A search engine reads this per URL, so the description here must match the
  // page it sits on rather than the default language's.
  const copy = siteCopy(locale);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${siteUrl}/#software`,
        name: appName,
        description: copy.description,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux, Windows',
        url: siteUrl,
        downloadUrl: repoUrl,
        codeRepository: repoUrl,
        programmingLanguage: 'TypeScript',
        license: 'https://opensource.org/licenses/MIT',
        softwareRequirements: 'Node.js >= 20.11',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'WebSite',
        '@id': `${siteUrl}/#website`,
        url: siteUrl,
        name: appName,
        description: copy.tagline,
        // Was hardcoded `'en'`: the Chinese page's JSON-LD told a search engine
        // it was English, which is a stronger wrong signal than a missing one —
        // the whole point of the hreflang set above is to keep eight
        // translations from competing with each other.
        inLanguage: BCP47[locale as Locale] ?? locale,
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${siteUrl}/docs?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
      {
        '@type': 'Organization',
        '@id': `${siteUrl}/#org`,
        name: appName,
        url: siteUrl,
        logo: `${siteUrl}/og-square.png`,
      },
    ],
  };
}
