import { MarkdownConverter } from './processor/markdown-converter.js';
import { ContentCleaner } from './processor/content-cleaner.js';
import { MetadataExtractor } from './processor/metadata-extractor.js';
import { ReadabilityExtractor } from './processor/readability-extractor.js';
import {
  buildLaunchPlan, loadEngine, DEFAULT_BLOCK_TYPES, TRACKER_HOSTS,
  type ReachProfile, type BrowserEngine,
} from './antibot/stealth-launch.js';
import { generateFingerprint, attachFingerprint, type SyntheticFingerprint } from './antibot/fingerprint.js';
import type { ProxyManager } from './antibot/proxy-manager.js';

/** First human-readable or ISO date found in text — last-resort publish-date signal. */
const DATE_RE = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d\d|20\d\d-\d\d-\d\d/i;
function firstDate(text: string): string | undefined {
  return text.match(DATE_RE)?.[0];
}

/** Run fn over items with a bounded number of concurrent workers (preserves input order in output). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * AgentBrowser — a persistent, scriptable Chromium session for autonomous web work.
 *
 * Uses a DEDICATED persistent profile (clean by default — logged into nothing). To grant it
 * access to a site, a human logs into that site once in this profile; the session then persists
 * across runs and the agent reuses it. The agent never needs to type passwords.
 *
 * Interaction is autonomous EXCEPT three hard-stops that cannot be disabled, matching the
 * operator's standing safety rules: it will not type into credential/payment fields, will not
 * click obvious financial/purchase actions, and will not attempt CAPTCHAs. Those return a
 * refusal for a human to handle.
 */

const CREDENTIAL_FIELD_RE = /pass(word)?|cvv|cvc|card.?number|cardnumber|ssn|social.?secur|routing|account.?number|secret|api.?key|otp|2fa|seed.?phrase|private.?key/i;
const FINANCIAL_ACTION_RE = /\b(buy|pay|purchase|checkout|place\s*order|send\s*money|transfer|withdraw|deposit|confirm\s*payment|wire|subscribe|complete\s*purchase)\b/i;

// Self-pacing for free Google scraping — politeness keeps it unblocked without any paid API.
let googleLastAt = 0;
let googleCooldownUntil = 0;
const GOOGLE_MIN_GAP_MS = 15_000;    // min spacing between Google queries
const GOOGLE_COOLDOWN_MS = 300_000;  // back off 5 min after a block

export interface AgentBrowserOptions {
  /** Persistent profile directory. Defaults to ~/.vortex-agent-browser (per reachProfile for non-natural). */
  profileDir?: string;
  /** Headless by default (Chrome new-headless, no window). Set false for headful (max stealth). */
  headless?: boolean;
  /** Reach strategy. 'natural' (default): real Chrome, override nothing, persistent logged-in profile. */
  reachProfile?: ReachProfile;
  /** Browser engine. 'patchright' (default) is undetected; falls back to 'playwright' if absent. */
  engine?: BrowserEngine;
  /** Proxy pool (consulted for stealth/rotating only). */
  proxyManager?: ProxyManager;
  /** Abort image/media/font + tracker requests for speed/cost. Default: on for stealth/rotating. */
  blockResources?: boolean;
  /** Real Chrome channel; default 'chrome'. Set to undefined to use bundled Chromium (weaker stealth). */
  channel?: string;
}

export interface ActResult {
  ok: boolean;
  url: string;
  title: string;
  /** Set when an action was refused or needs human attention. */
  note?: string;
}

export interface ExtractResult {
  url: string;
  title: string;
  markdown: string;
  approxTokens: number;
  captchaDetected: boolean;
  /** Best-effort publish date (og/JSON-LD → Readability → first date in prose). */
  publishDate?: string;
  /** Which extractor produced the markdown — useful for debugging quality. */
  extractedVia?: 'readability' | 'cleaner';
}

export class AgentBrowser {
  private context: any = null;
  private page: any = null;
  private readonly md = new MarkdownConverter();
  private readonly cleaner = new ContentCleaner();
  private readonly meta = new MetadataExtractor();
  private readonly readability = new ReadabilityExtractor();
  private readonly profileDir: string;
  private readonly headless: boolean;
  private readonly reachProfile: ReachProfile;
  private readonly engine: BrowserEngine;
  private readonly proxyManager?: ProxyManager;
  private readonly blockResources?: boolean;
  private readonly channel?: string;

  constructor(opts?: AgentBrowserOptions) {
    this.reachProfile = opts?.reachProfile ?? 'natural';
    // natural reuses the persistent logged-in profile; stealth/rotating get an isolated ephemeral one.
    const base = `${process.env.HOME}/.vortex-agent-browser`;
    this.profileDir = opts?.profileDir
      || (this.reachProfile === 'natural' ? base : `${base}-${this.reachProfile}-${Date.now()}`);
    this.headless = opts?.headless ?? true;
    this.engine = opts?.engine ?? 'patchright';
    this.proxyManager = opts?.proxyManager;
    this.blockResources = opts?.blockResources;
    this.channel = opts?.channel === undefined && opts && 'channel' in opts ? undefined : (opts?.channel ?? 'chrome');
  }

  /**
   * Launch (or no-op if already open). Uses Patchright (undetected) by default via dynamic import,
   * with a real-Chrome / stealth / rotating launch plan. Falls back to plain Playwright if patchright
   * is absent. Optionally blocks heavy resources and injects a synthetic fingerprint (rotating only).
   */
  async open(): Promise<ActResult> {
    if (this.context) return this.state('already open');

    const plan = buildLaunchPlan({
      reachProfile: this.reachProfile,
      headless: this.headless,
      engine: this.engine,
      channel: this.channel,
      proxyManager: this.proxyManager,
      blockResources: this.blockResources,
    });

    // rotating: synthesize a coherent fingerprint and align UA/viewport at context creation.
    let fingerprint: SyntheticFingerprint | null = null;
    if (plan.injectFingerprint) {
      fingerprint = await generateFingerprint();
      if (fingerprint?.userAgent) plan.launchOptions.userAgent = fingerprint.userAgent;
      if (fingerprint?.viewport) plan.launchOptions.viewport = fingerprint.viewport;
    }

    const { chromium, engine } = await loadEngine(plan.engine);
    try {
      this.context = await (chromium as any).launchPersistentContext(this.profileDir, plan.launchOptions);
    } catch (e: any) {
      // Most common cause: real Chrome channel unavailable. Retry once with bundled Chromium.
      if (plan.launchOptions.channel) {
        const fallback = { ...plan.launchOptions };
        delete (fallback as any).channel;
        this.context = await (chromium as any).launchPersistentContext(this.profileDir, fallback);
        plan.note = `channel '${this.channel}' unavailable (${(e?.message || '').slice(0, 50)}) — using bundled Chromium, weaker stealth`;
      } else {
        throw e;
      }
    }

    if (fingerprint) { await attachFingerprint(this.context, fingerprint); }
    if (plan.blockResources) { await this.installResourceBlocking(); }

    this.page = this.context.pages()[0] || (await this.context.newPage());
    const opened = await this.state('opened');
    return { ...opened, note: plan.note ? `${plan.note} [engine:${engine}]` : `opened [profile:${this.reachProfile} engine:${engine} headless:${this.headless}]` };
  }

  /** Abort heavy/tracker requests at the network layer — speed, bandwidth (metered proxies), and noise. */
  private async installResourceBlocking(): Promise<void> {
    try {
      await this.context.route('**/*', (route: any) => {
        const req = route.request();
        const type = req.resourceType();
        const url = req.url();
        if ((DEFAULT_BLOCK_TYPES as readonly string[]).includes(type) || TRACKER_HOSTS.some((h) => url.includes(h))) {
          return route.abort();
        }
        return route.continue();
      });
    } catch { /* routing best-effort */ }
  }

  private ensure(): void {
    if (!this.page) throw new Error('Browser not open — call open() first.');
  }

  private async state(note?: string): Promise<ActResult> {
    if (!this.page) return { ok: false, url: '', title: '', note: note || 'closed' };
    let title = '';
    try { title = await this.page.title(); } catch { /* page navigating */ }
    return { ok: true, url: this.page.url(), title, note };
  }

  async goto(url: string, waitForSelector?: string): Promise<ActResult> {
    this.ensure();
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (waitForSelector) {
      try { await this.page.waitForSelector(waitForSelector, { timeout: 10000 }); } catch { /* soft */ }
    } else {
      // Short settle, not a full networkidle wait — heavy sites never go idle and cost 6-8s otherwise.
      try { await this.page.waitForLoadState('networkidle', { timeout: 2500 }); } catch { /* soft */ }
    }
    return this.state('navigated');
  }

  /** All absolute outbound links on the page, with their anchor text. The browser DOM resolves
   *  hrefs to absolute, so this also fixes relative-link extraction. Deduped by URL. */
  async links(): Promise<{ href: string; text: string }[]> {
    this.ensure();
    const raw: { href: string; text: string }[] = await this.page.$$eval('a[href]', (as: any[]) =>
      as.map((a) => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 120) }))
    );
    const seen = new Set<string>();
    const out: { href: string; text: string }[] = [];
    for (const l of raw) {
      if (l.href.startsWith('http') && !seen.has(l.href)) { seen.add(l.href); out.push(l); }
    }
    return out;
  }

  /** Click by CSS selector, or by visible text when byText=true. Blocks obvious financial actions. */
  async click(target: string, byText = false): Promise<ActResult> {
    this.ensure();
    const locator = byText ? this.page.getByText(target, { exact: false }).first() : this.page.locator(target).first();
    let label = '';
    try { label = ((await locator.innerText({ timeout: 3000 })) || '').trim(); } catch { /* no text */ }
    if (FINANCIAL_ACTION_RE.test(label) || FINANCIAL_ACTION_RE.test(target)) {
      return { ...(await this.state()), ok: false, note: `REFUSED: "${label || target}" looks like a financial/purchase action. A human must do this.` };
    }
    await locator.click({ timeout: 10000 });
    try { await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch { /* soft */ }
    return this.state(`clicked ${byText ? `text:${target}` : target}`);
  }

  /** Type into a CSS selector. Refuses credential/payment fields (operator must seed logins manually). */
  async type(selector: string, text: string, submit = false): Promise<ActResult> {
    this.ensure();
    const el = this.page.locator(selector).first();
    let kind = '';
    try {
      kind = [
        await el.getAttribute('type'),
        await el.getAttribute('name'),
        await el.getAttribute('id'),
        await el.getAttribute('autocomplete'),
      ].filter(Boolean).join(' ');
    } catch { /* element gone */ }
    if (kind.toLowerCase().includes('password') || CREDENTIAL_FIELD_RE.test(kind)) {
      return { ...(await this.state()), ok: false, note: `REFUSED: "${selector}" is a credential/sensitive field. Log in manually once in the profile; the session persists.` };
    }
    await el.fill(text, { timeout: 10000 });
    if (submit) await el.press('Enter');
    return this.state(`typed into ${selector}${submit ? ' + submitted' : ''}`);
  }

  async press(key: string): Promise<ActResult> {
    this.ensure();
    await this.page.keyboard.press(key);
    return this.state(`pressed ${key}`);
  }

  async scroll(direction: 'down' | 'up' = 'down', amount = 1): Promise<ActResult> {
    this.ensure();
    const dy = (direction === 'down' ? 1 : -1) * 900 * amount;
    await this.page.mouse.wheel(0, dy);
    try { await this.page.waitForLoadState('networkidle', { timeout: 3000 }); } catch { /* soft */ }
    return this.state(`scrolled ${direction}`);
  }

  /**
   * Extract the current page as clean LLM-ready markdown. Readability (Firefox Reader View algo)
   * is the primary extractor — it isolates article prose where class-based cleaning fails; falls
   * back to ContentCleaner on non-articles. Also returns a best-effort publish date.
   */
  async extract(): Promise<ExtractResult> {
    this.ensure();
    return this.extractFromPage(this.page);
  }

  /** Shared extraction logic for any page — reused by extract() and the parallel methods. */
  private async extractFromPage(page: any): Promise<ExtractResult> {
    const url = page.url();
    const fullHtml: string = await page.content();
    const meta = this.meta.extract(fullHtml, url);
    const readable = this.readability.extract(fullHtml, url);

    let markdown: string;
    let extractedVia: 'readability' | 'cleaner';
    if (readable.ok && readable.contentHtml && (readable.textContent?.length ?? 0) >= 200) {
      markdown = this.md.convert(readable.contentHtml);
      extractedVia = 'readability';
    } else {
      markdown = this.md.convert(this.cleaner.clean(fullHtml, url));
      extractedVia = 'cleaner';
    }

    let captchaDetected = false;
    for (const sel of ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '.g-recaptcha', '#cf-challenge-stage']) {
      try { const loc = page.locator(sel).first(); if ((await loc.count()) && (await loc.isVisible())) { captchaDetected = true; break; } } catch { /* ignore */ }
    }

    let pageTitle = '';
    try { pageTitle = await page.title(); } catch { /* soft */ }
    const publishDate = meta.publishedAt || readable.publishedTime || firstDate(markdown);
    return { url, title: readable.title || meta.title || pageTitle, markdown, approxTokens: Math.round(markdown.length / 4), captchaDetected, publishDate, extractedVia };
  }

  /**
   * Navigate + extract many URLs in parallel, bounded to `concurrency` open tabs at a time (default 6)
   * so a large URL list can't spike memory by opening hundreds of tabs at once.
   */
  async parallelExtract(urls: string[], opts?: { settleMs?: number; concurrency?: number }): Promise<ExtractResult[]> {
    this.ensure();
    const settle = opts?.settleMs ?? 3000;
    return mapPool(urls, opts?.concurrency ?? 6, async (url) => {
      const page = await this.context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try { await page.waitForLoadState('networkidle', { timeout: 2500 }); } catch { /* soft */ }
        if (settle) await page.waitForTimeout(settle).catch(() => {});
        return await this.extractFromPage(page);
      } catch {
        return { url, title: '', markdown: '', approxTokens: 0, captchaDetected: false, extractedVia: 'cleaner' as const };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  /** Screenshot many jobs in parallel, bounded to `concurrency` open tabs at a time (default 6). */
  async parallelScreenshot(jobs: { url: string; path: string }[], opts?: { settleMs?: number; concurrency?: number }): Promise<{ url: string; path: string; ok: boolean }[]> {
    this.ensure();
    const settle = opts?.settleMs ?? 6000;
    return mapPool(jobs, opts?.concurrency ?? 6, async (job) => {
      const page = await this.context.newPage();
      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (settle) await page.waitForTimeout(settle).catch(() => {});
        await page.screenshot({ path: job.path, fullPage: false });
        return { url: job.url, path: job.path, ok: true };
      } catch {
        return { url: job.url, path: job.path, ok: false };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async screenshot(path: string): Promise<ActResult> {
    this.ensure();
    await this.page.screenshot({ path, fullPage: false });
    return this.state(`screenshot → ${path}`);
  }

  /**
   * Google-backed search — the strong index the fetch engines (Bing/DDG/Mojeek) lack. Google only
   * yields to a real browser (use a headful stealth profile), so this lives on AgentBrowser, not in
   * the fetch-based search(). Returns organic result title+url. Surfaces LinkedIn, specific people,
   * and pages the default search misses.
   */
  async googleSearch(query: string, maxResults = 10): Promise<{ title: string; url: string }[]> {
    this.ensure();
    // Self-pace: respect a cooldown after any prior block, and a minimum gap between queries.
    const now = Date.now();
    if (now < googleCooldownUntil) {
      throw new Error(`Google is cooling down for ${Math.ceil((googleCooldownUntil - now) / 1000)}s (it rate-limited recently). It paces itself to stay free + unblocked — retry after that.`);
    }
    const gap = googleLastAt + GOOGLE_MIN_GAP_MS - now;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    googleLastAt = Date.now();

    await this.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.max(maxResults, 10)}&hl=en&gl=us`);
    // Dismiss a consent wall if one appears (privacy-preserving: reject/never-personalized).
    for (const sel of ['button#W0wltc', 'button[aria-label*="Reject all"]', 'button:has-text("Reject all")']) {
      try { const btn = this.page.locator(sel).first(); if (await btn.count()) { await btn.click({ timeout: 2000 }); break; } } catch { /* none */ }
    }
    // Google rate-limits/CAPTCHAs scrapers aggressively, even headful. Detect and surface — never solve.
    const blocked = await this.page.evaluate(() => /detected unusual traffic|not a robot|recaptcha|before you continue/i.test((document.body?.innerText || '').slice(0, 2500)));
    if (blocked) {
      googleCooldownUntil = Date.now() + GOOGLE_COOLDOWN_MS; // back off automatically; don't hammer
      throw new Error('Google rate-limited (CAPTCHA / unusual traffic). Backing off 5 min automatically. Tip: log into your Google account once in this profile (headful) — logged-in sessions rarely get blocked. I never solve CAPTCHAs.');
    }

    // Each organic result is an <h3> title inside a result <a>. Start from h3 and climb to its link —
    // more robust than a:has(h3) across Google's shifting DOM.
    const raw: { url: string; title: string }[] = await this.page.$$eval('h3', (h3s: any[]) =>
      h3s.map((h) => {
        const a = h.closest('a') || h.parentElement?.querySelector('a');
        return { url: (a?.href as string) || '', title: (h.textContent || '').trim() };
      })
    );
    const seen = new Set<string>();
    const out: { title: string; url: string }[] = [];
    for (const r of raw) {
      if (!r.title || !/^https?:\/\//.test(r.url)) continue;
      if (/(^|\.)google\.|\/search\?|webcache\.|translate\.google|googleusercontent/.test(r.url)) continue;
      const key = r.url.replace(/[?#].*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title: r.title, url: r.url });
      if (out.length >= maxResults) break;
    }
    return out;
  }

  async close(): Promise<ActResult> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
    return { ok: true, url: '', title: '', note: 'closed' };
  }
}
