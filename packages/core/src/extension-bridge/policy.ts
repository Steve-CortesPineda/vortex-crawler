/**
 * Domain policy for the VANTA extension bridge. Because the bridge drives a REAL, logged-in Chrome
 * profile, the blast radius of a bad action is larger than with the throwaway Patchright profile — so
 * we gate by domain in code, not just by the per-action refusals in the content scripts.
 *
 *   BLOCKED   — no ops at all (banks, brokerages, payment processors). Even reads are refused.
 *   READ_ONLY — extract / fetch allowed, but act (click/type/press) refused (mail, admin consoles).
 *   FULL      — default. Everything the content-script safety regexes permit.
 *
 * Lists are seedable from env (VANTA_BLOCKED_DOMAINS / VANTA_READONLY_DOMAINS, comma-separated) which
 * are UNIONED with the built-in defaults — you can extend, never silently shrink, the safe defaults.
 */

export type DomainTier = 'blocked' | 'read_only' | 'full';
export type BridgeOp = 'fetch' | 'goto' | 'extract' | 'act' | 'screenshot';

const DEFAULT_BLOCKED = [
  // Banks / brokerages / payment — no automation should touch these, ever.
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'usbank.com',
  'schwab.com', 'fidelity.com', 'vanguard.com', 'robinhood.com', 'etrade.com', 'coinbase.com',
  'kraken.com', 'binance.com', 'paypal.com', 'stripe.com', 'venmo.com', 'wise.com', 'revolut.com',
  'americanexpress.com', 'discover.com',
];

const DEFAULT_READ_ONLY = [
  // Comms + admin consoles: reading is fine, but we don't click/type (no sending, no settings changes).
  'mail.google.com', 'outlook.com', 'outlook.live.com', 'proton.me',
  'console.aws.amazon.com', 'console.cloud.google.com', 'portal.azure.com',
  'admin.google.com', 'dashboard.stripe.com',
];

function envList(name: string): string[] {
  return (process.env[name] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const blocked = new Set([...DEFAULT_BLOCKED, ...envList('VANTA_BLOCKED_DOMAINS')]);
const readOnly = new Set([...DEFAULT_READ_ONLY, ...envList('VANTA_READONLY_DOMAINS')]);

/** hostname → registrable-ish match: a rule matches the host itself or any subdomain of it. */
function hostMatches(host: string, rules: Set<string>): boolean {
  host = host.toLowerCase();
  for (const rule of rules) {
    if (host === rule || host.endsWith('.' + rule)) return true;
  }
  return false;
}

export function tierFor(url: string): DomainTier {
  let host = '';
  try { host = new URL(url).hostname; } catch { return 'full'; }
  if (hostMatches(host, blocked)) return 'blocked';
  if (hostMatches(host, readOnly)) return 'read_only';
  return 'full';
}

/** Throws a policy error if `op` is not permitted on `url`. Called by ExtensionBrowser before every op. */
export function assertAllowed(op: BridgeOp, url: string): void {
  const tier = tierFor(url);
  if (tier === 'blocked') {
    throw new Error(`POLICY: ${new URL(url).hostname} is on the BLOCKED list (bank/broker/payment). No browser ops permitted. A human must handle this directly.`);
  }
  if (tier === 'read_only' && (op === 'act')) {
    throw new Error(`POLICY: ${new URL(url).hostname} is READ_ONLY — I can read it but won't click/type/submit there. A human must perform actions on this site.`);
  }
}

/** Introspection for /stats and tests. */
export function policySnapshot(): { blocked: string[]; readOnly: string[] } {
  return { blocked: [...blocked], readOnly: [...readOnly] };
}
