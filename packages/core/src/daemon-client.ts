/**
 * VortexDaemonClient — thin HTTP client for the shared browser daemon (browser-daemon.mjs).
 *
 * Lets any Node consumer (the MCP server, a background daemon, a script) drive the ONE warm shared
 * Chromium instead of launching its own — avoiding duplicate browsers and profile-lock conflicts.
 * The daemon binds 127.0.0.1 only; pass a token if VORTEX_DAEMON_TOKEN is set on the daemon.
 *
 * Non-Node consumers (a Python/Swift VANTA sidecar) should just POST the same JSON to the same paths —
 * this class is only a convenience wrapper, not the contract. See README "Browser daemon" for the API.
 */

export interface DaemonClientOptions {
  /** Base URL. Default from VORTEX_DAEMON_URL, else http://127.0.0.1:4477. */
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}

export interface DaemonExtract {
  url: string; title: string; markdown: string; approxTokens: number;
  captchaDetected: boolean; publishDate?: string; extractedVia?: string;
}

export class VortexDaemonClient {
  private baseUrl: string;
  private token: string;
  private timeoutMs: number;

  constructor(opts: DaemonClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || process.env.VORTEX_DAEMON_URL || 'http://127.0.0.1:4477').replace(/\/$/, '');
    this.token = opts.token || process.env.VORTEX_DAEMON_TOKEN || '';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private async post<T = unknown>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    const json: any = await res.json();
    if (!res.ok || json?.ok === false) throw new Error(json?.error || `daemon ${path} → HTTP ${res.status}`);
    return json.result as T;
  }

  /** True if the daemon is up and reachable — cheap probe used to decide whether to proxy or run in-process. */
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch { return false; }
  }

  /** Generic escape hatch — POST any daemon route and get its `result`. */
  call<T = unknown>(path: string, body: unknown = {}): Promise<T> { return this.post<T>(path, body); }

  // ── Interactive single-page ops (mirror the AgentBrowser surface) ────────────
  goto(url: string, waitFor?: string): Promise<unknown> { return this.post('/goto', { url, waitFor }); }
  extract(): Promise<DaemonExtract> { return this.post('/extract', {}); }
  click(target: string, byText = false): Promise<unknown> { return this.post('/click', { target, byText }); }
  type(selector: string, text: string, submit = false): Promise<unknown> { return this.post('/type', { selector, text, submit }); }
  press(key: string): Promise<unknown> { return this.post('/press', { key }); }
  scroll(direction: 'down' | 'up' = 'down', amount = 1): Promise<unknown> { return this.post('/scroll', { direction, amount }); }
  screenshot(path: string): Promise<unknown> { return this.post('/screenshot', { path }); }

  /** Navigate + extract a single URL to markdown. */
  page(url: string, waitFor?: string): Promise<DaemonExtract> { return this.post('/page', { url, waitFor }); }
  /** Fetch + extract many URLs in parallel (bounded tab pool in the daemon). */
  parallelExtract(urls: string[], opts?: { concurrency?: number; settleMs?: number }): Promise<DaemonExtract[]> {
    return this.post('/parallel_extract', { urls, ...opts });
  }
  parallelScreenshot(jobs: { url: string; path: string }[], opts?: { concurrency?: number; settleMs?: number }): Promise<{ url: string; path: string; ok: boolean }[]> {
    return this.post('/parallel_screenshot', { jobs, ...opts });
  }
  reach(url: string, allowArchive = true): Promise<unknown> { return this.post('/reach', { url, allowArchive }); }
  browse(query: string, opts?: Record<string, unknown>): Promise<unknown> { return this.post('/browse', { query, ...opts }); }
  search(query: string, opts?: { maxResults?: number; recency?: string; browserFallback?: boolean; rerank?: boolean; rerankTop?: number; youtube?: boolean; noCache?: boolean }): Promise<unknown> {
    return this.post('/search', { query, ...opts });
  }
  google(query: string, maxResults = 10): Promise<unknown> { return this.post('/google', { query, maxResults }); }
}
