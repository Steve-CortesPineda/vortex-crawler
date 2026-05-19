import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VortexCrawler, search } from '@vortex/core';

const crawler = new VortexCrawler();

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
  'Search the web using DuckDuckGo. No API key required. Returns titles, URLs, and snippets.',
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
