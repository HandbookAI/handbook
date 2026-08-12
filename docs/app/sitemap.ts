import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export const revalidate = false;

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages().map((page) => {
    // `lastModified` comes from git (see lib/source.ts). Where it is missing —
    // a shallow clone, a file git has never seen — the field is left out. An
    // absent date costs nothing; a wrong one teaches the crawler to ignore
    // every date on the site, including the accurate ones.
    const modified = page.data.lastModified;

    return {
      url: `${siteUrl}${page.url}`,
      ...(modified ? { lastModified: new Date(modified) } : {}),
      // The docs index outranks a leaf page; a leaf page outranks nothing.
      changeFrequency: 'weekly' as const,
      priority: page.slugs.length === 0 ? 0.9 : 0.7,
    };
  });

  // The home page's own date is the newest page date: it is assembled from the
  // content, so it is exactly as fresh as the freshest thing on it.
  const newest = pages
    .map((p) => p.lastModified)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return [
    {
      url: siteUrl,
      ...(newest ? { lastModified: newest } : {}),
      changeFrequency: 'weekly',
      priority: 1,
    },
    ...pages,
  ];
}
