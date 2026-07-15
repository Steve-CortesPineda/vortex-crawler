const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
];

/** sec-ch-ua client hints matching the Chrome UAs above. A Chrome User-Agent WITHOUT client hints is a
 * fingerprint mismatch every major bot-wall checks for; Safari/Firefox genuinely don't send them. */
const CHROME_CH = {
  'sec-ch-ua': '"Chromium";v="143", "Google Chrome";v="143", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
};
const CH_PLATFORM = ['"macOS"', '"Windows"', '"Linux"'];

const ACCEPT_LANGUAGE = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.9,es;q=0.8',
  'en-GB,en;q=0.9,en-US;q=0.8',
];

/** Stable 32-bit hash of a string — used to pin an identity to a hostname deterministically. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Per-domain STICKY headers. A given host always sees the same User-Agent + Accept-Language for the
 * life of the process (identity derived from a hostname hash), instead of the old global round-robin
 * that flipped the UA between consecutive hits to the same site — which reads as a bot, not a human.
 * Different hosts still get different identities, spreading the footprint across the pool.
 */
export function generateHeaders(url: string): Record<string, string> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch { /* keep random identity below */ }

  const seed = host ? hashStr(host) : Math.floor(Math.random() * 1e9);
  const uaIdx = seed % USER_AGENTS.length;
  const ua = USER_AGENTS[uaIdx];
  // `>>> 8`, not `>> 8`: seed is unsigned 32-bit, and a SIGNED shift on values ≥ 2^31 yields a negative
  // index — which made ACCEPT_LANGUAGE[-1] undefined and sent the literal header "Accept-Language:
  // undefined" to every host whose hash had the top bit set (startpage + brave among them).
  const acceptLang = ACCEPT_LANGUAGE[(seed >>> 8) % ACCEPT_LANGUAGE.length];
  const isChrome = uaIdx <= 2;

  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': acceptLang,
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    // 'none' = direct navigation (address bar / bookmark). A direct navigation carries NO Referer —
    // the old Referer+Site:none combo is self-contradictory and reads as scripted.
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    ...(isChrome ? { ...CHROME_CH, 'sec-ch-ua-platform': CH_PLATFORM[uaIdx] } : {}),
  };
}
