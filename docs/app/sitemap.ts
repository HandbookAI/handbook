import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export const revalidate = false;

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const pages = source.getPages().map((page) => ({
    url: `${siteUrl}${page.url}`,
    lastModified: now,
    // The docs index outranks a leaf page; a leaf page outranks nothing.
    changeFrequency: 'weekly' as const,
    priority: page.slugs.length === 0 ? 0.9 : 0.7,
  }));

  return [{ url: siteUrl, lastModified: now, changeFrequency: 'weekly', priority: 1 }, ...pages];
}
