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
import { AgentBrowser, browse, reach, search, ProxyManager } from './packages/core/dist/index.js';

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

// Warm stealth-Chrome for the web_search google fallback + /google (headful, own profile — logged-in
// Google rarely rate-limits). Lazily launched, kept alive. Separate profile dir to avoid a lock fight.
let googleBrowser = null;
async function getGoogleBrowser() {
  if (!googleBrowser) {
    googleBrowser = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${TRACKER_DIR}/google-profile` });
    await googleBrowser.open();
  }
  return googleBrowser;
}

// Serialize interactive single-page ops (goto/click/type/extract share one page); parallel work uses
// its own tab pool inside parallelExtract so it does NOT contend on this lock.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {}); // never let a rejection break the chain
  return run;
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
  '/goto':                (b) => serial(() => browser.open().then(() => browser.goto(b.url, b.waitFor))),
  '/extract':             ()  => serial(() => browser.extract()),
  '/page':                (b) => serial(async () => { await browser.open(); await browser.goto(b.url, b.waitFor); return browser.extract(); }),
  '/click':               (b) => serial(() => browser.click(b.target, b.byText ?? false)),
  '/type':                (b) => serial(() => browser.type(b.selector, b.text, b.submit ?? false)),
  '/press':               (b) => serial(() => browser.press(b.key)),
  '/scroll':              (b) => serial(() => browser.scroll(b.direction ?? 'down', b.amount ?? 1)),
  '/screenshot':          (b) => serial(() => browser.screenshot(b.path)),
  // Parallel fetch — opens its own bounded tab pool; the per-domain governor keeps it polite.
  '/parallel_extract':    async (b) => { await browser.open(); return browser.parallelExtract(b.urls, { concurrency: b.concurrency ?? 6, settleMs: b.settleMs ?? 3000 }); },
  '/parallel_screenshot': async (b) => { await browser.open(); return browser.parallelScreenshot(b.jobs, { concurrency: b.concurrency ?? 6, settleMs: b.settleMs ?? 6000 }); },
  // Higher-level research — the browse loop and the reach ladder share this warm browser.
  '/browse':              (b) => browse(browser, b.query, { maxPages: b.maxPages, maxSeeds: b.maxSeeds, maxDepth: b.maxDepth, minRelevance: b.minRelevance, maxAgeDays: b.maxAgeDays, recencyMode: b.recencyMode, seedUrls: b.seedUrls }),
  '/reach':               (b) => reach({ url: b.url, agentBrowser: browser, proxyManager, allowArchive: b.allowArchive ?? true }),
  '/search':              (b) => search(b.query, { maxResults: b.maxResults ?? 10, freshness: b.recency, fallback: b.browserFallback === false ? undefined : (q, max) => getGoogleBrowser().then((gb) => gb.googleSearch(q, max)) }),
  '/google':              async (b) => { const gb = await getGoogleBrowser(); return { query: b.query, engine: 'google', results: await gb.googleSearch(b.query, b.maxResults ?? 10) }; },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const path = url.pathname;

  if (path === '/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, uptimeMs: Date.now() - startedAt, port: PORT, profile: 'natural' });
  }
  if (req.method !== 'POST' || !(path in routes)) {
    return send(res, 404, { ok: false, error: `no route ${req.method} ${path}` });
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { ok: false, error: 'unauthorized' });
  }

  try {
    const body = await readBody(req);
    const result = await routes[path](body);
    send(res, 200, { ok: true, result });
  } catch (e) {
    send(res, 500, { ok: false, error: (e?.message || String(e)).slice(0, 300) });
  }
});

server.listen(PORT, HOST, () => {
  console.error(`[vortex-daemon] listening on http://${HOST}:${PORT}  (token:${TOKEN ? 'on' : 'off'})`);
});

async function shutdown() {
  console.error('[vortex-daemon] shutting down…');
  try { await browser.close(); } catch { /* */ }
  try { if (googleBrowser) await googleBrowser.close(); } catch { /* */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
