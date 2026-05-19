import * as cheerio from 'cheerio';
import { generateHeaders } from './antibot/headers.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults: number;
  timing: { fetchMs: number; totalMs: number };
}

/**
 * Web search via DuckDuckGo's HTML endpoint.
 * No API key needed. No rate limits (within reason).
 * Returns clean structured results.
 */
export async function search(query: string, options?: {
  maxResults?: number;
  region?: string;
}): Promise<SearchResponse> {
  const start = performance.now();
  const maxResults = options?.maxResults ?? 10;

  const params = new URLSearchParams({
    q: query,
    kl: options?.region || '',
  });

  const url = `https://html.duckduckgo.com/html/?${params}`;
  const headers = generateHeaders(url);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const html = await response.text();
  const fetchMs = performance.now() - start;

  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results are in .result elements
  $('.result').each((i, el) => {
    if (results.length >= maxResults) return;

    const $el = $(el);
    const titleEl = $el.find('.result__a');
    const snippetEl = $el.find('.result__snippet');

    const title = titleEl.text().trim();
    let resultUrl = titleEl.attr('href') || '';

    // DuckDuckGo wraps URLs in redirect links
    if (resultUrl.includes('uddg=')) {
      try {
        const decoded = new URL(resultUrl, 'https://duckduckgo.com');
        resultUrl = decodeURIComponent(decoded.searchParams.get('uddg') || resultUrl);
      } catch {
        // Keep original URL
      }
    }

    const snippet = snippetEl.text().trim();

    if (title && resultUrl) {
      results.push({ title, url: resultUrl, snippet });
    }
  });

  return {
    query,
    results,
    totalResults: results.length,
    timing: {
      fetchMs,
      totalMs: performance.now() - start,
    },
  };
}
