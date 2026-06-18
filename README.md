# Vortex

The web crawler that beats everything. Adaptive rendering, LLM-optimized output, MCP-native.

## Why Vortex?

| Feature | Vortex | Firecrawl | Crawl4AI | Scrapy | Crawlee |
|---------|--------|-----------|----------|--------|---------|
| Adaptive rendering | 3-tier auto-detect | Browser always | Browser always | HTTP only | Browser always |
| Idle RAM | **<20MB** | 500MB+ | 280MB+ | ~50MB | 200MB+ |
| MCP server | Built-in | No | No | No | No |
| LLM markdown | Yes + token count | Yes | Yes | No | Partial |
| Web search | DuckDuckGo built-in | No | No | No | No |
| YouTube extraction | Video + channel + transcript | No | No | No | No |
| Language | TypeScript | TypeScript | Python | Python | TypeScript |
| Cost | Free (MIT) | $83/mo+ | Free | Free | Free |

## Benchmarks

| Site | Tier | Time | Tokens | Reduction | Links |
|------|------|------|--------|-----------|-------|
| example.com | http | **90ms** | 27 | 21% | 1 |
| Hacker News | http | **379ms** | 878 | **62%** | 196 |
| Wikipedia | http | **291ms** | 11,084 | **45%** | 489 |
| GitHub Trending | http | **1,355ms** | 671 | **99%** | 1,192 |
| YouTube video | http | **502ms** | full data | N/A | N/A |

## Quick Start

```bash
npm install @vortex/core
```

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

Tools: `scrape_url`, `crawl_site`, `map_site`, `extract_data`, `web_search`

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
| `@vortex/core` | Crawler engine, adaptive rendering, caching, plugins |
| `@vortex/cli` | Command-line interface |
| `@vortex/mcp` | MCP server for AI agents |
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
