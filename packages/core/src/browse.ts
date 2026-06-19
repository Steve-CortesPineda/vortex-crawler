import { AgentBrowser, type ExtractResult } from './agent-browser.js';
import { search } from './search.js';
import { PriorityURLQueue } from './pipeline/queue.js';
import { GenericCache } from './cache/result-cache.js';
import { bm25ish, scoreLink, tokenize, ageInDays, NAV_RE, AGG_RE } from './browse-relevance.js';

/**
 * Autonomous multi-hop browse/research loop.
 *
 * Seeds from multi-engine search (capped), navigates INTO real source articles, and uses a
 * ZERO-TOKEN heuristic to score outbound links — then FOLLOWS the best ones via a priority queue,
 * so depth-1+ pages actually get visited (seeds no longer eat the whole budget). A relevance gate
 * kills topic drift; a recency gate handles staleness. Extracts are cached across hops/calls.
 * Optional LLM link-ranking is off by default and supplied as a callback (core imports no model SDK).
 */

export interface BrowseHop {
  url: string;
  title: string;
  depth: number;
  relevance: number;
  publishDate?: string;
  dated: string[];
  snippet: string;
}

export interface BrowseResult {
  query: string;
  pagesVisited: number;
  maxDepthReached: number;
  ms: number;
  story: BrowseHop[];
  skipped: string[];
}

export type RankLinks = (query: string, candidates: { href: string; text: string }[]) => Promise<string[]>;

export interface BrowseOptions {
  maxPages?: number;      // total pages visited (time/token bound). Default 6.
  maxSeeds?: number;      // seeds allowed into the frontier — the rest of the budget is for FOLLOWED links. Default 3.
  maxDepth?: number;      // how deep to follow links. Default 2.
  perPageLinks?: number;  // links enqueued per page. Default 3.
  perDomain?: number;     // max pages per domain. Default 2.
  charCap?: number;       // snippet length. Default 600.
  minRelevance?: number;  // page relevance gate (0..1). Default 0.18.
  maxAgeDays?: number;    // recency gate; undated pages are kept regardless.
  recencyMode?: 'soft' | 'hard'; // soft = down-weight stale links; hard = drop stale pages. Default 'soft'.
  useLLMRanker?: boolean;
  rankLinks?: RankLinks;
  maxLLMCalls?: number;   // cap ranker calls per browse(). Default 4.
  cache?: GenericCache<ExtractResult>;
}

const DATE_RE = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d\d|\b\d+\s+(hours?|days?|minutes?)\s+ago\b|20\d\d-\d\d-\d\d/i;

function normKey(url: string): string {
  try { const u = new URL(url); return (u.origin + u.pathname).replace(/\/+$/, ''); } catch { return url; }
}
function domainOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

export async function browse(b: AgentBrowser, query: string, opts: BrowseOptions = {}): Promise<BrowseResult> {
  const start = performance.now();
  const maxPages = opts.maxPages ?? 6;
  const maxSeeds = opts.maxSeeds ?? 3;
  const maxDepth = opts.maxDepth ?? 2;
  const perPageLinks = opts.perPageLinks ?? 3;
  const perDomain = opts.perDomain ?? 2;
  const charCap = opts.charCap ?? 600;
  const minRelevance = opts.minRelevance ?? 0.18;
  const recencyMode = opts.recencyMode ?? 'soft';
  const maxLLMCalls = opts.maxLLMCalls ?? 4;
  const cache = opts.cache ?? new GenericCache<ExtractResult>();
  const terms = tokenize(query);

  const frontier = new PriorityURLQueue();
  const skipped: string[] = [];

  // Seed — capped. Higher base priority for earlier search ranks, but a strong FOLLOWED link can still
  // outrank a weak seed; combined with the seed cap, this forces real depth into the budget.
  const seed = await search(query, { maxResults: 10 });
  let seedsAdded = 0;
  for (const r of seed.results) {
    if (seedsAdded >= maxSeeds) break;
    if (AGG_RE.test(r.url) || NAV_RE.test(r.url)) { skipped.push(`${r.url} (seed: homepage/aggregator)`); continue; }
    if (frontier.enqueue({ url: r.url, depth: 0, priority: 2 - seedsAdded * 0.1 })) seedsAdded++;
  }

  const domainCount = new Map<string, number>();
  const story: BrowseHop[] = [];
  let maxDepthReached = 0;
  let llmCalls = 0;

  await b.open();
  while (frontier.size && story.length < maxPages) {
    const item = frontier.dequeue()!;
    const { url, depth } = item;
    const dom = domainOf(url);
    if (!dom) continue;
    if ((domainCount.get(dom) || 0) >= perDomain) { skipped.push(`${url} (domain cap)`); continue; }

    try {
      // Extract (cached by normalized URL).
      let ex = cache.get(normKey(url));
      if (!ex) { await b.goto(url); ex = await b.extract(); cache.set(normKey(url), ex); }

      if (ex.captchaDetected) { skipped.push(`${url} (captcha — human needed)`); continue; }
      const prose = ex.markdown.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
      if (prose.length < 200) { skipped.push(`${url} (thin/${prose.length}c)`); continue; }

      // Relevance gate — kills topic drift (off-subject pages).
      const relevance = bm25ish(terms, prose.slice(0, 4000), ex.title);
      if (relevance < minRelevance) { skipped.push(`${url} (off-topic rel=${relevance.toFixed(2)})`); continue; }

      // Recency gate.
      const days = ageInDays(ex.publishDate);
      if (opts.maxAgeDays != null && days != null && days > opts.maxAgeDays) {
        if (recencyMode === 'hard') { skipped.push(`${url} (stale ${Math.round(days)}d)`); continue; }
      }

      domainCount.set(dom, (domainCount.get(dom) || 0) + 1);
      maxDepthReached = Math.max(maxDepthReached, depth);
      story.push({
        url, title: ex.title, depth, relevance: Number(relevance.toFixed(3)),
        publishDate: ex.publishDate,
        dated: (ex.markdown.match(new RegExp(DATE_RE, 'gi')) || []).slice(0, 5),
        snippet: prose.slice(0, charCap),
      });

      // Follow links — only if we can still use them and aren't at max depth.
      if (depth < maxDepth && story.length < maxPages) {
        const links = (await b.links()).filter((l) => !frontier.has(l.href) && domainOf(l.href));
        let ranked = links
          .map((l) => ({ ...l, s: scoreLink(l.href, l.text, terms) }))
          .filter((l) => l.s > 0)
          .sort((a, c) => c.s - a.s);

        // Optional LLM re-rank of the top candidates (gated + bounded).
        if (opts.useLLMRanker && opts.rankLinks && llmCalls < maxLLMCalls && ranked.length) {
          try {
            llmCalls++;
            const order = await opts.rankLinks(query, ranked.slice(0, perPageLinks * 2).map((l) => ({ href: l.href, text: l.text })));
            const rank = new Map(order.map((h, i) => [h, i]));
            ranked = ranked.slice().sort((a, c) => (rank.get(a.href) ?? 99) - (rank.get(c.href) ?? 99));
          } catch { /* fall back to heuristic order */ }
        }

        // Down-weight links from a stale page in soft recency mode.
        const recencyPenalty = (opts.maxAgeDays != null && days != null && days > opts.maxAgeDays) ? 0.5 : 1;
        for (const l of ranked.slice(0, perPageLinks)) {
          frontier.enqueue({ url: l.href, depth: depth + 1, priority: l.s * recencyPenalty, parentUrl: url });
        }
      }
    } catch (e: any) {
      skipped.push(`${url} (FAIL: ${(e?.message || 'error').slice(0, 50)})`);
    }
  }

  return {
    query, pagesVisited: story.length, maxDepthReached,
    ms: Math.round(performance.now() - start), story, skipped,
  };
}
