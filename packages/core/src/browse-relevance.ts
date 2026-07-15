/**
 * Zero-token relevance + recency scoring for the browse loop. All pure functions — no model calls.
 */

const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'this', 'that', 'with', 'from', 'what', 'how', 'why',
  'who', 'when', 'has', 'have', 'had', 'its', 'about', 'into', 'over', 'than', 'then', 'they', 'them',
]);

/** Tokenize, keeping version-like numbers (e.g. "4.8") intact — those are often the key discriminator. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of s.toLowerCase().matchAll(/\d+\.\d+|[a-z][a-z0-9]+/g)) {
    const w = m[0];
    if (w.length > 2 && !STOP.has(w)) out.push(w);
  }
  return out;
}

/**
 * BM25-ish single-document relevance. No corpus → flat IDF, so this rewards covering many DISTINCT
 * query terms with TF saturation (repeats give diminishing returns). Normalized to ~[0,1] by query
 * size so a threshold is comparable across queries. Title hits are boosted.
 */
export function bm25ish(queryTerms: string[], docText: string, titleText = ''): number {
  const k1 = 1.5;
  const docTokens = tokenize(docText);
  if (docTokens.length === 0 || queryTerms.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
  const titleSet = new Set(tokenize(titleText));
  const qset = [...new Set(queryTerms)];
  let score = 0;
  for (const q of qset) {
    const f = tf.get(q) || 0;
    if (f === 0) continue;
    let s = (f * (k1 + 1)) / (f + k1);   // saturating TF, max → (k1+1)
    if (titleSet.has(q)) s *= 1.5;
    score += s;
  }
  return score / (qset.length * (k1 + 1)); // normalize: all-terms-saturated ≈ 1.0
}

/**
 * Zero-token evidence extraction: split prose into sentences and return the top-k most query-relevant
 * ones (BM25-ish per sentence). These are the sentences that actually answer the query — feeding them to
 * the calling model turns a page of prose into one-step, citable synthesis.
 */
export function keyPassages(prose: string, queryTerms: string[], k = 2): string[] {
  // Split on sentence boundaries; keep reasonably-sized sentences.
  const sentences = prose
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 320);
  if (!sentences.length) return [];
  const scored = sentences
    .map((s) => ({ s, score: bm25ish(queryTerms, s) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { s } of scored) {
    const norm = s.toLowerCase().slice(0, 60);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(s);
    if (out.length >= k) break;
  }
  return out;
}

/**
 * Zero-token query-breadth classifier. 'broad' queries ("top world news today", "what's happening")
 * have no single deep branch to follow — a research TREE prunes hard and returns homepages, so they
 * should route to a NEWS SWEEP instead. 'specific' multi-hop questions ("what caused the Colorado
 * fires", "how does RISC-V compare to ARM") are exactly what the tree is for.
 */
const BROAD_MARKERS = /\b(news|today|latest|happening|headlines|current events|updates?|recent|whats? (going on|new|happening)|this week|right now|breaking|top stories|world|around the world)\b/i;
const SPECIFIC_MARKERS = /\b(why|how|caused?|because|compared?|vs\.?|versus|difference|explain|reason|impact of|effect of|history of|who is|when did)\b/i;

export function classifyQuery(query: string): 'broad' | 'specific' {
  const q = query.trim();
  const words = q.split(/\s+/);
  let broad = 0, specific = 0;
  if (BROAD_MARKERS.test(q)) broad += 2;
  if (SPECIFIC_MARKERS.test(q)) specific += 2;
  // Named/specific entities: capitalized mid-sentence words, years, versioned terms → specific.
  if (/\b(19|20)\d\d\b/.test(q)) specific += 1;
  if ((q.match(/[A-Z][a-z]{2,}/g) || []).length >= 2) specific += 1;
  if (/\d+\.\d+|v\d|[A-Z]{2,}\d/.test(q)) specific += 1; // version/model numbers
  // A short, generic query with no specifics leans broad.
  if (words.length <= 5 && specific === 0) broad += 1;
  if (words.length >= 8) specific += 1;                   // long phrasing → a specific question
  return broad > specific ? 'broad' : 'specific';
}

export function ageInDays(publishDate?: string): number | null {
  if (!publishDate) return null;
  const t = Date.parse(publishDate);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

/** Exponential recency weight in [0,1]. Unknown date → neutral 0.5 (don't punish evergreen by default). */
export function recencyScore(days: number | null, halfLifeDays = 30): number {
  if (days == null) return 0.5;
  if (days <= 0) return 1;
  return Math.pow(0.5, days / halfLifeDays);
}

const NAV_RE = /\/(login|sign-?in|sign-?up|about|contact|privacy|terms|category|categories|tag|tags|author|search|advertise|subscribe|account|cart|pricing)(\/|$|\?)|^https?:\/\/[^/]+\/?$/i;
// Match the aggregator host whether it appears as an apex domain (after `//` or `/`) or a subdomain (after `.`).
const AGG_RE = /(^|[./])(google|bing|duckduckgo|youtube|reddit|facebook|twitter|x|linkedin|instagram|pinterest)\.[a-z]/i;
// Low-VALUE links that share the topic's keywords but aren't real content: wiki meta namespaces
// (Talk:/Special:/Category:/Help:/Template:/File:/Portal:), PR/newsroom/investor pages, and raw
// financial-report CDNs/PDFs. These cost a fetch and add noise — the SVB trace followed a Talk: page
// and a "Newsroom" PR page, and wasted fetches on Special:WhatLinksHere + q4cdn earnings PDFs.
const LOW_VALUE_RE = /\/wiki\/(talk|special|category|help|template|file|portal|wikipedia|user):|\/(newsroom|press-?kit|media-?kit|investor-relations|press-releases?\/?$)|q4cdn\.com|\/(feed|rss|amp)(\/|$)|\.pdf($|\?)/i;

/** Link-follow score: heuristic URL signals + BM25-ish relevance of the anchor text to the query. */
export function scoreLink(href: string, text: string, terms: string[]): number {
  let path = '';
  try { path = new URL(href).pathname.toLowerCase(); } catch { return -100; }
  let s = bm25ish(terms, text) * 4; // anchor-text relevance, weighted
  for (const w of terms) { if (path.includes(w)) s += 1; }
  if (/\/20\d\d\//.test(path)) s += 2;                       // dated URL → likely an article
  if ((path.match(/-/g) || []).length >= 2) s += 1;          // slug
  if (path.split('/').filter(Boolean).length >= 2) s += 1;   // deep path
  if (NAV_RE.test(href)) s -= 6;
  if (AGG_RE.test(href)) s -= 8;
  if (LOW_VALUE_RE.test(href)) s -= 7;                       // wiki meta / PR / earnings PDFs → skip
  return s;
}

/** Strip markdown-link SYNTAX but KEEP the link text, so prose/evidence reads cleanly (deleting the whole
 * `[text](url)` leaves broken ", ," gaps — the SVB evidence had exactly that). Also drops leftover images. */
export function stripMarkdownLinks(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // images → gone
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // [text](url) → text
    .replace(/\\?\[+\s*\d+\s*\\?\]+/g, '')          // wiki citation markers [15], [[15]], [\[15\] → gone
    .replace(/\s+([,.;:])/g, '$1')                  // tidy space-before-punctuation left by removals
    .replace(/\s+/g, ' ')
    .trim();
}

export { NAV_RE, AGG_RE };
