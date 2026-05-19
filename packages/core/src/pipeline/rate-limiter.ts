export class PerDomainRateLimiter {
  private requestsPerSecond: number;
  private lastRequestTime = new Map<string, number>();

  constructor(requestsPerSecond = 2) {
    this.requestsPerSecond = requestsPerSecond;
  }

  async throttle(url: string): Promise<void> {
    const domain = new URL(url).hostname;
    const minInterval = 1000 / this.requestsPerSecond;
    const lastTime = this.lastRequestTime.get(domain) || 0;
    const elapsed = Date.now() - lastTime;

    if (elapsed < minInterval) {
      const delay = minInterval - elapsed;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    this.lastRequestTime.set(domain, Date.now());
  }
}
