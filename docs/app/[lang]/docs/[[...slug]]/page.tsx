import { getPageImageUrl, getPageMarkdownUrl, source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { gitConfig, siteUrl } from '@/lib/shared';
import { i18n, BCP47, LOCALES, type Locale } from '@/lib/i18n';
import { ui } from '@/lib/ui-strings';
import { pageCardMetadata, PageStructuredData } from '@/lib/seo';

export default async function Page(props: PageProps<'/[lang]/docs/[[...slug]]'>) {
  const { slug, lang } = await props.params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const t = ui(lang);
  // Which FILE the loader resolved, not which locale it labelled the page with:
  // `page.locale` is the locale that was asked for, so it is equal to `lang`
  // whether or not a translation exists and can never signal a fallback. A
  // translated page comes from `reference/cli.zh.mdx`; a fallback comes from
  // `reference/cli.mdx`. That difference is the only honest signal available.
  const isFallback = lang !== i18n.defaultLanguage && !page.path.includes(`.${lang}.`);

  // The breadcrumb trail Google renders under a result instead of a bare URL,
  // walked over the slug prefixes rather than read from the page tree.
  // `getBreadcrumbItems` matches a tree node by URL and the localized routes do
  // not line up with it, so it returned nothing usable and every page shipped
  // without breadcrumbs; `source.getPage` is the same lookup this route already
  // trusts for the page itself.
  //
  // Only levels that ARE a page appear. Most section folders here — `guides`,
  // `concepts` — carry a `meta.json` title and no index page, and schema.org
  // requires `item` on every breadcrumb but the last, so the alternative to
  // skipping those levels is inventing a link to a page that does not exist.
  // `Docs › Generating a handbook` is shorter than the sidebar, and resolves.
  const docsIndexUrl = lang === i18n.defaultLanguage ? '/docs' : `/${lang}/docs`;
  const ancestors = (slug ?? [])
    .slice(0, -1)
    .map((_, i) => source.getPage((slug ?? []).slice(0, i + 1), lang))
    .filter((p): p is NonNullable<typeof p> => !!p);
  const trail =
    page.url === docsIndexUrl
      ? []
      : [
          { name: t.navDocs, url: `${siteUrl}${docsIndexUrl}` },
          ...ancestors.map((p) => ({ name: p.data.title, url: `${siteUrl}${p.url}` })),
          { name: page.data.title, url: `${siteUrl}${page.url}` },
        ];

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <PageStructuredData
        title={page.data.title}
        description={page.data.description}
        url={`${siteUrl}${page.url}`}
        locale={lang}
        modified={page.data.lastModified}
        trail={trail}
      />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row items-center gap-2 border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/docs/content/docs/${page.path}`}
        />
      </div>
      {isFallback ? (
        <div className="mt-6 rounded-lg border border-fd-border bg-fd-card px-4 py-3 text-sm text-fd-muted-foreground">
          {t.untranslated}
        </div>
      ) : null}
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams('slug', 'lang');
}

export async function generateMetadata(props: PageProps<'/[lang]/docs/[[...slug]]'>): Promise<Metadata> {
  const { slug, lang } = await props.params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const path = slug?.length ? `/docs/${slug.join('/')}` : '/docs';
  const canonicalFor = (locale: string): string =>
    locale === i18n.defaultLanguage ? `${siteUrl}${path}` : `${siteUrl}/${locale}${path}`;

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: canonicalFor(lang),
      // Every locale, plus x-default — so a crawler serves a Spanish reader the
      // Spanish page instead of ranking eight near-duplicates against each other.
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [BCP47[l.code as Locale], canonicalFor(l.code)])),
        'x-default': canonicalFor(i18n.defaultLanguage),
      },
    },
    // Open Graph *and* Twitter together — see `pageCardMetadata`. Returning only
    // the first one left every documentation page unfurling as the home page on
    // Twitter/X, Slack, Discord, LinkedIn and Teams.
    ...pageCardMetadata({
      title: page.data.title,
      description: page.data.description,
      url: canonicalFor(lang),
      locale: lang,
      image: getPageImageUrl(page).url,
    }),
  };
}
