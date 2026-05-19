export type RenderTier = 'http' | 'jsdom' | 'browser';

export interface RenderingConfig {
  defaultTier: RenderTier;
  autoDetect: boolean;
  browserPoolSize: number;
  browserLazyLoad: boolean;
  jsdomThreshold: number;
  browserThreshold: number;
}

export interface RateLimitConfig {
  requestsPerSecond: number;
  perDomain: boolean;
  respectRobotsTxt: boolean;
}

export interface OutputConfig {
  format: 'markdown' | 'html' | 'text' | 'json';
  includeMetadata: boolean;
  includeTokenCount: boolean;
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface CacheConfig {
  enabled: boolean;
  ttl: number;
  maxSize: number;
  backend: 'memory' | 'file';
  directory?: string;
}

export interface AntiBotConfig {
  rotateUserAgent: boolean;
  rotateFingerprint: boolean;
  proxyUrls?: string[];
  proxyRotation: 'round-robin' | 'random' | 'sticky';
  cookies: 'persist' | 'discard';
}

export interface StorageBackendConfig {
  type: 'memory' | 'file';
  directory?: string;
}

export interface VortexConfig {
  maxConcurrency: number;
  maxDepth: number;
  timeout: number;
  retries: number;
  rendering: RenderingConfig;
  rateLimit: RateLimitConfig;
  output: OutputConfig;
  cache: CacheConfig;
  antiBot: AntiBotConfig;
  include?: string[];
  exclude?: string[];
  plugins?: VortexPlugin[];
  storage?: StorageBackendConfig;
}

export interface VortexPlugin {
  name: string;
  version?: string;
  onInit?(crawler: unknown): void | Promise<void>;
  onClose?(crawler: unknown): void | Promise<void>;
  beforeFetch?(request: FetchRequest): FetchRequest | null | Promise<FetchRequest | null>;
  afterFetch?(result: FetchResult, request: FetchRequest): FetchResult | Promise<FetchResult>;
  beforeProcess?(html: string, url: string): string | Promise<string>;
  afterProcess?(result: unknown): unknown | Promise<unknown>;
  extract?(result: unknown): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  beforeStore?(result: unknown): unknown | null | Promise<unknown | null>;
  filterUrl?(url: string, parentUrl: string): boolean;
}

export interface FetchRequest {
  url: string;
  headers?: Record<string, string>;
  tier?: RenderTier;
  timeout?: number;
  proxy?: string;
}

export interface FetchResult {
  url: string;
  statusCode: number;
  headers: Record<string, string>;
  html: string;
  tier: RenderTier;
  timing: { fetchMs: number };
}

export const DEFAULT_CONFIG: VortexConfig = {
  maxConcurrency: 5,
  maxDepth: 10,
  timeout: 30_000,
  retries: 2,
  rendering: {
    defaultTier: 'http',
    autoDetect: true,
    browserPoolSize: 2,
    browserLazyLoad: true,
    jsdomThreshold: 0.2,
    browserThreshold: 0.7,
  },
  rateLimit: {
    requestsPerSecond: 2,
    perDomain: true,
    respectRobotsTxt: true,
  },
  output: {
    format: 'markdown',
    includeMetadata: true,
    includeTokenCount: true,
  },
  cache: {
    enabled: true,
    ttl: 3_600_000,
    maxSize: 100 * 1024 * 1024,
    backend: 'memory',
  },
  antiBot: {
    rotateUserAgent: true,
    rotateFingerprint: false,
    proxyRotation: 'round-robin',
    cookies: 'persist',
  },
};
