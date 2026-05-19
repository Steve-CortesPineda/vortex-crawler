import type { FetchRequest, FetchResult, RenderTier, RenderingConfig } from '../types/config.js';
import { HttpFetcher } from './http-fetcher.js';
import { TierDetector } from './tier-detector.js';

export class AdaptiveFetcher {
  private httpFetcher: HttpFetcher;
  private tierDetector: TierDetector;
  private config: RenderingConfig;

  // Lazy-loaded fetchers
  private jsdomFetcher: { fetch: (req: FetchRequest) => Promise<FetchResult> } | null = null;
  private browserFetcher: { fetch: (req: FetchRequest) => Promise<FetchResult> } | null = null;

  constructor(config: RenderingConfig, timeout: number) {
    this.config = config;
    this.httpFetcher = new HttpFetcher(timeout);
    this.tierDetector = new TierDetector();
  }

  async fetch(req: FetchRequest): Promise<FetchResult> {
    // If tier is forced, use that directly
    if (req.tier) {
      return this.fetchAtTier(req, req.tier);
    }

    // Auto-detect: start with pre-fetch prediction
    const prediction = this.config.autoDetect
      ? this.tierDetector.preFetchScore(req.url)
      : { tier: this.config.defaultTier, confidence: 1, score: 0 };

    // Try at predicted tier
    try {
      const result = await this.fetchAtTier(req, prediction.tier);

      // If we started at Tier 1, check if we should escalate
      if (prediction.tier === 'http' && this.config.autoDetect) {
        const postScore = this.tierDetector.postFetchScore(result.html, result.headers);

        if (postScore.tier !== 'http') {
          // Escalate: the page needs JS rendering
          try {
            const escalated = await this.fetchAtTier(req, postScore.tier);
            this.tierDetector.recordOutcome(req.url, postScore.tier, true);
            return escalated;
          } catch {
            // Escalation failed, return Tier 1 result anyway
            this.tierDetector.recordOutcome(req.url, 'http', true);
            return result;
          }
        }
      }

      this.tierDetector.recordOutcome(req.url, prediction.tier, true);
      return result;
    } catch (error) {
      // Fallback: escalate through tiers
      return this.fetchWithFallback(req, prediction.tier, error as Error);
    }
  }

  private async fetchAtTier(req: FetchRequest, tier: RenderTier): Promise<FetchResult> {
    switch (tier) {
      case 'http':
        return this.httpFetcher.fetch(req);

      case 'jsdom': {
        if (!this.jsdomFetcher) {
          const { JsdomFetcher } = await import('./jsdom-fetcher.js');
          this.jsdomFetcher = new JsdomFetcher(req.timeout ?? 30_000);
        }
        return this.jsdomFetcher.fetch(req);
      }

      case 'browser': {
        if (!this.browserFetcher) {
          const { BrowserFetcher } = await import('./browser-fetcher.js');
          this.browserFetcher = new BrowserFetcher(this.config.browserPoolSize);
        }
        return this.browserFetcher.fetch(req);
      }
    }
  }

  private async fetchWithFallback(req: FetchRequest, failedTier: RenderTier, _error: Error): Promise<FetchResult> {
    const escalation: RenderTier[] = ['http', 'jsdom', 'browser'];
    const startIdx = escalation.indexOf(failedTier) + 1;

    for (let i = startIdx; i < escalation.length; i++) {
      try {
        const result = await this.fetchAtTier(req, escalation[i]);
        this.tierDetector.recordOutcome(req.url, escalation[i], true);
        return result;
      } catch {
        continue;
      }
    }

    throw new Error(`All rendering tiers failed for ${req.url}`);
  }

  async close(): Promise<void> {
    if (this.browserFetcher && 'close' in this.browserFetcher) {
      await (this.browserFetcher as { close: () => Promise<void> }).close();
    }
  }
}
