import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AgentBrowser } from './agent-browser.js';
import { search } from './search.js';
import { discoverDomain, type DomainKey } from './discover.js';

/**
 * tracker — a local "oracle": you name entities ONCE (a watchlist) and it tracks them over time,
 * accumulating mentions to a persistent store and reporting only what's NEW each run.
 *
 * Per run it pulls from the multi-source UNION (per-entity targeted search sweeps + domain RSS feeds),
 * matches every item to watched entities by name/alias, dedupes against everything seen before, and
 * stores new mentions. Zero model tokens. This is the foundation of the always-on daemon.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

/** Word-boundary matcher so short aliases/tickers (BTC, Grok, Fed) don't match inside other words. */
export function compileMatchers(e: WatchEntity): RegExp[] {
  return [e.name, ...(e.aliases || [])]
    .filter(Boolean)
    .map((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
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
  const M = MONTHS[now.getUTCMonth()], Y = now.getUTCFullYear();
  const seen = new Set(store.mentions.map((m) => `${norm(m.url)}|${m.entity}`));

  const candidates: { title: string; url: string; source: string; date?: string; snippet?: string }[] = [];

  // 1) Per-entity targeted sweeps — the watchlist's reliability (each named entity is explicitly tracked).
  for (const e of watchlist) {
    const alias = e.aliases?.[0] ? ` ${e.aliases[0]}` : '';
    try {
      const r = await search(`${e.name}${alias} news ${M} ${Y}`, { maxResults: opts.perEntity ?? 6 });
      for (const x of r.results) candidates.push({ title: x.title, url: x.url, source: `sweep:${e.name}`, snippet: x.snippet });
    } catch { /* skip */ }
  }

  // 2) Domain RSS feeds (freshness across the watched domains), merged in.
  if (opts.useDiscovery !== false) {
    const domains = [...new Set(watchlist.flatMap((e) => e.domains || []))] as DomainKey[];
    try {
      const dd = await discoverDomain(b, { domains: domains.length ? domains : 'all', perFeed: 10, searchSweep: false });
      for (const items of Object.values(dd.items)) for (const it of items) candidates.push({ title: it.title, url: it.url, source: it.feed, date: it.date });
    } catch { /* skip */ }
  }

  // 3) Match (title + snippet, word-boundary) → keep NEW → persist.
  const matchers = new Map(watchlist.map((e) => [e.name, compileMatchers(e)] as const));
  const newByEntity: Record<string, TrackedMention[]> = {};
  for (const c of candidates) {
    const haystack = `${c.title} ${c.snippet || ''}`;
    for (const e of watchlist) {
      if (!matchEntity(haystack, matchers.get(e.name)!)) continue;
      const key = `${norm(c.url)}|${e.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const m: TrackedMention = { entity: e.name, title: c.title, url: c.url, source: c.source, date: c.date, firstSeen: now.toISOString() };
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
