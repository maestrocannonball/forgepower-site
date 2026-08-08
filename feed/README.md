# The Gridline — RSS feed

An auto-updating RSS feed for Forge Power, published at
**https://feed.forgepower.ai/feed.xml**

The main site (www.forgepower.ai) is hosted on Canva, which cannot serve a feed
file or give articles their own URLs. This directory is a small, self-contained
site that does both, without touching the Canva site at all.

## Adding a post

Create one Markdown file in `content/`. That's the whole workflow.

### A LinkedIn article (featured content)

Copy `_TEMPLATE-linkedin.md`, rename it, remove the `draft` line:

```markdown
---
title: 'Title as published on LinkedIn'
description: 'One or two sentences — this is what subscribers see.'
pubDate: 2026-08-15
url: 'https://www.linkedin.com/pulse/...'
featured: true
---
```

Because `url` is set, the feed item links straight to LinkedIn and no page is
hosted here.

### An article hosted on the feed site

Same, minus `url`. Write the body in Markdown below the frontmatter:

```markdown
---
title: 'The headline'
description: 'Teaser text.'
pubDate: 2026-08-15
---

Body copy. Blank lines separate paragraphs.

## Subheadings work

**Bold**, *italic*, [links](https://example.com), and `-` bullet lists work.
```

It gets a real URL at `/p/<filename>/`.

Commit to `main` → Cloudflare Pages rebuilds and deploys, usually under a minute.

### Fields

| Field         | Required | Notes                                          |
| ------------- | -------- | ---------------------------------------------- |
| `title`       | yes      |                                                |
| `description` | yes      | Shown in feed readers                          |
| `pubDate`     | yes      | `YYYY-MM-DD`. Controls ordering                |
| `url`         | no       | Set for LinkedIn/external. Suppresses the page |
| `featured`    | no       | Adds a "Featured" tag on the index             |
| `draft`       | no       | `true` excludes it entirely                    |

Files beginning with `_` are ignored.

## Two rules worth knowing

1. **Never rename a published file.** The filename is the feed GUID. Rename it
   and every subscriber sees the post again as new.
2. **A malformed file fails the build on purpose.** Cloudflare will report the
   error and keep serving the last good deploy, rather than publishing a broken
   feed. The error names the file and the problem.

## Deployment

Cloudflare Pages, connected to this repo:

- **Root directory:** `feed`
- **Build command:** `node build.mjs`
- **Output directory:** `dist`

No dependencies, no lockfile, no environment variables. The build is one Node
script with zero packages — deliberately, so it doesn't rot.

## Why LinkedIn entries are manual

LinkedIn publishes no RSS feed and its API does not expose personal articles.
Automated scraping would violate their terms and break regularly. Pasting a URL
into a new file takes about thirty seconds and never breaks — and it means you
choose exactly what gets featured.

## Local preview

```bash
node build.mjs && npx serve dist
```
