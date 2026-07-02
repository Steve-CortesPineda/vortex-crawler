import * as cheerio from 'cheerio';
import { generateHeaders } from './antibot/headers.js';
import { bm25ish, tokenize } from './browse-relevance.js';
import { GenericCache } from './cache/result-cache.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Which engines returned this result (multi-engine mode). */
  engines?: string[];
  /** Final blended rank score (RRF + relevance + cross-engine agreement). Higher = better. */
  score?: number;
}

/** Per-engine health for a single search() call — makes silent rot/bot-walls visible.
 * 'timeout' = the engine hadn't answered by the soft latency budget (others had results). */
export type EngineStatus = 'ok' | 'zero' | 'blocked' | 'error' | 'timeout';
export interface EngineReport {
  engine: string;
  status: EngineStatus;
  count: number;
  ms: number;
  note?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults: number;
  /** Engines that actually responded with ≥1 result this call. */
  sources?: string[];
  /** Full per-engine health report (ok / zero / blocked / error). */
  engineReports?: EngineReport[];
  /** True if the stealth-Chrome fallback tier was used to backfill the fast tier. */
  usedFallback?: boolean;
  timing: { fetchMs: number; totalMs: number };
}

export type SearchEngine = 'startpage' | 'duckduckgo' | 'bing' | 'mojeek' | 'brave';

/** Recency window for SERP-level freshness filtering. */
export type Freshness = 'day' | 'week' | 'month' | 'year';
/** Per-engine freshness param maps. Startpage's `with_date` is verified to filter; Bing's ez1/2/3 is documented
 * (day/week/month only — no year); DDG's `df` works on residential IPs. Mojeek has no time filter. */
const SP_DATE: Record<Freshness, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };
const BING_EZ: Partial<Record<Freshness, string>> = { day: 'ez1', week: 'ez2', month: 'ez3' };
const DDG_DF: Record<Freshness, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };

interface EngineOpts { region?: string; freshness?: Freshness; proxy?: string; }

// ── Proxy support ──────────────────────────────────────────────────────────
// When VORTEX_PROXIES is set ("http://a:b@host:port,http://..."), engine fetches route through a proxy
// (undici ProxyAgent dispatcher), reviving engines bot-walled from the host IP (DDG/Mojeek/Brave). With
// no proxy configured this is fully inert — the fast lean path is unchanged.
let _proxyList: string[] | null = null;
function proxyList(): string[] {
  if (_proxyList === null) _proxyList = (process.env.VORTEX_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  return _proxyList;
}
export function proxiesConfigured(): boolean { return proxyList().length > 0; }
let _proxyIdx = 0;
function nextProxy(): string | undefined {
  const list = proxyList();
  return list.length ? list[_proxyIdx++ % list.length] : undefined;
}
const _dispatchers = new Map<string, unknown>();
async function dispatcherFor(proxy: string): Promise<unknown> {
  if (_dispatchers.has(proxy)) return _dispatchers.get(proxy);
  try {
    const { ProxyAgent } = await import('undici');
    const d = new ProxyAgent(proxy);
    _dispatchers.set(proxy, d);
    return d;
  } catch { return undefined; }
}

/** Fallback engine (e.g. headful stealth-Chrome Google). Supplied by the caller so core imports no browser SDK. */
export type FallbackSearch = (query: string, max: number) => Promise<{ title: string; url: string }[]>;

/**
 * Startpage first: it proxies Google's index and stays reachable over plain fetch from IPs where
 * DDG/Mojeek/Brave are bot-walled. Bing is the other reliably-scrapeable HTML endpoint. DDG + Mojeek
 * are kept as best-effort — they cost nothing in parallel and revive on other IPs / logged-in sessions.
 */
// DuckDuckGo's HTML/lite endpoints both bot-wall over plain fetch (202 "anomaly") AND hang until timeout,
// so it's left OUT of the no-proxy defaults — opt back in via `engines` when on a residential IP where it works.
// Brave verified live over plain fetch 2026-07-02 (its earlier 429-wall lifted) — engine health rotates, and
// the circuit breaker below absorbs whichever of these is currently walled (Startpage/Mojeek as of 2026-07-02).
const DEFAULT_ENGINES: SearchEngine[] = ['brave', 'startpage', 'bing', 'mojeek'];
// With a proxy configured, the IP-blocked engines become viable again — widen the pool for stronger fusion.
const PROXY_ENGINES: SearchEngine[] = ['startpage', 'bing', 'brave', 'duckduckgo', 'mojeek'];
/** RRF constant. 60 is the value from the original Cormack et al. paper. */
const RRF_K = 60;
/** Weight of single-document relevance (title+snippet vs query) blended on top of RRF. */
const RELEVANCE_WEIGHT = 0.04;
/** Per-extra-engine agreement bonus — a result two engines independently found is worth more. */
const AGREEMENT_BONUS = 0.01;
const PER_ENGINE_TIMEOUT_MS = 6000;
/** Soft latency budget: once ≥1 engine has returned results and this much time has passed, stop
 * waiting for stragglers (they're reported as status 'timeout'). Keeps one slow engine from
 * holding the whole search hostage; with zero results yet, we still wait out the per-engine timeout. */
const SOFT_BUDGET_MS = 2500;
/** Default cap on results from any single domain in the final list (prevents one-site domination). */
const DEFAULT_PER_DOMAIN = 3;

// ── Per-engine circuit breaker ─────────────────────────────────────────────
// A bot-walled engine (BlockedError) stays walled for minutes-to-hours, not milliseconds. Hitting it
// on every search wastes latency AND digs the block deeper. After a block, skip the engine for an
// exponential cooldown (5 → 30 min); a successful call resets it. State is process-lifetime.
const BREAKER_BASE_MS = 5 * 60_000;
const BREAKER_MAX_MS = 30 * 60_000;
interface BreakerState { until: number; strikes: number; }
const engineBreaker = new Map<string, BreakerState>();
function breakerCooldownMs(engine: string): number {
  const s = engineBreaker.get(engine);
  return s ? Math.max(0, s.until - Date.now()) : 0;
}
function breakerTrip(engine: string): void {
  const s = engineBreaker.get(engine) ?? { until: 0, strikes: 0 };
  s.strikes = Math.min(s.strikes + 1, 4);
  s.until = Date.now() + Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * 2 ** (s.strikes - 1));
  engineBreaker.set(engine, s);
}
function breakerReset(engine: string): void { engineBreaker.delete(engine); }
/** Test/diagnostic hook: clear all engine cooldowns. */
export function resetEngineCooldowns(): void { engineBreaker.clear(); }

/** Short-TTL cache so repeated/near-repeated queries don't re-hit engines (slower + raises bot-detection). */
const searchCache = new GenericCache<SearchResponse>(5 * 60_000, 200);

/** A throw of this type means the engine was bot-walled (not merely empty) — surfaced as status 'blocked'. */
export class BlockedError extends Error {
  constructor(public engine: string, public detail: string) {
    super(`${engine} blocked: ${detail}`);
    this.name = 'BlockedError';
  }
}

/** Normalize a URL for cross-engine dedupe: lowercase host, strip www/m/amp, drop tracking params, trailing slash, fragment. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^(www|m|amp)\./, '');
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref'];
    drop.forEach((p) => u.searchParams.delete(p));
    let s = u.toString();
    s = s.replace(/\/$/, '');
    return s;
  } catch {
    return raw.replace(/\/$/, '');
  }
}

function domainOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^(www|m|amp)\./, ''); } catch { return ''; }
}

interface FetchResult { status: number; html: string; }

async function fetchHtml(url: string, init?: RequestInit, proxy?: string): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_ENGINE_TIMEOUT_MS);
  try {
    const dispatcher = proxy ? await dispatcherFor(proxy) : undefined;
    const opts: Record<string, unknown> = {
      ...init,
      headers: { ...generateHeaders(url), ...(init?.headers || {}) },
      signal: ctrl.signal,
    };
    // `dispatcher` is a Node/undici-only fetch option (absent from lib.dom's RequestInit) — set via cast.
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch(url, opts as RequestInit);
    return { status: res.status, html: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Common bot-wall signatures across engines: throttle status codes + interstitial body text. */
function assertNotBlocked(engine: string, { status, html }: FetchResult): void {
  if (status === 202 || status === 403 || status === 429 || status === 503) {
    throw new BlockedError(engine, `HTTP ${status}`);
  }
  if (/our systems have detected unusual traffic|before you continue|are you a robot|captcha|anomaly|access denied/i.test(html.slice(0, 3000))) {
    throw new BlockedError(engine, 'interstitial');
  }
}

/** Startpage — proxies Google's index. POST/GET both work; GET is simplest. Strip css-in-js <style> noise. */
async function searchStartpage(query: string, max: number, opts?: EngineOpts): Promise<SearchResult[]> {
  const params = new URLSearchParams({ query, cat: 'web' });
  if (opts?.freshness) params.set('with_date', SP_DATE[opts.freshness]);
  const fr = await fetchHtml(`https://www.startpage.com/sp/search?${params}`, undefined, opts?.proxy);
  assertNotBlocked('startpage', fr);
  const $ = cheerio.load(fr.html);
  $('style').remove(); // styled-components inline <style> blocks pollute .text()
  const out: SearchResult[] = [];
  $('.w-gl__result, .result').each((_i, el) => {
    if (out.length >= max) return;
    const $el = $(el);
    const title = $el.find('h2, h3').first().text().trim();
    const url = $el.find('a.result-link, a.result-title, a[href^="http"]').first().attr('href') || '';
    const snippet = $el.find('.description, p.description, p').first().text().trim();
    if (title && url && url.startsWith('http')) out.push({ title, url, snippet });
  });
  return out;
}

/** DuckDuckGo HTML endpoint. POST form. Wraps result URLs in a uddg= redirect. */
async function searchDuckDuckGo(query: string, max: number, opts?: EngineOpts): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, kl: opts?.region || '' });
  if (opts?.freshness) params.set('df', DDG_DF[opts.freshness]);
  const fr = await fetchHtml(`https://html.duckduckgo.com/html/?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  }, opts?.proxy);
  assertNotBlocked('duckduckgo', fr);
  const $ = cheerio.load(fr.html);
  const out: SearchResult[] = [];
  $('.result').each((_i, el) => {
    if (out.length >= max) return;
    const $el = $(el);
    const titleEl = $el.find('.result__a');
    const title = titleEl.text().trim();
    let url = titleEl.attr('href') || '';
    if (url.includes('uddg=')) {
      try {
        const decoded = new URL(url, 'https://duckduckgo.com');
        url = decodeURIComponent(decoded.searchParams.get('uddg') || url);
      } catch { /* keep original */ }
    }
    const snippet = $el.find('.result__snippet').text().trim();
    if (title && url && url.startsWith('http')) out.push({ title, url, snippet });
  });
  return out;
}

/** Bing wraps result URLs in a bing.com/ck/a redirect with the real URL base64url-encoded in the `u=a1…` param. */
export function decodeBingUrl(href: string): string {
  if (!href.includes('bing.com/ck/a')) return href;
  try {
    const enc = new URL(href).searchParams.get('u') || '';
    if (enc.startsWith('a1')) {
      let b64 = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (decoded.startsWith('http')) return decoded;
    }
  } catch { /* keep original */ }
  return href;
}

/** Bing HTML results. GET. */
async function searchBing(query: string, max: number, opts?: EngineOpts): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(max), setlang: 'en' });
  if (opts?.freshness && BING_EZ[opts.freshness]) params.set('filters', `ex1:"${BING_EZ[opts.freshness]}"`);
  const fr = await fetchHtml(`https://www.bing.com/search?${params}`, undefined, opts?.proxy);
  assertNotBlocked('bing', fr);
  const $ = cheerio.load(fr.html);
  const out: SearchResult[] = [];
  $('li.b_algo').each((_i, el) => {
    if (out.length >= max) return;
    const $el = $(el);
    const a = $el.find('h2 a').first();
    const title = a.text().trim();
    const url = decodeBingUrl(a.attr('href') || '');
    const snippet = $el.find('.b_caption p, p.b_lineclamp2, .b_caption').first().text().trim();
    if (title && url && url.startsWith('http')) out.push({ title, url, snippet });
  });
  return out;
}

/** Mojeek — independent index, scrape-friendly when not IP-blocked. GET. */
async function searchMojeek(query: string, max: number, opts?: EngineOpts): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const fr = await fetchHtml(`https://www.mojeek.com/search?${params}`, undefined, opts?.proxy);
  assertNotBlocked('mojeek', fr);
  const $ = cheerio.load(fr.html);
  const out: SearchResult[] = [];
  // Real results are <li class="r1|r2|…">; title is <h2><a class="title">, the <a class="ob"> is just the URL line.
  $('ul.results-standard > li[class^="r"], ol.results li').each((_i, el) => {
    if (out.length >= max) return;
    const $el = $(el);
    const a = $el.find('h2 a').first();
    const title = a.text().trim();
    const url = a.attr('href') || '';
    const snippet = $el.find('p.s, .s').first().text().trim();
    if (title && url && url.startsWith('http')) out.push({ title, url, snippet });
  });
  return out;
}

/** Brave — independent index, answers 200/clean over plain fetch (live-verified 2026-07-02). Svelte DOM:
 * each web result is `.snippet[data-type="web"]`, title in `.title`, description in `.content`. */
async function searchBrave(query: string, max: number, opts?: EngineOpts): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, source: 'web' });
  const fr = await fetchHtml(`https://search.brave.com/search?${params}`, undefined, opts?.proxy);
  assertNotBlocked('brave', fr);
  const $ = cheerio.load(fr.html);
  const out: SearchResult[] = [];
  $('.snippet[data-type="web"], #results .snippet').each((_i, el) => {
    if (out.length >= max) return;
    const $el = $(el);
    const a = $el.find('a[href^="http"]').first();
    const url = a.attr('href') || '';
    const title = $el.find('.title, [class*="snippet-title"]').first().text().trim();
    const snippet = $el.find('.content, .snippet-description, [class*="description"]').first().text().trim();
    if (title && url && url.startsWith('http') && !/(^|\.)brave\.com/.test(url)) out.push({ title, url, snippet });
  });
  return out;
}

const ENGINE_FNS: Record<SearchEngine, (q: string, max: number, opts?: EngineOpts) => Promise<SearchResult[]>> = {
  startpage: searchStartpage,
  duckduckgo: searchDuckDuckGo,
  bing: searchBing,
  mojeek: searchMojeek,
  brave: searchBrave,
};

interface Merged extends SearchResult { _engines: Set<string>; _rrf: number; _rel: number; }

/** Blend RRF (cross-engine rank agreement) with single-doc relevance and an agreement bonus. */
function finalScore(m: Merged): number {
  return m._rrf + RELEVANCE_WEIGHT * m._rel + AGREEMENT_BONUS * (m._engines.size - 1);
}

/** Hosts that mass-republish other outlets' articles verbatim — when a title-dupe pair straddles one
 * of these and an original domain, keep the original URL (better for follow-up extraction). */
const SYNDICATION_HOSTS = /(^|\.)(msn\.com|news\.yahoo\.com|finance\.yahoo\.com|flipboard\.com)$/i;

/** Key for cross-domain syndication dedupe: same headline on two domains is (almost always) the same
 * article republished. Only long titles qualify — short/generic ones collide legitimately. */
function titleKey(title: string): string | null {
  const k = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return k.length >= 25 ? k : null;
}

/** Fold one engine's ranked results into the merge map (RRF + relevance), deduping by normalized URL
 * and — for long titles — by headline across domains (kills MSN/Yahoo syndication copies flooding the pool). */
function foldEngine(
  merged: Map<string, Merged>,
  engine: string,
  results: SearchResult[],
  terms: string[],
  titleIndex: Map<string, string> = new Map(),
): void {
  results.forEach((r, rank) => {
    const key = normalizeUrl(r.url);
    const contrib = 1 / (RRF_K + rank + 1);
    const tkey = titleKey(r.title);
    const existing = merged.get(key) ?? (tkey ? merged.get(titleIndex.get(tkey) || '') : undefined);
    if (existing) {
      existing._engines.add(engine);
      existing._rrf += contrib;
      if (!existing.snippet && r.snippet) existing.snippet = r.snippet;
      if (existing.title.length < r.title.length) existing.title = r.title;
      // Same article on a syndicator AND its original outlet → keep the original's URL.
      if (SYNDICATION_HOSTS.test(domainOf(existing.url)) && !SYNDICATION_HOSTS.test(domainOf(r.url))) {
        existing.url = r.url;
      }
    } else {
      const rel = bm25ish(terms, `${r.title} ${r.snippet}`, r.title);
      merged.set(key, { ...r, _engines: new Set([engine]), _rrf: contrib, _rel: rel });
      if (tkey) titleIndex.set(tkey, key);
    }
  });
}

/** Final ordering: blended score desc, with a per-domain cap applied greedily (then top-up if short). */
function rankAndCap(merged: Map<string, Merged>, maxResults: number, perDomain: number): SearchResult[] {
  const sorted = [...merged.values()].sort((a, b) => finalScore(b) - finalScore(a));
  const picked: Merged[] = [];
  const domainCount = new Map<string, number>();
  const overflow: Merged[] = [];
  for (const m of sorted) {
    if (picked.length >= maxResults) break;
    const dom = domainOf(m.url);
    const n = domainCount.get(dom) || 0;
    if (n >= perDomain) { overflow.push(m); continue; }
    domainCount.set(dom, n + 1);
    picked.push(m);
  }
  // If the domain cap left us short of maxResults, top up from the overflow (still best-score order).
  for (const m of overflow) {
    if (picked.length >= maxResults) break;
    picked.push(m);
  }
  return picked.slice(0, maxResults).map((m) => ({
    title: m.title,
    url: m.url,
    snippet: m.snippet,
    engines: [...m._engines],
    score: Number(finalScore(m).toFixed(4)),
  }));
}

/**
 * Multi-engine web search with relevance-blended reciprocal-rank fusion.
 *
 * Queries several independent engines in parallel, merges + dedupes by normalized URL, and ranks by
 * RRF (cross-engine agreement) BLENDED with single-document relevance (so a strong-match page that only
 * one engine returned isn't buried) plus a per-domain diversity cap. Reports per-engine health so a
 * bot-walled/rotted engine is visible instead of silently degrading the pool. No API keys.
 *
 * Hybrid fallback: pass `fallback` (e.g. headful-Chrome Google search). When the fast fetch tier comes
 * up thin — too few results, only one live engine, or weak top relevance — the fallback backfills the
 * pool and everything is re-fused together. Free + fast in the common case; real-browser muscle only when needed.
 */
export async function search(query: string, options?: {
  maxResults?: number;
  region?: string;
  engines?: SearchEngine[];
  perDomain?: number;
  /** SERP-level recency filter (verified on Startpage; best-effort on Bing/DDG). */
  freshness?: Freshness;
  fallback?: FallbackSearch;
  /** Skip the short-TTL cache for this call. */
  noCache?: boolean;
}): Promise<SearchResponse> {
  const start = performance.now();
  const maxResults = options?.maxResults ?? 10;
  const engines = options?.engines?.length ? options.engines : (proxiesConfigured() ? PROXY_ENGINES : DEFAULT_ENGINES);
  const perDomain = options?.perDomain ?? DEFAULT_PER_DOMAIN;
  const terms = tokenize(query);
  const cacheKey = `${query} ${maxResults} ${options?.region || ''} ${options?.freshness || ''} ${engines.join(',')}`;

  if (!options?.noCache) {
    const hit = searchCache.get(cacheKey);
    if (hit) return hit;
  }

  // Over-fetch per engine so the fusion has depth to work with.
  const perEngine = Math.max(maxResults, 10);

  const merged = new Map<string, Merged>();
  const titleIndex = new Map<string, string>();
  const reports: EngineReport[] = [];
  const sources: string[] = [];

  // Circuit breaker: skip engines still cooling down from a recent bot-wall — free latency, and it
  // keeps us from digging the block deeper. They rejoin automatically when the cooldown expires.
  const active: SearchEngine[] = [];
  for (const e of engines) {
    const cd = breakerCooldownMs(e);
    if (cd > 0) reports.push({ engine: e, status: 'blocked', count: 0, ms: 0, note: `cooldown ${Math.ceil(cd / 1000)}s (recent bot-wall)` });
    else active.push(e);
  }

  // Fire all live engines in parallel; settle either when every engine answers or when the soft
  // budget elapses with at least one engine's results in hand (stragglers → status 'timeout').
  type Outcome = { results?: SearchResult[]; err?: Error; ms: number };
  const outcomes = new Map<SearchEngine, Outcome>();
  await new Promise<void>((resolve) => {
    if (!active.length) return resolve();
    let softExpired = false;
    const timer = setTimeout(() => { softExpired = true; check(); }, SOFT_BUDGET_MS);
    const check = () => {
      const allDone = outcomes.size === active.length;
      const anyResults = [...outcomes.values()].some((o) => o.results?.length);
      if (allDone || (softExpired && anyResults)) { clearTimeout(timer); resolve(); }
    };
    for (const e of active) {
      const t0 = performance.now();
      ENGINE_FNS[e](query, perEngine, { region: options?.region, freshness: options?.freshness, proxy: nextProxy() })
        .then((results) => outcomes.set(e, { results, ms: performance.now() - t0 }))
        .catch((err) => outcomes.set(e, { err: err as Error, ms: performance.now() - t0 }))
        .finally(check);
    }
  });
  const fetchMs = performance.now() - start;

  for (const e of active) {
    const o = outcomes.get(e);
    if (!o) {
      reports.push({ engine: e, status: 'timeout', count: 0, ms: Math.round(fetchMs), note: `no answer within ${SOFT_BUDGET_MS}ms soft budget` });
      continue;
    }
    if (o.results) {
      breakerReset(e);
      reports.push({ engine: e, status: o.results.length ? 'ok' : 'zero', count: o.results.length, ms: Math.round(o.ms) });
      if (o.results.length) { sources.push(e); foldEngine(merged, e, o.results, terms, titleIndex); }
    } else {
      const blocked = o.err?.name === 'BlockedError';
      if (blocked) breakerTrip(e);
      reports.push({
        engine: e, status: blocked ? 'blocked' : 'error', count: 0,
        ms: Math.round(o.ms), note: (o.err?.message || 'error').slice(0, 80),
      });
    }
  }

  // ── Hybrid fallback tier ──────────────────────────────────────────────
  // Escalate to the stealth-Chrome engine when the fast tier is weak.
  const okCount = reports.filter((r) => r.status === 'ok').length;
  const bestRel = [...merged.values()].reduce((mx, m) => Math.max(mx, m._rel), 0);
  const thin = merged.size < Math.min(3, maxResults);
  const lowDiversity = okCount <= 1;
  const weakTop = bestRel < 0.12;
  let usedFallback = false;
  if (options?.fallback && (thin || lowDiversity || weakTop)) {
    try {
      const fb = await options.fallback(query, perEngine);
      if (fb.length) {
        usedFallback = true;
        sources.push('google');
        foldEngine(merged, 'google', fb.map((r) => ({ title: r.title, url: r.url, snippet: '' })), terms, titleIndex);
        reports.push({ engine: 'google', status: 'ok', count: fb.length, ms: 0, note: 'stealth-chrome fallback' });
      } else {
        reports.push({ engine: 'google', status: 'zero', count: 0, ms: 0, note: 'fallback returned 0' });
      }
    } catch (err) {
      reports.push({ engine: 'google', status: 'error', count: 0, ms: 0, note: ((err as Error)?.message || 'fallback error').slice(0, 80) });
    }
  }

  const results = rankAndCap(merged, maxResults, perDomain);

  const response: SearchResponse = {
    query,
    results,
    totalResults: results.length,
    sources,
    engineReports: reports,
    usedFallback,
    timing: { fetchMs, totalMs: performance.now() - start },
  };
  if (!options?.noCache) searchCache.set(cacheKey, response);
  return response;
}
