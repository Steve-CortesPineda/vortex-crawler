export { VortexCrawler } from './crawler.js';
export type { ScrapeOptions, CrawlOptions, MapOptions } from './crawler.js';

// Types
export * from './types/index.js';

// Fetcher
export { AdaptiveFetcher } from './fetcher/adaptive-fetcher.js';
export { HttpFetcher } from './fetcher/http-fetcher.js';
export { TierDetector } from './fetcher/tier-detector.js';

// Processor
export { ContentCleaner } from './processor/content-cleaner.js';
export { MarkdownConverter } from './processor/markdown-converter.js';
export { TokenEstimator } from './processor/token-estimator.js';
export { LinkExtractor } from './processor/link-extractor.js';
export { Chunker } from './processor/chunker.js';
export { MetadataExtractor } from './processor/metadata-extractor.js';

// Pipeline
export { PriorityURLQueue } from './pipeline/queue.js';
export { PerDomainRateLimiter } from './pipeline/rate-limiter.js';
export { ContentDeduplicator } from './pipeline/dedup.js';

// Cache
export { CacheManager } from './cache/cache-manager.js';

// Plugin
export { PluginManager } from './plugin/plugin-manager.js';
export type { VortexPlugin } from './plugin/types.js';

// Search
export { search } from './search.js';
export type { SearchResult, SearchResponse } from './search.js';

// Convenience
export function defineConfig(config: Partial<import('./types/config.js').VortexConfig>) {
  return config;
}
