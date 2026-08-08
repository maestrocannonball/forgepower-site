import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * The Gridline — Forge Power's thought-leadership collection.
 *
 * Two kinds of entry live here:
 *   1. Native posts  — body written in Markdown, published on this site.
 *   2. LinkedIn posts — `externalUrl` set, body optional. These are curated by
 *      hand (LinkedIn offers no API or RSS for personal articles) and render as
 *      outbound links rather than local pages.
 *
 * Both kinds appear in /feed.xml. `featured: true` pins an entry to the top of
 * the Gridline section on the homepage.
 */
const gridline = defineCollection({
  loader: glob({ base: './src/content/gridline', pattern: '**/*.md' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      // Set for LinkedIn articles and any other off-site writing.
      externalUrl: z.string().url().optional(),
      featured: z.boolean().default(false),
      draft: z.boolean().default(false),
      heroImage: image().optional(),
      tags: z.array(z.string()).default([]),
    }),
});

export const collections = { gridline };
