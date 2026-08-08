import { appName, repoUrl, shortDescription, siteUrl } from '@/lib/shared';

export const revalidate = false;

/**
 * Minimal oEmbed provider. Discord and a handful of other clients follow the
 * `application/json+oembed` <link> in the head and render `author_name` /
 * `provider_name` above the Open Graph card — the difference between a link
 * that looks deliberate and one that looks scraped.
 */
export function GET() {
  return Response.json(
    {
      version: '1.0',
      type: 'link',
      title: appName,
      description: shortDescription,
      author_name: `${appName} contributors`,
      author_url: repoUrl,
      provider_name: appName,
      provider_url: siteUrl,
      thumbnail_url: `${siteUrl}/og.png`,
      thumbnail_width: 1200,
      thumbnail_height: 630,
    },
    { headers: { 'cache-control': 'public, max-age=3600' } },
  );
}
