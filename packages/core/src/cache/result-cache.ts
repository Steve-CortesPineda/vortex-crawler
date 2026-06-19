/**
 * Tiny generic TTL+LRU cache. CacheManager is hard-typed to CrawlResult, so the browse/reach loops
 * use this for memoizing ExtractResult (and LLM-ranker decisions) by URL across hops and tool calls.
 */
export class GenericCache<T> {
  private map = new Map<string, { v: T; exp: number }>();

  constructor(private ttlMs = 3_600_000, private maxEntries = 500) {}

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) { this.map.delete(key); return undefined; }
    // LRU touch: re-insert to move to the end
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, v: T): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
  }

  has(key: string): boolean { return this.get(key) !== undefined; }
  get size(): number { return this.map.size; }
}
