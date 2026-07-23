/**
 * source-rules — the maintained domain-trust + query-vertical + freshness knowledge base for search ranking.
 *
 * Everything here is DATA-FIRST: plain domain lists compiled to suffix matchers, so adding a content farm
 * or a new vendor-docs host is a one-line edit covered by the benchmark suite (benchmarks/ + search.test.ts).
 * Consumed by search.ts (fusion ranking) and the daemon's content rerank.
 *
 * Verticals: a query is classified once (queryDomain) and domains are scored relative to that vertical —
 * a wire outlet is a great source for news and a poor one for API docs; YouTube is the source of record
 * for video queries and noise for finance.
 */

// ── Suffix-set matcher ────────────────────────────────────────────────────────
/** Compile a domain list into a matcher that hits the domain itself or any subdomain of it. */
function suffixMatcher(domains: string[]): (host: string) => boolean {
  const set = new Set(domains);
  return (host: string) => {
    let h = host;
    while (h) {
      if (set.has(h)) return true;
      const dot = h.indexOf('.');
      if (dot === -1) return false;
      h = h.slice(dot + 1);
    }
    return false;
  };
}

export function domainOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^(www|m|amp)\./, ''); } catch { return ''; }
}

// ── Source-of-record domains, per vertical ───────────────────────────────────
/** Government / official statistics / regulators — primary sources for policy, finance, law, travel rules. */
const GOV_PRIMARY = suffixMatcher([
  'federalreserve.gov', 'sec.gov', 'treasury.gov', 'fincen.gov', 'fdic.gov', 'occ.gov', 'ncua.gov',
  'bls.gov', 'bea.gov', 'census.gov', 'whitehouse.gov', 'congress.gov', 'federalregister.gov',
  'irs.gov', 'cdc.gov', 'nih.gov', 'fda.gov', 'faa.gov', 'state.gov', 'uscis.gov', 'cbp.gov', 'tsa.gov',
  'justice.gov', 'ftc.gov', 'fcc.gov', 'cftc.gov', 'gao.gov', 'cbo.gov', 'ustr.gov', 'bis.doc.gov',
  'europa.eu', 'ecb.europa.eu', 'bankofengland.co.uk', 'gov.uk', 'imf.org', 'worldbank.org', 'bis.org', 'oecd.org',
]);

/** AI labs + chipmakers — source of record for model releases and AI announcements. */
const AI_PRIMARY = suffixMatcher([
  'openai.com', 'anthropic.com', 'deepmind.google', 'ai.google', 'blog.google', 'nvidia.com',
  'nvidianews.nvidia.com', 'x.ai', 'microsoft.com', 'meta.com', 'about.fb.com', 'mistral.ai',
  'cohere.com', 'huggingface.co', 'stability.ai', 'deepseek.com', 'qwen.ai', 'amd.com', 'intel.com',
]);

/** Wire services + serious editorial. Great for news; near-worthless for technical/docs queries. */
const WIRE_EDITORIAL = suffixMatcher([
  'reuters.com', 'apnews.com', 'bloomberg.com', 'wsj.com', 'nytimes.com', 'ft.com', 'cnbc.com',
  'theverge.com', 'techcrunch.com', 'axios.com', 'semianalysis.com', 'theinformation.com',
  'washingtonpost.com', 'economist.com', 'wired.com', 'arstechnica.com',
]);

const SPECIALIST_EDITORIAL = suffixMatcher([
  'statnews.com', 'infoq.com', 'releasebot.io', 'forbes.com', 'theregister.com', 'anandtech.com',
]);

/** Official developer documentation, standards bodies, cloud docs — the docs-first set for technical queries. */
const OFFICIAL_DOCS = suffixMatcher([
  'developer.mozilla.org', 'learn.microsoft.com', 'docs.aws.amazon.com', 'cloud.google.com',
  'docs.github.com', 'docs.gitlab.com', 'docs.python.org', 'nodejs.org', 'react.dev', 'nextjs.org',
  'developer.apple.com', 'developer.android.com', 'developer.chrome.com', 'web.dev', 'kubernetes.io',
  'docs.docker.com', 'postgresql.org', 'sqlite.org', 'redis.io', 'nginx.org', 'certbot.eff.org',
  'docs.stripe.com', 'docs.digitalocean.com', 'docs.npmjs.com', 'pip.pypa.io', 'doc.rust-lang.org',
  'pkg.go.dev', 'go.dev', 'vitejs.dev', 'vuejs.org', 'angular.dev', 'tailwindcss.com', 'svelte.dev',
  'docs.anthropic.com', 'platform.openai.com', 'ai.google.dev', 'typescriptlang.org', 'deno.com',
  // standards / specs
  'rfc-editor.org', 'datatracker.ietf.org', 'ietf.org', 'w3.org', 'whatwg.org', 'ecma-international.org',
]);

/** Code hosting / Q&A / package registries — strong secondary sources for technical queries. */
const CODE_COMMUNITY = suffixMatcher([
  'github.com', 'gitlab.com', 'stackoverflow.com', 'serverfault.com', 'superuser.com',
  'askubuntu.com', 'unix.stackexchange.com', 'npmjs.com', 'pypi.org', 'crates.io', 'arxiv.org',
  'readthedocs.io', 'readthedocs.org',
]);

/** SEO tutorial farms — outrank real docs on keyword match while being shallow/stale/ad-walled. */
const TUTORIAL_FARMS = suffixMatcher([
  'w3schools.com', 'geeksforgeeks.org', 'tutorialspoint.com', 'javatpoint.com', 'tpointtech.com',
  'guru99.com', 'simplilearn.com', 'edureka.co', 'interviewbit.com', 'scaler.com', 'shiksha.com',
]);

/** Mass-republishers/aggregators: same headline as the original outlet, worse page. Dedupe keeps the original. */
const SYNDICATION = suffixMatcher([
  'msn.com', 'news.yahoo.com', 'finance.yahoo.com', 'uk.news.yahoo.com', 'ca.news.yahoo.com',
  'flipboard.com', 'aol.com', 'smartnews.com', 'newsbreak.com', 'headtopics.com', 'news.google.com',
  'apple.news', 'ground.news',
]);
/** Exported for the fold-time "keep the original outlet's URL" swap. */
export function isSyndicationHost(host: string): boolean { return SYNDICATION(host); }

/** Content farms, churnalism, copied-notes sites, tabloids — low trust in any vertical. */
const LOW_TRUST = suffixMatcher([
  'fandom.com', 'cloudwards.net', 'dailymail.com', 'dailymail.co.uk', 'the-sun.com', 'thesun.co.uk',
  'express.co.uk', 'mirror.co.uk', 'ibtimes.com', 'ibtimes.co.in', 'ibtimes.co.uk',
  'marketbeat.com', '247wallst.com', 'beincrypto.com', 'clearank.com', 'analyticsinsight.net', 'geeky-gadgets.com',
  'gobankingrates.com', 'cheatsheet.com', 'techtimes.com', 'screenrant.com', 'slashgear.com',
  'roic.ai', 'gate.com',
  'coinpedia.org', 'cryptopolitan.com', 'ambcrypto.com', 'u.today', 'coingape.com', 'tronweekly.com',
  'studocu.com', 'coursehero.com', 'scribd.com', 'slideshare.net', 'pinterest.com',
  'thetravel.com', 'traveltriangle.com', 'theculturetrip.com', 'thrillophilia.com',
  'bestproducts.com', 'top10.com', 'reviews.org', 'retailmenot.com', 'coupons.com',
]);

const SOCIAL = suffixMatcher([
  'instagram.com', 'facebook.com', 'threads.com', 'x.com', 'twitter.com', 'linkedin.com',
  'tiktok.com', 'reddit.com',
]);

/** Hotel/flight booking + review platforms — the positive class for travel queries (a hotel query
 * answered without one of these is answered badly). */
const TRAVEL_BOOKING = suffixMatcher([
  'booking.com', 'agoda.com', 'expedia.com', 'hotels.com', 'kayak.com', 'tripadvisor.com',
  'skyscanner.com', 'skyscanner.net', 'trip.com', 'hostelworld.com', 'airbnb.com', 'vrbo.com',
  'priceline.com', 'orbitz.com', 'travelocity.com', 'marriott.com', 'hilton.com', 'hyatt.com', 'ihg.com',
]);

/** Retailers/marketplaces — positive for commerce queries, noise elsewhere. */
const COMMERCE_RETAILER = suffixMatcher([
  'amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'bestbuy.com', 'newegg.com',
  'bhphotovideo.com', 'homedepot.com', 'lowes.com', 'costco.com', 'aliexpress.com', 'etsy.com',
]);

/** Encyclopedic reference — fine for definitional queries, a non-answer for "latest news". */
const WIKI_REFERENCE = suffixMatcher([
  'wikipedia.org', 'wiktionary.org', 'wikidata.org', 'britannica.com',
]);

/** Discussion communities distinct from SOCIAL — modest positive signal on technical queries. */
const FORUM_COMMUNITY = suffixMatcher([
  'news.ycombinator.com', 'quora.com', 'lobste.rs', 'community.letsencrypt.org',
]);

/** Retail-broker / quote-page hosts — a stock QUOTE is not news; they crowded NVIDIA temporal queries. */
const STOCK_QUOTE = suffixMatcher([
  'robinhood.com', 'webull.com', 'stockanalysis.com', 'barchart.com', 'tipranks.com',
  'simplywall.st', 'zacks.com', 'marketwatch.com', 'investing.com',
]);

/** App stores — driver/app listing pages keyword-match product queries without answering them. */
const APP_STORE = suffixMatcher([
  'apps.apple.com', 'play.google.com', 'apps.microsoft.com', 'chromewebstore.google.com',
]);

/** Job boards — outrank real answers on company-name queries. */
const JOB_BOARD = suffixMatcher([
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'lever.co', 'greenhouse.io', 'wellfound.com',
]);

// ── Query verticals ───────────────────────────────────────────────────────────
export type QueryVertical = 'technical' | 'ai' | 'markets' | 'youtube' | 'travel' | 'commerce' | 'general';

const TECHNICAL_Q = /\b(webhook|api|docs?|documentation|developer|sdk|cli|endpoint|signing secret|secret rotation|rotate|dns|certbot|nginx|reserved ip|floating ip|cloud dns|let'?s encrypt|ssl|tls|github|stackoverflow|serverfault|error|exception|stack ?trace|traceback|npm|pnpm|yarn|pip|docker|kubernetes|k8s|sql|postgres|mysql|sqlite|node(\.js)?|python|typescript|javascript|react|next\.?js|rust|golang|git|oauth|jwt|regex|rfc ?\d+|http ?\d{3}|deprecat\w*|migrat\w* (guide|from)|install\w*|config\w* file)\b/i;
const AI_Q = /\b(claude|anthropic|openai|gpt|gemini|deepmind|deepseek|mistral|llama|nvidia|nvda|ai chip|llm|model|agent)\b/i;
const MARKETS_Q = /\b(federal reserve|fomc|fed|inflation|cpi|pce|rates?|treasury|aml|bank|bitcoin|btc|stock|market|earnings|dividend|etf|nasdaq|s&p|ticker|nvda)\b/i;
const YOUTUBE_Q = /\b(youtube|video|channel|creator|mrbeast|watch|views?|subscriber)\b/i;
const TRAVEL_Q = /\b(flight|flights|hotel|hostel|visa|itinerary|travel|airport|airline|passport|customs|immigration|layover|baggage)\b/i;
const COMMERCE_Q = /\b(buy|price of|cheapest|deal|deals|discount|coupon|order|shipping|in stock|best .{0,20} to buy|where to (buy|get))\b/i;

export function queryDomain(query: string): QueryVertical {
  if (TECHNICAL_Q.test(query)) return 'technical';
  if (AI_Q.test(query)) return 'ai';
  if (MARKETS_Q.test(query)) return 'markets';
  if (YOUTUBE_Q.test(query)) return 'youtube';
  if (TRAVEL_Q.test(query)) return 'travel';
  if (COMMERCE_Q.test(query)) return 'commerce';
  return 'general';
}

// ── Path shape helpers ────────────────────────────────────────────────────────
export const HOMEPAGE_RE = /^https?:\/\/[^/]+\/?$/i;
const GENERIC_PRIMARY_PATH = /^\/(company|about|products?|platform|pricing|careers?|contact|team|research|api|login|sign-?in|register)\/?$/i;
const LOCALE_ROOT_PATH = /^\/[a-z]{2}(?:-[a-z]{2})?\/?$/i;
const LEGACY_HOME_PATH = /^\/page\/home(?:\.html)?$/i;
const PRIMARY_NEWS_PATH = /^\/(news|blog|press|newsevents|publications|reports|research\/[^/]+|announcements?|index\/[^/]+)\b/i;
const PRIMARY_NEWS_HINT = /\b(news|pressreleases|release|blog|article|previewing|introducing|202\d)\b/i;
/** Docs-looking hostname: docs.x.y / developer.x.y / learn.x.y (needs a real domain after the prefix —
 * `dev.to` must NOT match). */
const DOCS_SUBDOMAIN = /^(docs|developer|developers|learn|devcenter|dev)\./i;
const DOCS_PATH = /^\/(docs|documentation|developers?|api|reference|guides?|manual|handbook)\b/i;

function isDocsish(host: string, path: string): boolean {
  if (OFFICIAL_DOCS(host)) return true;
  if (DOCS_SUBDOMAIN.test(host) && host.split('.').length >= 3) return true;
  return DOCS_PATH.test(path);
}

/** Vendor exceptions where the marketing domain hosts real docs under a path. */
function isOfficialDocsPath(host: string, path: string, query: string): boolean {
  if (host === 'stripe.com') return /^\/docs\b/i.test(path);
  if (host === 'digitalocean.com') return /^\/community\/tutorials\b/i.test(path);
  if (OFFICIAL_DOCS(host)) return true;
  if (DOCS_SUBDOMAIN.test(host) && host.split('.').length >= 3) return true;
  return TECHNICAL_Q.test(query) && DOCS_PATH.test(path);
}

// ── Freshness: explicit date extraction + stale penalties ────────────────────
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const iso = (y: number, m: number, d: number): string | null => {
  if (y < 1995 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * Best-effort publish date from what the SERP gives us: relative ages and absolute dates in the snippet
 * (engines prefix "2 days ago ·" / "Jun 5, 2026 ·"), then date-shaped URL paths (/2026/07/05/, /2026-07-05).
 * Returns ISO yyyy-mm-dd or null. `now` injectable for tests.
 */
export function extractResultDate(snippet: string, url: string, now: Date = new Date()): string | null {
  const s = (snippet || '').slice(0, 160); // engine date prefixes live at the front
  // Relative: "21 hours ago", "2 days ago", "3 weeks ago", "1 month ago", "2 years ago"
  const rel = s.match(/\b(\d{1,2})\s+(minute|hour|day|week|month|year)s?\s+ago\b/i);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs: Record<string, number> = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };
    const d = new Date(now.getTime() - n * unitMs[rel[2].toLowerCase()]);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  // Absolute: "Jun 5, 2026" / "June 5, 2026" / "5 Jun 2026"
  const mdY = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (mdY) return iso(Number(mdY[3]), MONTHS[mdY[1].toLowerCase()], Number(mdY[2]));
  const dMY = s.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i);
  if (dMY) return iso(Number(dMY[3]), MONTHS[dMY[2].toLowerCase()], Number(dMY[1]));
  const isoM = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoM) return iso(Number(isoM[1]), Number(isoM[2]), Number(isoM[3]));
  // URL path: /2026/07/05/ or /2026-07-05 or /2026/07/
  try {
    const path = new URL(url).pathname;
    const p1 = path.match(/\/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:[/-]|$)/);
    if (p1) return iso(Number(p1[1]), Number(p1[2]), Number(p1[3]));
    const p2 = path.match(/\/(20\d{2})[/-](\d{1,2})(?:\/|$)/);
    if (p2) return iso(Number(p2[1]), Number(p2[2]), 1);
  } catch { /* */ }
  return null;
}

/** Queries where recency matters: "latest", "news", explicit recent year/month, release/announce framing. */
const TEMPORAL_Q = /\b(latest|newest|news|today|yesterday|this (week|month|year)|current|now|recent|update[ds]?|launch\w*|releas\w*|announc\w*|proposal|delay\w*|202\d)\b/i;
export function isTemporalQuery(query: string): boolean { return TEMPORAL_Q.test(query); }

/**
 * Additive score adjustment for freshness on temporal queries. Fresh (≤7d) gets a nudge up; stale gets
 * penalized on a ramp; a result dated OUTSIDE an explicitly-asked year ("July 2026 release") sinks hard.
 * Neutral (0) when the query isn't temporal or no date could be extracted — absence of a date is common
 * on evergreen pages and must not be punished.
 */
export function freshnessAdjust(query: string, dateIso: string | null, now: Date = new Date()): number {
  if (!dateIso || !isTemporalQuery(query)) return 0;
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return 0;
  const ageDays = (now.getTime() - t) / 86400e3;
  // Explicit year asked → wrong-year results sink regardless of ramp.
  const yearAsked = query.match(/\b(202\d)\b/)?.[1];
  if (yearAsked && dateIso.slice(0, 4) !== yearAsked) return -0.03;
  if (ageDays <= 7) return 0.008;
  if (ageDays <= 90) return 0;
  if (ageDays <= 365) return -0.012;
  return -0.025;
}

// ── Source classification (for the benchmark harness + diagnostics) ──────────
export type SourceClass =
  | 'gov' | 'ai-lab' | 'official-docs' | 'code' | 'wire' | 'specialist'
  | 'syndication' | 'low-trust' | 'tutorial-farm' | 'social' | 'youtube' | 'homepage'
  | 'travel-booking' | 'commerce-retailer' | 'wiki-reference' | 'forum-community'
  | 'stock-quote' | 'app-store' | 'job-board' | 'other';

/** Query-independent class of a URL's source — what KIND of site this is. The benchmark asserts on
 * classes ("a technical query's top-3 must include official-docs, never tutorial-farm") so expectations
 * survive re-ranking-weight tweaks. */
export function sourceClass(url: string): SourceClass {
  const host = domainOf(url);
  const path = (() => { try { return new URL(url).pathname; } catch { return '/'; } })();
  if (GOV_PRIMARY(host)) return 'gov';
  if (AI_PRIMARY(host)) return 'ai-lab';
  if (host === 'youtube.com' || host === 'youtu.be') return 'youtube';
  if (OFFICIAL_DOCS(host) || (DOCS_SUBDOMAIN.test(host) && host.split('.').length >= 3)) return 'official-docs';
  if (host === 'stripe.com' && /^\/docs\b/i.test(path)) return 'official-docs';
  if (TUTORIAL_FARMS(host)) return 'tutorial-farm';
  if (CODE_COMMUNITY(host)) return 'code';
  if (WIRE_EDITORIAL(host)) return 'wire';
  if (SPECIALIST_EDITORIAL(host)) return 'specialist';
  if (SYNDICATION(host)) return 'syndication';
  if (LOW_TRUST(host)) return 'low-trust';
  if (SOCIAL(host)) return 'social';
  if (TRAVEL_BOOKING(host)) return 'travel-booking';
  if (COMMERCE_RETAILER(host)) return 'commerce-retailer';
  if (WIKI_REFERENCE(host)) return 'wiki-reference';
  if (FORUM_COMMUNITY(host)) return 'forum-community';
  if (STOCK_QUOTE(host)) return 'stock-quote';
  if (APP_STORE(host)) return 'app-store';
  if (JOB_BOARD(host)) return 'job-board';
  if (HOMEPAGE_RE.test(url)) return 'homepage';
  return 'other';
}

// ── The scorer ────────────────────────────────────────────────────────────────
/**
 * Source/domain authority for a URL given the query's vertical, in [-0.9, 1]. Blended into ranking with
 * a small weight — enough to lift primary sources and sink farms, never enough to beat strong relevance.
 */
export function sourceQuality(url: string, query = ''): number {
  const host = domainOf(url);
  const qd = queryDomain(query);
  const temporal = isTemporalQuery(query);
  const u = (() => { try { return new URL(url); } catch { return null; } })();
  const path = u?.pathname || '/';
  const hostName = u?.hostname || '';
  const genericPrimaryPath = path === '/' || GENERIC_PRIMARY_PATH.test(path) || LOCALE_ROOT_PATH.test(path) || LEGACY_HOME_PATH.test(path);
  const primaryNewsPath = PRIMARY_NEWS_PATH.test(path) || PRIMARY_NEWS_HINT.test(path);

  // Technical: docs-first. Official docs ≫ code/Q&A ≫ everything else; tutorial farms sink.
  if (qd === 'technical') {
    if (isOfficialDocsPath(host, path, query)) return 1.0;
    if (TUTORIAL_FARMS(host)) return -0.25;
    if (CODE_COMMUNITY(host)) return 0.45;
    if (WIRE_EDITORIAL(host) || SPECIALIST_EDITORIAL(host)) return 0.05;
  }
  // A lab/gov HOMEPAGE is a non-answer for a "latest news" query even though the domain is primary.
  if (temporal && genericPrimaryPath && (GOV_PRIMARY(host) || AI_PRIMARY(host))) return -0.2;
  if (temporal && qd === 'ai' && /^(apps|account|login|support)\./i.test(hostName) && AI_PRIMARY(host)) return -0.15;
  if (GOV_PRIMARY(host)) return primaryNewsPath ? (qd === 'markets' || qd === 'travel' ? 1.0 : 0.8) : 0.35;
  if (AI_PRIMARY(host)) return primaryNewsPath ? (qd === 'ai' ? 1.0 : 0.75) : 0.35;
  // Investor-relations subdomains are the source of record for earnings/guidance queries.
  if (qd === 'markets' && /^(investor|investors|ir)\./i.test(u?.hostname || '')) return 0.8;
  if (qd === 'youtube' && host === 'youtube.com' && !genericPrimaryPath) return 0.8;
  if (WIRE_EDITORIAL(host)) return 0.65;
  if (SPECIALIST_EDITORIAL(host)) return 0.35;
  // Vertical positives: the booking/retail platforms ARE the answer for their own verticals.
  if (TRAVEL_BOOKING(host)) return qd === 'travel' ? 0.8 : 0;
  if (COMMERCE_RETAILER(host)) return qd === 'commerce' ? 0.7 : 0;
  // Encyclopedias answer "what is X", not "what happened to X this week" — the Bing-only failure mode
  // was Wikipedia crowding the top of every serious temporal query.
  if (WIKI_REFERENCE(host)) return temporal ? -0.3 : 0.25;
  // A quote/broker page is a non-answer for temporal news ("NVIDIA chip delay" → Robinhood quote page).
  if (STOCK_QUOTE(host)) return temporal ? -0.4 : 0.1;
  if (APP_STORE(host)) return /\b(app|download|extension|install)\b/i.test(query) ? 0.4 : -0.35;
  if (JOB_BOARD(host)) return /\b(job|jobs|hiring|salary|career)\b/i.test(query) ? 0.5 : -0.4;
  if (FORUM_COMMUNITY(host)) return qd === 'technical' ? 0.2 : 0.05;
  if (isDocsish(host, path)) return 0.45; // docs still decent outside technical queries
  if (CODE_COMMUNITY(host)) return 0.45;
  if (SYNDICATION(host)) return -0.45;
  if (LOW_TRUST(host)) return -0.9;
  if (TUTORIAL_FARMS(host)) return -0.2;
  if (SOCIAL(host)) return qd === 'youtube' ? -0.05 : -0.5;
  if (HOMEPAGE_RE.test(url)) return -0.15;
  return 0;
}
