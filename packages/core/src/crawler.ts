import { EventEmitter } from 'events';
import PQueue from 'p-queue';
import micromatch from 'micromatch';
import type { VortexConfig, FetchRequest, RenderTier } from './types/config.js';
import type { CrawlResult, CrawlProgress, CrawlSummary, SitemapResult, PageMetadata } from './types/result.js';
import { DEFAULT_CONFIG } from './types/config.js';
import { AdaptiveFetcher } from './fetcher/adaptive-fetcher.js';
import { ContentCleaner } from './processor/content-cleaner.js';
import { MarkdownConverter } from './processor/markdown-converter.js';
import { TokenEstimator } from './processor/token-estimator.js';
import { LinkExtractor } from './processor/link-extractor.js';
import { MetadataExtractor } from './processor/metadata-extractor.js';
import { Chunker } from './processor/chunker.js';
import { CacheManager } from './cache/cache-manager.js';
import { PluginManager } from './plugin/plugin-manager.js';
import { PriorityURLQueue } from './pipeline/queue.js';
import { PerDomainRateLimiter } from './pipeline/rate-limiter.js';
import { ContentDeduplicator } from './pipeline/dedup.js';
import type { VortexPlugin } from './plugin/types.js';

export interface ScrapeOptions {
  tier?: RenderTier;
  output?: Partial<VortexConfig['output']>;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface CrawlOptions extends ScrapeOptions {
  maxPages?: number;
  maxDepth?: number;
  include?: string[];
  exclude?: string[];
}

export interface MapOptions {
  maxUrls?: number;
}

export class VortexCrawler extends EventEmitter {
  private config: VortexConfig;
  private fetcher: AdaptiveFetcher;
  private cleaner: ContentCleaner;
  private converter: MarkdownConverter;
  private estimator: TokenEstimator;
  private linkExtractor: LinkExtractor;
  private metadataExtractor: MetadataExtractor;
  private chunker: Chunker;
  private cache: CacheManager;
  private plugins: PluginManager;
  private rateLimiter: PerDomainRateLimiter;

  constructor(config?: Partial<VortexConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as VortexConfig;

    this.fetcher = new AdaptiveFetcher(this.config.rendering, this.config.timeout);
    this.cleaner = new ContentCleaner();
    this.converter = new MarkdownConverter();
    this.estimator = new TokenEstimator();
    this.linkExtractor = new LinkExtractor();
    this.metadataExtractor = new MetadataExtractor();
    this.chunker = new Chunker();
    this.cache = new CacheManager(this.config.cache);
    this.plugins = new PluginManager();
    this.rateLimiter = new PerDomainRateLimiter(this.config.rateLimit.requestsPerSecond);
  }

  /** Register a plugin */
  use(plugin: VortexPlugin): this {
    this.plugins.register(plugin);
    return this;
  }

  /** Scrape a single page */
  async scrape(url: string, options?: ScrapeOptions): Promise<CrawlResult> {
    // Check cache
    const cached = this.cache.get(url);
    if (cached) return cached;

    const totalStart = performance.now();

    // Rate limit
    await this.rateLimiter.throttle(url);

    // Build fetch request
    let request: FetchRequest | null = {
      url,
      tier: options?.tier,
      headers: options?.headers,
      timeout: options?.timeout ?? this.config.timeout,
    };

    // Plugin: beforeFetch
    request = await this.plugins.runBeforeFetch(request);
    if (!request) throw new Error(`Fetch skipped by plugin for ${url}`);

    // Fetch
    const fetchResult = await this.fetcher.fetch(request);
    const afterFetch = await this.plugins.runAfterFetch(fetchResult, request);

    // Plugin: beforeProcess
    let html = await this.plugins.runBeforeProcess(afterFetch.html, url);

    // Extract metadata from raw HTML (before cleaning)
    const metadata = this.metadataExtractor.extract(html, url);

    // Clean HTML
    const cleanHtml = this.cleaner.clean(html, url);

    // Convert to markdown
    const markdown = this.converter.convert(cleanHtml);

    // Extract plain text
    const text = markdown
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[#*_`\[\]()>|-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Token estimation
    const markdownTokens = this.estimator.estimate(markdown);
    const htmlTokens = this.estimator.estimate(afterFetch.html);
    const reduction = htmlTokens > 0
      ? Math.round((1 - markdownTokens / htmlTokens) * 100)
      : 0;

    // Extract links
    const links = this.linkExtractor.extract(afterFetch.html, url);

    // Content fingerprint for dedup
    const dedup = new ContentDeduplicator();
    const contentHash = dedup.fingerprint(markdown);

    // Chunking (if configured)
    const outputConfig = { ...this.config.output, ...options?.output };
    const chunks = outputConfig.chunkSize
      ? this.chunker.chunk(markdown, outputConfig.chunkSize, outputConfig.chunkOverlap)
      : undefined;

    const processMs = performance.now() - totalStart - afterFetch.timing.fetchMs;

    let result: CrawlResult = {
      url,
      statusCode: afterFetch.statusCode,
      tier: afterFetch.tier,
      html: afterFetch.html,
      markdown,
      text,
      metadata,
      tokens: { markdown: markdownTokens, html: htmlTokens, reduction },
      chunks,
      links,
      timing: {
        fetchMs: afterFetch.timing.fetchMs,
        processMs,
        totalMs: performance.now() - totalStart,
      },
      fromCache: false,
      contentHash,
    };

    // Plugin: extract
    const extracted = await this.plugins.runExtract(result);
    if (Object.keys(extracted).length > 0) {
      result.extracted = extracted;
    }

    // Plugin: afterProcess
    result = await this.plugins.runAfterProcess(result);

    // Cache the result
    this.cache.set(url, result);

    return result;
  }

  /** Crawl multiple pages, yielding results as they complete */
  async *crawl(url: string, options?: CrawlOptions): AsyncGenerator<CrawlResult> {
    const maxPages = options?.maxPages ?? 50;
    const maxDepth = options?.maxDepth ?? this.config.maxDepth;
    const include = options?.include;
    const exclude = options?.exclude;

    const queue = new PriorityURLQueue();
    const dedup = new ContentDeduplicator();
    const concurrencyQueue = new PQueue({ concurrency: this.config.maxConcurrency });

    let crawled = 0;
    let failed = 0;
    const errors: Array<{ url: string; error: string }> = [];
    const tierBreakdown: Record<RenderTier, number> = { http: 0, jsdom: 0, browser: 0 };

    // Seed the queue
    queue.enqueue({ url, depth: 0, priority: 10 });

    const results: CrawlResult[] = [];
    let resolveNext: ((value: IteratorResult<CrawlResult>) => void) | null = null;

    const processUrl = async (queueUrl: string, depth: number) => {
      if (crawled >= maxPages) return;

      try {
        const result = await this.scrape(queueUrl, options);
        crawled++;
        tierBreakdown[result.tier]++;

        // Check for content duplicates
        if (dedup.isDuplicate(result.markdown)) return;

        // Discover and enqueue new links
        if (depth < maxDepth) {
          for (const link of result.links) {
            if (!link.isInternal) continue;
            if (include && !micromatch.isMatch(link.url, include)) continue;
            if (exclude && micromatch.isMatch(link.url, exclude)) continue;
            if (!this.plugins.filterUrl(link.url, queueUrl)) continue;

            queue.enqueue({
              url: link.url,
              depth: depth + 1,
              priority: 10 - depth,
              parentUrl: queueUrl,
            });
          }
        }

        results.push(result);

        this.emit('result', result);
        this.emit('progress', {
          crawled,
          queued: queue.size,
          failed,
          currentUrl: queueUrl,
        } satisfies CrawlProgress);

      } catch (err) {
        failed++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ url: queueUrl, error: errorMsg });
        this.emit('error', err, queueUrl);
      }
    };

    // Process the queue
    while ((queue.size > 0 || concurrencyQueue.size > 0 || concurrencyQueue.pending > 0) && crawled < maxPages) {
      // Drain available items from queue into concurrency pool
      while (queue.size > 0 && crawled + concurrencyQueue.pending + concurrencyQueue.size < maxPages) {
        const item = queue.dequeue();
        if (!item) break;
        concurrencyQueue.add(() => processUrl(item.url, item.depth));
      }

      // Wait for batch to finish
      if (concurrencyQueue.size > 0 || concurrencyQueue.pending > 0) {
        await concurrencyQueue.onIdle();
      }

      // Yield all ready results
      while (results.length > 0) {
        yield results.shift()!;
      }

      // If nothing left to process, break
      if (queue.size === 0 && concurrencyQueue.size === 0 && concurrencyQueue.pending === 0) break;
    }

    // Yield any remaining
    while (results.length > 0) {
      yield results.shift()!;
    }

    this.emit('done', {
      totalPages: crawled,
      totalTokens: 0, // Would sum up
      avgTokensPerPage: 0,
      tierBreakdown,
      totalTimeMs: 0,
      errors,
    } satisfies CrawlSummary);
  }

  /** Discover all URLs on a site */
  async map(url: string, options?: MapOptions): Promise<SitemapResult> {
    const maxUrls = options?.maxUrls ?? 100;
    const urls: string[] = [];

    // Try sitemap.xml first
    try {
      const base = new URL(url);
      const sitemapUrl = `${base.origin}/sitemap.xml`;
      const result = await this.fetcher.fetch({ url: sitemapUrl, timeout: 10_000 });

      if (result.statusCode === 200) {
        const matches = result.html.matchAll(/<loc>(.*?)<\/loc>/gi);
        for (const match of matches) {
          if (urls.length >= maxUrls) break;
          urls.push(match[1]);
        }
      }
    } catch {
      // No sitemap, fall back to crawling
    }

    // If sitemap didn't give enough, crawl for links
    if (urls.length < maxUrls) {
      for await (const result of this.crawl(url, { maxPages: maxUrls - urls.length, maxDepth: 3 })) {
        if (!urls.includes(result.url)) {
          urls.push(result.url);
        }
        if (urls.length >= maxUrls) break;
      }
    }

    return { urls, totalFound: urls.length };
  }

  /** Shut down the crawler */
  async close(): Promise<void> {
    await this.plugins.closeAll(this);
    await this.fetcher.close();
    this.cache.clear();
  }
}
