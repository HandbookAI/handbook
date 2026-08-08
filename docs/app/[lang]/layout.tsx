import { RootProvider } from '@/components/provider';
import { defineI18nUI } from 'fumadocs-ui/i18n';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import '../global.css';
import { PlatformMeta, siteMetadata } from '@/lib/seo';
import { brand } from '@/lib/shared';
import { BCP47, i18n, LOCALES, type Locale } from '@/lib/i18n';
import { UI } from '@/lib/ui-strings';

const inter = Inter({ subsets: ['latin'], display: 'swap' });

/**
 * Fumadocs' own chrome (search box, table of contents, theme and language
 * menus) in each locale. Its keys are a subset of ours, so the table in
 * `ui-strings.ts` stays the single place a translator has to look.
 */
const localeTranslations: Partial<Record<string, Record<string, string> & { displayName?: string }>> =
  Object.fromEntries(
    LOCALES.map((locale) => {
      const t = UI[locale.code as Locale];
      return [
        locale.code,
        {
          displayName: locale.name as string,
          search: t.search,
          searchNoResult: t.searchNoResult,
          toc: t.toc,
          tocNoHeadings: t.tocNoHeadings,
          lastUpdate: t.lastUpdate,
          chooseLanguage: t.chooseLanguage,
          nextPage: t.nextPage,
          previousPage: t.previousPage,
          chooseTheme: t.chooseTheme,
          editOnGithub: t.editOnGithub,
        },
      ];
    }),
  );

const { provider } = defineI18nUI(i18n, localeTranslations);

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export async function generateMetadata(props: LayoutProps<'/[lang]'>): Promise<Metadata> {
  const { lang } = await props.params;
  return siteMetadata(lang);
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'dark light',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: brand.background },
  ],
};

export default async function Layout({ children, params }: LayoutProps<'/[lang]'>) {
  const { lang } = await params;
  return (
    // The full BCP 47 tag, not the bare code: `lang="zh"` leaves a screen reader
    // and a crawler guessing between Simplified and Traditional.
    <html lang={BCP47[lang as Locale] ?? lang} className={inter.className} suppressHydrationWarning>
      <head>
        <PlatformMeta locale={lang} />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider i18n={provider(lang)}>{children}</RootProvider>
      </body>
    </html>
  );
}
