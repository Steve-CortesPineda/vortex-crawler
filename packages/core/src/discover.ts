import { AgentBrowser } from './agent-browser.js';
import { search } from './search.js';

/**
 * discover() — broad event DISCOVERY (vs browse()'s narrow query-driven research).
 *
 * The blind spot in query-driven search: you only find categories you thought to name (so "sports"
 * / FIFA never surfaces). discover() instead reads a broad, editorially-curated, CATEGORIZED,
 * time-ordered primary feed — the Wikipedia Current Events Portal — one day at a time across a
 * window, and buckets every notable event by category. No relevance gate (breadth is the point);
 * recency is intrinsic (each page IS a single day). Zero model tokens.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The standard Wikipedia Current Events category headers.
const CATEGORIES = [
  'Armed conflicts and attacks', 'Arts and culture', 'Business and economy', 'Disasters and accidents',
  'Health and environment', 'International relations', 'Law and crime', 'Politics and elections',
  'Science and technology', 'Sports',
];

export interface DiscoveredEvent { date: string; category: string; text: string; }
export interface DiscoverResult {
  source: string;
  daysRequested: number;
  daysCovered: number;
  totalEvents: number;
  categories: Record<string, DiscoveredEvent[]>;
}

export interface DiscoverOptions {
  days?: number;            // window size; default 30
  category?: string;        // optional filter (substring match on category name)
  maxPerCategory?: number;  // cap events kept per category; default 60
  todayUTC?: string;        // override "now" for testing (YYYY-MM-DD)
}

function dayUrls(days: number, todayUTC?: string): { date: string; url: string }[] {
  const now = todayUTC ? new Date(`${todayUTC}T00:00:00Z`) : new Date();
  const out: { date: string; url: string }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    out.push({ date: iso, url: `https://en.wikipedia.org/wiki/Portal:Current_events/${y}_${MONTHS[m]}_${day}` });
  }
  return out;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Split a day's markdown into per-category event lines. */
function parseDay(markdown: string, date: string): DiscoveredEvent[] {
  const events: DiscoveredEvent[] = [];
  const positions = CATEGORIES
    .map((c) => ({ c, i: markdown.search(new RegExp(escapeRe(c), 'i')) }))
    .filter((p) => p.i >= 0)
    .sort((a, b) => a.i - b.i);

  for (let k = 0; k < positions.length; k++) {
    const start = positions[k].i + positions[k].c.length;
    const end = k + 1 < positions.length ? positions[k + 1].i : markdown.length;
    const block = markdown.slice(start, end);
    const items = block
      .split(/\n|(?: - )/)
      .map((s) =>
        s.replace(/\*\*/g, '')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown link → its text
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter((s) => s.length > 12 && s.length < 400 && !/^\W*$/.test(s));
    for (const text of items) events.push({ date, category: positions[k].c, text });
  }
  return events;
}

// ── Domain-depth discovery ──────────────────────────────────────────────────────────────────────
// Wikipedia Current Events gives WORLD breadth but misses niche-domain items (e.g. a new AI agent
// release). discoverDomain() reads each domain's community/primary HUBS the same way — a hub's
// outbound links ARE its recent items — to surface the niche stuff query-search and world-feeds miss.

export type DomainKey = 'ai' | 'markets' | 'youtube' | 'crypto';

// RSS feeds — clean title+link+date per item, no nav/product noise. Reddit's .rss often works even
// where its HTML hard-blocks. Per-feed best-effort; failures are skipped.
const DOMAIN_FEEDS: Record<DomainKey, string[]> = {
  ai: ['https://news.ycombinator.com/rss', 'http://export.arxiv.org/rss/cs.AI', 'https://www.reddit.com/r/LocalLLaMA/.rss', 'https://www.reddit.com/r/MachineLearning/.rss'],
  markets: ['https://www.federalreserve.gov/feeds/press_all.xml', 'https://www.reddit.com/r/economics/.rss', 'https://www.reddit.com/r/StockMarket/.rss'],
  youtube: ['https://www.tubefilter.com/feed/', 'https://www.reddit.com/r/PartneredYoutube/.rss', 'https://www.reddit.com/r/NewTubers/.rss'],
  crypto: ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'https://cointelegraph.com/rss', 'https://www.reddit.com/r/CryptoCurrency/.rss'],
};

// Date-bounded search sweeps catch MAJOR events that RSS (only days deep) and Wikipedia (selective) miss
// — e.g. a record subscriber milestone. Phrasing matters: vague queries return junk, so these are
// specific. They SUPPLEMENT the feeds; comprehensiveness is the union of feeds + portal + sweeps.
const DOMAIN_QUERIES: Record<DomainKey, string[]> = {
  ai: ['major AI model release announcement {M} {Y}', 'AI company breakthrough record {M} {Y}'],
  markets: ['stock market Federal Reserve decision {M} {Y}', 'record market move {M} {Y}'],
  youtube: ['YouTube subscriber milestone record {M} {Y}', 'YouTube creator record announcement {M} {Y}'],
  crypto: ['cryptocurrency bitcoin record milestone {M} {Y}', 'major crypto announcement {M} {Y}'],
};

export interface DomainItem { domain: DomainKey; feed: string; title: string; url: string; date?: string; }
export interface DiscoverDomainResult {
  source: string;
  domains: DomainKey[];
  feedsRead: number;
  feedsFailed: number;
  totalItems: number;
  items: Record<DomainKey, DomainItem[]>;
}

export interface DiscoverDomainOptions {
  domains?: DomainKey[] | 'all';
  perFeed?: number;     // items kept per feed; default 12
  maxAgeDays?: number;  // optional recency filter using item pubDate
  searchSweep?: boolean; // also run date-bounded search sweeps to catch big events RSS misses. Default true.
  todayUTC?: string;    // override "now" for query month/year (YYYY-MM-DD)
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : undefined;
}

/** Parse RSS <item> and Atom <entry> into {title,url,date}. */
function parseFeed(xml: string, max: number): { title: string; url: string; date?: string }[] {
  const out: { title: string; url: string; date?: string }[] = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const blk of blocks) {
    if (out.length >= max) break;
    const title = tag(blk, 'title');
    // Atom <link href="..."/> or RSS <link>...</link>
    const atom = blk.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
    const rss = tag(blk, 'link') || blk.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim();
    const url = (atom || rss || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const date = tag(blk, 'pubDate') || tag(blk, 'published') || tag(blk, 'updated') || tag(blk, 'dc:date');
    if (title && url && url.startsWith('http')) out.push({ title, url, date });
  }
  return out;
}

const FEED_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function discoverDomain(_b: AgentBrowser, opts: DiscoverDomainOptions = {}): Promise<DiscoverDomainResult> {
  const domains: DomainKey[] = opts.domains === 'all' || !opts.domains ? (Object.keys(DOMAIN_FEEDS) as DomainKey[]) : opts.domains;
  const perFeed = opts.perFeed ?? 12;
  const items: Record<DomainKey, DomainItem[]> = { ai: [], markets: [], youtube: [], crypto: [] };
  const seen = new Set<string>();
  let feedsRead = 0, feedsFailed = 0, totalItems = 0;
  const cutoff = opts.maxAgeDays != null ? Date.now() - opts.maxAgeDays * 86_400_000 : null;

  // Fetch every feed in parallel (independent HTTP GETs); merge sequentially so dedupe stays deterministic.
  const feedJobs = domains.flatMap((domain) => DOMAIN_FEEDS[domain].map((feed) => ({ domain, feed })));
  const fetched = await Promise.allSettled(feedJobs.map(async ({ domain, feed }) => {
    const res = await fetch(feed, { headers: { 'User-Agent': FEED_UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { domain, feed, parsed: parseFeed(await res.text(), perFeed) };
  }));
  for (const r of fetched) {
    if (r.status !== 'fulfilled') { feedsFailed++; continue; }
    feedsRead++;
    const { domain, feed, parsed } = r.value;
    for (const it of parsed) {
      if (cutoff && it.date) { const t = Date.parse(it.date); if (!Number.isNaN(t) && t < cutoff) continue; }
      const key = it.url.replace(/[?#].*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      items[domain].push({ domain, feed, title: it.title, url: it.url, date: it.date });
      totalItems++;
    }
  }

  // Search sweep — catch major events the feeds miss (e.g. milestone records weeks back).
  if (opts.searchSweep !== false) {
    const now = opts.todayUTC ? new Date(`${opts.todayUTC}T00:00:00Z`) : new Date();
    const M = MONTHS[now.getUTCMonth()], Y = String(now.getUTCFullYear());
    for (const domain of domains) {
      for (const tmpl of DOMAIN_QUERIES[domain]) {
        const q = tmpl.replace('{M}', M).replace('{Y}', Y);
        try {
          const r = await search(q, { maxResults: 8 });
          for (const x of r.results) {
            const key = x.url.replace(/[?#].*$/, '');
            if (seen.has(key)) continue;
            seen.add(key);
            items[domain].push({ domain, feed: `sweep:${q}`, title: x.title, url: x.url });
            totalItems++;
          }
        } catch { /* sweep best-effort */ }
      }
    }
  }

  return { source: 'domain RSS feeds + date-bounded search sweeps', domains, feedsRead, feedsFailed, totalItems, items };
}

export async function discover(b: AgentBrowser, opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const days = opts.days ?? 30;
  const maxPerCategory = opts.maxPerCategory ?? 60;
  const filter = opts.category?.toLowerCase();

  await b.open();
  const byCat = new Map<string, DiscoveredEvent[]>();
  let daysCovered = 0;

  // Fetch all day-pages in parallel (bounded by parallelExtract's concurrency cap). Wikipedia day
  // pages are static, so no settle wait is needed — this turns ~30 sequential nav round-trips into
  // a handful of concurrent batches.
  const dayList = dayUrls(days, opts.todayUTC);
  const extracts = await b.parallelExtract(dayList.map((d) => d.url), { settleMs: 0 });
  extracts.forEach((ex, i) => {
    if (!ex || ex.markdown.length < 200) return;
    daysCovered++;
    for (const e of parseDay(ex.markdown, dayList[i].date)) {
      if (filter && !e.category.toLowerCase().includes(filter)) continue;
      if (!byCat.has(e.category)) byCat.set(e.category, []);
      byCat.get(e.category)!.push(e);
    }
  });

  const categories: Record<string, DiscoveredEvent[]> = {};
  let totalEvents = 0;
  for (const [c, items] of byCat) {
    // dedupe by text (events recur across day pages), keep chronological, cap.
    const dedup = [...new Map(items.map((i) => [i.text, i])).values()]
      .sort((a, b2) => b2.date.localeCompare(a.date))
      .slice(0, maxPerCategory);
    categories[c] = dedup;
    totalEvents += dedup.length;
  }

  return { source: 'Wikipedia Current Events Portal', daysRequested: days, daysCovered, totalEvents, categories };
}
