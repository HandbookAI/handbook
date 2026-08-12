import { RootProvider } from '@/components/provider';
import { defineI18nUI } from 'fumadocs-ui/i18n';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import '../global.css';
import { PlatformMeta, StructuredData, siteMetadata } from '@/lib/seo';
import { brand } from '@/lib/shared';
import { BCP47, i18n, type Locale } from '@/lib/i18n';
import { FUMADOCS_TRANSLATIONS } from '@/lib/fumadocs-strings';

const inter = Inter({ subsets: ['latin'], display: 'swap' });

/**
 * Fumadocs' own chrome (search, table of contents, page actions, theme and
 * language menus, sidebar, pagination) in each locale.
 *
 * Handed over whole, and deliberately NOT reshaped here. `defineI18nUI` accepts
 * `Record<string, string>`, so any key this file invented would type-check and
 * then render English — which is precisely the bug that shipped. The table in
 * `lib/fumadocs-strings.ts` is annotated with the library's own `Translations`
 * type, and this call site's job is only to pass it through unchanged.
 */
const { provider } = defineI18nUI(i18n, FUMADOCS_TRANSLATIONS);

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
        <StructuredData locale={lang} />
      </body>
    </html>
  );
}
