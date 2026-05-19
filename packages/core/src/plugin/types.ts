import type { FetchRequest, FetchResult } from '../types/config.js';
import type { CrawlResult } from '../types/result.js';

export interface VortexPlugin {
  name: string;
  version?: string;

  onInit?(crawler: unknown): void | Promise<void>;
  onClose?(crawler: unknown): void | Promise<void>;

  beforeFetch?(request: FetchRequest): FetchRequest | null | Promise<FetchRequest | null>;
  afterFetch?(result: FetchResult, request: FetchRequest): FetchResult | Promise<FetchResult>;

  beforeProcess?(html: string, url: string): string | Promise<string>;
  afterProcess?(result: CrawlResult): CrawlResult | Promise<CrawlResult>;

  extract?(result: CrawlResult): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;

  beforeStore?(result: CrawlResult): CrawlResult | null | Promise<CrawlResult | null>;

  filterUrl?(url: string, parentUrl: string): boolean;
}
