#!/usr/bin/env node
/**
 * Vortex Browser Daemon — ONE warm, shared Chromium that every consumer talks to over localhost HTTP.
 *
 * Why this exists: Claude (via the MCP server), VANTA (the AVA sidecar), and the background daemons
 * each used to construct their own `new AgentBrowser()`, which means duplicate Chromium processes and
 * — worse — profile-directory LOCK conflicts on the shared persistent profile. This daemon owns the
 * browser once; everyone else is a thin HTTP client. It's also the single process that hosts the
 * shared per-domain governor, so no matter how many clients fan out in parallel, one host's rate limit
 * is honored globally.
 *
 * Bind: 127.0.0.1 only (never exposed off-box). Optional bearer token via VORTEX_DAEMON_TOKEN.
 * Port:  VORTEX_DAEMON_PORT (default 4477).
 *
 * Run:   node browser-daemon.mjs      (or via the launchd plist in tools/)
 * Deps:  none beyond built core — mirrors tracker-daemon.mjs (imports packages/core/dist).
 */
import http from 'node:http';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentBrowser, browse, reach, search, ProxyManager, BridgeServer, ExtensionBrowser, treeBrowse, classifyQuery, keyPassages, tokenize, stripMarkdownLinks, bm25ish, sourceQuality } from './packages/core/dist/index.js';

const execFile = promisify(execFileCb);

const PORT = Number(process.env.VORTEX_DAEMON_PORT) || 4477;
// Loopback-only by default. To let another box (e.g. the PC-side VANTA) reach it, set
// VORTEX_DAEMON_HOST=0.0.0.0 — but that is REFUSED without a token, so a browser-control service can
// never be exposed to the LAN unauthenticated by accident.
const HOST = process.env.VORTEX_DAEMON_HOST || '127.0.0.1';
const TOKEN = process.env.VORTEX_DAEMON_TOKEN || '';
const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (!LOOPBACK && !TOKEN) {
  console.error('[vortex-daemon] REFUSING to bind a non-loopback host without VORTEX_DAEMON_TOKEN set. ' +
    'Set a token, or bind 127.0.0.1. Aborting.');
  process.exit(1);
}
const TRACKER_DIR = process.env.VORTEX_TRACKER_DIR || `${process.env.HOME}/.vortex-tracker`;
const startedAt = Date.now();

const proxyManager = new ProxyManager((process.env.VORTEX_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean));

// Primary browser: natural profile (real Chrome, persistent logged-in profile), headless.
const browser = new AgentBrowser({ proxyManager });

// VANTA extension bridge — set up after the http server is created (needs it for the WS upgrade hook).
// When the extension is connected, browser routes ride the REAL Chrome profile (cookie-fetch tier +
// parallel tab pool); otherwise everything falls back to the Patchright `browser` above, unchanged.
let bridge = null;
let extBrowser = null;
const VANTA_POOL_SIZE = Number(process.env.VANTA_POOL_SIZE) || 8;

/** Pick the backend for a route. `force` = body.backend ('extension'|'patchright'); default: extension if live. */
function backend(force) {
  if (force === 'patchright') return browser;
  if (force === 'extension') return extBrowser; // may be null → caller errors clearly
  return (extBrowser && extBrowser.connected) ? extBrowser : browser;
}
function bridgeUp() { return !!(bridge && bridge.connected); }

function isYouTubeLookup(query) {
  return /\b(youtube|latest video|newest video|recent upload|channel upload|views? on|mrbeast)\b/i.test(query);
}

const KNOWN_YOUTUBE_CHANNELS = [
  { name: 'MrBeast', id: 'UCX6OQ3DkcsbYNE6H8uQQuVA', handle: '@MrBeast', match: /\bmr\s*beast\b|\bmrbeast\b/i },
  { name: 'Watch Alex', id: 'UCcUJz_iBE-Ily7Orj3BimeA', handle: '@Watch_Alex', match: /\bwatch\s+alex\b|@watch_alex\b/i },
];

function wantsChannelLatest(query) {
  return /\b(latest|newest|recent|upload|uploads|new video|latest video|youtube)\b/i.test(query);
}

function knownYouTubeChannel(query) {
  if (!wantsChannelLatest(query)) return null;
  return KNOWN_YOUTUBE_CHANNELS.find((c) => c.match.test(query)) || null;
}

// ── General channel resolver: query → canonical channel via InnerTube search ──────────────────────
// The known-channel map above is the fast path for Steve's own channels; everything else resolves live:
// strip the "latest/upload/video" framing words → candidate channel phrase → InnerTube channel-filtered
// search (web client, no API key, no YouTube Data quota) → accept only when the top channel's title or
// handle actually matches the phrase (so "latest ai news video" can't resolve to a random channel).
const channelResolveCache = new Map(); // normalized phrase -> { name, id, handle } | null (negative cached too)
const YT_FRAME_WORDS = /\b(latest|newest|most recent|recent|new|video|videos|vid|upload|uploads|uploaded|from|on|by|of|the|a|an|channel|channels|youtube|what|whats|what's|is|are|did|has|have|post|posted|drop|dropped|out|show me|find|get)\b/gi;
function channelPhrase(query) {
  const p = String(query)
    .replace(YT_FRAME_WORDS, ' ')
    .replace(/[^\w@' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return p.length >= 2 ? p : null;
}
const normTokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9@ ]+/g, ' ').split(/\s+/).filter(Boolean);
/** Fraction of `a`'s tokens found in `b` (order-free). */
function tokenCoverage(a, b) {
  const bt = new Set(normTokens(b));
  const at = normTokens(a);
  if (!at.length) return 0;
  return at.filter((t) => bt.has(t)).length / at.length;
}
/** Recursively collect all values under a given key from arbitrarily-nested InnerTube JSON. */
function collectKey(node, key, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) collectKey(n, key, out); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v);
    else collectKey(v, key, out);
  }
  return out;
}
async function innertubeChannelSearch(phrase) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20250620.00.00', hl: 'en', gl: 'US' } },
      query: phrase,
      params: 'EgIQAg==', // search filter: type=channel
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`innertube search HTTP ${res.status}`);
  const data = await res.json();
  return collectKey(data, 'channelRenderer').map((c) => {
    const title = c?.title?.simpleText || (c?.title?.runs || []).map((r) => r.text).join('') || '';
    // YouTube moved the @handle into subscriberCountText on the web client; check both spots.
    const handleTexts = [c?.channelHandleText, c?.subscriberCountText]
      .map((t) => t?.simpleText || (t?.runs || []).map((r) => r.text).join('') || '');
    const handle = handleTexts.find((t) => /^@/.test(t)) || '';
    return { name: title, id: c?.channelId || '', handle };
  }).filter((c) => c.id && c.name);
}
/** Resolve a free-form query to a canonical channel, or null when nothing matches confidently. */
async function resolveYouTubeChannel(query) {
  const phrase = channelPhrase(query);
  if (!phrase) return null;
  const key = normTokens(phrase).join(' ');
  if (channelResolveCache.has(key)) return channelResolveCache.get(key);
  let resolved = null;
  try {
    const candidates = (await innertubeChannelSearch(phrase)).slice(0, 5);
    // Confidence gate: the channel's own name/handle must cover the phrase (or vice versa) —
    // ≥0.6 catches partial matches like "marques brownlee" → "Marques Brownlee (MKBHD)".
    resolved = candidates.find((c) =>
      tokenCoverage(phrase, `${c.name} ${c.handle}`) >= 0.6 || tokenCoverage(c.name, phrase) >= 0.6
    ) || null;
  } catch { resolved = null; }
  channelResolveCache.set(key, resolved);
  if (channelResolveCache.size > 500) channelResolveCache.delete(channelResolveCache.keys().next().value);
  return resolved;
}

/** Uploads via the channel's public RSS feed — ~200ms, no subprocess, includes publish dates + views.
 * Returns null when the feed is unavailable (terminated channel, network) so callers fall back to yt-dlp. */
async function rssChannelLatest(channel, max) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, max);
  if (!entries.length) return null;
  const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const results = [];
  for (const [, e] of entries) {
    const id = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = e.match(/<title>([^<]*)<\/title>/)?.[1];
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1]?.slice(0, 10);
    const views = e.match(/<media:statistics views="(\d+)"/)?.[1];
    if (!id || !title) continue;
    const parts = [channel.name, channel.handle, published, views ? `${Number(views).toLocaleString()} views` : ''].filter(Boolean);
    results.push({
      title: unesc(title), url: `https://www.youtube.com/watch?v=${id}`,
      snippet: parts.join(' · '), engines: ['yt-rss'], score: 1, sourceQuality: 1,
    });
  }
  return results.length ? results : null;
}

async function youtubeChannelLatest(query, channel, maxResults = 8) {
  const max = Math.max(1, Math.min(maxResults, 12));
  // RSS feed first (fast, no subprocess, has dates); yt-dlp only when the feed is unusable.
  const viaRss = await rssChannelLatest(channel, max).catch(() => null);
  if (viaRss) {
    return {
      query,
      vertical: 'youtube',
      results: viaRss,
      totalResults: viaRss.length,
      sources: ['yt-rss'],
      engineReports: [{ engine: 'yt-rss', status: 'ok', count: viaRss.length, ms: 0, note: `YouTube channel-latest route (uploads feed): ${channel.name}` }],
      usedFallback: false,
      lowConfidence: false,
      timing: { fetchMs: 0, totalMs: 0 },
    };
  }
  const { stdout } = await execFile('yt-dlp', [
    '--dump-json',
    '--flat-playlist',
    '--playlist-end',
    String(max),
    '--no-warnings',
    '--quiet',
    `https://www.youtube.com/channel/${channel.id}/videos`,
  ], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
  const rows = stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const seen = new Set();
  const results = [];
  for (const v of rows) {
    const url = v.webpage_url || v.url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const parts = [channel.name, channel.handle, v.duration_string ? `${v.duration_string}` : '', 'channel uploads'].filter(Boolean);
    results.push({
      title: v.title || url,
      url,
      snippet: parts.join(' · '),
      engines: ['yt-dlp'],
      score: 1,
      sourceQuality: 1,
    });
    if (results.length >= max) break;
  }
  return {
    query,
    vertical: 'youtube',
    results,
    totalResults: results.length,
    sources: ['yt-dlp'],
    engineReports: [{ engine: 'yt-dlp', status: results.length ? 'ok' : 'zero', count: results.length, ms: 0, note: `YouTube channel-latest route: ${channel.name}` }],
    usedFallback: false,
    lowConfidence: results.length === 0,
    timing: { fetchMs: 0, totalMs: 0 },
  };
}

async function youtubeSearch(query, maxResults = 8) {
  const channel = knownYouTubeChannel(query);
  if (channel) return youtubeChannelLatest(query, channel, maxResults);
  // "latest/uploads from X" with no known-map hit → resolve X live via InnerTube channel search.
  if (wantsChannelLatest(query)) {
    const resolved = await resolveYouTubeChannel(query).catch(() => null);
    if (resolved) return youtubeChannelLatest(query, resolved, maxResults);
  }
  const max = Math.max(1, Math.min(maxResults, 12));
  const { stdout } = await execFile('yt-dlp', [
    '--dump-json',
    '--flat-playlist',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    `ytsearch${max}:${query}`,
  ], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
  const rows = stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const seen = new Set();
  const results = [];
  for (const v of rows) {
    const url = v.webpage_url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const date = v.upload_date ? `${String(v.upload_date).slice(0, 4)}-${String(v.upload_date).slice(4, 6)}-${String(v.upload_date).slice(6, 8)}` : '';
    const views = Number.isFinite(v.view_count) ? `${v.view_count.toLocaleString()} views` : '';
    const parts = [v.channel || v.uploader, date, views].filter(Boolean);
    results.push({
      title: v.title || url,
      url,
      snippet: parts.join(' · '),
      engines: ['yt-dlp'],
      score: 1,
      sourceQuality: 1,
    });
    if (results.length >= max) break;
  }
  return {
    query,
    vertical: 'youtube',
    results,
    totalResults: results.length,
    sources: ['yt-dlp'],
    engineReports: [{ engine: 'yt-dlp', status: results.length ? 'ok' : 'zero', count: results.length, ms: 0, note: 'YouTube vertical route' }],
    usedFallback: false,
    lowConfidence: results.length === 0,
    timing: { fetchMs: 0, totalMs: 0 },
  };
}

// Warm stealth-Chrome for the web_search google fallback + /google (headful, own profile — logged-in
// Google rarely rate-limits). Lazily launched, kept alive. Separate profile dir to avoid a lock fight.
let googleBrowser = null;
let googleBrowserInit = null; // cached init promise — prevents a check-then-act race where two concurrent
                              // callers both construct a browser on the SAME profile dir (profile-lock conflict).
async function getGoogleBrowser() {
  if (googleBrowser) return googleBrowser;
  if (!googleBrowserInit) {
    googleBrowserInit = (async () => {
      const b = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${TRACKER_DIR}/google-profile` });
      await b.open();
      googleBrowser = b;
      return b;
    })().catch((e) => { googleBrowserInit = null; throw e; }); // let a failed init be retried
  }
  return googleBrowserInit;
}

// Serialize interactive single-page ops (goto/click/type/extract share one page); parallel work uses
// its own tab pool inside parallelExtract so it does NOT contend on this lock.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {}); // never let a rejection break the chain
  return run;
}

// ── Backpressure: cap concurrent HEAVY ops so a burst can't starve the single-process event loop or
// oversubscribe the tab pool. Light ops (/fetch, /health, /stats, /goto…) bypass this entirely. Under a
// stress burst this turns "everything thrashes for 70s" into "N run fast, the rest wait in a cheap queue".
// Heavy = CPU-heavy parsing / many-tab / OCR ops that starve the event loop under burst. NOT /search
// (network-bound, frequent, self-bounded by its soft budgets) or /fetch — those stay in the fast lane.
const HEAVY_ROUTES = new Set(['/research', '/parallel_extract', '/parallel_screenshot', '/read_visual', '/session_search', '/browse']);
const MAX_HEAVY = Number(process.env.VANTA_MAX_HEAVY) || 5;
let heavyActive = 0;
const heavyQueue = [];
function acquireHeavy() {
  if (heavyActive < MAX_HEAVY) { heavyActive++; return Promise.resolve(); }
  return new Promise((resolve) => heavyQueue.push(resolve));
}
function releaseHeavy() {
  heavyActive--;
  const next = heavyQueue.shift();
  if (next) { heavyActive++; next(); }
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ── Route table: path → handler(body) → result object ────────────────────────
const routes = {
  // Interactive single-page ops. The extension backend serializes internally (TabPool interactive lane);
  // the patchright backend uses the process-wide serial() chain. Route through serial() only for patchright.
  '/goto':                (b) => { const bk = backend(b.backend); return bk === browser ? serial(() => bk.open().then(() => bk.goto(b.url, b.waitFor))) : bk.open().then(() => bk.goto(b.url, b.waitFor)); },
  '/extract':             (b) => { const bk = backend(b.backend); return bk === browser ? serial(() => bk.extract()) : bk.extract(); },
  '/page':                (b) => { const bk = backend(b.backend); const run = async () => { await bk.open(); return bk.page ? bk.page(b.url, b.waitFor) : (await bk.goto(b.url, b.waitFor), bk.extract()); }; return bk === browser ? serial(run) : run(); },
  '/click':               (b) => { const bk = backend(b.backend); return bk === browser ? serial(() => bk.click(b.target, b.byText ?? false)) : bk.click(b.target, b.byText ?? false); },
  '/type':                (b) => { const bk = backend(b.backend); return bk === browser ? serial(() => bk.type(b.selector, b.text, b.submit ?? false)) : bk.type(b.selector, b.text, b.submit ?? false); },
  '/press':               (b) => { const bk = backend(b.backend); return bk === browser ? serial(() => bk.press(b.key)) : bk.press(b.key); },
  '/scroll':              (b) => { const bk = backend(b.backend); return bk === browser ? serial(() => bk.scroll(b.direction ?? 'down', b.amount ?? 1)) : bk.scroll(b.direction ?? 'down', b.amount ?? 1); },
  '/screenshot':          (b) => { const bk = backend(b.backend); return bk === browser ? serial(() => bk.screenshot(b.path)) : bk.screenshot(b.path); },
  // Batch actions in ONE round trip — extension backend only (patchright has no act()).
  '/act':                 (b) => { const bk = backend(b.backend); if (!bk.act) throw new Error('act() needs the extension backend (bridge not connected)'); return bk.act(b.steps); },
  // Cookie-authenticated fetch tier — extension only. No render; real session cookies.
  '/fetch':               (b) => { if (!bridgeUp()) throw new Error('http.fetch needs the extension backend (bridge not connected)'); return extBrowser.httpFetch(b.url, { method: b.method, headers: b.headers, body: b.body, timeoutMs: b.timeoutMs }); },
  // Cookie-fetch → clean markdown (logged-in, no render). Falls back to a rendered page if the fast path is thin.
  '/fetch_extract':       async (b) => { if (!bridgeUp()) throw new Error('fetch_extract needs the extension backend (bridge not connected)'); const fast = await extBrowser.fetchExtract(b.url); if (fast && fast.markdown.replace(/\s+/g, '').length >= 300) return fast; return extBrowser.page(b.url); },
  // Parallel fetch — extension uses cookie-fetch-first + tab pool; patchright uses its own tab pool.
  '/parallel_extract':    async (b) => { const bk = backend(b.backend); await bk.open(); return bk.parallelExtract(b.urls, { concurrency: b.concurrency ?? 6, settleMs: b.settleMs ?? 3000 }); },
  '/parallel_screenshot': async (b) => { const bk = backend(b.backend); await bk.open(); return bk.parallelScreenshot(b.jobs, { concurrency: b.concurrency ?? 6, settleMs: b.settleMs ?? 6000 }); },
  // Higher-level research — browse loop + reach ladder ride whichever backend is live.
  '/browse':              (b) => browse(backend(b.backend), b.query, { maxPages: b.maxPages, maxSeeds: b.maxSeeds, maxDepth: b.maxDepth, minRelevance: b.minRelevance, maxAgeDays: b.maxAgeDays, recencyMode: b.recencyMode, seedUrls: b.seedUrls }),
  '/reach':               (b) => reach({ url: b.url, agentBrowser: backend(b.backend), proxyManager, allowArchive: b.allowArchive ?? true, extBrowser: bridgeUp() ? extBrowser : undefined }),
  // Parallel research tree — fans out per level and dives deeper only into relevant branches. Needs the
  // extension backend (parallel pool + links). Seeds from google-session-fused search. Broad/temporal
  // queries (no single deep branch) auto-route to a NEWS SWEEP instead of a tree, unless mode is forced.
  '/research':            async (b) => {
    if (!bridgeUp()) throw new Error('research (tree browse) needs the extension backend — bridge not connected');
    const mode = b.mode || classifyQuery(b.query);
    if (mode === 'broad') return newsSweep(b.query, b.maxPages ?? 8);
    const tree = await treeBrowse(extBrowser, b.query, {
      seedSearch: (q) => search(q, { maxResults: b.maxSeeds ?? 4, sessionEngines: sessionEnginesFor(), fallback: googleFallback }).then((r) => r.results),
      maxSeeds: b.maxSeeds, poolWidth: b.poolWidth, maxPages: b.maxPages, maxDepth: b.maxDepth,
      perDomain: b.perDomain, perPageLinks: b.perPageLinks, minRelevance: b.minRelevance,
      expandThreshold: b.expandThreshold, maxAgeDays: b.maxAgeDays, settleMs: b.settleMs,
    });
    return { mode: 'tree', ...tree };
  },
  '/search':              async (b) => {
    const t0 = Date.now();
    if (b.youtube !== false && isYouTubeLookup(b.query)) {
      try {
        const yt = await youtubeSearch(b.query, b.maxResults ?? 8);
        yt.timing = { fetchMs: Date.now() - t0, totalMs: Date.now() - t0 };
        if (yt.results.length) return yt;
      } catch { /* fall through to general web search */ }
    }
    const r = await search(b.query, { maxResults: b.maxResults ?? 10, freshness: b.recency, noCache: b.noCache, sessionEngines: b.browserFallback === false ? undefined : sessionEnginesFor(), fallback: b.browserFallback === false ? undefined : googleFallback });
    // Content re-rank (default ON when the bridge is up): read the top results' ACTUAL pages via the
    // cookie-fetch tier and re-order by real content relevance — homepages/thin pages sink, substantive
    // matches rise. Disable with rerank:false. Skipped for navigational lookups where a homepage is fine.
    if (b.rerank !== false && bridgeUp() && r.results.length > 1) {
      try { return await contentRerank(b.query, r, b.rerankTop ?? 4); } catch { /* fall back to fused order */ }
    }
    return r;
  },
  '/google':              async (b) => { if (bridgeUp()) { try { return { query: b.query, engine: 'google-session', results: await googleViaExtension(b.query, b.maxResults ?? 10, !!b.news) }; } catch (e) { /* fall through */ } } const gb = await getGoogleBrowser(); return { query: b.query, engine: 'google', results: await gb.googleSearch(b.query, b.maxResults ?? 10) }; },
  // Logged-in walled-garden search (reddit/x/twitter/linkedin) via YOUR session. Returns DOM content
  // links where the markup allows (reddit) AND a DOM-proof VISUAL read (screenshot+OCR) for hostile SPAs
  // (x/linkedin) so "look up what's there" works even when the DOM is obfuscated. `visual` forces/disables.
  '/session_search':      async (b) => {
    if (!bridgeUp()) throw new Error('session_search needs the extension backend — bridge not connected');
    const site = String(b.site || '').toLowerCase();
    const results = await extBrowser.siteSearch(site, b.query, b.maxResults ?? 10).catch(() => []);
    const wantVisual = b.visual !== undefined ? b.visual : (site === 'x' || site === 'twitter' || site === 'linkedin' || results.length === 0);
    let visibleText;
    if (wantVisual) {
      const searchUrl = { reddit: `https://old.reddit.com/search?q=${encodeURIComponent(b.query)}`, x: `https://x.com/search?q=${encodeURIComponent(b.query)}&f=live`, twitter: `https://x.com/search?q=${encodeURIComponent(b.query)}&f=live`, linkedin: `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(b.query)}` }[site];
      if (searchUrl) { try { visibleText = (await extBrowser.readVisual(searchUrl, { scrolls: b.scrolls ?? 4 })).text; } catch (e) { visibleText = `visual read failed: ${(e?.message || '').slice(0, 60)}`; } }
    }
    return { site, query: b.query, results, visibleText };
  },
  // Universal DOM-proof reader: render any URL in the logged-in session, scroll + screenshot + OCR → text.
  '/read_visual':         (b) => { if (!bridgeUp()) throw new Error('read_visual needs the extension backend — bridge not connected'); return extBrowser.readVisual(b.url, { scrolls: b.scrolls, settleMs: b.settleMs }); },
  '/stats':               () => ({ bridge: bridge ? bridge.info : { connected: false }, ext: extBrowser ? extBrowser.stats() : null, backpressure: { active: heavyActive, queued: heavyQueue.length, max: MAX_HEAVY }, metrics: metricsSnapshot() }),
};

// ── Lightweight per-route metrics (p50/p95, counts, errors) for /stats observability ──────────────
const metrics = new Map(); // path -> { samples:[ms...], count, errors }
function recordMetric(path, ms, ok) {
  let m = metrics.get(path);
  if (!m) { m = { samples: [], count: 0, errors: 0 }; metrics.set(path, m); }
  m.count++; if (!ok) m.errors++;
  m.samples.push(ms); if (m.samples.length > 200) m.samples.shift(); // rolling window
}
function pct(sorted, p) { if (!sorted.length) return 0; return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]); }
function metricsSnapshot() {
  const out = {};
  for (const [path, m] of metrics) {
    const s = [...m.samples].sort((a, b) => a - b);
    out[path] = { count: m.count, errors: m.errors, p50: pct(s, 0.5), p95: pct(s, 0.95) };
  }
  return out;
}

/** Google via the logged-in VANTA session — renders on a pool tab and parses the SERP in-page for clean
 * {title,url,snippet}. Returns SearchResult[] ready for fusion. */
async function googleViaExtension(query, maxResults = 10, news = false) {
  return extBrowser.googleSearch(query, { max: maxResults, news });
}
/** google-session as a first-class fusion engine (when the bridge is up). */
function sessionEnginesFor() {
  return bridgeUp() ? [{ name: 'google-session', fn: (q, max) => googleViaExtension(q, max, false) }] : undefined;
}
/** Content re-rank: fetch the top candidates (cookie-fetch tier) and re-order by REAL page-content
 * relevance to the query. This is what kills the "homepage ranked #1" problem — a homepage fetched has
 * thin/generic prose (low content match) and sinks; a substantive article rises. Adds ~1s (parallel). */
const RERANK_TOP = 4;
const RERANK_WEIGHT = 0.05;      // how hard content-relevance moves the fused score
const RERANK_SOURCE_WEIGHT = 0.025; // keep source-of-record pages above copied/reposted prose
const RERANK_THIN_PENALTY = 0.03; // extra demotion for pages with almost no real prose (homepages/walls)
async function contentRerank(query, resp, topN = RERANK_TOP) {
  const terms = tokenize(query);
  const limit = Math.max(1, Math.min(Number(topN) || RERANK_TOP, 8));
  const top = resp.results.slice(0, limit);
  const rest = resp.results.slice(limit);
  const extracts = await extBrowser.parallelExtract(top.map((r) => r.url), { settleMs: 800 });
  const rescored = top.map((r, i) => {
    const prose = stripMarkdownLinks(extracts[i]?.markdown || '');
    // Real page-content relevance to the query (same scorer the tree/relevance gate use).
    const contentRel = prose.length < 250 ? 0 : bm25ish(terms, prose.slice(0, 6000), r.title || '');
    const thin = prose.replace(/\s+/g, '').length < 400;
    const quality = Number.isFinite(r.sourceQuality) ? r.sourceQuality : sourceQuality(r.url, query);
    const thinPenalty = thin && quality < 0.85 ? RERANK_THIN_PENALTY : 0;
    const blended = (r.score ?? 0) + RERANK_WEIGHT * contentRel + RERANK_SOURCE_WEIGHT * quality - thinPenalty;
    return { ...r, sourceQuality: quality, contentRel: Number(contentRel.toFixed(3)), rerankScore: Number(blended.toFixed(4)) };
  });
  rescored.sort((a, b) => b.rerankScore - a.rerankScore);
  return { ...resp, reranked: true, rerankTop: limit, results: [...rescored, ...rest] };
}

/** News sweep for BROAD queries: google-session news results + a parallel read of the top few articles,
 * returning citable evidence (key sentences + source) — the breadth-appropriate answer, not a deep tree. */
async function newsSweep(query, maxPages = 8) {
  const t0 = Date.now();
  // Prefer the News tab; fall back to a fused search if news is thin.
  let items = [];
  try { items = await extBrowser.googleSearch(query, { news: true, max: maxPages }); } catch { /* */ }
  if (items.length < 3) {
    const r = await search(query, { maxResults: maxPages, sessionEngines: sessionEnginesFor(), fallback: googleFallback });
    items = r.results.map((x) => ({ title: x.title, url: x.url, snippet: x.snippet || '' }));
  }
  // Read the top articles in parallel (cookie-fetch tier) and pull key sentences for citation.
  const top = items.slice(0, Math.min(6, maxPages));
  const terms = tokenize(query);
  const extracts = await extBrowser.parallelExtract(top.map((i) => i.url), { settleMs: 2000 }).catch(() => []);
  const evidence = [];
  extracts.forEach((ex, i) => {
    const prose = stripMarkdownLinks(ex?.markdown || '');
    if (prose.length < 200) return;
    for (const p of keyPassages(prose.slice(0, 8000), terms, 2)) {
      evidence.push({ text: p, url: top[i].url, title: ex.title || top[i].title, relevance: 1 });
    }
  });
  return { mode: 'news', query, results: items, evidence: evidence.slice(0, 12), ms: Date.now() - t0 };
}

/** search() fallback (only fires if fusion is still weak): logged-in google-session, else warm stealth Chrome. */
async function googleFallback(q, max) {
  if (bridgeUp()) { try { const r = await googleViaExtension(q, max); if (r.length) return r; } catch { /* */ } }
  return getGoogleBrowser().then((gb) => gb.googleSearch(q, max));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const path = url.pathname;

  if (path === '/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, uptimeMs: Date.now() - startedAt, port: PORT, profile: 'natural', bridge: bridge ? bridge.info : { connected: false } });
  }
  if (req.method !== 'POST' || !(path in routes)) {
    return send(res, 404, { ok: false, error: `no route ${req.method} ${path}` });
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { ok: false, error: 'unauthorized' });
  }

  const _t0 = Date.now();
  const heavy = HEAVY_ROUTES.has(path);
  if (heavy) await acquireHeavy();
  try {
    const body = await readBody(req);
    const result = await routes[path](body);
    recordMetric(path, Date.now() - _t0, true);
    send(res, 200, { ok: true, result });
  } catch (e) {
    recordMetric(path, Date.now() - _t0, false);
    send(res, 500, { ok: false, error: (e?.message || String(e)).slice(0, 300) });
  } finally {
    if (heavy) releaseHeavy();
  }
});

// Attach the VANTA extension bridge to the SAME http server (WS upgrade on /vanta-bridge). Reuses the
// daemon's loopback + token guarantees. The extension connects OUT to this; until it does, extBrowser
// exists but reports connected:false and all routes transparently use the Patchright backend.
bridge = new BridgeServer(server, { token: TOKEN, path: '/vanta-bridge' });
extBrowser = new ExtensionBrowser(bridge, { size: VANTA_POOL_SIZE });
bridge.onConnect(() => console.error(`[vortex-daemon] VANTA extension connected (${bridge.info.tabs} tabs) — browser routes now ride real Chrome`));

server.listen(PORT, HOST, () => {
  console.error(`[vortex-daemon] listening on http://${HOST}:${PORT}  (token:${TOKEN ? 'on' : 'off'})  bridge:/vanta-bridge`);
});

async function shutdown() {
  console.error('[vortex-daemon] shutting down…');
  try { if (bridge) await bridge.close(); } catch { /* */ }
  try { await browser.close(); } catch { /* */ }
  try { if (googleBrowser) await googleBrowser.close(); } catch { /* */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
