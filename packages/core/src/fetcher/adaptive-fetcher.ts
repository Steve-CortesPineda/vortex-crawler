import type { FetchRequest, FetchResult, RenderTier, RenderingConfig } from '../types/config.js';
import { HttpFetcher } from './http-fetcher.js';
import { TierDetector } from './tier-detector.js';

/** Minimal cookie-fetch backend (the VANTA extension) — logged-in, no-render HTML. Structurally typed. */
export interface CookieFetcher { httpFetch(url: string, opts?: { timeoutMs?: number }): Promise<{ status: number; finalUrl: string; headers: Record<string, string>; body: string }>; }

export class AdaptiveFetcher {
  private httpFetcher: HttpFetcher;
  private tierDetector: TierDetector;
  private config: RenderingConfig;
  private cookieFetcher?: CookieFetcher;

  // Lazy-loaded fetchers
  private jsdomFetcher: { fetch: (req: FetchRequest) => Promise<FetchResult> } | null = null;
  private browserFetcher: { fetch: (req: FetchRequest) => Promise<FetchResult> } | null = null;

  constructor(config: RenderingConfig, timeout: number, cookieFetcher?: CookieFetcher) {
    this.config = config;
    this.httpFetcher = new HttpFetcher(timeout);
    this.tierDetector = new TierDetector();
    this.cookieFetcher = cookieFetcher;
  }

  async fetch(req: FetchRequest): Promise<FetchResult> {
    // If tier is forced, use that directly
    if (req.tier) {
      return this.fetchAtTier(req, req.tier);
    }

    // Cookie tier first (logged-in, no render) when a VANTA extension backend is available — recovers
    // most article/authed pages instantly. Falls through to the normal ladder if it's thin/blocked.
    if (this.cookieFetcher) {
      try {
        const r = await this.cookieFetcher.httpFetch(req.url, { timeoutMs: req.timeout });
        if (r.status < 400 && r.body && r.body.length > 500 && /text\/html|xhtml/i.test(r.headers['content-type'] || 'text/html')) {
          const post = this.tierDetector.postFetchScore(r.body, r.headers);
          if (post.tier === 'http') { // static-enough content — no JS render needed
            return { url: r.finalUrl || req.url, statusCode: r.status, headers: r.headers, html: r.body, tier: 'http', timing: { fetchMs: 0 } };
          }
        }
      } catch { /* fall through to the normal flow */ }
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
