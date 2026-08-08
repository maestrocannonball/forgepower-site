// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// `site` must be the canonical production origin — RSS item links, the sitemap,
// and the feed's <atom:link rel="self"> are all built from it.
export default defineConfig({
  site: 'https://www.forgepower.ai',
  integrations: [sitemap()],
});
