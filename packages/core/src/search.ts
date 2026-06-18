import * as cheerio from 'cheerio';
import { generateHeaders } from './antibot/headers.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Which engines returned this result (multi-engine mode). */
  engines?: string[];
  /** Reciprocal-rank-fusion score (higher = stronger cross-engine agreement). */
  score?: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults: number;
  /** Engines that actually responded with results this call. */
  sources?: string[];
  timing: { fetchMs: number; totalMs: number };
}

export type SearchEngine = 'duckduckgo' | 'bing' | 'mojeek';

const DEFAULT_ENGINES: SearchEngine[] = ['duckduckgo', 'bing', 'mojeek'];
/** RRF constant. 60 is the value from the original Cormack et al. paper. */
const RRF_K = 60;
const PER_ENGINE_TIMEOUT_MS = 8000;

/** Normalize a URL for cross-engine dedupe: lowercase host, drop tracking params, trailing slash, fragment. */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref'];
    drop.forEach((p) => u.searchParams.delete(p));
    let s = u.toString();
    s = s.replace(/\/$/, '');
    return s;
  } catch {
    return raw.replace(/\/$/, '');
  }
}

async function fetchHtml(url: string, init?: RequestInit): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_ENGINE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...generateHeaders(url), ...(init?.headers || {}) },
      signal: ctrl.signal,
    });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** DuckDuckGo HTML endpoint. POST form. Wraps result URLs in a uddg= redirect. */
async function searchDuckDuckGo(query: string, max: number, region?: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, kl: region || '' });
  const html = await fetchHtml(`https://html.duckduckgo.com/html/?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const $ = cheerio.load(html);
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
function decodeBingUrl(href: string): string {
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
async function searchBing(query: string, max: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(max), setlang: 'en' });
  const html = await fetchHtml(`https://www.bing.com/search?${params}`);
  const $ = cheerio.load(html);
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

/** Mojeek — independent index, scrape-friendly. GET. */
async function searchMojeek(query: string, max: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const html = await fetchHtml(`https://www.mojeek.com/search?${params}`);
  const $ = cheerio.load(html);
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

const ENGINE_FNS: Record<SearchEngine, (q: string, max: number, region?: string) => Promise<SearchResult[]>> = {
  duckduckgo: searchDuckDuckGo,
  bing: searchBing,
  mojeek: searchMojeek,
};

/**
 * Multi-engine web search with reciprocal-rank fusion.
 * Queries several independent engines in parallel, merges + dedupes by normalized URL,
 * and ranks by cross-engine agreement (results found by multiple engines rise to the top).
 * No API keys, no rate-limited single source. Falls back gracefully if an engine fails;
 * if every engine fails, returns an empty result set rather than throwing.
 */
export async function search(query: string, options?: {
  maxResults?: number;
  region?: string;
  engines?: SearchEngine[];
}): Promise<SearchResponse> {
  const start = performance.now();
  const maxResults = options?.maxResults ?? 10;
  const engines = options?.engines?.length ? options.engines : DEFAULT_ENGINES;
  // Over-fetch per engine so the fusion has depth to work with.
  const perEngine = Math.max(maxResults, 10);

  const settled = await Promise.allSettled(
    engines.map((e) => ENGINE_FNS[e](query, perEngine, options?.region))
  );
  const fetchMs = performance.now() - start;

  // Reciprocal-rank fusion across engines.
  const merged = new Map<string, SearchResult & { _engines: Set<string>; _score: number }>();
  const sources: string[] = [];
  settled.forEach((res, idx) => {
    const engine = engines[idx];
    if (res.status !== 'fulfilled' || res.value.length === 0) return;
    sources.push(engine);
    res.value.forEach((r, rank) => {
      const key = normalizeUrl(r.url);
      const contrib = 1 / (RRF_K + rank + 1);
      const existing = merged.get(key);
      if (existing) {
        existing._engines.add(engine);
        existing._score += contrib;
        if (!existing.snippet && r.snippet) existing.snippet = r.snippet;
        if (existing.title.length < r.title.length) existing.title = r.title;
      } else {
        merged.set(key, { ...r, _engines: new Set([engine]), _score: contrib });
      }
    });
  });

  const results: SearchResult[] = [...merged.values()]
    .sort((a, b) => b._score - a._score)
    .slice(0, maxResults)
    .map(({ _engines, _score, ...r }) => ({
      ...r,
      engines: [..._engines],
      score: Number(_score.toFixed(4)),
    }));

  return {
    query,
    results,
    totalResults: results.length,
    sources,
    timing: { fetchMs, totalMs: performance.now() - start },
  };
}
