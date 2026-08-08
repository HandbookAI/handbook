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

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
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
    openGraph: {
      title: page.data.title,
      description: page.data.description,
      url: canonicalFor(lang),
      locale: BCP47[lang as Locale] ?? lang,
      images: getPageImageUrl(page).url,
    },
  };
}
