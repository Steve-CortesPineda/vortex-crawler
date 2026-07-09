export { VortexCrawler } from './crawler.js';
export type { ScrapeOptions, CrawlOptions, MapOptions } from './crawler.js';
export type { CookieFetcher } from './fetcher/adaptive-fetcher.js';

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
export { PerDomainRateLimiter, DomainGovernor, sharedGovernor, type GovernorOptions } from './pipeline/rate-limiter.js';
export { ContentDeduplicator } from './pipeline/dedup.js';

// Cache
export { CacheManager } from './cache/cache-manager.js';

// Plugin
export { PluginManager } from './plugin/plugin-manager.js';
export type { VortexPlugin } from './plugin/types.js';

// Search
export { search, proxiesConfigured, sourceQuality } from './search.js';
export type { SearchResult, SearchResponse, SearchEngine, Freshness, EngineReport, EngineStatus } from './search.js';
export { queryDomain, extractResultDate, freshnessAdjust, isTemporalQuery, sourceClass } from './source-rules.js';
export type { QueryVertical, SourceClass } from './source-rules.js';

// Browser daemon client
export { VortexDaemonClient } from './daemon-client.js';
export type { DaemonClientOptions, DaemonExtract } from './daemon-client.js';

// Agent browser
export { AgentBrowser } from './agent-browser.js';
export type { AgentBrowserOptions, ActResult, ExtractResult } from './agent-browser.js';
export { ProxyManager } from './antibot/proxy-manager.js';
export { buildLaunchPlan, loadEngine } from './antibot/stealth-launch.js';
export type { ReachProfile, BrowserEngine, LaunchPlan } from './antibot/stealth-launch.js';
export { ReadabilityExtractor } from './processor/readability-extractor.js';

// OCR (Apple Vision — on-device, free, macOS)
export { ocrAvailable, ocrFile, ocrUrl, looksOcrable } from './ocr/vision.js';
export type { OcrUrlResult } from './ocr/vision.js';

// Reach (fallback ladder)
export { reach, classifyPage } from './reach.js';
export type { ReachOutcome, ReachStrategy, ReachOptions, PageClass } from './reach.js';

// Discover (broad event discovery — spans all categories, not query-driven)
export { discover, discoverDomain } from './discover.js';
export type { DiscoverResult, DiscoverOptions, DiscoveredEvent, DiscoverDomainResult, DiscoverDomainOptions, DomainKey, DomainItem } from './discover.js';

// Tracker (local oracle — watchlist + persistent accumulation)
export { track, setWatchlist, getWatchlist, DEFAULT_WATCHLIST } from './tracker.js';
export type { WatchEntity, TrackedMention, TrackDigest, TrackOptions, EntityType } from './tracker.js';

// VANTA extension bridge (real-Chrome control via MV3 extension — cookie-fetch tier + parallel tab pool)
export { BridgeServer, ExtensionBrowser, TabPool, tierFor, assertAllowed, policySnapshot, BRIDGE_PROTOCOL_VERSION } from './extension-bridge/index.js';
export type { BridgeServerOptions, TabPoolOptions, DomainTier, BridgeOp, ActStep, ExtensionExtractResult, ExtensionActResult } from './extension-bridge/index.js';

// Browse loop (autonomous multi-hop research)
export { browse } from './browse.js';
export type { BrowseResult, BrowseHop, BrowseOptions, RankLinks } from './browse.js';

// Tree browse (parallel, relevance-gated research tree — adaptive depth)
export { treeBrowse } from './tree-browse.js';
export type { TreeBrowseResult, TreeBrowseOptions, TreeNode, TreeFetcher, TreeFetchResult } from './tree-browse.js';
export { GenericCache } from './cache/result-cache.js';
export { bm25ish, scoreLink, ageInDays, recencyScore, tokenize, keyPassages, classifyQuery, stripMarkdownLinks } from './browse-relevance.js';

// Convenience
export function defineConfig(config: Partial<import('./types/config.js').VortexConfig>) {
  return config;
}
