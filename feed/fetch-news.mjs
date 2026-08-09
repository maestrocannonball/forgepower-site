#!/usr/bin/env node
/**
 * Forge Power — industry news aggregator
 *
 * Fetches every source in sources.json, keeps on-topic items, and writes
 * news.json. Run on a schedule by .github/workflows/news.yml; the result is
 * committed so the site build never depends on the network.
 *
 * Copyright posture: we store headline, a short excerpt, the source name and
 * the original link. Never full article text. Every item links back to the
 * publisher.
 *
 * Zero dependencies, by design.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8'));
const OUT_FILE = join(ROOT, 'news.json');

const MAX_ITEMS = 60; // total kept
const MAX_PER_SOURCE = 5; // stops one prolific source dominating
const MAX_PER_FILTER_SOURCE = 3; // general-interest sources get less room
const MAX_AGE_DAYS = 30;
const TIMEOUT_MS = 20000;

/**
 * General-interest sources must clear a real bar, not a single stray keyword.
 * Without this, "nuclear" matched an Air Force story about blast-flash goggles
 * and "gigawatt" pulled in a SpaceX funding piece.
 */
const FILTER_MIN_SCORE = 6;

/* ---------- minimal XML field extraction ---------- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”',
  '#8211': '–', '#8212': '—', '#160': ' ',
};

function decode(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z0-9#]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
}

const stripTags = (s = '') => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function field(block, names) {
  for (const name of names) {
    // CDATA form
    let m = block.match(new RegExp(`<${name}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i'));
    if (m) return decode(m[1]).trim();
    // plain form
    m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (m) return decode(stripTags(m[1])).trim();
  }
  return '';
}

/** Atom links live in an attribute, not a text node. */
function atomLink(block) {
  const m =
    block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
    block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return m ? decode(m[1]).trim() : '';
}

function parseFeed(xml) {
  const blocks = [
    ...(xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []),
    ...(xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []),
  ];
  return blocks.map((b) => {
    const link = field(b, ['link']) || atomLink(b);
    const dateRaw = field(b, ['pubDate', 'published', 'updated', 'dc:date']);
    const d = dateRaw ? new Date(dateRaw) : null;
    return {
      title: field(b, ['title']),
      link,
      date: d && !Number.isNaN(d.valueOf()) ? d : null,
      summary: field(b, ['description', 'summary', 'content:encoded', 'content']),
    };
  });
}

/* ---------- fetching ---------- */

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'User-Agent': 'ForgePowerFeedBot/1.0 (+https://feed.forgepower.ai)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- scoring ---------- */

const TOPICS = Object.entries(CONFIG.topics);
const EXCLUDE = CONFIG.exclude.map((s) => s.toLowerCase());

function score(item) {
  const title = item.title.toLowerCase();
  const hay = `${item.title} ${item.summary}`.toLowerCase();
  if (EXCLUDE.some((x) => hay.includes(x))) return -1;
  let s = 0;
  let titleHits = 0;
  const matched = [];
  for (const [kw, w] of TOPICS) {
    if (hay.includes(kw)) {
      // A hit in the headline is a much stronger signal than one buried in
      // the summary, so it counts double.
      const inTitle = title.includes(kw);
      if (inTitle) titleHits++;
      s += inTitle ? w * 2 : w;
      matched.push(kw.trim());
    }
  }
  return { score: s, titleHits, matched: matched.slice(0, 4) };
}

const normTitle = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const excerpt = (s, n = 220) => {
  const t = stripTags(s);
  if (t.length <= n) return t;
  return t.slice(0, t.lastIndexOf(' ', n) > 0 ? t.lastIndexOf(' ', n) : n).trim() + '…';
};

/* ---------- main ---------- */

const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
const collected = [];
const report = [];

const results = await Promise.allSettled(
  CONFIG.sources.map(async (src) => {
    const xml = await fetchText(src.url);
    return { src, items: parseFeed(xml) };
  })
);

for (const [i, r] of results.entries()) {
  const src = CONFIG.sources[i];
  if (r.status === 'rejected') {
    report.push(`  FAIL  ${src.name}: ${r.reason?.message || r.reason}`);
    continue;
  }
  const { items } = r.value;
  let kept = 0;

  for (const it of items) {
    if (!it.title || !it.link) continue;
    if (it.date && it.date.valueOf() < cutoff) continue;

    const sc = score(it);
    if (sc === -1) continue;
    // Dedicated sources pass on their own merit. General-interest sources must
    // clear the score bar AND name the topic in the headline.
    if (src.mode === 'filter' && (sc.score < FILTER_MIN_SCORE || sc.titleHits === 0)) continue;

    collected.push({
      title: it.title,
      link: it.link,
      source: src.name,
      topic: src.topic,
      date: (it.date || new Date()).toISOString(),
      excerpt: excerpt(it.summary),
      score: sc.score + (src.mode === 'always' ? 2 : 0),
      matched: sc.matched,
    });
    kept++;
  }
  report.push(`  ok    ${src.name}: ${kept}/${items.length}`);
}

if (!collected.length) {
  console.error('No items collected from any source.');
  console.error(report.join('\n'));
  // Leave the previous news.json in place rather than publishing an empty feed.
  process.exit(existsSync(OUT_FILE) ? 0 : 1);
}

// Dedupe: same URL, or same headline syndicated across outlets.
const seen = new Set();
const unique = [];
for (const it of collected.sort((a, b) => b.score - a.score)) {
  const k1 = it.link.split('?')[0].replace(/\/$/, '');
  const k2 = normTitle(it.title);
  if (seen.has(k1) || seen.has(k2)) continue;
  seen.add(k1);
  seen.add(k2);
  unique.push(it);
}

// Cap per source, then order by recency for presentation.
const modeOf = Object.fromEntries(CONFIG.sources.map((s) => [s.name, s.mode]));
const perSource = {};
const capped = unique.filter((it) => {
  perSource[it.source] = (perSource[it.source] || 0) + 1;
  const cap = modeOf[it.source] === 'filter' ? MAX_PER_FILTER_SOURCE : MAX_PER_SOURCE;
  return perSource[it.source] <= cap;
});

const final = capped
  .sort((a, b) => new Date(b.date) - new Date(a.date))
  .slice(0, MAX_ITEMS);

/*
  Only rewrite the file when the item set actually changed.

  The scheduled workflow commits news.json when `git diff` reports a change. If
  we stamped a fresh timestamp on every run, that diff would never be quiet and
  the job would commit twice a day forever — churning history and triggering
  pointless rebuilds. So `fetchedAt` records when the items last CHANGED, not
  when the fetch last ran.
*/
const payload = { fetchedAt: new Date().toISOString(), count: final.length, items: final };

let unchanged = false;
if (existsSync(OUT_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    unchanged = JSON.stringify(prev.items) === JSON.stringify(final);
  } catch {
    unchanged = false; // unreadable or malformed — rewrite it
  }
}

if (unchanged) {
  console.log(report.join('\n'));
  console.log(`\nItem set unchanged since last run. Leaving news.json untouched.`);
  process.exit(0);
}

writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n');

console.log(report.join('\n'));
console.log(
  `\n${collected.length} collected -> ${unique.length} unique -> ${final.length} published`
);
console.log(
  'Sources represented: ' + [...new Set(final.map((i) => i.source))].length + '/' + CONFIG.sources.length
);
