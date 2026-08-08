import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE } from '../consts.js';

/**
 * RSS 2.0 feed at /feed.xml
 *
 * Design notes:
 *  - GUIDs are derived from the entry `id` (the filename slug), NOT from the
 *    link. That keeps them stable even if a post later moves from an external
 *    LinkedIn URL to a native page — otherwise every reader would re-surface
 *    the item as new.
 *  - LinkedIn entries link out to LinkedIn; native posts link to their own page.
 */
export async function GET(context) {
  const posts = (await getCollection('gridline', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf()
  );

  return rss({
    title: SITE.title,
    description: SITE.description,
    site: context.site,
    trailingSlash: false,
    xmlns: { atom: 'http://www.w3.org/2005/Atom' },
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: post.data.externalUrl ?? `/gridline/${post.id}/`,
      categories: post.data.tags,
      customData: [
        `<guid isPermaLink="false">forgepower.ai/gridline/${post.id}</guid>`,
        post.data.externalUrl
          ? `<source url="${context.site}feed.xml">${SITE.title}</source>`
          : '',
      ]
        .filter(Boolean)
        .join(''),
    })),
    customData: [
      // Canonical self-reference. Required by the W3C feed validator and used
      // by some readers to de-duplicate a feed reached via different URLs.
      `<atom:link href="${context.site}feed.xml" rel="self" type="application/rss+xml"/>`,
      `<language>en-us</language>`,
      `<copyright>Copyright ${new Date().getFullYear()} Forge Power</copyright>`,
      `<managingEditor>${SITE.email} (Forge Power)</managingEditor>`,
      `<webMaster>${SITE.email} (Forge Power)</webMaster>`,
    ].join(''),
  });
}
