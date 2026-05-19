export interface QueueItem {
  url: string;
  depth: number;
  priority: number;
  parentUrl?: string;
}

export class PriorityURLQueue {
  private queue: QueueItem[] = [];
  private seen = new Set<string>();

  get size(): number {
    return this.queue.length;
  }

  get totalSeen(): number {
    return this.seen.size;
  }

  enqueue(item: QueueItem): boolean {
    const normalized = this.normalize(item.url);
    if (this.seen.has(normalized)) return false;

    this.seen.add(normalized);
    this.queue.push(item);
    // Sort by priority descending (higher = first)
    this.queue.sort((a, b) => b.priority - a.priority);
    return true;
  }

  enqueueMany(items: QueueItem[]): number {
    let added = 0;
    for (const item of items) {
      if (this.enqueue(item)) added++;
    }
    return added;
  }

  dequeue(): QueueItem | undefined {
    return this.queue.shift();
  }

  has(url: string): boolean {
    return this.seen.has(this.normalize(url));
  }

  clear(): void {
    this.queue = [];
    this.seen.clear();
  }

  private normalize(url: string): string {
    try {
      const u = new URL(url);
      u.hash = '';
      // Remove trailing slash
      return u.href.replace(/\/+$/, '');
    } catch {
      return url;
    }
  }
}
