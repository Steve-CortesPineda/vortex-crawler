import type { RenderTier } from '../types/config.js';

const SPA_DOMAINS = new Set([
  'app.', 'dashboard.', 'console.', 'portal.',
]);

const SPA_FRAMEWORKS_RE = /(?:react|vue|angular|svelte|next|nuxt|gatsby|remix)[\w.-]*\.js/i;
const EMPTY_ROOT_RE = /<div\s+id=["'](?:root|app|__next|__nuxt)["']\s*>\s*<\/div>/i;
const NOSCRIPT_RE = /<noscript[^>]*>[\s\S]{100,}<\/noscript>/i;
const SUBSTANTIAL_TEXT_RE = /(?:<(?:p|h[1-6]|li|td|article|section|main)[^>]*>[^<]{50,}<\/)/i;

export interface TierScore {
  tier: RenderTier;
  confidence: number;
  score: number;
}

export class TierDetector {
  private domainTierCache = new Map<string, RenderTier>();

  /** Score a URL before fetching to predict which tier is needed */
  preFetchScore(url: string): TierScore {
    const hostname = new URL(url).hostname;

    // Check domain cache first
    const cached = this.domainTierCache.get(hostname);
    if (cached) {
      return { tier: cached, confidence: 0.9, score: cached === 'browser' ? 0.9 : cached === 'jsdom' ? 0.4 : 0.0 };
    }

    let score = 0;

    // URL-based signals
    if (url.includes('#/') || url.includes('#!/')) score += 0.3;
    if (/\/(?:app|dashboard|settings|console|portal)\b/.test(url)) score += 0.1;

    // Domain signals
    for (const prefix of SPA_DOMAINS) {
      if (hostname.startsWith(prefix)) {
        score += 0.2;
        break;
      }
    }

    return this.scoreToTier(score);
  }

  /** Score a Tier 1 HTTP response to decide if we need to escalate */
  postFetchScore(html: string, headers: Record<string, string>): TierScore {
    let score = 0;

    // Empty root div (SPA shell)
    if (EMPTY_ROOT_RE.test(html)) score += 0.35;

    // Noscript with significant content suggests JS is required
    if (NOSCRIPT_RE.test(html)) score += 0.3;

    // SPA framework bundles in script tags
    if (SPA_FRAMEWORKS_RE.test(html)) score += 0.2;

    // Very small body with many scripts = likely SPA
    const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').trim();
    const scriptCount = (html.match(/<script/gi) || []).length;
    if (bodyText.length < 500 && scriptCount > 3) score += 0.25;

    // Negative signals: page already has substantial content — these are strong
    // because if the server sent real text, JS rendering won't add much
    if (SUBSTANTIAL_TEXT_RE.test(html)) score -= 0.4;
    if (bodyText.length > 2000) score -= 0.4;
    if (bodyText.length > 500) score -= 0.2;

    // Server-rendered signals
    const contentType = headers['content-type'] || '';
    if (contentType.includes('text/html') && bodyText.length > 1000) score -= 0.2;

    return this.scoreToTier(Math.max(0, score));
  }

  /** Record which tier worked for a domain to improve future predictions */
  recordOutcome(url: string, tier: RenderTier, success: boolean): void {
    if (success) {
      const hostname = new URL(url).hostname;
      this.domainTierCache.set(hostname, tier);
    }
  }

  private scoreToTier(score: number): TierScore {
    if (score > 0.5) return { tier: 'browser', confidence: Math.min(score, 1), score };
    if (score > 0.2) return { tier: 'jsdom', confidence: score, score };
    return { tier: 'http', confidence: 1 - score, score };
  }
}
