import type { BridgeServer } from './ws-server.js';
import { TabPool, type TabPoolOptions } from './scheduler.js';
import { assertAllowed } from './policy.js';
import {
  type ExtractPayload, type HttpFetchResult, type TabGotoResult, type ActStep, type TabActResult,
  type SerpItem,
} from './protocol.js';
import { ReadabilityExtractor } from '../processor/readability-extractor.js';
import { MarkdownConverter } from '../processor/markdown-converter.js';
import { ContentCleaner } from '../processor/content-cleaner.js';
import { MetadataExtractor } from '../processor/metadata-extractor.js';
import { LinkExtractor } from '../processor/link-extractor.js';
import { sharedGovernor } from '../pipeline/rate-limiter.js';
import { GenericCache } from '../cache/result-cache.js';
import { ocrFile, ocrAvailable } from '../ocr/vision.js';

/** Shared across the process: concurrent research trees reuse each other's google-session SERPs instead
 * of each waiting on the 8s pacing gap. 5-min TTL. */
const googleSerpCache = new GenericCache<SerpItem[]>(5 * 60_000, 300);

/**
 * ExtensionBrowser — an AgentBrowser-shaped facade over the VANTA extension bridge.
 *
 * Same method names/return shapes as AgentBrowser (ExtractResult, ActResult) so the browser daemon can
 * route to it transparently. Two speed tiers live here:
 *   - fetchExtract(): cookie-authenticated `http.fetch` in the extension + server-side Readability/markdown.
 *     No render — the fast path for articles/SERPs/APIs the profile is logged into.
 *   - goto()+extract(): real tab render + in-page extraction, for JS-dependent pages.
 * Parallel work runs on the TabPool (batch lane); interactive goto/click/type serialize on one tab.
 */

export interface ExtractResult {
  url: string; title: string; markdown: string; approxTokens: number;
  captchaDetected: boolean; publishDate?: string;
  extractedVia?: 'readability' | 'cleaner' | 'ocr';
  /** Absolute outbound links from the rendered page (used by google-session parsing + browse link-following). */
  links?: { href: string; text: string }[];
}
export interface ActResult { ok: boolean; url: string; title: string; note?: string; }

const CAPTCHA_HTML_RE = /recaptcha|hcaptcha|cf-challenge|turnstile|are you a robot|verify you are human/i;

/** Derive a readable title from a content URL's slug (e.g. /comments/abc/easy_home_workout/ → "easy home workout"). */
function slugTitle(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    // Pick the longest slug-looking segment (has letters + a separator), not an id.
    const slug = parts.filter((p) => /[a-z].*[_-]/i.test(p)).sort((a, b) => b.length - a.length)[0] || '';
    return slug.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  } catch { return ''; }
}

export class ExtensionBrowser {
  private bridge: BridgeServer;
  private pool: TabPool;
  private readonly readability = new ReadabilityExtractor();
  private readonly md = new MarkdownConverter();
  private readonly cleaner = new ContentCleaner();
  private readonly meta = new MetadataExtractor();
  private readonly linkExtractor = new LinkExtractor();

  constructor(bridge: BridgeServer, poolOpts?: TabPoolOptions) {
    this.bridge = bridge;
    this.pool = new TabPool(bridge, poolOpts);
    // A (re)connect means a fresh extension SW — and possibly a fresh Chrome session whose tab ids share
    // nothing with the ones we cached. Flush the pool so every lane re-leases instead of erroring on
    // dead ids ("No tab with id: …"). On the FIRST connect the pool is empty and this is a no-op.
    bridge.onConnect(() => this.pool.reset());
  }

  get connected(): boolean { return this.bridge.connected; }
  stats() { return { bridge: this.bridge.info, pool: this.pool.stats() }; }

  // ── Google via the logged-in session ────────────────────────────────────────
  // Render on a POOL tab (keeps the interactive lane free), parse the SERP in-page for clean
  // {title,url,snippet}, and self-pace so repeated Google renders stay unflagged even when logged in.
  private googleLastAt = 0;
  private googleCooldownUntil = 0;
  // Logged-in Google tolerates a faster cadence than anonymous scraping — 4s keeps it responsive as the
  // PRIMARY quality engine without tripping challenges. A CAPTCHA backs off only 60s (was 3min) so a
  // single hiccup doesn't take the good engine out for the rest of the session.
  private static readonly GOOGLE_MIN_GAP_MS = 4_000;
  private static readonly GOOGLE_COOLDOWN_MS = 60_000;

  async googleSearch(query: string, opts?: { news?: boolean; max?: number }): Promise<SerpItem[]> {
    const max = opts?.max ?? 10;
    // Cache hit → skip the render AND the pacing wait entirely (big win when concurrent tasks overlap).
    const cacheKey = `${opts?.news ? 'news' : 'web'}:${query}`;
    const cached = googleSerpCache.get(cacheKey);
    if (cached) return cached.slice(0, max);
    const now = Date.now();
    if (now < this.googleCooldownUntil) {
      throw new Error(`google-session cooling down ${Math.ceil((this.googleCooldownUntil - now) / 1000)}s (recent block)`);
    }
    const gap = this.googleLastAt + ExtensionBrowser.GOOGLE_MIN_GAP_MS - now;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.googleLastAt = Date.now();

    const tbm = opts?.news ? '&tbm=nws' : '';
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us&num=${Math.max(max, 10)}${tbm}`;
    return this.pool.withTab(url, async (tabId, s) => {
      const r = await this.bridge.call<TabGotoResult>('tab.goto', { tabId, url });
      s.markNav();
      // Detect a block/CAPTCHA via a quick extract; back off if Google challenged us.
      const probe = await this.bridge.call<ExtractPayload>('tab.extract', { tabId, settleMs: 1200 });
      if (probe.captchaDetected || /unusual traffic|not a robot|before you continue/i.test(probe.markdown.slice(0, 1500))) {
        this.googleCooldownUntil = Date.now() + ExtensionBrowser.GOOGLE_COOLDOWN_MS;
        throw new Error('google-session challenged (CAPTCHA/unusual traffic) — backing off');
      }
      const items = await this.bridge.call<SerpItem[]>('tab.serp', { tabId, mode: opts?.news ? 'news' : 'web', max });
      if (items.length) googleSerpCache.set(cacheKey, items);
      return items.slice(0, max);
    });
  }

  // ── Tier 0.5: cookie-authenticated fetch, no render ─────────────────────────
  /** Raw cookie-authenticated fetch via the extension. Returns status+headers+body. */
  async httpFetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<HttpFetchResult> {
    assertAllowed('fetch', url);
    await sharedGovernor.throttle(url);
    const r = await this.bridge.call<HttpFetchResult>('http.fetch', { url, ...opts }, opts?.timeoutMs);
    sharedGovernor.noteResponse(url, r.status);
    return r;
  }

  /** Cookie-fetch → server-side extract to markdown. The fast path; returns null if the body is unusable. */
  async fetchExtract(url: string): Promise<ExtractResult | null> {
    const r = await this.httpFetch(url);
    if (r.status >= 400 || !r.body || r.body.length < 100) return null;
    if (!/text\/html|application\/xhtml/i.test(r.headers['content-type'] || 'text/html')) {
      // Non-HTML (JSON/text) — hand back as-is; callers decide.
      const md = r.body.slice(0, 200_000);
      return { url: r.finalUrl || url, title: '', markdown: md, approxTokens: Math.round(md.length / 4), captchaDetected: false, extractedVia: 'cleaner' };
    }
    return this.htmlToExtract(r.finalUrl || url, r.body);
  }

  /** Shared server-side HTML→markdown (Readability primary, ContentCleaner fallback) + metadata. */
  private htmlToExtract(url: string, html: string): ExtractResult {
    const meta = this.meta.extract(html, url);
    const readable = this.readability.extract(html, url);
    let markdown: string;
    let extractedVia: 'readability' | 'cleaner';
    if (readable.ok && readable.contentHtml && (readable.textContent?.length ?? 0) >= 200) {
      markdown = this.md.convert(readable.contentHtml);
      extractedVia = 'readability';
    } else {
      markdown = this.md.convert(this.cleaner.clean(html, url));
      extractedVia = 'cleaner';
    }
    const captchaDetected = CAPTCHA_HTML_RE.test(html.slice(0, 4000));
    const publishDate = meta.publishedAt || readable.publishedTime || undefined;
    // Carry links so the cookie-fetch tier feeds the tree/browse link-following (readability strips them).
    const links = this.linkExtractor.extract(html, url).map((l) => ({ href: l.url, text: l.text }));
    return {
      url, title: readable.title || meta.title || '', markdown,
      approxTokens: Math.round(markdown.length / 4), captchaDetected, publishDate, extractedVia, links,
    };
  }

  // ── Logged-in site search (Reddit / X / LinkedIn walled gardens) ────────────
  // Renders the site's own search in YOUR logged-in session and returns on-site content links. Uses the
  // generic in-page link extraction (rendered DOM) filtered to each site's content-URL pattern.
  private static readonly SITES: Record<string, { url: (q: string) => string; contentRe: RegExp; minText: number }> = {
    reddit:   { url: (q) => `https://old.reddit.com/search?q=${encodeURIComponent(q)}&sort=relevance&t=year`, contentRe: /reddit\.com\/r\/[^/]+\/comments\//i, minText: 10 },
    x:        { url: (q) => `https://x.com/search?q=${encodeURIComponent(q)}&f=live`, contentRe: /(x|twitter)\.com\/[^/]+\/status\/\d+/i, minText: 8 },
    twitter:  { url: (q) => `https://x.com/search?q=${encodeURIComponent(q)}&f=live`, contentRe: /(x|twitter)\.com\/[^/]+\/status\/\d+/i, minText: 8 },
    linkedin: { url: (q) => `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(q)}`, contentRe: /linkedin\.com\/(posts|feed\/update|pulse)\//i, minText: 12 },
  };

  async siteSearch(site: string, query: string, max = 10): Promise<{ title: string; url: string }[]> {
    const cfg = ExtensionBrowser.SITES[site.toLowerCase()];
    if (!cfg) throw new Error(`unknown site '${site}' (known: ${Object.keys(ExtensionBrowser.SITES).join(', ')})`);
    const ex = await this.page(cfg.url(query));
    const out: { title: string; url: string }[] = [];
    const seen = new Set<string>();
    for (const l of (ex.links || [])) {
      if (out.length >= max) break;
      if (!cfg.contentRe.test(l.href)) continue;
      // Result anchors often have empty text (title lives in a sibling); fall back to the URL slug.
      let title = (l.text || '').trim();
      if (title.length < cfg.minText) title = slugTitle(l.href);
      if (title.length < cfg.minText) continue;
      const key = l.href.replace(/[?#].*$/, '');
      if (seen.has(key)) continue;
      seen.add(key); out.push({ title, url: l.href });
    }
    return out;
  }

  // ── Visual reader: screenshot + OCR (DOM-proof) ─────────────────────────────
  // For hostile SPAs (X/LinkedIn) and anti-scraping/canvas pages: render in YOUR logged-in session,
  // scroll while screenshotting, OCR each frame with Apple Vision, and return the on-screen TEXT.
  // Reads what a human would see — no DOM parsing. Loses per-item URLs (not painted on screen), so it's
  // for "look up what's there", not "give me links". macOS-only (Apple Vision); errors cleanly elsewhere.
  async readVisual(url: string, opts?: { scrolls?: number; settleMs?: number }): Promise<{ url: string; text: string; frames: number }> {
    if (!(await ocrAvailable())) throw new Error('visual read needs Apple Vision OCR (macOS + swiftc)');
    assertAllowed('goto', url);
    const scrolls = Math.max(1, Math.min(opts?.scrolls ?? 3, 8));
    const settleMs = opts?.settleMs ?? 1500;
    const { promises: fs } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    return this.pool.runInteractive(async (tabId) => {
      await sharedGovernor.throttle(url);
      await this.bridge.call<TabGotoResult>('tab.goto', { tabId, url });
      const seen = new Set<string>();
      const lines: string[] = [];
      let frames = 0;
      for (let i = 0; i < scrolls; i++) {
        let shot = '';
        try { shot = (await this.bridge.call<{ dataUrl: string }>('tab.screenshot', { tabId })).dataUrl; } catch { break; }
        const file = path.join(os.tmpdir(), `vanta-visual-${process.pid}-${i}.png`);
        try {
          await fs.writeFile(file, Buffer.from(shot.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
          const text = await ocrFile(file);
          frames++;
          // Dedupe lines across overlapping frames.
          for (const ln of (text || '').split('\n').map((s) => s.trim())) {
            if (ln.length < 3) continue;
            const key = ln.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key); lines.push(ln);
          }
        } finally { await fs.unlink(file).catch(() => {}); }
        if (i < scrolls - 1) {
          await this.bridge.call('tab.act', { tabId, steps: [{ kind: 'scroll', direction: 'down', amount: 2 }] }).catch(() => {});
          await new Promise((r) => setTimeout(r, settleMs));
        }
      }
      return { url, text: lines.join('\n'), frames };
    });
  }

  // ── Interactive tab (serialized) ────────────────────────────────────────────
  async open(): Promise<ActResult> {
    if (!this.bridge.connected) return { ok: false, url: '', title: '', note: 'extension bridge not connected' };
    return { ok: true, url: '', title: '', note: 'extension bridge ready' };
  }

  async goto(url: string, waitFor?: string): Promise<ActResult> {
    assertAllowed('goto', url);
    return this.pool.runInteractive(async (tabId) => {
      await sharedGovernor.throttle(url);
      const r = await this.bridge.call<TabGotoResult>('tab.goto', { tabId, url, waitFor });
      if (r.status != null) sharedGovernor.noteResponse(url, r.status);
      return { ok: true, url: r.finalUrl || url, title: '', note: 'navigated' };
    });
  }

  async extract(): Promise<ExtractResult> {
    return this.pool.runInteractive(async (tabId) => {
      const p = await this.bridge.call<ExtractPayload>('tab.extract', { tabId });
      return this.payloadToResult(p);
    });
  }

  /** Navigate + extract a single URL on the interactive tab. */
  async page(url: string, waitFor?: string): Promise<ExtractResult> {
    assertAllowed('goto', url);
    return this.pool.runInteractive(async (tabId) => {
      await sharedGovernor.throttle(url);
      const r = await this.bridge.call<TabGotoResult>('tab.goto', { tabId, url, waitFor });
      if (r.status != null) sharedGovernor.noteResponse(url, r.status);
      const p = await this.bridge.call<ExtractPayload>('tab.extract', { tabId });
      return this.payloadToResult(p);
    });
  }

  async click(target: string, byText = false): Promise<ActResult> {
    return this.actOne({ kind: 'click', target, byText });
  }
  async type(selector: string, text: string, submit = false): Promise<ActResult> {
    return this.actOne({ kind: 'type', selector, text, submit });
  }
  async press(key: string): Promise<ActResult> {
    return this.actOne({ kind: 'press', key });
  }
  async scroll(direction: 'down' | 'up' = 'down', amount = 1): Promise<ActResult> {
    return this.actOne({ kind: 'scroll', direction, amount });
  }

  /** Batch a sequence of actions into ONE round trip on the interactive tab. */
  async act(steps: ActStep[]): Promise<ActResult> {
    return this.pool.runInteractive(async (tabId) => {
      const cur = await this.currentUrl(tabId);
      assertAllowed('act', cur);
      const r = await this.bridge.call<TabActResult>('tab.act', { tabId, steps });
      return { ok: !r.refused, url: cur, title: '', note: r.refused || `ran ${r.ran}/${steps.length}: ${r.notes.join('; ')}`.slice(0, 300) };
    });
  }
  private actOne(step: ActStep): Promise<ActResult> { return this.act([step]); }

  private async currentUrl(tabId: number): Promise<string> {
    try { const p = await this.bridge.call<ExtractPayload>('tab.extract', { tabId }); return p.url; } catch { return ''; }
  }

  async screenshot(path: string): Promise<ActResult> {
    return this.pool.runInteractive(async (tabId) => {
      const { dataUrl } = await this.bridge.call<{ dataUrl: string }>('tab.screenshot', { tabId });
      const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const { promises: fs } = await import('node:fs');
      await fs.writeFile(path, Buffer.from(b64, 'base64'));
      return { ok: true, url: '', title: '', note: `screenshot → ${path}` };
    });
  }

  async links(): Promise<{ href: string; text: string }[]> {
    return this.pool.runInteractive(async (tabId) => {
      const p = await this.bridge.call<ExtractPayload>('tab.extract', { tabId });
      return p.links || [];
    });
  }

  // ── Parallel (batch lane) ───────────────────────────────────────────────────
  /**
   * Fetch + extract many URLs in parallel. Tries the cookie-fetch tier FIRST (no tab, fastest); only
   * URLs that come back thin/unusable fall back to a real tab render on the pool. Order preserved.
   */
  async parallelExtract(urls: string[], opts?: { settleMs?: number; concurrency?: number }): Promise<ExtractResult[]> {
    const settleMs = opts?.settleMs ?? 3000;
    return Promise.all(urls.map(async (url) => {
      // tier 0.5 first
      try {
        assertAllowed('goto', url);
        const fast = await this.fetchExtract(url);
        if (fast && fast.markdown.replace(/\s+/g, '').length >= 400 && !fast.captchaDetected) return fast;
      } catch (e) {
        const msg = (e as Error)?.message || '';
        if (msg.startsWith('POLICY:')) return { url, title: '', markdown: '', approxTokens: 0, captchaDetected: false, extractedVia: 'cleaner' as const };
        // else fall through to render
      }
      // render fallback on a pool tab
      try {
        return await this.pool.withTab(url, async (tabId, s) => {
          const r = await this.bridge.call<TabGotoResult>('tab.goto', { tabId, url, block: true });
          if (r.status != null) sharedGovernor.noteResponse(url, r.status);
          s.markNav();
          const p = await this.bridge.call<ExtractPayload>('tab.extract', { tabId, settleMs });
          return this.payloadToResult(p);
        });
      } catch {
        return { url, title: '', markdown: '', approxTokens: 0, captchaDetected: false, extractedVia: 'cleaner' as const };
      }
    }));
  }

  async parallelScreenshot(jobs: { url: string; path: string }[], _opts?: { settleMs?: number; concurrency?: number }): Promise<{ url: string; path: string; ok: boolean }[]> {
    const { promises: fs } = await import('node:fs');
    return Promise.all(jobs.map((job) =>
      this.pool.withTab(job.url, async (tabId, s) => {
        try {
          await this.bridge.call<TabGotoResult>('tab.goto', { tabId, url: job.url });
          s.markNav();
          const { dataUrl } = await this.bridge.call<{ dataUrl: string }>('tab.screenshot', { tabId });
          await fs.writeFile(job.path, Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
          return { url: job.url, path: job.path, ok: true };
        } catch { return { url: job.url, path: job.path, ok: false }; }
      })
    ));
  }

  private payloadToResult(p: ExtractPayload): ExtractResult {
    return {
      url: p.url, title: p.title, markdown: p.markdown, approxTokens: p.approxTokens,
      captchaDetected: p.captchaDetected, publishDate: p.publishDate, extractedVia: p.extractedVia,
      links: p.links || [],
    };
  }

  async close(): Promise<ActResult> {
    await this.pool.drain().catch(() => {});
    return { ok: true, url: '', title: '', note: 'pool drained (extension stays connected)' };
  }
}
