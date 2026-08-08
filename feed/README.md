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

## Two feeds, on purpose

| URL         | What it is                                              |
| ----------- | ------------------------------------------------------- |
| `/feed.xml` | The Gridline — Forge's own writing and LinkedIn articles |
| `/news.xml` | Curated industry headlines across energy and frontier tech |

They're separate because someone subscribing to The Gridline is subscribing to
Forge's point of view. Blending twenty syndicated headlines a week into that
feed would bury the voice and turn it into a clipping service. The homepage
shows the eight most recent news items with a link to the full list.

## Industry news pipeline

`fetch-news.mjs` pulls ~21 verified energy and frontier-tech feeds, filters for
relevance, dedupes, and writes `news.json`. `build.mjs` turns that into
`/news.xml` and `/news/`.

```bash
node fetch-news.mjs   # refresh news.json
node build.mjs        # rebuild the site
```

`.github/workflows/news.yml` runs the fetch twice daily and commits `news.json`
when it changes. **The result is committed rather than fetched at build time** —
so a source being down can never break a deploy; the last good snapshot stays
live.

### Editing what gets pulled

`sources.json` holds everything:

- **`sources`** — each has a `mode`. `always` means the whole publication is
  on-topic, take everything. `filter` means it's general-interest, so an item
  must score at least 6 on topic keywords **and** name a topic in its headline.
  That two-part bar exists because a single stray keyword was pulling in an Air
  Force story about nuclear blast goggles and a SpaceX funding round.
- **`topics`** — keyword weights. Higher weight = stronger relevance signal.
  Headline matches count double.
- **`exclude`** — dropped regardless of score. Promotional noise plus
  off-domain uses of on-domain words (weapons, rockets, crypto, gadgets).

Caps: 5 items per dedicated source, 3 per general-interest source, 60 total,
nothing older than 30 days.

**Before adding a source, verify its feed actually parses.** Several obvious
candidates don't work: Microgrid Knowledge and Data Center Frontier both block
feed access, RTO Insider serves malformed XML, Reuters requires a licence. All
four are on-topic and worth periodically re-testing.

### Copyright posture

Headline, short excerpt, source attribution, and a link to the publisher.
Never full article text. Every item links back to where it came from.

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
