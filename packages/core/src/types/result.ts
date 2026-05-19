import type { RenderTier } from './config.js';

export interface PageMetadata {
  title: string;
  description: string;
  language: string;
  author?: string;
  publishedAt?: string;
  ogImage?: string;
  canonical?: string;
  robots?: string;
  structuredData?: object[];
}

export interface TokenInfo {
  markdown: number;
  html: number;
  reduction: number;
}

export interface ContentChunk {
  index: number;
  content: string;
  tokens: number;
  metadata: { startOffset: number; endOffset: number };
}

export interface DiscoveredLink {
  url: string;
  text: string;
  rel?: string;
  isInternal: boolean;
}

export interface CrawlResult {
  url: string;
  statusCode: number;
  tier: RenderTier;
  html: string;
  markdown: string;
  text: string;
  metadata: PageMetadata;
  tokens: TokenInfo;
  chunks?: ContentChunk[];
  extracted?: Record<string, unknown>;
  links: DiscoveredLink[];
  timing: {
    fetchMs: number;
    processMs: number;
    totalMs: number;
  };
  fromCache: boolean;
  contentHash: string;
}

export interface CrawlProgress {
  crawled: number;
  queued: number;
  failed: number;
  currentUrl: string;
}

export interface CrawlSummary {
  totalPages: number;
  totalTokens: number;
  avgTokensPerPage: number;
  tierBreakdown: Record<RenderTier, number>;
  totalTimeMs: number;
  errors: Array<{ url: string; error: string }>;
}

export interface SitemapResult {
  urls: string[];
  totalFound: number;
}
