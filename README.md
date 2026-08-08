# forgepower-site

The Forge Power AI website. Static site built with [Astro](https://astro.build),
deployed on Cloudflare Pages. Replaces the previous Canva-hosted site.

## Why this exists

The Canva site could not host an RSS feed, had no per-article URLs, and cost a
monthly subscription. This repo fixes all three.

## Adding a post to The Gridline

Every entry is one Markdown file in `src/content/gridline/`. The filename becomes
the URL slug **and the feed GUID** — so don't rename a file after publishing, or
feed readers will re-show the post as new.

### A native post (published on this site)

Create `src/content/gridline/my-post-slug.md`:

```markdown
---
title: 'The headline'
description: 'One or two sentences for the card and the feed.'
pubDate: 2026-08-15
featured: false
tags: ['grid resilience']
---

Body copy in Markdown.
```

Lives at `/gridline/my-post-slug/` and appears in `/feed.xml` automatically.

### A LinkedIn article (featured content)

Same thing, plus `externalUrl`. Copy `_example-linkedin-article.md` as a starting
point. Entries with `externalUrl` get **no local page** — the card and the feed
item both link out to LinkedIn.

```markdown
---
title: 'Title as published on LinkedIn'
description: 'Teaser text.'
pubDate: 2026-08-15
externalUrl: 'https://www.linkedin.com/pulse/...'
featured: true
---
```

LinkedIn provides no API or RSS for personal articles, so this list is curated by
hand. That is deliberate — it also means you control exactly what gets featured.

### Options

| Field         | Effect                                                        |
| ------------- | ------------------------------------------------------------- |
| `featured`    | Shows a "Featured" pill on the card                            |
| `draft`       | `true` hides it from the site and the feed                     |
| `externalUrl` | Links out instead of creating a local page                     |
| `updatedDate` | Optional; for substantive revisions                            |

Commit and push to `main` — Cloudflare Pages rebuilds and deploys automatically.

## Local development

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # outputs to dist/
```

## Deployment

Cloudflare Pages, connected to this repo.

- Build command: `npm run build`
- Output directory: `dist`
- No environment variables required

## Feed

`/feed.xml` — RSS 2.0, with `<link rel="alternate">` autodiscovery in the site
`<head>` so readers detect it from any page.

## Outstanding

- [ ] Real publication dates for the three migrated Gridline posts
- [ ] Full article bodies (only excerpts were recoverable from the Canva site)
- [ ] The five legal pages
- [ ] Images migrated from the Canva site
- [ ] Typeface: the original uses proprietary Canva Sans; this uses Figtree
