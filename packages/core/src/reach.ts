import { AgentBrowser, type ExtractResult } from './agent-browser.js';
import type { ProxyManager } from './antibot/proxy-manager.js';

/**
 * reach() — "get me this page by any LEGITIMATE means, or tell me a human is needed."
 *
 * Ordered fallback ladder: direct → stealth-retry → logged-in → wayback → archive.today → reader.
 * Bright lines enforced in code (cannot be configured away):
 *   - CAPTCHA on the live origin → STOP, needsHuman. We never solve or evade a challenge.
 *   - Hard paid paywall (body withheld) → STOP, needsHuman. We never circumvent payment.
 * Soft paywalls (full body present but visually hidden) and bot-walls/thin renders MAY be recovered
 * via a public mirror (Wayback/archive.today) — reading a public snapshot is not evading the live wall.
 */

export type ReachStrategy = 'direct' | 'stealth-retry' | 'logged-in' | 'wayback' | 'archive-today' | 'reader';
export type PageClass = 'good' | 'captcha' | 'paywall-soft' | 'paywall-hard' | 'blocked' | 'thin';

export type ReachOutcome =
  | { ok: true; via: ReachStrategy; url: string; result: ExtractResult; tried: ReachStrategy[] }
  | { ok: false; reason: 'captcha' | 'paywall' | 'blocked' | 'thin' | 'error'; needsHuman: boolean; tried: ReachStrategy[]; note: string };

export interface ReachOptions {
  url: string;
  agentBrowser: AgentBrowser;          // primary (typically natural profile)
  loggedInBrowser?: AgentBrowser;      // optional: the persistent logged-in profile
  proxyManager?: ProxyManager;         // used by the stealth-retry browser
  ladder?: ReachStrategy[];
  minProse?: number;                   // "thin" threshold, default 200 (matches browse/agent-browser)
  allowArchive?: boolean;              // default true; gates wayback/archive/reader
}

const BLOCK_RE = /verify you are human|attention required|cloudflare|access denied|request blocked|enable javascript|unusual traffic|just a moment|checking your browser/i;
const PAYWALL_RE = /subscribe to (read|continue)|already a subscriber|metered|this article is for subscribers|to continue reading|create a free account to|sign in to read/i;
const DEFAULT_LADDER: ReachStrategy[] = ['direct', 'stealth-retry', 'logged-in', 'wayback', 'archive-today', 'reader'];

function prose(ex: ExtractResult): string {
  return ex.markdown.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

export function classifyPage(ex: ExtractResult, minProse = 200): PageClass {
  if (ex.captchaDetected) return 'captcha';
  const text = prose(ex);
  const head = (ex.title + ' ' + ex.markdown.slice(0, 4000));
  if (PAYWALL_RE.test(head)) return text.length >= 600 ? 'paywall-soft' : 'paywall-hard';
  if (BLOCK_RE.test(head) && text.length < 800) return 'blocked';
  if (text.length < minProse) return 'thin';
  return 'good';
}

/** Wayback availability API → the closest snapshot's raw (toolbar-free) URL, or null. */
async function waybackSnapshot(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
    const data: any = await res.json();
    const snap = data?.archived_snapshots?.closest;
    if (snap?.available && snap.url) {
      // insert id_ after the timestamp to get the raw capture without the Wayback chrome
      return String(snap.url).replace(/(\/web\/\d+)\//, '$1id_/');
    }
  } catch { /* unavailable */ }
  return null;
}

async function fetchReader(url: string): Promise<ExtractResult | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const md = await res.text();
    if (md.length < 200) return null;
    return { url, title: '', markdown: md, approxTokens: Math.round(md.length / 4), captchaDetected: false, extractedVia: 'readability' };
  } catch { return null; }
}

async function tryRender(browser: AgentBrowser, url: string): Promise<ExtractResult | null> {
  try { await browser.goto(url); await browser.scroll('down', 1); return await browser.extract(); }
  catch { return null; }
}

export async function reach(opts: ReachOptions): Promise<ReachOutcome> {
  const minProse = opts.minProse ?? 200;
  const allowArchive = opts.allowArchive ?? true;
  const ladder = opts.ladder ?? DEFAULT_LADDER;
  const tried: ReachStrategy[] = [];

  let stealthBrowser: AgentBrowser | undefined;
  const cleanup = async () => { if (stealthBrowser) { try { await stealthBrowser.close(); } catch { /* */ } } };

  try {
    for (const strategy of ladder) {
      let ex: ExtractResult | null = null;

      switch (strategy) {
        case 'direct':
          tried.push(strategy);
          ex = await tryRender(opts.agentBrowser, opts.url);
          break;
        case 'stealth-retry':
          tried.push(strategy);
          stealthBrowser = new AgentBrowser({ reachProfile: 'stealth', headless: false, proxyManager: opts.proxyManager });
          await stealthBrowser.open();
          ex = await tryRender(stealthBrowser, opts.url);
          break;
        case 'logged-in':
          if (!opts.loggedInBrowser) continue;
          tried.push(strategy);
          ex = await tryRender(opts.loggedInBrowser, opts.url);
          break;
        case 'wayback': {
          if (!allowArchive) continue;
          tried.push(strategy);
          const snap = await waybackSnapshot(opts.url);
          if (snap) ex = await tryRender(opts.agentBrowser, snap);
          break;
        }
        case 'archive-today':
          if (!allowArchive) continue;
          tried.push(strategy);
          ex = await tryRender(opts.agentBrowser, `https://archive.ph/newest/${opts.url}`);
          break;
        case 'reader':
          if (!allowArchive) continue;
          tried.push(strategy);
          ex = await fetchReader(opts.url);
          break;
      }

      if (!ex) continue;
      const cls = classifyPage(ex, minProse);

      // BRIGHT LINES — only enforced on the LIVE origin (direct / stealth-retry / logged-in),
      // never short-circuit on a public mirror's own quirks.
      const liveOrigin = strategy === 'direct' || strategy === 'stealth-retry' || strategy === 'logged-in';
      if (liveOrigin && cls === 'captcha') {
        return { ok: false, reason: 'captcha', needsHuman: true, tried, note: `CAPTCHA on ${opts.url}. A human must solve it — I do not.` };
      }
      if (liveOrigin && cls === 'paywall-hard') {
        return { ok: false, reason: 'paywall', needsHuman: true, tried, note: `Hard paywall on ${opts.url} (body withheld). A human/subscription is required.` };
      }
      if (cls === 'good' || cls === 'paywall-soft') {
        return { ok: true, via: strategy, url: ex.url || opts.url, result: ex, tried };
      }
      // blocked/thin/captcha-on-mirror → keep climbing the ladder
    }

    return { ok: false, reason: 'blocked', needsHuman: true, tried, note: `Could not reach ${opts.url} via ${tried.join(' → ')}. Likely hard bot-wall; a human may need to open it.` };
  } catch (e: any) {
    return { ok: false, reason: 'error', needsHuman: true, tried, note: `reach error: ${(e?.message || 'unknown').slice(0, 80)}` };
  } finally {
    await cleanup();
  }
}
