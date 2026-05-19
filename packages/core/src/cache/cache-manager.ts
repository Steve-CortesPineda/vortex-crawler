import type { CrawlResult } from '../types/result.js';
import type { CacheConfig } from '../types/config.js';

interface CacheEntry {
  result: CrawlResult;
  timestamp: number;
}

export class CacheManager {
  private store = new Map<string, CacheEntry>();
  private config: CacheConfig;
  private totalSize = 0;

  constructor(config: CacheConfig) {
    this.config = config;
  }

  get(url: string): CrawlResult | null {
    if (!this.config.enabled) return null;

    const entry = this.store.get(url);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > this.config.ttl) {
      this.store.delete(url);
      return null;
    }

    return { ...entry.result, fromCache: true };
  }

  set(url: string, result: CrawlResult): void {
    if (!this.config.enabled) return;

    const size = this.estimateSize(result);

    // Evict if over max size
    while (this.totalSize + size > this.config.maxSize && this.store.size > 0) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.delete(oldest);
    }

    this.store.set(url, { result, timestamp: Date.now() });
    this.totalSize += size;
  }

  has(url: string): boolean {
    return this.get(url) !== null;
  }

  delete(url: string): void {
    const entry = this.store.get(url);
    if (entry) {
      this.totalSize -= this.estimateSize(entry.result);
      this.store.delete(url);
    }
  }

  clear(): void {
    this.store.clear();
    this.totalSize = 0;
  }

  get size(): number {
    return this.store.size;
  }

  private estimateSize(result: CrawlResult): number {
    // Rough estimate: markdown + html lengths in bytes
    return (result.markdown?.length || 0) + (result.html?.length || 0);
  }
}
