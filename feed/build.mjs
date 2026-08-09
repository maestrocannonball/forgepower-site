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

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
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

// Clean first. Otherwise a page that was published in an earlier build — an
// article since set back to draft, say — lingers in dist and can be deployed.
rmSync(OUT, { recursive: true, force: true });
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

const newsCard = (n) => `<article class="entry">
  <p class="meta"><time datetime="${n.date}">${human(new Date(n.date))}</time>
  <span class="tag tag-x">${htmlEscape(n.source)}</span></p>
  <h2><a href="${htmlEscape(n.link)}" target="_blank" rel="noopener noreferrer">${htmlEscape(n.title)}</a></h2>
  <p>${htmlEscape(n.excerpt)}</p>
</article>`;

const page = (title, inner, extraHead = '') => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)}</title>
<link rel="alternate" type="application/rss+xml" title="${htmlEscape(SITE.title)}" href="${SITE.origin}/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;0,900;1,400&display=swap" rel="stylesheet">
${extraHead}
<style>
/*
  Forge Power visual identity.
  Ground #000b0d (near-black, teal cast) · teal #13b8a7 (structure) ·
  amber #f49e0b (emphasis) · electric green #00ff15 (ONE spot use, live signal).
  Roboto is the brand's designated substitute for Aktiv Grotesk.
  Typesetting: mixed case, flush left, ragged, no hyphenation, tight kerning.
*/
:root{
  --ground:#000b0d; --ground-2:#001216; --ink:#ffffff;
  --teal:#13b8a7; --amber:#f49e0b; --navy:#0b2138; --live:#00ff15;
  --muted:#8fa0a2; --rule:rgba(255,255,255,.13);
  --measure:68ch;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--ground); color:var(--ink);
  font-family:'Roboto',Helvetica,Arial,sans-serif;
  font-size:18px; line-height:1.6; -webkit-font-smoothing:antialiased;
  hyphens:none; text-align:left;
}
::selection{background:var(--teal);color:var(--ground)}
.wrap{width:min(100% - 3rem, 46rem);margin:0 auto;padding:0 0 6rem}

/* masthead */
header.mast{border-bottom:1px solid var(--rule);margin-bottom:3.5rem}
.mast-in{width:min(100% - 3rem, 46rem);margin:0 auto;padding:1.6rem 0;
  display:flex;align-items:center;justify-content:space-between;gap:1.5rem}
.mast img{width:132px;height:auto;display:block}
.mast a{text-decoration:none;color:inherit}
.sub-link{display:inline-flex;align-items:center;gap:.55rem;
  font-size:.78rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;
  color:var(--teal);border:1px solid rgba(19,184,167,.4);border-radius:999px;
  padding:.45rem .9rem;white-space:nowrap}
.sub-link:hover{background:rgba(19,184,167,.1)}
/* the single electric-green instance on the page: a live signal */
.dot{width:7px;height:7px;border-radius:50%;background:var(--live);flex:0 0 auto}

h1{font-size:clamp(2.1rem,1.4rem+2.6vw,3.1rem);line-height:1.04;
  font-weight:700;letter-spacing:-.035em;text-wrap:balance}
h2{font-weight:700;letter-spacing:-.025em;line-height:1.15}
p{margin:0 0 1.15em;text-wrap:pretty}
a{color:var(--teal)}
strong{font-weight:700}

.kicker{font-size:.78rem;font-weight:700;letter-spacing:.2em;text-transform:uppercase;
  color:var(--teal);margin:0 0 1rem}
.lede{font-size:1.22rem;line-height:1.5;color:#c9d5d6;max-width:var(--measure);
  margin:1.1rem 0 0}
.meta{font-size:.85rem;color:var(--muted);display:flex;gap:.7rem;align-items:center;
  flex-wrap:wrap;margin:0 0 .5rem}

/* index list — poster scale, flush left, generous space */
article.entry{padding:2.2rem 0;border-top:1px solid var(--rule)}
article.entry:first-of-type{border-top:2px solid var(--teal)}
article.entry h2{font-size:clamp(1.35rem,1.1rem+1vw,1.75rem);margin:.15rem 0 .5rem;
  max-width:32ch}
article.entry h2 a{color:var(--ink);text-decoration:none}
article.entry h2 a:hover{color:var(--teal)}
article.entry p{margin:0;color:var(--muted);max-width:var(--measure)}
.tag{font-size:.62rem;font-weight:900;letter-spacing:.1em;text-transform:uppercase;
  padding:.18rem .5rem;border-radius:999px;border:1px solid var(--rule);color:var(--muted)}
.tag-f{background:var(--amber);color:var(--ground);border-color:var(--amber)}
.tag-x{border-color:rgba(19,184,167,.45);color:var(--teal)}

/* section break */
h2.section{font-size:clamp(1.6rem,1.2rem+1.4vw,2.1rem);margin:4.5rem 0 .5rem;
  padding-top:2.6rem;border-top:3px solid var(--amber)}
.section-note{color:var(--muted);max-width:var(--measure);margin:0 0 1.5rem}
.more{margin-top:2rem;font-weight:700}
.more a{text-decoration:none}
.more a:hover{text-decoration:underline}

/* article body */
.body{max-width:var(--measure)}
.body h2{font-size:1.45rem;margin:2.6rem 0 .8rem}
.body p{margin:0 0 1.25em}
.body a{color:var(--teal)}
.back{margin-top:4rem;padding-top:1.5rem;border-top:1px solid var(--rule);font-weight:700}
.back a{text-decoration:none}
.back a:hover{text-decoration:underline}

footer{margin-top:5rem;padding-top:1.6rem;border-top:1px solid var(--rule);
  font-size:.85rem;color:var(--muted)}
footer a{color:var(--muted)}
footer a:hover{color:var(--teal)}

:focus-visible{outline:2px solid var(--teal);outline-offset:3px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head>
<body>
<header class="mast"><div class="mast-in">
  <a href="/" aria-label="Forge Power"><img src="/logo.png" alt="Forge Power"></a>
  <a class="sub-link" href="/feed.xml"><span class="dot"></span>Subscribe</a>
</div></header>
<div class="wrap">${inner}</div>
</body></html>
`;

writeFileSync(
  join(OUT, 'index.html'),
  page(
    SITE.title,
    `<p class="kicker">Forge Power</p>
<h1>The Gridline</h1>
<p class="lede">${htmlEscape(SITE.description)}</p>
<p class="meta" style="margin-top:1.4rem"><a href="${SITE.homepage}">forgepower.ai</a></p>

${entries
  .map(
    (e) => `<article class="entry">
  <p class="meta"><time datetime="${e.date.toISOString()}">${human(e.date)}</time>
  ${e.featured ? '<span class="tag tag-f">Featured</span>' : ''}
  ${e.external ? '<span class="tag tag-x">LinkedIn</span>' : ''}</p>
  <h2><a href="${htmlEscape(e.link)}"${e.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${htmlEscape(e.title)}</a></h2>
  <p>${htmlEscape(e.description)}</p>
</article>`
  )
  .join('\n')}
${
  news.length
    ? `<h2 class="section">Energy &amp; Frontier Tech</h2>
<p class="section-note">Headlines we're tracking across energy, micro-grids, edge compute, data
centers, quantum, geothermal, nuclear and next-generation fuels. Every item links to its
original publisher.</p>
<p class="meta"><a href="/news/">All ${news.length} items</a> · <a href="/news.xml">Subscribe</a></p>
${news.slice(0, 8).map(newsCard).join('\n')}
<p class="more"><a href="/news/">More industry news →</a></p>`
    : ''
}
<footer>© ${new Date().getFullYear()} Forge Power · <a href="mailto:${SITE.email}">${SITE.email}</a></footer>`
  )
);

// The wordmark is a real brand asset, never type set to imitate it.
copyFileSync(join(ROOT, 'assets', 'logo.png'), join(OUT, 'logo.png'));

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
      `<p class="kicker"><a href="/" style="color:inherit;text-decoration:none">← The Gridline</a></p>
<h1>Energy &amp; Frontier Tech</h1>
<p class="lede">Headlines across energy, micro-grids, edge compute, data centers, quantum,
geothermal, nuclear and next-generation fuels. Every item links to its original publisher.</p>
<p class="meta" style="margin-top:1.4rem"><a href="/news.xml">Subscribe to this feed</a></p>
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
      `<p class="kicker"><a href="/" style="color:inherit;text-decoration:none">← The Gridline</a></p>
<h1>${htmlEscape(e.title)}</h1>
<p class="lede">${htmlEscape(e.description)}</p>
<p class="meta" style="margin:1.6rem 0 2.6rem;padding-bottom:1.4rem;border-bottom:1px solid var(--rule)"><time datetime="${e.date.toISOString()}">${human(e.date)}</time></p>
<div class="body">${e.bodyHtml || `<p>${htmlEscape(e.description)}</p>`}</div>
<p class="back"><a href="/">← All Gridline writing</a></p>
<footer><a href="${SITE.homepage}">forgepower.ai</a> · <a href="/feed.xml">RSS</a></footer>`,
      `<meta name="description" content="${htmlEscape(e.description)}">`
    )
  );
}

console.log(
  `Built ${entries.length} entries (${hosted} hosted, ${entries.length - hosted} external) -> dist/`
);
