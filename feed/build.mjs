#!/usr/bin/env node
/**
 * Forge Power — feed builder
 *
 * Reads every Markdown file in ./content and emits:
 *   dist/feed.xml   RSS 2.0
 *   dist/index.html a plain human-readable index (so the URL isn't bare XML)
 *   dist/p/<slug>/  a permalink page per hosted entry
 *
 * Zero dependencies on purpose. This has to keep working untouched for years,
 * and every dependency is a future build failure.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(ROOT, 'content');
const OUT = join(ROOT, 'dist');

const SITE = {
  title: 'The Gridline — Forge Power',
  description:
    'Thought leadership on grid resilience, edge compute, and distributed digital infrastructure from Forge Power.',
  origin: 'https://feed.forgepower.ai',
  homepage: 'https://www.forgepower.ai',
  email: 'inquiries@forgepower.ai',
  language: 'en-us',
};

/* ---------- tiny helpers ---------- */

const xmlEscape = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const htmlEscape = xmlEscape;

/** Frontmatter: `key: value` lines between --- fences. Quotes optional. */
function parseFrontmatter(raw, file) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing --- frontmatter block`);
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i === -1) throw new Error(`${file}: cannot parse frontmatter line: ${line}`);
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      val = val.slice(1, -1);
    }
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    data[key] = val;
  }
  return { data, body: m[2] };
}

/**
 * Markdown subset -> HTML. Handles headings, paragraphs, unordered lists,
 * links, bold, italic. Deliberately small: prose only, no tables or images.
 */
function markdown(src) {
  const inline = (t) =>
    htmlEscape(t)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

  const out = [];
  let list = null;

  const closeList = () => {
    if (list) {
      out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      list = null;
    }
  };

  for (const block of src.split(/\r?\n\r?\n/)) {
    const t = block.trim();
    if (!t || t.startsWith('<!--')) continue;

    if (/^-\s+/m.test(t) && t.split(/\r?\n/).every((l) => /^-\s+/.test(l.trim()))) {
      list = t.split(/\r?\n/).map((l) => l.trim().replace(/^-\s+/, ''));
      closeList();
      continue;
    }
    closeList();

    const h = t.match(/^(#{2,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    out.push(`<p>${inline(t.replace(/\r?\n/g, ' '))}</p>`);
  }
  closeList();
  return out.join('\n');
}

/* ---------- load ---------- */

if (!existsSync(CONTENT)) throw new Error(`No content directory at ${CONTENT}`);

const entries = readdirSync(CONTENT)
  .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
  .map((file) => {
    const slug = file.replace(/\.md$/, '');
    const { data, body } = parseFrontmatter(readFileSync(join(CONTENT, file), 'utf8'), file);

    for (const req of ['title', 'description', 'pubDate']) {
      if (!data[req]) throw new Error(`${file}: missing required field "${req}"`);
    }
    const date = new Date(data.pubDate);
    if (Number.isNaN(date.valueOf())) throw new Error(`${file}: invalid pubDate "${data.pubDate}"`);

    return {
      slug,
      title: data.title,
      description: data.description,
      date,
      url: data.url || null, // external (e.g. LinkedIn)
      featured: data.featured === true,
      draft: data.draft === true,
      bodyHtml: body.trim() ? markdown(body) : '',
    };
  })
  .filter((e) => !e.draft)
  .sort((a, b) => b.date - a.date);

if (!entries.length) throw new Error('No publishable entries found.');

// An entry links out if it has a url; otherwise we host a page for it here.
for (const e of entries) {
  e.link = e.url ?? `${SITE.origin}/p/${e.slug}/`;
  e.external = Boolean(e.url);
}

/* ---------- emit ---------- */

mkdirSync(OUT, { recursive: true });

const rfc822 = (d) => d.toUTCString();
const human = (d) =>
  d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const items = entries
  .map(
    (e) => `    <item>
      <title>${xmlEscape(e.title)}</title>
      <link>${xmlEscape(e.link)}</link>
      <guid isPermaLink="false">forgepower.ai/gridline/${xmlEscape(e.slug)}</guid>
      <description>${xmlEscape(e.description)}</description>
      <pubDate>${rfc822(e.date)}</pubDate>
    </item>`
  )
  .join('\n');

writeFileSync(
  join(OUT, 'feed.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(SITE.title)}</title>
    <link>${xmlEscape(SITE.homepage)}</link>
    <description>${xmlEscape(SITE.description)}</description>
    <language>${SITE.language}</language>
    <lastBuildDate>${rfc822(new Date())}</lastBuildDate>
    <managingEditor>${SITE.email} (Forge Power)</managingEditor>
    <atom:link href="${SITE.origin}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`
);

const NEWS_FILE = join(ROOT, 'news.json');
let news = [];
if (existsSync(NEWS_FILE)) {
  try {
    news = JSON.parse(readFileSync(NEWS_FILE, 'utf8')).items || [];
  } catch (err) {
    console.warn(`Warning: could not read news.json (${err.message}); building without news.`);
  }
}

const newsCard = (n) => `<article>
  <p class="meta"><time datetime="${n.date}">${human(new Date(n.date))}</time>
  <span class="tag">${htmlEscape(n.source)}</span></p>
  <h2><a href="${htmlEscape(n.link)}" target="_blank" rel="noopener noreferrer">${htmlEscape(n.title)}</a></h2>
  <p>${htmlEscape(n.excerpt)}</p>
</article>`;

const page = (title, inner, extraHead = '') => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)}</title>
<link rel="alternate" type="application/rss+xml" title="${htmlEscape(SITE.title)}" href="${SITE.origin}/feed.xml">
${extraHead}
<style>
:root{--ink:#141512;--soft:#4a4d47;--rule:#d9dcdc;--green:#008a0b}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
line-height:1.6;font-size:17px}
.wrap{width:min(100% - 2.5rem,44rem);margin:0 auto;padding:3.5rem 0 5rem}
a{color:var(--green)}
h1{font-size:2rem;letter-spacing:-.02em;margin:0 0 .4rem}
.sub{color:var(--soft);margin:0 0 2.5rem}
article{padding:1.6rem 0;border-top:1px solid var(--rule)}
article h2{font-size:1.2rem;margin:.2rem 0 .4rem;line-height:1.3}
article h2 a{color:inherit;text-decoration:none}
article h2 a:hover{text-decoration:underline}
article p{margin:0;color:var(--soft)}
h2.section{font-size:1.5rem;margin:3.5rem 0 .4rem;padding-top:2.5rem;border-top:3px solid var(--ink)}
.more{margin-top:1.5rem;font-weight:600}
.meta{font-size:.82rem;color:var(--soft);display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.tag{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;
padding:.1rem .45rem;border-radius:999px;border:1px solid var(--rule);color:var(--soft)}
.tag-f{background:var(--ink);color:#fff;border-color:var(--ink)}
footer{margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--rule);
font-size:.85rem;color:var(--soft)}
.body h2{font-size:1.35rem;margin:2rem 0 .6rem}
</style></head>
<body><div class="wrap">${inner}</div></body></html>
`;

writeFileSync(
  join(OUT, 'index.html'),
  page(
    SITE.title,
    `<h1>The Gridline</h1>
<p class="sub">${htmlEscape(SITE.description)}
<br><a href="/feed.xml">Subscribe via RSS</a> · <a href="${SITE.homepage}">forgepower.ai</a></p>
${entries
  .map(
    (e) => `<article>
  <p class="meta"><time datetime="${e.date.toISOString()}">${human(e.date)}</time>
  ${e.featured ? '<span class="tag tag-f">Featured</span>' : ''}
  ${e.external ? '<span class="tag">LinkedIn</span>' : ''}</p>
  <h2><a href="${htmlEscape(e.link)}"${e.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${htmlEscape(e.title)}</a></h2>
  <p>${htmlEscape(e.description)}</p>
</article>`
  )
  .join('\n')}
${
  news.length
    ? `<h2 class="section">Energy &amp; Frontier Tech</h2>
<p class="sub">Industry headlines we're tracking — energy, micro-grids, edge compute, data
centers, quantum, geothermal, nuclear and next-generation fuels.
<br><a href="/news/">See all ${news.length}</a> · <a href="/news.xml">Subscribe via RSS</a></p>
${news.slice(0, 8).map(newsCard).join('\n')}
<p class="more"><a href="/news/">More industry news →</a></p>`
    : ''
}
<footer>© ${new Date().getFullYear()} Forge Power · <a href="mailto:${SITE.email}">${SITE.email}</a></footer>`
  )
);

// Cloudflare Pages reads this. Without it feed.xml is served as text/xml and
// some readers are fussy; the short cache keeps new posts surfacing quickly.
writeFileSync(
  join(OUT, '_headers'),
  `/feed.xml
  Content-Type: application/rss+xml; charset=utf-8
  Cache-Control: public, max-age=600
`
);

/* ---------- curated industry news (separate feed) ---------- */

/*
  News lives in its own feed on purpose. Someone subscribing to The Gridline is
  subscribing to Forge's point of view; burying that under twenty syndicated
  headlines a week would turn it into a clipping service. Two feeds, one build.

  Copyright: headline + short excerpt + attribution + link to the publisher.
  Never full text.
*/
if (news.length) {
  writeFileSync(
    join(OUT, 'news.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Energy &amp; Frontier Tech — curated by Forge Power</title>
    <link>${xmlEscape(SITE.origin)}/news/</link>
    <description>Industry headlines across energy, micro-grids, edge compute, data centers, quantum, geothermal, nuclear and next-generation fuels. Curated by Forge Power; each item links to its original publisher.</description>
    <language>${SITE.language}</language>
    <lastBuildDate>${rfc822(new Date())}</lastBuildDate>
    <atom:link href="${SITE.origin}/news.xml" rel="self" type="application/rss+xml"/>
${news
  .map(
    (n) => `    <item>
      <title>${xmlEscape(n.title)}</title>
      <link>${xmlEscape(n.link)}</link>
      <guid isPermaLink="true">${xmlEscape(n.link)}</guid>
      <source url="${xmlEscape(SITE.origin)}/news.xml">${xmlEscape(n.source)}</source>
      <description>${xmlEscape(n.excerpt)}</description>
      <pubDate>${rfc822(new Date(n.date))}</pubDate>
    </item>`
  )
  .join('\n')}
  </channel>
</rss>
`
  );

  mkdirSync(join(OUT, 'news'), { recursive: true });
  writeFileSync(
    join(OUT, 'news', 'index.html'),
    page(
      'Energy & Frontier Tech — curated by Forge Power',
      `<p class="meta"><a href="/">← The Gridline</a></p>
<h1>Energy &amp; Frontier Tech</h1>
<p class="sub">Headlines across energy, micro-grids, edge compute, data centers, quantum,
geothermal, nuclear and next-generation fuels. Every item links to its original publisher.
<br><a href="/news.xml">Subscribe via RSS</a></p>
${news.map(newsCard).join('\n')}
<footer>Curated automatically from ${new Set(news.map((n) => n.source)).size} industry
sources. Headlines and excerpts remain the property of their publishers.</footer>`
    )
  );
}

let hosted = 0;
for (const e of entries) {
  if (e.external) continue;
  hosted++;
  const dir = join(OUT, 'p', e.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    page(
      `${e.title} — The Gridline`,
      `<p class="meta"><a href="/">← The Gridline</a></p>
<h1>${htmlEscape(e.title)}</h1>
<p class="sub"><time datetime="${e.date.toISOString()}">${human(e.date)}</time></p>
<div class="body">${e.bodyHtml || `<p>${htmlEscape(e.description)}</p>`}</div>
<footer><a href="${SITE.homepage}">forgepower.ai</a> · <a href="/feed.xml">RSS</a></footer>`,
      `<meta name="description" content="${htmlEscape(e.description)}">`
    )
  );
}

console.log(
  `Built ${entries.length} entries (${hosted} hosted, ${entries.length - hosted} external) -> dist/`
);
