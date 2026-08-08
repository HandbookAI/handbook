'use client';

import { FrameworkProvider } from 'fumadocs-core/framework';
import { RootProvider as BaseRootProvider } from 'fumadocs-ui/provider/base';
import NextImage from 'next/image';
import NextLink from 'next/link';
import { useParams, usePathname as useNextPathname, useRouter } from 'next/navigation';
import { i18n } from '@/lib/i18n';
import type { Framework } from 'fumadocs-core/framework';
import type { ComponentProps } from 'react';

/**
 * `hideLocale: 'default-locale'` means English keeps bare `/docs/...` URLs, and
 * fumadocs' middleware delivers that by REWRITING `/docs/x` to `/en/docs/x`.
 * A rewrite is invisible to the browser but not to the renderer: at prerender
 * time the route really is `/en/docs/x`, so `usePathname()` returns that, while
 * in the browser it returns `/docs/x`.
 *
 * Every consumer inside fumadocs compares that pathname against page-tree and
 * nav `url`s — which are the PUBLIC, locale-hidden ones. So the server compared
 * `/en/docs/reference/cli` against `/docs/reference/cli`, matched nothing, and
 * prerendered English pages with no active sidebar item, every folder collapsed
 * and no previous/next links. The browser then matched, rebuilt the tree, and
 * React reported a hydration mismatch (#418) on every English docs page.
 *
 * Normalising here — at the one seam fumadocs offers for it — makes both sides
 * read the same public path. It is a no-op for every prefixed locale, and a
 * no-op entirely unless the default locale is actually hidden.
 */
const hidden = i18n.hideLocale === 'default-locale' ? `/${i18n.defaultLanguage}` : null;

function usePublicPathname(): string {
  const pathname = useNextPathname();
  if (!hidden) return pathname;
  if (pathname === hidden) return '/';
  return pathname.startsWith(`${hidden}/`) ? pathname.slice(hidden.length) : pathname;
}

/**
 * Fumadocs treats `href` and `src` as optional; Next's components require them.
 * These two adapters are the whole difference — `next/link` and `next/image`
 * are still what renders, so prefetching and image optimisation are unchanged.
 */
const Link: NonNullable<Framework['Link']> = ({ href, prefetch, ...rest }) =>
  href === undefined ? <a {...rest} /> : <NextLink href={href} prefetch={prefetch} {...rest} />;

const Image: NonNullable<Framework['Image']> = ({ src, alt = '', priority, width, height, ...rest }) =>
  src === undefined ? (
    <img alt={alt} width={width} height={height} fetchPriority={priority ? 'high' : 'auto'} {...rest} />
  ) : (
    <NextImage
      src={src}
      alt={alt}
      priority={priority}
      // `<img width>` is `string | number`; `next/image` wants a number.
      width={width === undefined ? undefined : Number(width)}
      height={height === undefined ? undefined : Number(height)}
      {...rest}
    />
  );

export function RootProvider(props: ComponentProps<typeof BaseRootProvider>) {
  return (
    <FrameworkProvider
      usePathname={usePublicPathname}
      useRouter={useRouter}
      useParams={useParams}
      Link={Link}
      Image={Image}
    >
      <BaseRootProvider {...props} />
    </FrameworkProvider>
  );
}
