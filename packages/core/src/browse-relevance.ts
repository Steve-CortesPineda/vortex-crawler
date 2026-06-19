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
  return s;
}

export { NAV_RE, AGG_RE };
