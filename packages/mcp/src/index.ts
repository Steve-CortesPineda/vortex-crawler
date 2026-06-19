import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VortexCrawler, search, AgentBrowser, browse, reach, discover, discoverDomain, track, getWatchlist, setWatchlist, ProxyManager } from '@stevecortesp/vortex-core';

const crawler = new VortexCrawler();
// Proxies (optional) come from VORTEX_PROXIES="http://a:b@host:port,http://..." — consulted by stealth/rotating.
const proxyManager = new ProxyManager((process.env.VORTEX_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean));
const browser = new AgentBrowser({ proxyManager });

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
  'Multi-engine web search (DuckDuckGo + Bing + Mojeek) fused via reciprocal-rank. No API key. Returns titles, URLs, snippets, the engines that found each result, and a fusion score.',
  {
    query: z.string().describe('The search query'),
    maxResults: z.number().default(10).describe('Maximum number of results to return'),
  },
  async (args) => {
    const results = await search(args.query, { maxResults: args.maxResults });

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
  async () => browserResult(await browser.open())
);
server.tool('browser_goto', 'Navigate the agent browser to a URL.',
  { url: z.string().url().describe('URL to open'), waitFor: z.string().optional().describe('Optional CSS selector to wait for') },
  async (args) => browserResult(await browser.goto(args.url, args.waitFor))
);
server.tool('browser_click', 'Click an element by CSS selector, or by visible text when byText=true. Refuses obvious financial/purchase actions.',
  { target: z.string().describe('CSS selector or visible text'), byText: z.boolean().default(false).describe('Treat target as visible text') },
  async (args) => browserResult(await browser.click(args.target, args.byText))
);
server.tool('browser_type', 'Type text into a field by CSS selector. Refuses credential/payment fields (seed logins manually). Set submit=true to press Enter.',
  { selector: z.string().describe('CSS selector of the input'), text: z.string().describe('Text to type'), submit: z.boolean().default(false) },
  async (args) => browserResult(await browser.type(args.selector, args.text, args.submit))
);
server.tool('browser_extract', 'Extract the current page as clean LLM-ready markdown (prefers article/main). Reports CAPTCHA detection.',
  {}, async () => browserResult(await browser.extract())
);
server.tool('browser_press', 'Press a keyboard key (e.g. Enter, Escape, PageDown).',
  { key: z.string().describe('Key name') }, async (args) => browserResult(await browser.press(args.key))
);
server.tool('browser_scroll', 'Scroll the page to trigger lazy-loading.',
  { direction: z.enum(['down', 'up']).default('down'), amount: z.number().default(1) },
  async (args) => browserResult(await browser.scroll(args.direction, args.amount))
);
server.tool('browser_screenshot', 'Save a screenshot of the current viewport to a file path.',
  { path: z.string().describe('Absolute file path for the PNG') }, async (args) => browserResult(await browser.screenshot(args.path))
);
server.tool('browser_close', 'Close the agent browser session (profile + logins persist on disk).',
  {}, async () => browserResult(await browser.close())
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
  async (args) => browserResult(await browse(browser, args.query, {
    maxPages: args.maxPages, maxSeeds: args.maxSeeds, maxDepth: args.maxDepth,
    minRelevance: args.minRelevance, maxAgeDays: args.maxAgeDays, recencyMode: args.recencyMode,
    seedUrls: args.seedUrls,
  }))
);

server.tool('reach', 'Get ONE hard-to-reach URL by any legitimate means: direct render → stealth retry (headful real Chrome) → public Wayback/archive.today fallback. STOPS and returns needsHuman on a CAPTCHA or hard paid paywall — it never solves CAPTCHAs or bypasses payment. Returns the page content (markdown + publishDate) or a clear reason.',
  {
    url: z.string().url().describe('The URL to reach'),
    allowArchive: z.boolean().default(true).describe('Allow public Wayback/archive.today/reader fallback'),
  },
  async (args) => browserResult(await reach({ url: args.url, agentBrowser: browser, proxyManager, allowArchive: args.allowArchive }))
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
    // Persistent profile under $HOME by default (survives an unmounted external drive; override with
    // VORTEX_TRACKER_DIR). Log into Google ONCE here (headful) and the session sticks —
    // logged-in Google rarely rate-limits at personal volume. Free, no API. Self-paces + backs off.
    const trackerDir = process.env.VORTEX_TRACKER_DIR || `${process.env.HOME}/.vortex-tracker`;
    const gb = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${trackerDir}/google-profile` });
    try { await gb.open(); return browserResult({ query: args.query, engine: 'google', results: await gb.googleSearch(args.query, args.maxResults) }); }
    finally { await gb.close(); }
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
