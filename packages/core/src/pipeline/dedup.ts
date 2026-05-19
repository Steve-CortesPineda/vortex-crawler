/**
 * Content deduplication using MurmurHash3 fingerprinting.
 * Detects near-duplicate pages to avoid processing the same content twice.
 */

export class ContentDeduplicator {
  private hashes = new Set<string>();

  /** Simple but fast string hash for dedup purposes */
  fingerprint(content: string): string {
    // Strip HTML, normalize whitespace for content-based comparison
    const normalized = content
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // FNV-1a hash — fast, good distribution, zero dependencies
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }

    return hash.toString(16).padStart(8, '0');
  }

  /** Returns true if this content has been seen before */
  isDuplicate(content: string): boolean {
    const hash = this.fingerprint(content);
    if (this.hashes.has(hash)) return true;
    this.hashes.add(hash);
    return false;
  }

  clear(): void {
    this.hashes.clear();
  }
}
