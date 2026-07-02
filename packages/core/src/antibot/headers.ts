const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
];

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
  let origin: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    origin = parsed.origin;
  } catch {
    origin = '';
  }

  const seed = host ? hashStr(host) : Math.floor(Math.random() * 1e9);
  const ua = USER_AGENTS[seed % USER_AGENTS.length];
  const acceptLang = ACCEPT_LANGUAGE[(seed >> 8) % ACCEPT_LANGUAGE.length];

  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': acceptLang,
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    ...(origin ? { 'Referer': origin } : {}),
  };
}
