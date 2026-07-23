import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AgentBrowser } from './agent-browser.js';
import { search, type SearchResult } from './search.js';
import { VortexDaemonClient } from './daemon-client.js';
import { discoverDomain, type DomainKey } from './discover.js';
import { sourceClass, type SourceClass } from './source-rules.js';

/**
 * tracker — a local "oracle": you name entities ONCE (a watchlist) and it tracks them over time,
 * accumulating mentions to a persistent store and reporting only what's NEW each run.
 *
 * Per run it pulls from the multi-source UNION (per-entity targeted search sweeps + domain RSS feeds),
 * matches every item to watched entities by name/alias, dedupes against everything seen before, and
 * stores new mentions. Zero model tokens. This is the foundation of the always-on daemon.
 */

export type EntityType = 'person' | 'org' | 'ticker' | 'topic' | 'channel';

export interface WatchEntity {
  name: string;
  type: EntityType;
  aliases?: string[];
  domains?: DomainKey[];   // which domain feeds to also scan for this entity
}

export interface TrackedMention {
  entity: string;
  title: string;
  url: string;
  source: string;
  date?: string;
  firstSeen: string;
  /** Query-independent class of the source site (gov, wire, ai-lab, official-docs, ...). */
  sourceClass?: string;
  /** 'high' = primary/wire source AND published within the last 7 days — worth an immediate push. */
  priority?: 'high' | 'normal';
}

export interface TrackDigest {
  ranAt: string;
  entities: number;
  newMentions: number;
  byEntity: Record<string, { new: TrackedMention[]; totalKnown: number }>;
}

export interface TrackOptions {
  storePath?: string;
  watchlist?: WatchEntity[];
  useDiscovery?: boolean;   // also merge domain RSS feeds. Default true.
  perEntity?: number;       // search results per entity sweep. Default 6.
  todayUTC?: string;
}

// Store lives under $HOME by default so the always-on daemon survives an unmounted external drive
// (overridable via VORTEX_TRACKER_DIR to point at canonical SSD storage when it's mounted).
const TRACKER_DIR = process.env.VORTEX_TRACKER_DIR || `${process.env.HOME}/.vortex-tracker`;
const DEFAULT_STORE = `${TRACKER_DIR}/store.json`;

// Cap store growth: drop mentions older than this on each save (the daemon runs every few hours,
// so the store would otherwise grow without bound and re-scan O(n) on every run).
const PRUNE_DAYS = Number(process.env.VORTEX_TRACKER_PRUNE_DAYS || 90);

// Seeded from Steve's interests — editable in the store file or via setWatchlist().
export const DEFAULT_WATCHLIST: WatchEntity[] = [
  { name: 'MrBeast', type: 'person', aliases: ['Jimmy Donaldson', 'Mr Beast'], domains: ['youtube'] },
  { name: 'Anthropic', type: 'org', aliases: ['Claude'], domains: ['ai'] },
  { name: 'OpenAI', type: 'org', aliases: ['ChatGPT', 'GPT-5'], domains: ['ai'] },
  { name: 'Google DeepMind', type: 'org', aliases: ['Gemini'], domains: ['ai'] },
  { name: 'xAI', type: 'org', aliases: ['Grok'], domains: ['ai'] },
  { name: 'Nvidia', type: 'org', aliases: ['NVDA'], domains: ['ai', 'markets'] },
  { name: 'Federal Reserve', type: 'org', aliases: ['FOMC', 'the Fed'], domains: ['markets'] },
  { name: 'Bitcoin', type: 'ticker', aliases: ['BTC'], domains: ['crypto'] },
];

interface Store { watchlist: WatchEntity[]; mentions: TrackedMention[]; }

async function loadStore(path: string): Promise<Store> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Store; } catch { return { watchlist: [], mentions: [] }; }
}
async function saveStore(path: string, store: Store): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2));
}

function norm(url: string): string { return url.replace(/[?#].*$/, '').replace(/\/+$/, ''); }

/** Word-boundary matcher so short aliases/tickers (BTC, Grok, Fed) don't match inside other words.
 * Uses unicode lookarounds instead of \b — \b is ASCII-only, so a name ending in an accented char
 * ("Todd Beaupré") silently never matches at the boundary. */
export function compileMatchers(e: WatchEntity): RegExp[] {
  return [e.name, ...(e.aliases || [])]
    .filter(Boolean)
    .map((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    });
}
/** Match against title AND snippet — entities are often only in the snippet, not the headline. */
export function matchEntity(text: string, matchers: RegExp[]): boolean {
  return matchers.some((re) => re.test(text));
}

/** Drop mentions older than PRUNE_DAYS (keeps undated/unparseable entries to be safe). */
export function pruneMentions(mentions: TrackedMention[], now: Date): TrackedMention[] {
  const cutoff = now.getTime() - PRUNE_DAYS * 86_400_000;
  return mentions.filter((m) => { const t = Date.parse(m.firstSeen); return Number.isNaN(t) || t >= cutoff; });
}

/** Set/replace the persisted watchlist without running a track. */
export async function setWatchlist(watchlist: WatchEntity[], storePath = DEFAULT_STORE): Promise<void> {
  const store = await loadStore(storePath);
  store.watchlist = watchlist;
  await saveStore(storePath, store);
}

export async function getWatchlist(storePath = DEFAULT_STORE): Promise<WatchEntity[]> {
  const store = await loadStore(storePath);
  return store.watchlist.length ? store.watchlist : DEFAULT_WATCHLIST;
}

export async function track(b: AgentBrowser, opts: TrackOptions = {}): Promise<TrackDigest> {
  const path = opts.storePath ?? DEFAULT_STORE;
  const store = await loadStore(path);
  const watchlist = opts.watchlist ?? (store.watchlist.length ? store.watchlist : DEFAULT_WATCHLIST);
  store.watchlist = watchlist;

  const now = opts.todayUTC ? new Date(`${opts.todayUTC}T00:00:00Z`) : new Date();
  const seen = new Set(store.mentions.map((m) => `${norm(m.url)}|${m.entity}`));

  const candidates: { title: string; url: string; source: string; date?: string; snippet?: string }[] = [];

  // Sweep tier: prefer the shared browser daemon when it's up — its /search fuses the logged-in
  // google-session engine, which is dramatically stronger than the bare fetch engines. Probe health
  // ONCE per run; per-call failures fall back to in-process search() so a mid-run daemon crash
  // degrades gracefully instead of losing the sweep.
  type SweepResponse = { results: SearchResult[]; qualityFailure?: boolean; lowConfidence?: boolean };
  const daemon = new VortexDaemonClient();
  const daemonUp = await daemon.healthy();
  const sweepSearch = async (q: string, max: number): Promise<SweepResponse> => {
    if (daemonUp) {
      try {
        // youtube:false — entity sweeps must never divert to the YouTube vertical; rerank:false —
        // content re-rank reads top pages, far too heavy for N-entity background sweeps.
        const r = (await daemon.search(q, { maxResults: max, recency: 'month', youtube: false, rerank: false })) as SweepResponse;
        if (r && Array.isArray(r.results)) return r;
      } catch { /* daemon hiccup → in-process engines below */ }
    }
    return search(q, { maxResults: max, freshness: 'month' });
  };

  // 1) Per-entity targeted sweeps — the watchlist's reliability (each named entity is explicitly tracked).
  // Query shape: quoted name (multi-word) + ONE rotated alias + "news". No literal month/year — that
  // template was SEO-listicle bait ("X news July 2026" ranks roundup farms); SERP-level month freshness
  // does the temporal scoping instead. Alias rotates by day-of-year so every alias gets swept over time.
  const dayOfYear = Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86_400_000);
  for (const e of watchlist) {
    const aliases = (e.aliases || []).filter(Boolean);
    const alias = aliases.length ? ` ${aliases[dayOfYear % aliases.length]}` : '';
    const namePart = /\s/.test(e.name) ? `"${e.name}"` : e.name;
    try {
      const r = await sweepSearch(`${namePart}${alias} news`, opts.perEntity ?? 6);
      // Quality gate: qualityFailure = no quality engine answered a serious query — Bing/Mojeek-only
      // keyword junk. Store entries are PERMANENT dedupe keys, so ingesting one junk batch suppresses
      // the real article forever. Discard the sweep instead.
      if (r.qualityFailure) continue;
      for (const x of r.results) candidates.push({ title: x.title, url: x.url, source: `sweep:${e.name}`, snippet: x.snippet, date: x.publishedAt });
    } catch { /* skip */ }
  }

  // 2) Domain RSS feeds (freshness across the watched domains), merged in.
  if (opts.useDiscovery !== false) {
    const domains = [...new Set(watchlist.flatMap((e) => e.domains || []))] as DomainKey[];
    try {
      const dd = await discoverDomain(b, { domains: domains.length ? domains : 'all', perFeed: 10, searchSweep: false });
      for (const items of Object.values(dd.items)) for (const it of items) candidates.push({ title: it.title, url: it.url, source: it.feed, date: it.date, snippet: it.snippet });
    } catch { /* skip */ }
  }

  // 3) Match (title + snippet, word-boundary) → keep NEW → persist.
  // Junk gate: a mention sweep is always a temporal news query, so quote pages and farms are never
  // the answer — drop them by source class before they enter the store (store entries are permanent
  // dedupe keys, so a junk URL admitted once suppresses nothing useful but pollutes every digest).
  const JUNK_CLASSES = new Set<SourceClass>(['low-trust', 'syndication', 'tutorial-farm', 'stock-quote']);
  // Primary-source classes whose fresh items warrant an immediate push (vs the daily digest).
  const HIGH_CLASSES = new Set<SourceClass>(['gov', 'wire', 'ai-lab', 'official-docs']);
  const FRESH_CUTOFF = now.getTime() - 45 * 86_400_000;   // dated candidates older than 45d are stale
  const HIGH_CUTOFF = now.getTime() - 7 * 86_400_000;     // "high" additionally requires <7d old
  const matchers = new Map(watchlist.map((e) => [e.name, compileMatchers(e)] as const));
  const newByEntity: Record<string, TrackedMention[]> = {};
  for (const c of candidates) {
    const cls = sourceClass(c.url);
    if (JUNK_CLASSES.has(cls)) continue;
    // Freshness gate: engines still surface years-old evergreen pages for entity queries. A parseable
    // date older than 45 days is not a "new development"; undated candidates pass (fail-open).
    const t = c.date ? Date.parse(c.date) : NaN;
    if (!Number.isNaN(t) && t < FRESH_CUTOFF) continue;
    const haystack = `${c.title} ${c.snippet || ''}`;
    for (const e of watchlist) {
      if (!matchEntity(haystack, matchers.get(e.name)!)) continue;
      const key = `${norm(c.url)}|${e.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const priority: TrackedMention['priority'] = HIGH_CLASSES.has(cls) && !Number.isNaN(t) && t >= HIGH_CUTOFF ? 'high' : 'normal';
      const m: TrackedMention = { entity: e.name, title: c.title, url: c.url, source: c.source, date: c.date, firstSeen: now.toISOString(), sourceClass: cls, priority };
      store.mentions.push(m);
      (newByEntity[e.name] ||= []).push(m);
    }
  }
  store.mentions = pruneMentions(store.mentions, now);
  await saveStore(path, store);

  const byEntity: TrackDigest['byEntity'] = {};
  for (const e of watchlist) {
    byEntity[e.name] = { new: newByEntity[e.name] || [], totalKnown: store.mentions.filter((m) => m.entity === e.name).length };
  }
  const newMentions = Object.values(newByEntity).reduce((a, b2) => a + b2.length, 0);
  return { ranAt: now.toISOString(), entities: watchlist.length, newMentions, byEntity };
}
