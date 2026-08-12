import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VortexCrawler, search, AgentBrowser, browse, reach, discover, discoverDomain, track, getWatchlist, setWatchlist, ProxyManager, ocrUrl, ocrAvailable, VortexDaemonClient } from '@stevecortesp/vortex-core';
import { collapseAxElements } from './ax-collapse.js';

// ── Output cap for page-fetch tools ──────────────────────────────────────────
// web_fetch/reach used to return the daemon's full extraction verbatim (measured 61KB for one
// page — a token bomb). Cap the big markdown field(s) at a paragraph boundary, leave metadata
// intact. reach() nests the page under `result` (ReachOutcome.ok === true), handled recursively.
function truncateAtParagraph(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf('\n\n', maxChars);
  const kept = text.slice(0, cut > 0 ? cut : maxChars);
  return `${kept}\n\n[truncated: showing ${kept.length} of ${text.length} chars — pass maxChars for more]`;
}
function capTextFields<T>(result: T, maxChars: number): T {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !(maxChars > 0)) return result;
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const key of ['markdown', 'content', 'text']) {
    if (typeof out[key] === 'string' && (out[key] as string).length > maxChars) out[key] = truncateAtParagraph(out[key] as string, maxChars);
  }
  if (out.result && typeof out.result === 'object') out.result = capTextFields(out.result, maxChars);
  return out as T;
}

// Cookie-fetch tier for scrape/crawl: route raw HTML through the daemon's logged-in VANTA session when
// the daemon is up (no-render, real cookies). Throws when the daemon is down → adaptive-fetcher falls
// through to its normal http/jsdom/browser ladder. Inert with no daemon.
const cookieFetcher = {
  async httpFetch(url: string, opts?: { timeoutMs?: number }) {
    if (!(await daemonUp())) throw new Error('daemon down');
    return daemon.call<{ status: number; finalUrl: string; headers: Record<string, string>; body: string }>('/fetch', { url, timeoutMs: opts?.timeoutMs });
  },
};
const crawler = new VortexCrawler(undefined, cookieFetcher);
// Proxies (optional) come from VORTEX_PROXIES="http://a:b@host:port,http://..." — consulted by stealth/rotating.
const proxyManager = new ProxyManager((process.env.VORTEX_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean));
const browser = new AgentBrowser({ proxyManager });

// ── Shared browser daemon (preferred when running) ───────────────────────────
// If the local browser daemon (browser-daemon.mjs) is up, route all browser/browse/reach/search work
// through it so Claude shares ONE warm Chromium with VANTA + the background daemons — no duplicate
// browsers, no profile-dir lock fights, and the daemon's shared governor rate-limits globally. When
// the daemon is DOWN we transparently fall back to the in-process browser (unchanged legacy behavior).
// The in-process `browser`/`googleBrowser` are only ever opened on the fallback path.
const daemon = new VortexDaemonClient();
let _daemonOk: boolean | null = null;
let _daemonCheckedAt = 0;
async function daemonUp(): Promise<boolean> {
  if (Date.now() - _daemonCheckedAt < 30_000 && _daemonOk !== null) return _daemonOk;
  _daemonOk = await daemon.healthy().catch(() => false);
  _daemonCheckedAt = Date.now();
  return _daemonOk;
}

// Warm stealth-Chrome for the hybrid web_search fallback tier (and search_google). Lazily launched and
// kept alive across calls so the ~seconds launch cost is paid once, not per query. Persistent profile —
// log into Google ONCE (headful) and the session sticks; logged-in Google rarely rate-limits. One shared
// singleton avoids a user-data-dir lock conflict between web_search's fallback and search_google.
const trackerDir = process.env.VORTEX_TRACKER_DIR || `${process.env.HOME}/.vortex-tracker`;
let googleBrowser: AgentBrowser | null = null;
async function getGoogleBrowser(): Promise<AgentBrowser> {
  if (!googleBrowser) {
    googleBrowser = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${trackerDir}/google-profile` });
    await googleBrowser.open();
  }
  return googleBrowser;
}

const server = new McpServer({
  name: 'vortex-crawler',
  version: '0.1.0',
});

// ─── Tool: scrape_url ────────────────────────────────
server.tool(
  'scrape_url',
  'Fetch a single URL and return clean markdown content optimized for LLMs. Returns title, content, token count, and optionally discovered links.',
  {
    url: z.string().url().describe('The URL to scrape'),
    format: z.enum(['markdown', 'html', 'text']).default('markdown').describe('Output format'),
    includeLinks: z.boolean().default(false).describe('Include discovered links in output'),
    chunkSize: z.number().optional().describe('Split content into chunks of N tokens'),
    tier: z.enum(['http', 'jsdom', 'browser']).optional().describe('Force a specific rendering tier'),
  },
  async (args) => {
    const result = await crawler.scrape(args.url, {
      tier: args.tier,
      output: { format: args.format, chunkSize: args.chunkSize },
    });

    const content = args.format === 'html' ? result.html
      : args.format === 'text' ? result.text
      : result.markdown;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          url: result.url,
          title: result.metadata.title,
          description: result.metadata.description,
          tier: result.tier,
          tokens: result.tokens,
          content,
          ...(args.includeLinks ? { links: result.links } : {}),
          ...(result.chunks ? { chunks: result.chunks } : {}),
          timing: result.timing,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: crawl_site ────────────────────────────────
server.tool(
  'crawl_site',
  'Crawl multiple pages from a website, following internal links. Returns markdown content for each page found.',
  {
    url: z.string().url().describe('The starting URL to crawl from'),
    maxPages: z.number().default(10).describe('Maximum number of pages to crawl'),
    maxDepth: z.number().default(3).describe('Maximum link depth to follow'),
    include: z.array(z.string()).optional().describe('URL glob patterns to include'),
    exclude: z.array(z.string()).optional().describe('URL glob patterns to exclude'),
  },
  async (args) => {
    const results: Array<{
      url: string;
      title: string;
      tokens: { markdown: number; reduction: number };
      content: string;
    }> = [];

    for await (const result of crawler.crawl(args.url, {
      maxPages: args.maxPages,
      maxDepth: args.maxDepth,
      include: args.include,
      exclude: args.exclude,
    })) {
      results.push({
        url: result.url,
        title: result.metadata.title,
        tokens: { markdown: result.tokens.markdown, reduction: result.tokens.reduction },
        content: result.markdown,
      });
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          pagesFound: results.length,
          results,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: map_site ──────────────────────────────────
server.tool(
  'map_site',
  'Discover all pages on a website via sitemap.xml and link crawling. Returns a list of URLs.',
  {
    url: z.string().url().describe('The website URL to map'),
    maxUrls: z.number().default(100).describe('Maximum URLs to discover'),
  },
  async (args) => {
    const sitemap = await crawler.map(args.url, { maxUrls: args.maxUrls });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(sitemap, null, 2),
      }],
    };
  }
);

// ─── Tool: extract_data ──────────────────────────────
server.tool(
  'extract_data',
  'Extract structured data from a URL using CSS selectors. Returns extracted fields as JSON.',
  {
    url: z.string().url().describe('The URL to extract data from'),
    selectors: z.record(z.string()).describe('Map of field names to CSS selectors, e.g. {"title": "h1", "price": ".price"}'),
  },
  async (args) => {
    const result = await crawler.scrape(args.url);

    // Run CSS selectors on the HTML
    const cheerio = await import('cheerio');
    const $ = cheerio.load(result.html);

    const extracted: Record<string, string | string[]> = {};
    for (const [field, selector] of Object.entries(args.selectors)) {
      const elements = $(selector);
      if (elements.length === 1) {
        extracted[field] = elements.text().trim();
      } else if (elements.length > 1) {
        extracted[field] = elements.map((_, el) => $(el).text().trim()).get();
      } else {
        extracted[field] = '';
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          url: result.url,
          title: result.metadata.title,
          extracted,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: web_search ────────────────────────────────
server.tool(
  'web_search',
  'Multi-engine web search (Brave + Startpage + Bing + Mojeek) fused via relevance-blended reciprocal-rank, with a per-engine circuit breaker (bot-walled engines are skipped while cooling down) and syndication dedupe (MSN/Yahoo copies collapse into the original article). When the VANTA browser is connected, your logged-in google-session is fused in as a first-class engine — so results stay strong even when the fetch engines are walled. No API key. Returns titles, URLs, snippets, the engines that found each result, a blended score, and a per-engine health report (engineReports). Hybrid: if the fast tier is still thin, it auto-escalates to a warm stealth-Chrome Google search to backfill (set browserFallback:false to disable).',
  {
    query: z.string().describe('The search query'),
    maxResults: z.number().default(10).describe('Maximum number of results to return'),
    recency: z.enum(['day', 'week', 'month', 'year']).optional().describe('SERP-level recency filter — only return results from the last day/week/month/year. Use for "latest"/"today" queries.'),
    browserFallback: z.boolean().default(true).describe('Allow auto-escalation to the warm stealth-Chrome Google fallback when the fast tier is thin'),
    rerankTop: z.number().min(1).max(8).default(4).describe('When the daemon is available, content-rerank only this many top results synchronously for speed'),
    youtube: z.boolean().default(true).describe('Route YouTube/latest-video queries through the YouTube vertical path when the daemon is available'),
  },
  async (args) => {
    // When the daemon is up, run the whole search there — its warm Google browser handles the fallback,
    // so the MCP never launches a second headful Chrome for the fallback tier.
    const results = await daemonUp()
      ? await daemon.search(args.query, { maxResults: args.maxResults, recency: args.recency, browserFallback: args.browserFallback, rerankTop: args.rerankTop, youtube: args.youtube })
      : await search(args.query, {
          maxResults: args.maxResults,
          freshness: args.recency,
          fallback: args.browserFallback === false ? undefined : (q, max) => getGoogleBrowser().then((b) => b.googleSearch(q, max)),
        });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(results, null, 2),
      }],
    };
  }
);

// ─── Agent browser: persistent autonomous Chromium session ───
// Dedicated clean profile. Logins persist once seeded manually. Autonomous EXCEPT hard-stops
// on credential/payment fields, financial-action clicks, and CAPTCHAs (returns a refusal note).
const browserResult = (r: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] });

server.tool('browser_open', 'Launch the persistent agent browser (dedicated clean profile, headless). Idempotent.',
  {},
  async () => browserResult(await daemonUp() ? { ok: true, note: 'using shared browser daemon' } : await browser.open())
);
server.tool('browser_goto', 'Navigate the agent browser to a URL.',
  { url: z.string().url().describe('URL to open'), waitFor: z.string().optional().describe('Optional CSS selector to wait for') },
  async (args) => browserResult(await daemonUp() ? await daemon.goto(args.url, args.waitFor) : await browser.goto(args.url, args.waitFor))
);
server.tool('browser_click', 'Click an element by CSS selector, or by visible text when byText=true. Refuses obvious financial/purchase actions.',
  { target: z.string().describe('CSS selector or visible text'), byText: z.boolean().default(false).describe('Treat target as visible text') },
  async (args) => browserResult(await daemonUp() ? await daemon.click(args.target, args.byText) : await browser.click(args.target, args.byText))
);
server.tool('browser_type', 'Type text into a field by CSS selector. Refuses credential/payment fields (seed logins manually). Set submit=true to press Enter.',
  { selector: z.string().describe('CSS selector of the input'), text: z.string().describe('Text to type'), submit: z.boolean().default(false) },
  async (args) => browserResult(await daemonUp() ? await daemon.type(args.selector, args.text, args.submit) : await browser.type(args.selector, args.text, args.submit))
);
server.tool('browser_extract', 'Extract the current page as clean LLM-ready markdown (prefers article/main). Reports CAPTCHA detection.',
  {}, async () => browserResult(await daemonUp() ? await daemon.extract() : await browser.extract())
);
server.tool('browser_press', 'Press a keyboard key (e.g. Enter, Escape, PageDown).',
  { key: z.string().describe('Key name') }, async (args) => browserResult(await daemonUp() ? await daemon.press(args.key) : await browser.press(args.key))
);
server.tool('browser_scroll', 'Scroll the page to trigger lazy-loading.',
  { direction: z.enum(['down', 'up']).default('down'), amount: z.number().default(1) },
  async (args) => browserResult(await daemonUp() ? await daemon.scroll(args.direction, args.amount) : await browser.scroll(args.direction, args.amount))
);
server.tool('browser_screenshot', 'Save a screenshot of the current viewport to a file path.',
  { path: z.string().describe('Absolute file path for the PNG') }, async (args) => browserResult(await daemonUp() ? await daemon.screenshot(args.path) : await browser.screenshot(args.path))
);
server.tool('browser_close', 'Close the agent browser session (profile + logins persist on disk).',
  {}, async () => browserResult(await daemonUp() ? { ok: true, note: 'shared daemon stays warm; not closing' } : await browser.close())
);

// Parallel fetch — open many tabs at once (bounded pool), extract each to markdown. Per-domain rate
// governing still applies, so tabs on different hosts run concurrent while same-host tabs stay polite.
server.tool('browser_parallel_extract',
  'Fetch AND extract many URLs in parallel (bounded tab pool), returning clean markdown for each. Much faster than looping browser_goto+browser_extract. Per-domain politeness still enforced. Use when you have a known list of URLs to read at once.',
  {
    urls: z.array(z.string().url()).min(1).max(50).describe('URLs to fetch and extract in parallel'),
    concurrency: z.number().min(1).max(12).default(6).describe('Max tabs open at once'),
    settleMs: z.number().min(0).max(15000).default(3000).describe('Post-load settle delay per page (ms)'),
  },
  async (args) => {
    if (await daemonUp()) {
      return browserResult(await daemon.parallelExtract(args.urls, { concurrency: args.concurrency, settleMs: args.settleMs }));
    }
    await browser.open();
    const results = await browser.parallelExtract(args.urls, { concurrency: args.concurrency, settleMs: args.settleMs });
    return browserResult(results.map((r) => ({
      url: r.url, title: r.title, approxTokens: r.approxTokens,
      captchaDetected: r.captchaDetected, publishDate: r.publishDate, markdown: r.markdown,
    })));
  }
);
server.tool('browser_parallel_screenshot',
  'Screenshot many URLs in parallel (bounded tab pool). Each job is {url, path}; returns per-job ok/fail. Use for visual capture of a batch of pages at once.',
  {
    jobs: z.array(z.object({ url: z.string().url(), path: z.string() })).min(1).max(50).describe('{url, path} jobs'),
    concurrency: z.number().min(1).max(12).default(6).describe('Max tabs open at once'),
    settleMs: z.number().min(0).max(15000).default(6000).describe('Post-load settle delay per page (ms)'),
  },
  async (args) => {
    if (await daemonUp()) {
      return browserResult(await daemon.parallelScreenshot(args.jobs, { concurrency: args.concurrency, settleMs: args.settleMs }));
    }
    await browser.open();
    return browserResult(await browser.parallelScreenshot(args.jobs, { concurrency: args.concurrency, settleMs: args.settleMs }));
  }
);

server.tool('browse', 'Autonomous multi-hop research. Seeds from multi-engine search, navigates INTO real source articles (not just aggregator result pages), and FOLLOWS the most relevant links (priority queue, zero-token scoring) to real depth. Relevance gate kills topic drift; recency gate handles staleness. Returns assembled findings with relevance + publish dates. Bounded by maxPages for time/token cost. Use for "what happened / research X" instead of a single search.',
  {
    query: z.string().describe('Research question or topic'),
    maxPages: z.number().default(6).describe('Hard cap on pages visited (controls time + token cost)'),
    maxSeeds: z.number().default(3).describe('Search seeds allowed in; the rest of the budget is for followed links (forces depth)'),
    maxDepth: z.number().default(2).describe('How deep to follow links'),
    minRelevance: z.number().default(0.18).describe('Topic-relevance gate (0..1); higher = stricter, less drift'),
    maxAgeDays: z.number().optional().describe('Recency gate in days; undated pages are kept regardless'),
    recencyMode: z.enum(['soft', 'hard']).default('soft').describe('soft = down-weight stale; hard = drop stale pages'),
    seedUrls: z.array(z.string().url()).optional().describe('Explicit entry URLs to enter directly (bypasses search + the homepage/aggregator filter). Use when told to "go look at" specific pages — including company homepages.'),
  },
  async (args) => {
    const opts = {
      maxPages: args.maxPages, maxSeeds: args.maxSeeds, maxDepth: args.maxDepth,
      minRelevance: args.minRelevance, maxAgeDays: args.maxAgeDays, recencyMode: args.recencyMode,
      seedUrls: args.seedUrls,
    };
    return browserResult(await daemonUp() ? await daemon.browse(args.query, opts) : await browse(browser, args.query, opts));
  }
);

server.tool('reach', 'Get ONE hard-to-reach URL by any legitimate means: direct render → stealth retry (headful real Chrome) → public Wayback/archive.today fallback. STOPS and returns needsHuman on a CAPTCHA or hard paid paywall — it never solves CAPTCHAs or bypasses payment. Returns the page content (markdown + publishDate) or a clear reason.',
  {
    url: z.string().url().describe('The URL to reach'),
    allowArchive: z.boolean().default(true).describe('Allow public Wayback/archive.today/reader fallback'),
    maxChars: z.number().default(8000).describe('Cap on returned markdown characters; truncated at a paragraph boundary with a note. Pass higher for full text.'),
  },
  // ReachOutcome nests the page as { ok: true, result: { markdown, ... } } — capTextFields recurses into it.
  async (args) => browserResult(capTextFields(await daemonUp()
    ? await daemon.reach(args.url, args.allowArchive)
    : await reach({ url: args.url, agentBrowser: browser, proxyManager, allowArchive: args.allowArchive }), args.maxChars))
);

server.tool('discover', 'Broad event DISCOVERY across ALL categories (vs browse\'s narrow query research). Reads the Wikipedia Current Events Portal day-by-day over a window and buckets every notable event by category — Armed conflicts, Business, Disasters, Politics, Science, Sports, etc. Use for "what happened in the last N days / everything recent" — it surfaces categories you did NOT think to ask about (sports, disasters, obituaries…). Zero model tokens.',
  {
    days: z.number().default(30).describe('Window size in days back from today'),
    category: z.string().optional().describe('Optional filter, e.g. "Sports" or "Science"'),
    maxPerCategory: z.number().default(60).describe('Cap events kept per category'),
  },
  async (args) => browserResult(await discover(browser, { days: args.days, category: args.category, maxPerCategory: args.maxPerCategory }))
);

server.tool('discover_domain', 'Domain-DEPTH discovery: reads each domain\'s community/primary hubs (Hacker News, Reddit subs, arXiv, Fed) and returns recent items per domain. Catches niche stuff world-feeds and query-search miss (e.g. a new AI agent release). Domains: ai, markets, youtube, crypto. Use alongside discover() (world breadth) for full coverage.',
  {
    domains: z.array(z.enum(['ai', 'markets', 'youtube', 'crypto'])).optional().describe('Which domains; omit for all'),
    perFeed: z.number().default(12).describe('Items kept per RSS feed'),
    maxAgeDays: z.number().optional().describe('Only items newer than this many days'),
  },
  async (args) => browserResult(await discoverDomain(browser, { domains: args.domains ?? 'all', perFeed: args.perFeed, maxAgeDays: args.maxAgeDays }))
);

server.tool('track', 'Run the local tracking ORACLE over your watchlist: for each watched entity (person/org/ticker/topic/channel) pull targeted search sweeps + domain feeds, match, dedupe against everything seen before, and report only NEW developments per entity. Accumulates to a persistent local store (~/.vortex-tracker/store.json). Answers "what\'s new about the things I track".',
  { perEntity: z.number().default(6).describe('Results per entity sweep') },
  async (args) => browserResult(await track(browser, { perEntity: args.perEntity }))
);

server.tool('watchlist', 'View or replace the tracking watchlist. Pass entities to set; omit to view current. Each entity: {name, type: person|org|ticker|topic|channel, aliases?, domains?}.',
  { entities: z.array(z.object({ name: z.string(), type: z.enum(['person', 'org', 'ticker', 'topic', 'channel']), aliases: z.array(z.string()).optional(), domains: z.array(z.enum(['ai', 'markets', 'youtube', 'crypto'])).optional() })).optional().describe('Set the watchlist; omit to view') },
  async (args) => { if (args.entities) await setWatchlist(args.entities); return browserResult({ watchlist: await getWatchlist() }); }
);

server.tool('search_google', 'High-quality search via Google\'s real index — finds LinkedIn, specific people, and pages the default web_search (Bing/DuckDuckGo/Mojeek) misses or buries. Bypasses Google\'s bot-wall with a headful stealth browser (opens a brief real Chrome window, slower). Use when you need Google-grade results, especially finding a specific person/profile.',
  { query: z.string().describe('Search query'), maxResults: z.number().default(10) },
  async (args) => {
    // Reuse the warm singleton (shared persistent profile under $HOME by default; override with
    // VORTEX_TRACKER_DIR). Log into Google ONCE here (headful) and the session sticks — logged-in Google
    // rarely rate-limits at personal volume. Free, no API. Self-paces + backs off. Kept warm, not closed.
    if (await daemonUp()) return browserResult(await daemon.google(args.query, args.maxResults));
    const gb = await getGoogleBrowser();
    return browserResult({ query: args.query, engine: 'google', results: await gb.googleSearch(args.query, args.maxResults) });
  }
);

server.tool('ocr_url', 'OCR an image or PDF URL with Apple Vision (on-device, free, no GPU — macOS only). Extracts text from scanned PDFs, infographics, charts, and image-only documents that normal scraping returns empty for. For the asset itself (a .pdf/.png/.jpg URL), NOT for HTML pages.',
  { url: z.string().url().describe('Direct URL to a PDF or image (png/jpg/tiff/webp/heic)') },
  async (args) => {
    if (!(await ocrAvailable())) return browserResult({ ok: false, error: 'OCR unavailable (needs macOS + swiftc)' });
    try { return browserResult({ ok: true, ...(await ocrUrl(args.url)) }); }
    catch (e) { return browserResult({ ok: false, error: (e as Error)?.message?.slice(0, 200) || 'ocr failed' }); }
  }
);

// ─── VANTA extension-backed tools (require the browser daemon + connected extension) ───
server.tool('web_fetch',
  'Fetch ONE URL through the logged-in VANTA Chrome session and return clean markdown — cookie-authenticated, NO browser render (fast, ~100-400ms). Use for pages behind your logins or soft paywalls, or when you just need the article body quickly. Requires the VANTA browser daemon + extension; errors clearly if not connected.',
  {
    url: z.string().url().describe('The URL to fetch'),
    maxChars: z.number().default(8000).describe('Cap on returned markdown characters; truncated at a paragraph boundary with a note. Pass higher for full text.'),
  },
  async (args) => { try { return browserResult(capTextFields(await daemon.call('/fetch_extract', { url: args.url }), args.maxChars)); } catch (e) { return browserResult({ ok: false, error: (e as Error)?.message?.slice(0, 200) }); } }
);

server.tool('research',
  'Autonomous PARALLEL research TREE. From one question it seeds roots (google-session-fused search), fetches each level concurrently, scores every page for relevance, and DIVES DEEPER only into strongly-relevant branches while pruning dead ends — adaptive depth, not a fixed crawl. Returns a tree of nodes with per-node relevance and why-expanded/why-pruned. Use for multi-hop "understand X deeply" questions. Requires the VANTA browser daemon + extension.',
  {
    query: z.string().describe('The research question'),
    maxPages: z.number().default(20).describe('Total pages visited (budget). Default 20.'),
    maxDepth: z.number().default(3).describe('Deepest tree level. Default 3.'),
    poolWidth: z.number().default(6).describe('Pages fetched concurrently per level. Default 6.'),
    maxSeeds: z.number().default(4).describe('Root pages seeded from search. Default 4.'),
    expandThreshold: z.number().optional().describe('Relevance (0..1) at/above which a node dives deeper. Default 0.30.'),
    minRelevance: z.number().optional().describe('Below this a fetched page is pruned as off-topic. Default 0.15.'),
    maxAgeDays: z.number().optional().describe('Optional recency gate (soft down-weight; undated kept).'),
  },
  async (args) => { try { return browserResult(await daemon.call('/research', args)); } catch (e) { return browserResult({ ok: false, error: (e as Error)?.message?.slice(0, 200) }); } }
);

server.tool('session_search',
  'Search a LOGGED-IN walled garden (reddit, x/twitter, linkedin) using your VANTA session. Returns `results` (clickable content links, best on reddit) AND `visibleText` — a DOM-proof screenshot+OCR read of the results page (auto for x/linkedin, whose markup resists scraping). Use `visibleText` to "look up what people are saying"; use `results` when you need links to web_fetch. Requires the VANTA daemon + being logged into that site in the profile.',
  {
    site: z.enum(['reddit', 'x', 'twitter', 'linkedin']).describe('Which logged-in site to search'),
    query: z.string().describe('Search query'),
    maxResults: z.number().default(10).describe('Max link results'),
    visual: z.boolean().optional().describe('Force (true) or skip (false) the screenshot+OCR read. Default: on for x/linkedin.'),
    scrolls: z.number().optional().describe('How many viewports to scroll+OCR (default 4). More = more content, slower.'),
  },
  async (args) => { try { return browserResult(await daemon.call('/session_search', args)); } catch (e) { return browserResult({ ok: false, error: (e as Error)?.message?.slice(0, 200) }); } }
);

server.tool('read_visual',
  'DOM-proof VISUAL reader: render a URL in your logged-in VANTA session, scroll while screenshotting, and OCR the pixels (Apple Vision) to return the on-screen TEXT. Use for anti-scraping SPAs, canvas/image-based pages, or anything where normal extraction returns empty — it reads what a human would see. Note: returns visible text, NOT the links behind it. macOS-only. Requires the VANTA daemon.',
  {
    url: z.string().url().describe('The URL to visually read'),
    scrolls: z.number().default(3).describe('Viewports to scroll+OCR (1-8). Default 3.'),
  },
  async (args) => { try { return browserResult(await daemon.call('/read_visual', args)); } catch (e) { return browserResult({ ok: false, error: (e as Error)?.message?.slice(0, 200) }); } }
);

server.tool('vanta_stats',
  'Health of the VANTA browser bridge: whether the extension is connected, the logged-in profile, and the parallel tab-pool occupancy. Use to check if the real-Chrome backend is available before relying on web_fetch/research.',
  {},
  async () => { try { return browserResult(await daemon.call('/stats', {})); } catch (e) { return browserResult({ ok: false, connected: false, error: (e as Error)?.message?.slice(0, 200) }); } }
);

// ─── VANTA Control: desktop eyes+hands (AX-first) ────────────────────────────
// Bridges the vanta-control executor (Projects/vanta-control) into the same MCP
// surface as the web tools: Vortex = web arm, these = desktop arm. Degrades to a
// clear error when the binary is missing. Outward actions (send/publish/pay/
// delete) are never allowed — draft-by-default is enforced by the caller rules.
const VANTA_AX = process.env.VANTA_AX_BIN || '/Volumes/AVANTI/Projects/vanta-control/bin/vanta-ax';
async function axCall(argv: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(VANTA_AX, argv, { timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) resolve(JSON.stringify({ ok: false, error: (stderr || err.message).trim().slice(0, 400) }));
      else resolve(stdout.trim());
    });
  });
}
const axResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

server.tool('desktop_read_ui',
  'Read the macOS accessibility tree of a native app (semantic perception: numbered elements with role/title/value/frame/actions, 30-250ms, zero image tokens). The desktop counterpart of web_fetch — use for native apps (Notes, Mail, Finder, Calendar, any non-browser UI). Element ids are only valid until the next action; for button sequences use desktop_act press with `find`.',
  {
    app: z.string().optional().describe('App name or bundle id; omit for frontmost'),
    // Measured 2026-08-05 on Notes (a known big tree): max 40 → 109ms,
    // 100 → 99ms, 500 → 2139ms. The element budget IS the scoped-query fix —
    // cost is superlinear past ~100, and the first N elements are the window
    // chrome + visible content you actually want. Default 120; raise per-call
    // only when a specific deep element is missing. (Never "fix" this by
    // rebuilding vanta-ax: TCC grants are code-signature-bound and a rebuild
    // silently voids Accessibility permission.)
    max: z.number().default(120).describe('Element cap. 120 default ≈100ms; >200 gets superlinearly slower on big trees (Notes/Xcode). Raise only if a needed element is missing.'),
  },
  async (args) => {
    const argv = ['dump', '--max', String(args.max ?? 120)];
    if (args.app) argv.push('--app', args.app);
    const raw = await axCall(argv);
    // Post-filter (MCP-side only — daemon + vanta-ax binary untouched): collapse junk element
    // runs (odometer digits, duplicate-frame wrapper groups) that eat the element budget.
    // Measured ~40% of an 80-element budget wasted on one real page. Surviving ids are the
    // ORIGINAL ids (desktop_act references them). Unparseable/error payloads pass through as-is.
    try {
      const dump = JSON.parse(raw);
      if (dump && Array.isArray(dump.elements)) {
        const { elements, removed } = collapseAxElements(dump.elements);
        dump.elements = elements;
        dump.elementCount = elements.length;
        dump.collapsedElements = removed;
        return axResult(JSON.stringify(dump));
      }
    } catch { /* not a dump payload (axCall error JSON, etc.) */ }
    return axResult(raw);
  }
);

server.tool('desktop_act',
  'Act on a native macOS app via accessibility identity (AXPress/AXValue; CGEvent fallback). verbs: press (use find=visible label — robust; or id from last read_ui), setvalue (id+text, no focus steal, verified), focus (id), type (text into focus), key (combo e.g. cmd+n), click (x,y last resort), open (app). NEVER use for outward actions (sending/publishing/deleting) — draft only.',
  {
    verb: z.enum(['press', 'setvalue', 'focus', 'type', 'key', 'click', 'open']).describe('Action verb'),
    find: z.string().optional().describe('press: visible label to content-match (preferred)'),
    role: z.string().optional().describe('press+find: narrow by AX role, e.g. AXButton'),
    app: z.string().optional().describe('press+find / open: target app'),
    id: z.number().optional().describe('press/setvalue/focus: element id from last desktop_read_ui'),
    text: z.string().optional().describe('setvalue/type: the text'),
    combo: z.string().optional().describe('key: e.g. cmd+s, cmd+shift+n, return'),
    x: z.number().optional(), y: z.number().optional(),
  },
  async (a) => {
    const argv = ['act', a.verb === 'open' ? 'open' : a.verb];
    if (a.verb === 'press') {
      if (a.find) { argv.push('--find', a.find); if (a.role) argv.push('--role', a.role); if (a.app) argv.push('--app', a.app); }
      else if (a.id !== undefined) argv.push('--id', String(a.id));
      else return axResult(JSON.stringify({ ok: false, error: 'press needs find or id' }));
    }
    if (a.verb === 'setvalue') { argv.push('--id', String(a.id), '--text', a.text ?? ''); }
    if (a.verb === 'focus') argv.push('--id', String(a.id));
    if (a.verb === 'type') argv.push('--text', a.text ?? '');
    if (a.verb === 'key') argv.push('--combo', a.combo ?? '');
    if (a.verb === 'click') argv.push('--x', String(a.x), '--y', String(a.y));
    if (a.verb === 'open') argv.push('--app', a.app ?? '');
    return axResult(await axCall(argv));
  }
);

server.tool('desktop_screenshot',
  'Screenshot the screen (or frontmost window) to a PNG path — the vision FALLBACK for pixel-only/AX-dark UI. Prefer desktop_read_ui. Returns the file path; read it with your file tools.',
  {
    window: z.boolean().optional().describe('Frontmost window only'),
    out: z.string().optional().describe('Output path, default /tmp/vanta-screen.png'),
  },
  async (a) => {
    const argv = ['screenshot', '--out', a.out || '/tmp/vanta-screen.png'];
    if (a.window) argv.push('--window');
    return axResult(await axCall(argv));
  }
);

// ─── Start ───────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Vortex MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
