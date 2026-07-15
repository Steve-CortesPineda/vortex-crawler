import { bm25ish, scoreLink, tokenize, ageInDays, keyPassages, stripMarkdownLinks, NAV_RE, AGG_RE } from './browse-relevance.js';
import { PriorityURLQueue } from './pipeline/queue.js';

/**
 * treeBrowse — a PARALLEL, relevance-gated research tree.
 *
 * Where browse() walks one page at a time, treeBrowse expands the frontier in LEVELS: each level fetches
 * up to `poolWidth` pages CONCURRENTLY (via the extension tab pool / cookie-fetch tier), scores each for
 * relevance, and then decides per-node whether to DIVE DEEPER. A strongly-relevant node expands its
 * best-scored children into the next level; a weak or off-topic node is kept-but-pruned (not expanded).
 * So relevant branches go deep and dead ends stop — an adaptive tree, not a fixed-depth crawl.
 *
 * The fetcher only needs a parallel extract that returns links (the ExtensionBrowser satisfies this).
 * Seeds come from a caller-supplied search (so google-session fusion feeds the tree's roots).
 */

export interface TreeFetchResult {
  url: string; title: string; markdown: string; publishDate?: string;
  links?: { href: string; text: string }[];
}
export interface TreeFetcher {
  parallelExtract(urls: string[], opts?: { settleMs?: number; concurrency?: number }): Promise<TreeFetchResult[]>;
}

export interface TreeNode {
  url: string; title: string; depth: number; relevance: number;
  publishDate?: string; snippet: string;
  keyPassages: string[];          // the most query-relevant sentences from this page (for citation)
  parentUrl?: string;
  expanded: boolean;
  reason: string;                 // why this node was expanded or pruned
  children: string[];             // child urls enqueued from this node
}

/** A citable piece of evidence: a key sentence with its source. The calling model synthesizes from these. */
export interface Evidence { text: string; url: string; title: string; relevance: number; }

export interface TreeBrowseResult {
  query: string;
  nodesVisited: number;
  maxDepthReached: number;
  ms: number;
  nodes: TreeNode[];
  /** Top query-relevant sentences across ALL nodes, each with its source — ready for a one-step cited answer. */
  evidence: Evidence[];
  pruned: string[];               // url (reason) for anything dropped before becoming a node
}

export interface TreeBrowseOptions {
  seeds?: string[];               // explicit root URLs
  seedSearch?: (query: string) => Promise<{ url: string }[]>;  // or a search fn to seed roots
  maxSeeds?: number;              // roots taken from search. Default 4.
  poolWidth?: number;             // pages fetched concurrently per level. Default 6.
  maxPages?: number;              // total nodes visited (budget). Default 20.
  maxDepth?: number;              // deepest level. Default 3.
  perDomain?: number;             // max pages per domain. Default 3.
  perPageLinks?: number;          // children enqueued from an expanded node. Default 4.
  minRelevance?: number;          // below this, a fetched page is pruned as off-topic. Default 0.15.
  expandThreshold?: number;       // at/above this, a node DIVES DEEPER (expands children). Default 0.30.
  charCap?: number;               // snippet length. Default 500.
  maxAgeDays?: number;            // optional recency gate (soft: down-weight; undated kept).
  settleMs?: number;              // per-page render settle cap. Default 2500.
}

function domainOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}
function proseOf(markdown: string): string {
  return stripMarkdownLinks(markdown); // keep link TEXT so evidence sentences read cleanly (no ", ," gaps)
}
/** Pull up to `n` items off the priority queue (highest-priority first) as plain objects. */
function drainFrontier(frontier: PriorityURLQueue, n: number): { url: string; depth: number; parentUrl?: string }[] {
  const out: { url: string; depth: number; parentUrl?: string }[] = [];
  while (out.length < n && frontier.size) {
    const it = frontier.dequeue()!;
    out.push({ url: it.url, depth: it.depth, parentUrl: it.parentUrl });
  }
  return out;
}

export async function treeBrowse(fetcher: TreeFetcher, query: string, opts: TreeBrowseOptions = {}): Promise<TreeBrowseResult> {
  const start = performance.now();
  const maxSeeds = opts.maxSeeds ?? 4;
  const poolWidth = opts.poolWidth ?? 6;
  const maxPages = opts.maxPages ?? 20;
  const maxDepth = opts.maxDepth ?? 3;
  const perDomain = opts.perDomain ?? 3;
  const perPageLinks = opts.perPageLinks ?? 4;
  const minRelevance = opts.minRelevance ?? 0.15;
  const expandThreshold = opts.expandThreshold ?? 0.30;
  const charCap = opts.charCap ?? 500;
  const settleMs = opts.settleMs ?? 2500;
  const terms = tokenize(query);

  const frontier = new PriorityURLQueue();
  const pruned: string[] = [];
  const nodes: TreeNode[] = [];
  const domainCount = new Map<string, number>();
  let maxDepthReached = 0;

  // ── Seed the roots ──────────────────────────────────────────────────────
  for (const u of opts.seeds ?? []) { if (domainOf(u)) frontier.enqueue({ url: u, depth: 0, priority: 3 }); }
  if (opts.seedSearch) {
    let added = 0;
    try {
      const res = await opts.seedSearch(query);
      for (const r of res) {
        if (added >= maxSeeds) break;
        if (AGG_RE.test(r.url)) { pruned.push(`${r.url} (seed: aggregator)`); continue; }
        if (NAV_RE.test(r.url) && !/^https?:\/\/[^/]+\/?$/i.test(r.url)) { pruned.push(`${r.url} (seed: nav)`); continue; }
        if (frontier.enqueue({ url: r.url, depth: 0, priority: 2 - added * 0.1 })) added++;
      }
    } catch (e) { pruned.push(`seed search failed: ${(e as Error)?.message?.slice(0, 60)}`); }
  }

  // ── Level-synchronous BFS with parallel fetch per level ─────────────────
  // Domain-capped items carry OVER to the next wave in a local list — we can't re-enqueue them (the
  // PriorityURLQueue's `seen` set rejects any URL it already dequeued, which silently dropped them before).
  type QItem = { url: string; depth: number; parentUrl?: string };
  let carryOver: QItem[] = [];
  while ((frontier.size || carryOver.length) && nodes.length < maxPages) {
    const wave: QItem[] = [];
    const stillCapped: QItem[] = [];
    // Pull from the carry-over first (highest-priority deferrals), then the frontier.
    const source: QItem[] = [...carryOver, ...drainFrontier(frontier, poolWidth * 2)];
    carryOver = [];
    for (const item of source) {
      if (wave.length >= poolWidth) { stillCapped.push(item); continue; }
      const dom = domainOf(item.url);
      if (!dom) continue;
      const inWave = wave.filter((w) => domainOf(w.url) === dom).length;
      if ((domainCount.get(dom) || 0) + inWave >= perDomain) { stillCapped.push(item); continue; }
      wave.push(item);
    }
    carryOver = stillCapped; // keep the capped ones for the next wave (no data loss)
    if (!wave.length) break;

    // Fetch the whole wave CONCURRENTLY (cookie-fetch-first inside the fetcher).
    const results = await fetcher.parallelExtract(wave.map((w) => w.url), { settleMs, concurrency: poolWidth });

    for (let i = 0; i < wave.length; i++) {
      if (nodes.length >= maxPages) break;
      const w = wave[i];
      const ex = results[i];
      const dom = domainOf(w.url)!;
      const prose = proseOf(ex?.markdown || '');
      if (prose.length < 200) { pruned.push(`${w.url} (thin/${prose.length}c)`); continue; }

      const relevance = bm25ish(terms, prose.slice(0, 4000), ex.title || '');
      if (relevance < minRelevance) { pruned.push(`${w.url} (off-topic rel=${relevance.toFixed(2)})`); continue; }

      domainCount.set(dom, (domainCount.get(dom) || 0) + 1);
      maxDepthReached = Math.max(maxDepthReached, w.depth);
      const days = ageInDays(ex.publishDate);
      const stale = opts.maxAgeDays != null && days != null && days > opts.maxAgeDays;

      const node: TreeNode = {
        url: w.url, title: ex.title || '', depth: w.depth, relevance: Number(relevance.toFixed(3)),
        publishDate: ex.publishDate, snippet: prose.slice(0, charCap),
        keyPassages: keyPassages(prose.slice(0, 8000), terms, 2),   // best sentences from the fuller prose
        parentUrl: w.parentUrl, expanded: false, reason: '', children: [],
      };

      // ── The "dive deep if necessary" decision ──────────────────────────
      if (w.depth >= maxDepth) { node.reason = `kept — at max depth ${maxDepth}`; }
      else if (nodes.length >= maxPages) { node.reason = 'kept — budget reached'; }
      else if (relevance < expandThreshold) { node.reason = `kept — relevance ${relevance.toFixed(2)} < expand ${expandThreshold} (not deep enough to warrant diving)`; }
      else {
        // Strongly relevant → expand: score children, enqueue the best.
        const links = (ex.links || []).filter((l) => domainOf(l.href) && !frontier.has(l.href));
        const ranked = links
          .map((l) => ({ ...l, s: scoreLink(l.href, l.text, terms) * (stale ? 0.5 : 1) }))
          .filter((l) => l.s > 0)
          .sort((a, c) => c.s - a.s)
          .slice(0, perPageLinks);
        for (const l of ranked) {
          if (frontier.enqueue({ url: l.href, depth: w.depth + 1, priority: l.s, parentUrl: w.url })) node.children.push(l.href);
        }
        node.expanded = node.children.length > 0;
        node.reason = node.expanded
          ? `expanded — relevance ${relevance.toFixed(2)} ≥ ${expandThreshold}, dove into ${node.children.length} link(s)`
          : `kept — relevant but no strong outbound links to follow`;
      }
      nodes.push(node);
    }
  }

  // Aggregate the strongest sentences across all nodes into a citable evidence list (best nodes first).
  const evidence: Evidence[] = [];
  const seenEv = new Set<string>();
  for (const n of [...nodes].sort((a, b) => b.relevance - a.relevance)) {
    for (const p of n.keyPassages) {
      const key = p.toLowerCase().slice(0, 50);
      if (seenEv.has(key)) continue;
      seenEv.add(key);
      evidence.push({ text: p, url: n.url, title: n.title, relevance: n.relevance });
      if (evidence.length >= 12) break;
    }
    if (evidence.length >= 12) break;
  }

  return {
    query, nodesVisited: nodes.length, maxDepthReached,
    ms: Math.round(performance.now() - start), nodes, evidence, pruned,
  };
}
