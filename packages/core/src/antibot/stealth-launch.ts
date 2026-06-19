import type { ProxyManager } from './proxy-manager.js';

/**
 * Stealth launch planning for AgentBrowser. Resolves the Patchright-vs-fingerprint tension by
 * PROFILE, never by stacking:
 *   - natural  : real Google Chrome via Patchright, override nothing (no UA/headers/viewport).
 *                Maximum single-identity trust. Pair with the persistent logged-in profile.
 *   - stealth  : same real-Chrome fingerprint, but a fresh/ephemeral identity + optional proxy.
 *   - rotating : synthetic coherent fingerprint (fingerprint-injector) + proxy. IP/identity variety,
 *                weaker than stealth against the hardest WAFs — accepted trade.
 *
 * buildLaunchPlan is a PURE function (no I/O) so it is unit-testable and the profile branch table
 * can't silently regress.
 */

export type ReachProfile = 'natural' | 'stealth' | 'rotating';
export type BrowserEngine = 'patchright' | 'playwright';

export interface LaunchPlan {
  engine: BrowserEngine;
  launchOptions: Record<string, unknown>;
  injectFingerprint: boolean;   // rotating only
  blockResources: boolean;
  note?: string;                // surfaced when a request was downgraded (e.g. headful→headless)
}

export interface BuildLaunchPlanArgs {
  reachProfile: ReachProfile;
  headless: boolean;
  engine: BrowserEngine;
  channel?: string;             // default 'chrome' (real Google Chrome)
  proxyManager?: ProxyManager;  // consulted only for stealth/rotating
  domain?: string;              // for sticky proxy
  blockResources?: boolean;
}

/** Parse a proxy URL (optionally with creds) into Playwright's proxy option shape. */
export function parseProxy(raw?: string): { server: string; username?: string; password?: string } | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const out: { server: string; username?: string; password?: string } = { server: `${u.protocol}//${u.host}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: raw };
  }
}

export function buildLaunchPlan(a: BuildLaunchPlanArgs): LaunchPlan {
  const synthetic = a.reachProfile === 'rotating';
  const args = ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'];
  if (process.platform === 'linux') args.push('--no-sandbox'); // needed on Linux/root; never on macOS

  const launchOptions: Record<string, unknown> = {
    channel: a.channel ?? 'chrome',
    headless: a.headless,
    args,
  };

  // natural/stealth: let the real Chrome viewport/UA stand (override NOTHING). rotating: injector sets them.
  if (!synthetic) launchOptions.viewport = null;

  // Proxy egress only for non-natural profiles.
  if (a.reachProfile !== 'natural' && a.proxyManager?.hasProxies) {
    const proxy = parseProxy(a.proxyManager.getProxy(a.domain));
    if (proxy) launchOptions.proxy = proxy;
  }

  // Headful stealth needs a display. On Linux without one, Chrome headful crashes — downgrade legibly.
  let note: string | undefined;
  if (!a.headless && process.platform === 'linux' && !process.env.DISPLAY) {
    launchOptions.headless = true;
    note = 'headful requested but no DISPLAY (Linux) — running headless; install xvfb for max stealth';
  }

  return {
    engine: a.engine,
    launchOptions,
    injectFingerprint: synthetic,
    blockResources: a.blockResources ?? a.reachProfile !== 'natural',
    note,
  };
}

/** Dynamic-import the engine so both stay optional/external. Patchright degrades to plain Playwright. */
export async function loadEngine(engine: BrowserEngine): Promise<{ chromium: unknown; engine: BrowserEngine }> {
  if (engine === 'patchright') {
    try { return { chromium: (await import('patchright')).chromium, engine: 'patchright' }; }
    catch { /* fall through */ }
  }
  return { chromium: (await import('playwright')).chromium, engine: 'playwright' };
}

/** Default network-level blocklist: heavy non-essential resource types + common tracker hosts. */
export const DEFAULT_BLOCK_TYPES = ['image', 'media', 'font'] as const;
export const TRACKER_HOSTS = [
  'doubleclick.net', 'googletagmanager.com', 'google-analytics.com', 'googlesyndication.com',
  'segment.com', 'segment.io', 'hotjar.com', 'mixpanel.com', 'amplitude.com', 'facebook.net',
  'scorecardresearch.com', 'adservice.google.com', 'analytics.', 'taboola.com', 'outbrain.com',
];
