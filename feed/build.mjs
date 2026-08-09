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
    'News and ideas on grid constraint, distributed infrastructure, and the collision between compute demand and a system that was not built for it.',
  origin: 'https://feed.forgepower.ai',
  homepage: 'https://www.forgepower.ai',
  email: 'inquiries@forgepower.ai',
  language: 'en-us',
};

/* ---------- tiny helpers ---------- */

const xmlEscape = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const htmlEscape = xmlEscape;


/**
 * Widow control. A line of text should never end with a word stranded alone.
 * Binds the last N words with non-breaking spaces so they wrap together.
 * Body copy holds three; headings hold two, since large type fits fewer words
 * per line and over-binding causes overflow.
 */
function noWidow(str = '', hold = 3) {
  const words = String(str).trim().split(/\s+/);
  if (words.length <= 7) return str;          // short lines cannot orphan badly
  const n = Math.min(hold, words.length - 1);
  const head = words.slice(0, words.length - n).join(' ');
  const tail = words.slice(words.length - n).join('\u00A0');
  return `${head} ${tail}`;
}

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
      out.push(`<h${lvl}>${noWidow(inline(h[2]), 2)}</h${lvl}>`);
      continue;
    }
    out.push(`<p>${noWidow(inline(t.replace(/\r?\n/g, ' ')))}</p>`);
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
      // Figure spec — every entry carries a built graphic. See figure().
      fig: data.fig || 'plates',
      figA: data.figA ? Number(data.figA) : null,
      figB: data.figB ? Number(data.figB) : null,
      figLabelA: data.figLabelA || '',
      figLabelB: data.figLabelB || '',
      figUnit: data.figUnit || '',
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


/* ============================================================
   FIGURES — one built graphic per story
   Flat fields, two inks, no gradients. Every figure is derived
   from the story's own numbers where it has them, and from the
   brand's registration motif where it does not.
   ============================================================ */

/* Aspect varies by module so the page has vertical rhythm rather than a
   uniform band down the page. Hero is wide and cinematic; splits are taller
   and denser, which is what makes the spread read as a magazine. */
const FIG_SIZE = { hero: [1200, 560], split: [900, 720] };

function figRatio(e, W, H) {
  const a = e.figA ?? 1, b = e.figB ?? 1;
  const max = Math.max(a, b);
  const aw = Math.round((a / max) * (W - 40));
  const bw = Math.round((b / max) * (W - 40));
  const midY = H * 0.34, botY = H * 0.72;
  return `
  <text class="f-num f-t" x="0" y="${midY - 26}">${a}${e.figUnit}</text>
  <rect class="f-bar f-teal" x="0" y="${midY}" width="${aw}" height="${H * 0.09}"/>
  <text class="f-lab f-t" x="0" y="${midY + H * 0.09 + 34}">${htmlEscape(e.figLabelA)}</text>
  <text class="f-num f-a" x="0" y="${botY - 26}">${b}${e.figUnit}</text>
  <rect class="f-bar f-amber" x="0" y="${botY}" width="${bw}" height="${H * 0.15}"/>
  <text class="f-lab f-a" x="0" y="${botY + H * 0.15 + 34}">${htmlEscape(e.figLabelB)}</text>`;
}

function figGrid(e, W, H) {
  const cols = W > 1000 ? 40 : 26;
  const rows = W > 1000 ? 12 : 20;
  const total = cols * rows;
  const share = e.figA && e.figB ? e.figA / e.figB : 0.19;
  const on = Math.round(total * share);
  const cw = W / cols, ch = H / rows;
  let out = '';
  for (let i = 0; i < total; i++) {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    const cls = i < on ? 'f-cell f-on' : 'f-cell f-off';
    out += `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cw - 6).toFixed(1)}" height="${(ch - 6).toFixed(1)}" style="--d:${(i % cols) * 6 + Math.floor(i / cols) * 18}ms"/>`;
  }
  return out;
}

function figStack(e, W, H) {
  const ratio = e.figA && e.figB ? e.figB / e.figA : 5.19;
  const full = Math.floor(ratio), frac = ratio - full;
  const gap = 10;
  const bh = (H - 90 - full * gap) / (full + 1.4);
  const lw = W * 0.26, rw = W * 0.5, rx = W * 0.36;
  let out = `<rect class="f-bar f-teal" x="0" y="${H - bh}" width="${lw}" height="${bh}"/>
  <text class="f-lab f-t" x="0" y="${H - bh - 18}">${htmlEscape(e.figLabelA)}</text>`;
  for (let i = 0; i < full; i++) {
    const y = H - (i + 1) * (bh + gap);
    out += `<rect class="f-bar f-amber" x="${rx}" y="${y}" width="${rw}" height="${bh}" style="--d:${i * 80}ms"/>`;
  }
  const py = H - (full + 1) * (bh + gap);
  out += `<rect class="f-bar f-amber" x="${rx}" y="${py + bh - bh * frac}" width="${rw}" height="${Math.round(bh * frac)}" style="--d:${full * 80}ms"/>`;
  out += `<text class="f-lab f-a" x="${rx}" y="${py - 18}">${htmlEscape(e.figLabelB)}</text>`;
  return out;
}

function figPlates(e, W, H) {
  // The registration motif: three impressions converging into alignment.
  const w = W * 0.54, h = H * 0.56;
  return `
  <rect class="f-plate f-p1" x="${W * 0.10}" y="${H * 0.16}" width="${w}" height="${h}"/>
  <rect class="f-plate f-p2" x="${W * 0.26}" y="${H * 0.28}" width="${w}" height="${h}"/>
  <rect class="f-plate f-p3" x="${W * 0.18}" y="${H * 0.22}" width="${w}" height="${h}"/>`;
}


/* Cascade — one failure propagating. Built for the Iberia piece: a row of
   healthy cells going dark left to right, which is what a cascading grid
   failure actually looks like as a sequence. */
function figCascade(e, W, H) {
  const cols = 9, rows = 5, total = cols * rows;
  const cw = W / cols, ch = H / rows;
  let out = '';
  for (let i = 0; i < total; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    const dark = c + r * 0.6 > 3.2;           // the wavefront
    out += `<rect class="f-cell ${dark ? 'f-dark' : 'f-live'}" x="${(c * cw).toFixed(1)}" y="${(r * ch).toFixed(1)}" width="${(cw - 10).toFixed(1)}" height="${(ch - 10).toFixed(1)}" style="--d:${Math.round((c + r * 0.6) * 55)}ms"/>`;
  }
  return out;
}

function figure(e, variant = 'hero') {
  const [W, H] = FIG_SIZE[variant] || FIG_SIZE.hero;
  const body =
    e.fig === 'ratio' ? figRatio(e, W, H)
    : e.fig === 'grid' ? figGrid(e, W, H)
    : e.fig === 'stack' ? figStack(e, W, H)
    : e.fig === 'cascade' ? figCascade(e, W, H)
    : figPlates(e, W, H);
  return `<svg class="fig fig-${e.fig} fig-${variant}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${htmlEscape(e.title)}">${body}</svg>`;
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
.wrap{width:min(100% - 3rem, 76rem);margin:0 auto;padding:0 0 7rem}
.measure{max-width:var(--measure)}

/* masthead */
header.mast{border-bottom:1px solid var(--rule);margin-bottom:3.5rem}
.mast-in{width:min(100% - 3rem, 76rem);margin:0 auto;padding:1.6rem 0;
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
   LAYOUT SYSTEM — 12 columns, alternating modules
   The grid is planned first and everything aligns to it. Module
   rhythm carries hierarchy: lead, split, mirrored split, dense.
   ============================================================ */
.canvas{display:grid;grid-template-columns:repeat(12,1fr);
  column-gap:2rem;row-gap:0;align-items:start}
.mod{grid-column:1 / -1;display:grid;grid-template-columns:subgrid;
  padding:3rem 0;border-top:1px solid var(--rule);position:relative}
.mod > .figwrap{grid-column:1 / -1}
.mod > .modtext{grid-column:1 / -1}

/* lead — full bleed, poster scale */
.mod-lead{border-top:2px solid var(--teal);padding-top:2.4rem}
.mod-lead h2{font-size:clamp(2.2rem,1.3rem+3.4vw,3.6rem);letter-spacing:-.042em;
  line-height:1.0;max-width:18ch}
.mod-lead .figwrap{margin-bottom:2rem}
.mod-lead .fig{padding:3rem 3.2rem}

/* split — figure left, text right */
@media (min-width:60rem){
  .mod-a > .figwrap{grid-column:1 / 8}
  .mod-a > .modtext{grid-column:8 / -1}
  .mod-b > .figwrap{grid-column:6 / -1;order:2}
  .mod-b > .modtext{grid-column:1 / 6;order:1}
  .mod-lead > .figwrap{grid-column:1 / -1}
  .mod-lead > .modtext{grid-column:1 / 9}
}
.mod-a .figwrap,.mod-b .figwrap{margin:0}
.mod-a h2,.mod-b h2{font-size:clamp(1.3rem,1.05rem+.9vw,1.7rem);max-width:22ch}
.mod-a .fig,.mod-b .fig{padding:1.8rem 2rem}
.mod-lead .figwrap{aspect-ratio:12/5}
.mod-a .figwrap,.mod-b .figwrap{aspect-ratio:5/4}
.figwrap{display:flex;align-items:center}
.fig{margin:auto}
.modtext p{max-width:46ch}

/* dense — the news register, deliberately different in texture */
.dense{grid-column:1 / -1;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));
  gap:0 2rem;margin-top:1.2rem}
.dense article{padding:1.1rem 0;border-top:1px solid var(--rule)}
.dense h3{font-size:.98rem;line-height:1.28;font-weight:700;letter-spacing:-.015em;
  margin:.3rem 0 .35rem}
.dense h3 a{color:var(--ink);text-decoration:none}
.dense h3 a:hover{color:var(--teal)}
.dense .meta{font-size:.7rem;margin:0 0 .1rem}
.dense p{font-size:.8rem;color:var(--muted);margin:0;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dense .tag{font-size:.58rem;padding:.1rem .38rem}

/* section head spans the full canvas */
.sechead{grid-column:1 / -1;margin-top:4rem;padding-top:2.6rem;
  border-top:3px solid var(--amber)}
.sechead h2{font-size:clamp(1.7rem,1.2rem+1.6vw,2.4rem)}

/* ============================================================
   FIGURES — the built graphic that leads every story
   ============================================================ */
.figwrap{display:block;margin:0 0 1.6rem;background:var(--ground-2);
  border:1px solid var(--rule);overflow:hidden;position:relative}
.figwrap::after{content:"";position:absolute;inset:auto 0 0 0;height:3px;
  background:var(--teal);transform:scaleX(0);transform-origin:left;
  transition:transform var(--dur-view) var(--ease-out) 120ms}
.entry.in .figwrap::after,.figwrap.in::after{transform:scaleX(1)}
.fig{display:block;width:100%;height:auto;padding:2.2rem 2.4rem}
.f-num{font:900 76px/1 'Roboto',Helvetica,Arial,sans-serif;letter-spacing:-.04em}
.f-lab{font:700 22px/1 'Roboto',Helvetica,Arial,sans-serif;letter-spacing:.02em}
.f-t{fill:var(--teal)} .f-a{fill:var(--amber)}
.f-teal{fill:var(--teal)} .f-amber{fill:var(--amber)}

.f-bar{transform:scaleX(0);transform-origin:left center;
  transition:transform var(--dur-set) var(--ease-out);transition-delay:var(--d,0ms)}
.entry.in .f-bar,.fig.in .f-bar{transform:scaleX(1)}

.f-cell{transition:opacity var(--dur-comp) var(--ease-out);transition-delay:var(--d,0ms);opacity:0}
.entry.in .f-cell,.fig.in .f-cell{opacity:1}
.f-live{fill:var(--teal)} .f-dark{fill:rgba(19,184,167,.10);stroke:rgba(19,184,167,.28);stroke-width:1.5}
.f-on{fill:var(--amber)} .f-off{fill:rgba(19,184,167,.22);stroke:rgba(19,184,167,.5);stroke-width:1.5}

.f-plate{opacity:0}
.f-p1{fill:var(--teal)} .f-p2{fill:var(--amber)} .f-p3{fill:#fff}
.entry.in .f-p1,.fig.in .f-p1{opacity:.34;animation:pl1 var(--dur-set) var(--ease-out) both}
.entry.in .f-p2,.fig.in .f-p2{opacity:.30;animation:pl2 var(--dur-set) var(--ease-out) both}
.entry.in .f-p3,.fig.in .f-p3{opacity:.92;animation:pl3 var(--dur-set) var(--ease-out) both}
@keyframes pl1{from{transform:translate(-46px,26px);opacity:.9}to{transform:none;opacity:.34}}
@keyframes pl2{from{transform:translate(44px,-28px);opacity:.9}to{transform:none;opacity:.30}}
@keyframes pl3{from{transform:translate(10px,8px);opacity:0}to{transform:none;opacity:.92}}

@media (prefers-reduced-motion:reduce){
  .f-bar{transform:scaleX(1);transition:none}
  .f-cell{opacity:1;transition:none}
  .f-plate{animation:none} .f-p1{opacity:.34}.f-p2{opacity:.30}.f-p3{opacity:.92}
  .figwrap::after{transform:scaleX(1);transition:none}
}

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
  <p class="lede measure" style="margin-top:1.6rem">${noWidow(htmlEscape(SITE.description))}</p>
  <p class="meta" style="margin-top:1.2rem"><a href="${SITE.homepage}">forgepower.ai</a></p>
</section>

<div class="canvas">
${entries
  .map((e, i) => {
    // Module rhythm: lead, then alternating split and mirrored split.
    const mod = i === 0 ? 'mod-lead' : i % 2 === 1 ? 'mod-a' : 'mod-b';
    const variant = i === 0 ? 'hero' : 'split';
    return `<article class="mod ${mod} entry reveal" data-i="${i}">
  <a class="figwrap" href="${htmlEscape(e.link)}"${e.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${figure(e, variant)}</a>
  <div class="modtext">
    <p class="meta"><time datetime="${e.date.toISOString()}">${human(e.date)}</time>
    ${e.featured ? '<span class="tag tag-f">Featured</span>' : ''}
    ${e.external ? '<span class="tag tag-x">LinkedIn</span>' : ''}</p>
    <h2><a href="${htmlEscape(e.link)}"${e.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${noWidow(htmlEscape(e.title), 2)}</a></h2>
    <p>${noWidow(htmlEscape(e.description))}</p>
  </div>
</article>`;
  })
  .join('\n')}
${
  news.length
    ? `<div class="sechead reveal" data-i="0">
  <h2>Energy &amp; Frontier Tech</h2>
  <p class="section-note measure">Headlines we're tracking across energy, micro-grids, edge
  compute, data centers, quantum, geothermal, nuclear and next-generation fuels. Every item
  links to its original publisher.</p>
</div>
<div class="dense">
${news
  .slice(0, 12)
  .map(
    (n, i) => `  <article class="reveal" data-i="${i % 7}">
    <p class="meta"><time datetime="${n.date}">${human(new Date(n.date))}</time>
    <span class="tag tag-x">${htmlEscape(n.source)}</span></p>
    <h3><a href="${htmlEscape(n.link)}" target="_blank" rel="noopener noreferrer">${noWidow(htmlEscape(n.title), 2)}</a></h3>
    <p>${noWidow(htmlEscape(n.excerpt))}</p>
  </article>`
  )
  .join('\n')}
</div>
<p class="more reveal" data-i="0" style="grid-column:1 / -1"><a href="/news/">All industry news →</a></p>`
    : ''
}
</div>
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
<p class="meta" style="margin-top:1.8rem"><a href="/news.xml">Subscribe to this feed</a></p>
<hr style="border:0;border-top:1px solid var(--rule);margin:2.6rem 0 0">
<div class="dense">${news
  .map(
    (n, i) => `  <article class="reveal" data-i="${i % 7}">
    <p class="meta"><time datetime="${n.date}">${human(new Date(n.date))}</time>
    <span class="tag tag-x">${htmlEscape(n.source)}</span></p>
    <h3><a href="${htmlEscape(n.link)}" target="_blank" rel="noopener noreferrer">${noWidow(htmlEscape(n.title), 2)}</a></h3>
    <p>${noWidow(htmlEscape(n.excerpt))}</p>
  </article>`
  )
  .join('\n')}</div>
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
<h1 class="measure">${noWidow(htmlEscape(e.title), 2)}</h1>
<div class="figwrap in" style="margin-top:1.8rem">${figure(e, 'hero')}</div>
<p class="lede measure" style="margin-top:1.8rem">${noWidow(htmlEscape(e.description))}</p>
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
