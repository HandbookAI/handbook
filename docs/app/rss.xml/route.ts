import { source } from '@/lib/source';
import { appName, description, siteUrl } from '@/lib/shared';

export const revalidate = false;

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A feed of the documentation itself, so a reader can watch the docs move. */
export function GET() {
  const items = source
    .getPages()
    .map(
      (page) => `    <item>
      <title>${escape(page.data.title)}</title>
      <link>${siteUrl}${page.url}</link>
      <guid isPermaLink="true">${siteUrl}${page.url}</guid>
      <description>${escape(page.data.description ?? '')}</description>
    </item>`,
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escape(appName)} — documentation</title>
    <link>${siteUrl}</link>
    <description>${escape(description)}</description>
    <language>en</language>
    <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
}
