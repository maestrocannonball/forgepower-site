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

const bySource = [...news.reduce((m, n) => m.set(n.source, (m.get(n.source) || 0) + 1), new Map())]
  .sort((a, b) => b[1] - a[1]);
const byTopic = [...news.reduce((m, n) => m.set(n.topic, (m.get(n.topic) || 0) + 1), new Map())]
  .sort((a, b) => b[1] - a[1]);
const peak = Math.max(1, ...bySource.map((r) => r[1]));

/* Small multiples: one identical cell per value, so the comparison happens
   inside a single eyespan rather than across a scroll. */
const multiples = (rows, max) => `<ul class="multiples">
${rows
  .map(
    ([label, n], i) => `  <li class="mult${n >= max ? ' hi' : ''} reveal" data-i="${i % 7}">
    <span class="track"><span class="fill" style="width:${Math.round((n / max) * 100)}%"></span></span>
    <span class="lbl"><span class="n">${n}</span>${htmlEscape(label)}</span>
  </li>`
  )
  .join('\n')}
</ul>`;

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
  /* motion tokens — see Design canon. Motion must do feedback, continuity or
     hierarchy. Anything else is decoration. */
  --dur-micro:160ms; --dur-comp:260ms; --dur-view:420ms; --dur-set:1100ms;
  --ease-out:cubic-bezier(.16,1,.3,1);
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

/* ============================================================
   INFORMATION LAYER — small multiples, stat strip
   Tufte: maximise data-ink, erase everything else. One design
   repeated across values so comparison happens in one eyespan.
   ============================================================ */
.strip{display:flex;flex-wrap:wrap;gap:0 2.4rem;margin:1.8rem 0 0;
  padding:1rem 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.stat{padding:.35rem 0}
.stat b{display:block;font-size:1.35rem;font-weight:700;letter-spacing:-.03em;
  line-height:1;font-variant-numeric:tabular-nums}
.stat span{display:block;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted);margin-top:.35rem}
.stat.t b{color:var(--teal)} .stat.a b{color:var(--amber)}

.multiples{display:grid;grid-template-columns:repeat(auto-fill,minmax(9.5rem,1fr));
  gap:.9rem 1.6rem;margin:1.6rem 0 0;padding:0;list-style:none}
.mult{font-size:.72rem;color:var(--muted);line-height:1.3}
.mult .n{font-variant-numeric:tabular-nums;color:var(--ink);font-weight:700;
  font-size:.82rem;margin-right:.3rem}
.mult .track{display:block;height:3px;background:rgba(255,255,255,.09);margin:.4rem 0 .35rem}
.mult .fill{display:block;height:3px;background:var(--teal);
  transform:scaleX(0);transform-origin:left;transition:transform var(--dur-view) var(--ease-out)}
.in .mult .fill,.mult.in .fill{transform:scaleX(1)}
.mult.hi .fill{background:var(--amber)}
.mult .lbl{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ============================================================
   POSTER LAYER — index only
   Blue Note covers were silkscreened. The honest motion is
   registration: color plates converging into alignment. Slow,
   deliberate, once. Nothing loops except the live signal.
   ============================================================ */

/* masthead plate — three offset impressions snapping into register */
.hero{padding:1rem 0 3.5rem}
.plate{position:relative;display:block;font-weight:900;
  font-size:clamp(3.2rem,2rem+7vw,6.4rem);line-height:.88;letter-spacing:-.05em;
  margin:0 0 1.6rem}
.plate span{display:block}
.plate .ink{position:relative;color:var(--ink);z-index:3}
.plate .t,.plate .a{position:absolute;inset:0;z-index:1}
.plate .t{color:var(--teal);animation:reg-t 1100ms cubic-bezier(.16,1,.3,1) both}
.plate .a{color:var(--amber);animation:reg-a 1100ms cubic-bezier(.16,1,.3,1) both}
@keyframes reg-t{from{transform:translate3d(-14px,7px,0);opacity:.9}
                 to{transform:translate3d(0,0,0);opacity:.34}}
@keyframes reg-a{from{transform:translate3d(13px,-8px,0);opacity:.9}
                 to{transform:translate3d(0,0,0);opacity:.30}}

/* the rule draws like a plotter pass */
.draw{height:2px;background:var(--teal);transform-origin:left center;
  animation:draw 900ms 250ms cubic-bezier(.16,1,.3,1) both}
@keyframes draw{from{transform:scaleX(0)}to{transform:scaleX(1)}}

/* entries rise into place, staggered, once */
.reveal{opacity:0;transform:translate3d(0,14px,0)}
.reveal.in{opacity:1;transform:none;
  transition:opacity 700ms cubic-bezier(.16,1,.3,1),transform 700ms cubic-bezier(.16,1,.3,1)}

/* hero entry — poster scale for the newest piece */
article.entry.lead h2{font-size:clamp(2rem,1.3rem+3vw,3.2rem);letter-spacing:-.04em;
  line-height:1.02;max-width:20ch}
article.entry.lead{padding-top:2.8rem}

/* hover: an amber rule extends, the way a plate edge catches */
article.entry{position:relative}
article.entry::before{content:"";position:absolute;left:-1.4rem;top:2.4rem;
  width:0;height:2px;background:var(--amber);transition:width 320ms cubic-bezier(.16,1,.3,1)}
article.entry:hover::before{width:.9rem}
article.entry h2 a{transition:color 220ms ease}

/* live signal — the only looping motion on the page */
.dot{animation:pulse 2.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}

/* hairline reading progress */
.prog{position:fixed;top:0;left:0;height:2px;width:100%;transform:scaleX(0);
  transform-origin:left;background:var(--teal);opacity:.55;z-index:50}

@media (prefers-reduced-motion:reduce){
  .plate .t,.plate .a,.draw,.dot{animation:none}
  .plate .t{opacity:.34}.plate .a{opacity:.30}
  .draw{transform:none}
  .reveal{opacity:1;transform:none}
  .prog{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head>
<body>
<header class="mast"><div class="mast-in">
  <a href="/" aria-label="Forge Power"><img src="/logo.png" alt="Forge Power"></a>
  <a class="sub-link" href="/feed.xml"><span class="dot"></span>Subscribe</a>
</div></header>
<div class="prog" id="prog"></div>
<div class="wrap">${inner}</div>
<script>
(function(){
  var p=document.getElementById('prog');
  if(p) addEventListener('scroll',function(){
    var h=document.documentElement,
        d=(h.scrollHeight-h.clientHeight)||1;
    p.style.transform='scaleX('+Math.min(1,h.scrollTop/d)+')';
  },{passive:true});

  var els=[].slice.call(document.querySelectorAll('.reveal'));
  if(!els.length) return;
  if(!('IntersectionObserver' in window)){
    els.forEach(function(e){e.classList.add('in')}); return;
  }
  var io=new IntersectionObserver(function(rows){
    rows.forEach(function(r){
      if(!r.isIntersecting) return;
      var i=+(r.target.dataset.i||0);
      setTimeout(function(){r.target.classList.add('in')}, Math.min(i,6)*90);
      io.unobserve(r.target);
    });
  },{rootMargin:'0px 0px -8% 0px',threshold:.08});
  els.forEach(function(e){io.observe(e)});
})();
</script>
</body></html>
`;

writeFileSync(
  join(OUT, 'index.html'),
  page(
    SITE.title,
    `<section class="hero">
  <p class="kicker">Forge Power</p>
  <h1 class="plate" aria-label="The Gridline">
    <span class="t" aria-hidden="true">The Gridline</span>
    <span class="a" aria-hidden="true">The Gridline</span>
    <span class="ink">The Gridline</span>
  </h1>
  <div class="draw"></div>
  <p class="lede" style="margin-top:1.6rem">${htmlEscape(SITE.description)}</p>
  <div class="strip">
    <div class="stat"><b>${entries.length}</b><span>Pieces</span></div>
    <div class="stat t"><b>${bySource.length}</b><span>Sources tracked</span></div>
    <div class="stat a"><b>${news.length}</b><span>Items in pool</span></div>
    <div class="stat"><b>${human(entries[0].date)}</b><span>Last published</span></div>
  </div>
  <p class="meta" style="margin-top:1.2rem"><a href="${SITE.homepage}">forgepower.ai</a></p>
</section>

${entries
  .map(
    (e, i) => `<article class="entry reveal${i === 0 ? ' lead' : ''}" data-i="${i}">
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
    ? `<h2 class="section reveal" data-i="0">Energy &amp; Frontier Tech</h2>
<p class="section-note reveal" data-i="1">Headlines we're tracking across energy, micro-grids, edge
compute, data centers, quantum, geothermal, nuclear and next-generation fuels. Every item links
to its original publisher.</p>
<p class="meta reveal" data-i="1"><a href="/news/">All ${news.length} items</a> · <a href="/news.xml">Subscribe</a></p>
${news
  .slice(0, 8)
  .map((n, i) => newsCard(n).replace('<article class="entry">', `<article class="entry reveal" data-i="${i}">`))
  .join('\n')}
<p class="more reveal" data-i="0"><a href="/news/">More industry news →</a></p>`
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
<div class="strip">
  <div class="stat a"><b>${news.length}</b><span>Items</span></div>
  <div class="stat t"><b>${bySource.length}</b><span>Sources</span></div>
  <div class="stat"><b>${byTopic.length}</b><span>Topics</span></div>
</div>
<p class="kicker" style="margin:2.4rem 0 0">Where it came from</p>
${multiples(bySource, peak)}
<p class="kicker" style="margin:2.4rem 0 0">What it was about</p>
${multiples(byTopic, Math.max(1, ...byTopic.map((r) => r[1])))}
<p class="meta" style="margin-top:2.4rem"><a href="/news.xml">Subscribe to this feed</a></p>
<hr style="border:0;border-top:1px solid var(--rule);margin:2.6rem 0 0">
${news.map((n, i) => newsCard(n).replace('<article class="entry">', `<article class="entry reveal" data-i="${i % 7}">`)).join('\n')}
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
