# Vortex

The adaptive web crawler — fastest among JS-capable crawlers in our benchmark because it only
launches a browser when a page actually needs one. LLM-optimized markdown, MCP-native, plus an
autonomous browsing agent, multi-engine search, and an always-on tracking oracle.

## Why Vortex?

| Feature | Vortex | Firecrawl | Crawl4AI | Scrapy | Crawlee |
|---------|--------|-----------|----------|--------|---------|
| Adaptive rendering | 3-tier auto-detect | Browser always | Browser always | HTTP only | Browser always |
| Browser launched | **Only when needed** | Always | Always | Never (no JS) | Always |
| MCP server | Built-in (18 tools) | No | No | No | No |
| LLM markdown | Yes + token count | Yes | Yes | No | Partial |
| Web search | Multi-engine fusion + Google | No | No | No | No |
| Autonomous research | Multi-hop `browse` + `reach` ladder | No | No | No | No |
| Stealth | Patchright + fingerprint/proxy profiles | Partial | Partial | No | Partial |
| Entity tracking | Persistent watchlist oracle | No | No | No | No |
| YouTube extraction | Video + channel + transcript | No | No | No | No |
| Language | TypeScript | TypeScript | Python | Python | TypeScript |
| Cost | Free (MIT) | $83/mo+ | Free | Free | Free |

> No API keys anywhere. Search fuses **DuckDuckGo + Bing + Mojeek** via reciprocal-rank fusion;
> hard-to-reach pages fall back through a stealth browser and public archives; CAPTCHAs and paid
> paywalls are detected and **surfaced for a human, never solved or bypassed**.

## Benchmarks

Measured head-to-head on the **same machine, same run**: 4 URLs (example.com, Hacker News, a Wikipedia
article, and a JavaScript-rendered page), fetched sequentially from cold. Reproduce with `benchmarks/`.
Firecrawl is a paid hosted API and was not benchmarked.

| Crawler | Total time | JS page | Peak RAM | Notes |
|---------|-----------|---------|----------|-------|
| **Vortex** | **2.2 s** | ✅ rendered | 289 MB | Browser launched for **1 of 4** pages (the JS one); the rest run on the HTTP tier |
| Crawl4AI | 5.1 s | ✅ rendered | 221 MB | Launches a browser for every page |
| Crawlee | 2.7 s | ✅ rendered | 280 MB | Launches a browser for every page |
| Scrapy | 1.0 s | ❌ shell only | 86 MB | Fastest & lightest, but can't execute JavaScript |

**The takeaway:** among crawlers that can actually render JavaScript, Vortex is the fastest here —
because adaptive tiering means it *only* pays the browser cost on the page that needs it, instead of
launching Chromium for every request. Scrapy is faster and lighter but returns an empty shell for the
JS page. (Per-process peak RAM is similar across the browser-capable tools; Vortex's edge is speed and
selective rendering, not a smaller footprint — Node + the HTML stack sits around ~230 MB either way.)

## Install

```bash
npm install @vortex/core      # or: @vortex/cli, @vortex/mcp, @vortex/extractors
```

Or run from source (also how you contribute):

```bash
git clone https://github.com/Steve-CortesPineda/vortex-crawler.git
cd vortex-crawler && pnpm install && pnpm build
```

## Quick Start

```typescript
import { VortexCrawler } from '@vortex/core';

const crawler = new VortexCrawler();

// Scrape a single page
const result = await crawler.scrape('https://example.com');
console.log(result.markdown);   // Clean markdown
console.log(result.tokens);     // { markdown: 27, html: 34, reduction: 21 }
console.log(result.metadata);   // { title, description, author, ... }

// Crawl multiple pages (streaming)
for await (const page of crawler.crawl('https://example.com', { maxDepth: 3 })) {
  console.log(page.url, page.tokens.markdown);
}

// Search the web
import { search } from '@vortex/core';
const results = await search('best web frameworks 2026');
```

## CLI

```bash
npx @vortex/cli scrape https://example.com          # Markdown to stdout
npx @vortex/cli scrape https://example.com --json    # Full JSON output
npx @vortex/cli crawl https://example.com -n 50      # Crawl 50 pages
npx @vortex/cli map https://example.com              # Discover all URLs
npx @vortex/cli search "your query here"             # Web search
```

## MCP Server (for AI agents)

```bash
npx @vortex/mcp
```

**18 tools**, grouped:

| Group | Tools |
|-------|-------|
| Fetch & extract | `scrape_url`, `crawl_site`, `map_site`, `extract_data` |
| Search | `web_search` (multi-engine fusion), `search_google` (headful, finds what the others miss) |
| Autonomous research | `browse` (multi-hop, follows the best links to real depth), `reach` (get one hard page via the fallback ladder) |
| Discovery | `discover` (categorized world events), `discover_domain` (per-domain hubs: AI / markets / YouTube / crypto) |
| Tracking oracle | `track` (what's new about your watchlist), `watchlist` (view/set entities) |
| Agent browser | `browser_open`, `browser_goto`, `browser_click`, `browser_type`, `browser_extract`, `browser_press`, `browser_scroll`, `browser_screenshot`, `browser_close` |

Add to Claude Code:
```json
{
  "mcpServers": {
    "vortex": {
      "type": "command",
      "command": "npx",
      "args": ["@vortex/mcp"]
    }
  }
}
```

## Autonomous Research & Tracking

Beyond single-page scraping, Vortex can run multi-step research on its own — all zero-token (no model
calls in the hot path; heuristics do the ranking).

```typescript
import { AgentBrowser, browse, reach, track } from '@vortex/core';

const b = new AgentBrowser();           // persistent, scriptable Chromium (logs into nothing by default)

// browse — seed from multi-engine search, navigate INTO sources, follow the best links to real depth.
const research = await browse(b, 'what happened with the EU AI Act this month', {
  maxPages: 6, maxDepth: 2, maxAgeDays: 30,
});
console.log(research.story);            // [{ url, title, relevance, publishDate, snippet }, ...]

// reach — get ONE hard page by any legitimate means; STOPS on CAPTCHA / hard paywall (never solves them).
const page = await reach({ url: 'https://example.com/blocked-article', agentBrowser: b });
if (!page.ok && page.needsHuman) console.log(page.note);

// track — a local oracle: name entities once, get only what's NEW each run (persistent store).
const digest = await track(b);          // pulls per-entity sweeps + domain RSS, dedupes, reports new
```

Safety hard-stops are enforced in code and **cannot be configured away**: the agent browser refuses
credential/payment fields and obvious purchase actions, and `reach` refuses to solve CAPTCHAs or
circumvent paid paywalls — those return a clear "a human is needed" result.

## Adaptive 3-Tier Rendering

Vortex automatically detects what each page needs:

- **Tier 1: HTTP + Cheerio** (~5ms, ~2MB) — Static HTML. Used 95% of the time.
- **Tier 2: JSDOM** (~50ms, ~15MB) — Light JavaScript execution.
- **Tier 3: Playwright** (~500ms, ~80MB) — Full browser. Lazy-loaded only when needed.

The `TierDetector` uses heuristic scoring (pre-fetch URL analysis + post-fetch HTML analysis) to pick the right tier. If a lower tier fails, it automatically escalates.

## YouTube Support

```typescript
import { VortexCrawler } from '@vortex/core';
import { youtubeExtractor, transcriptExtractor } from '@vortex/extractors';

const crawler = new VortexCrawler();
crawler.use(youtubeExtractor());
crawler.use(transcriptExtractor());

// Video page — title, description, views, keywords, related videos
const video = await crawler.scrape('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

// Channel page — name, description, all video listings
const channel = await crawler.scrape('https://www.youtube.com/@MrBeast/videos');

// Transcript extraction (requires yt-dlp: pip install yt-dlp)
// Automatically appends timestamped transcript to markdown output
```

## Plugin System

```typescript
import type { VortexPlugin } from '@vortex/core';

const myPlugin: VortexPlugin = {
  name: 'my-plugin',

  // Modify requests before fetching
  beforeFetch(request) { return request; },

  // Process results after fetching
  afterProcess(result) { return result; },

  // Extract structured data
  extract(result) {
    return { price: '$19.99' };
  },

  // Filter which URLs to crawl
  filterUrl(url, parentUrl) { return true; },
};

crawler.use(myPlugin);
```

## Built-in Extractors

```typescript
import { cssExtractor, schemaExtractor, tableExtractor } from '@vortex/extractors';

crawler.use(cssExtractor({ title: 'h1', price: '.price', description: '.desc' }));
crawler.use(schemaExtractor());  // JSON-LD structured data
crawler.use(tableExtractor());   // HTML tables to arrays
```

## Packages

| Package | Description |
|---------|-------------|
| `@vortex/core` | Crawler engine, adaptive rendering, caching, plugins, multi-engine search, agent browser, `browse`/`reach`/`track`, anti-bot/stealth |
| `@vortex/cli` | Command-line interface |
| `@vortex/mcp` | MCP server for AI agents (18 tools) |
| `@vortex/extractors` | YouTube, CSS, schema, table extractors |

## Development

```bash
git clone https://github.com/Steve-CortesPineda/vortex-crawler.git
cd vortex-crawler
pnpm install
pnpm build      # build all packages
pnpm test       # run the test suite
```

Requires Node 18+ and pnpm 8+. The repo is a pnpm/turbo monorepo — packages live under `packages/`.

## License

MIT
