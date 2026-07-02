/**
 * DomainGovernor — one shared per-domain politeness + adaptive-backoff state machine.
 *
 * Every fetch path (single scrape, browse loop, parallel tab extraction, the daemon) routes through
 * ONE shared instance so that N concurrent callers can't collectively hammer a host: spacing and
 * cooldown are keyed by hostname, not by caller. Two mechanisms:
 *
 *   1. Jittered spacing  — a minimum interval between hits to the same domain, plus additive random
 *      jitter so the cadence isn't a detectable metronome (fixed 500ms gaps read as a bot).
 *   2. Adaptive backoff  — when a host answers 429/503/403 (or a Cloudflare-style 520-526), the domain
 *      enters an exponential cooldown (honoring `Retry-After` when present). Consecutive strikes widen
 *      the cooldown; a clean response decays it. This is the piece that was missing: previously a rate-
 *      limited host just kept getting pounded at the same 2 req/s until it hard-blocked the IP.
 *
 * `throttle(url)` is called BEFORE a request and waits out both spacing and any active cooldown.
 * `noteResponse(url, status, headers?)` is called AFTER and updates the domain's strike state.
 */

export interface GovernorOptions {
  /** Steady-state ceiling per domain. Default 2. */
  requestsPerSecond?: number;
  /** Additive jitter as a fraction of the min interval (0 = none). Default 0.4. */
  jitterRatio?: number;
  /** First-strike cooldown base. Default 2000ms. */
  backoffBaseMs?: number;
  /** Cooldown ceiling regardless of strike count. Default 120000ms (2 min). */
  maxBackoffMs?: number;
}

interface DomainState {
  lastAt: number;        // last time we hit this domain
  cooldownUntil: number; // don't send again until this timestamp (adaptive backoff)
  strikes: number;       // consecutive throttle responses — drives exponential backoff
}

/** Status codes that mean "you're going too fast" or "temporarily unavailable". */
const THROTTLE_CODES = new Set([403, 429, 503, 520, 521, 522, 523, 524, 525, 526]);

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms-from-now, capped. Undefined if absent/garbage. */
function retryAfterMs(headers: Record<string, string> | undefined, cap: number): number | undefined {
  if (!headers) return undefined;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(cap, Math.max(0, secs * 1000));
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(cap, Math.max(0, when - Date.now()));
  return undefined;
}

export class DomainGovernor {
  private minInterval: number;
  private jitterRatio: number;
  private backoffBaseMs: number;
  private maxBackoffMs: number;
  private state = new Map<string, DomainState>();

  constructor(opts: GovernorOptions = {}) {
    const rps = opts.requestsPerSecond ?? 2;
    this.minInterval = rps > 0 ? 1000 / rps : 0;
    this.jitterRatio = opts.jitterRatio ?? 0.4;
    this.backoffBaseMs = opts.backoffBaseMs ?? 2000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 120_000;
  }

  private get(domain: string): DomainState {
    let s = this.state.get(domain);
    if (!s) { s = { lastAt: 0, cooldownUntil: 0, strikes: 0 }; this.state.set(domain, s); }
    return s;
  }

  /** Wait until it's polite to hit `url`'s domain: max(spacing since last hit, active cooldown) + jitter. */
  async throttle(url: string): Promise<void> {
    const domain = hostOf(url);
    const s = this.get(domain);
    const now = Date.now();

    const jitter = this.minInterval * this.jitterRatio * Math.random();
    const spacingReady = s.lastAt + this.minInterval + jitter;
    const readyAt = Math.max(spacingReady, s.cooldownUntil);
    const wait = readyAt - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    s.lastAt = Date.now();
  }

  /**
   * Record a response so the domain's backoff adapts. Throttle codes widen an exponential cooldown
   * (honoring Retry-After); any other response decays one strike. Call this from every fetch path
   * that can see a status code (http-fetcher, browser goto, search engines).
   */
  noteResponse(url: string, status: number, headers?: Record<string, string>): void {
    const s = this.get(hostOf(url));
    if (THROTTLE_CODES.has(status)) {
      s.strikes = Math.min(s.strikes + 1, 8);
      const exp = this.backoffBaseMs * Math.pow(2, s.strikes - 1);
      const backoff = retryAfterMs(headers, this.maxBackoffMs)
        ?? Math.min(this.maxBackoffMs, exp) + Math.random() * this.backoffBaseMs;
      s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + backoff);
    } else if (status >= 200 && status < 400) {
      if (s.strikes > 0) s.strikes -= 1;
      if (s.strikes === 0) s.cooldownUntil = 0;
    }
  }

  /** Current cooldown remaining for a domain (ms), for diagnostics/telemetry. */
  cooldownRemaining(url: string): number {
    return Math.max(0, this.get(hostOf(url)).cooldownUntil - Date.now());
  }
}

/**
 * The process-wide shared governor. Import this everywhere a fetch happens so per-domain politeness
 * is truly global (parallel callers share one host's spacing + cooldown). Tunable via env:
 *   VORTEX_RPS (default 2), VORTEX_MAX_BACKOFF_MS (default 120000).
 */
export const sharedGovernor = new DomainGovernor({
  requestsPerSecond: Number(process.env.VORTEX_RPS) || 2,
  maxBackoffMs: Number(process.env.VORTEX_MAX_BACKOFF_MS) || 120_000,
});

/**
 * Back-compat alias. Older code constructs `new PerDomainRateLimiter(rps)` and calls `.throttle(url)`.
 * It now delegates to a DomainGovernor so those paths get jitter + backoff for free; when constructed
 * with no args it proxies the shared singleton so state is unified across the process.
 */
export class PerDomainRateLimiter {
  private governor: DomainGovernor;
  constructor(requestsPerSecond?: number) {
    this.governor = requestsPerSecond === undefined ? sharedGovernor : new DomainGovernor({ requestsPerSecond });
  }
  throttle(url: string): Promise<void> { return this.governor.throttle(url); }
  noteResponse(url: string, status: number, headers?: Record<string, string>): void {
    this.governor.noteResponse(url, status, headers);
  }
}
