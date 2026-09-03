#!/usr/bin/env node
/**
 * VANTA Chrome launcher — starts the dedicated real-Chrome profile with the VANTA Bridge extension
 * loaded, then leaves it running. Uses Playwright's persistent-context extension loading, which works
 * where Chrome 149's bare `--load-extension` CLI switch is silently ignored.
 *
 * The extension connects OUT to the browser daemon (browser-daemon.mjs) over the loopback WS. Log into
 * Google/LinkedIn/etc. ONCE in this window and the session persists in the profile.
 *
 *   node vanta-chrome.mjs            # headful (most human)
 *   VANTA_HEADLESS=1 node vanta-chrome.mjs
 *
 * Env: VANTA_PROFILE_DIR (default ~/.vortex-vanta-profile), VANTA_EXT_DIR (default packages/extension/dist).
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Patchright (stealth Playwright fork) strips the automation signals — navigator.webdriver,
// --enable-automation, CDP runtime leaks — that make Google reject login with "this browser may not be
// secure". It's a dependency of packages/core (not the repo root), so resolve it from there; fall back
// to plain playwright only if that fails (which is NOT stealthy — Google will block login).
const _root = path.dirname(fileURLToPath(import.meta.url));
const _req = createRequire(path.join(_root, 'packages/core/package.json'));
function pickChromium(mod) { return mod?.chromium || mod?.default?.chromium || mod?.default || null; }
let chromium = null; let engineName = 'playwright';
try {
  const mod = await import(_req.resolve('patchright'));
  chromium = pickChromium(mod);
  if (chromium?.launchPersistentContext) engineName = 'patchright';
  else chromium = null;
} catch { /* fall through */ }
if (!chromium) {
  const mod = await import(_req.resolve('playwright'));
  chromium = pickChromium(mod);
}
if (!chromium?.launchPersistentContext) { console.error('[vanta-chrome] FATAL: no usable chromium (patchright/playwright)'); process.exit(1); }

const root = _root;
const EXT = process.env.VANTA_EXT_DIR || path.join(root, 'packages/extension/dist');
const PROFILE = process.env.VANTA_PROFILE_DIR || path.join(os.homedir(), '.vortex-vanta-profile');
const HEADLESS = process.env.VANTA_HEADLESS === '1';

const args = [
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
];

// Chrome 149 silently ignores the CLI --load-extension switch, and Playwright's channel:'chrome' doesn't
// reliably load unpacked extensions either. The officially supported path is Playwright's BUNDLED Chromium
// (patchright's is stealth-patched), which loads MV3 extensions via persistent context. Slightly more
// fingerprintable than stock Chrome, but the profile still persists real logins.
const useChannel = process.env.VANTA_CHANNEL; // set e.g. 'chrome' to force real Chrome (may not load ext)
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: HEADLESS,
  ...(useChannel ? { channel: useChannel } : {}),
  args,
  viewport: null,
});

// A real page so the wake content-script fires and nudges the SW to connect immediately.
const page = ctx.pages()[0] || await ctx.newPage();
try { await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch { /* ok */ }

// Login handoff: open each site in VANTA_LOGIN_TABS as a visible foreground tab so the human can sign in
// once. Sessions persist in the profile. We NEVER touch credential fields — the human logs in manually.
const loginTabs = (process.env.VANTA_LOGIN_TABS || '').split(',').map((s) => s.trim()).filter(Boolean);
for (const url of loginTabs) {
  try { const p = await ctx.newPage(); await p.bringToFront(); await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
  catch { /* leave the tab; the human can retype */ }
}
if (loginTabs.length) console.error(`[vanta-chrome] opened ${loginTabs.length} login tab(s) — sign in manually; sessions persist.`);

console.error(`[vanta-chrome] launched via ${engineName} (headless:${HEADLESS}) profile:${PROFILE}`);

// Diagnostics: report the extension's service worker so we can tell if Chrome loaded it.
ctx.on('serviceworker', (w) => console.error('[vanta-chrome] serviceworker up:', w.url()));
await new Promise((r) => setTimeout(r, 4000));
const sws = ctx.serviceWorkers().map((w) => w.url());
console.error('[vanta-chrome] service workers:', JSON.stringify(sws));
const ourSw = ctx.serviceWorkers().find((w) => w.url().includes('sw.js'));
if (!ourSw) {
  console.error('[vanta-chrome] WARNING: VANTA sw.js not loaded. Extension not recognized by this Chrome.');
} else {
  console.error('[vanta-chrome] VANTA extension SW is live:', ourSw.url());
  // Optional: seed the WS token into the extension's storage so the SW authenticates to a token-gated
  // daemon. Loopback-only means the token is defense-in-depth; off by default.
  const token = process.env.VORTEX_DAEMON_TOKEN;
  if (token) {
    try { await ourSw.evaluate((t) => chrome.storage.local.set({ token: t }), token); console.error('[vanta-chrome] seeded WS token into extension storage'); }
    catch (e) { console.error('[vanta-chrome] token seed failed:', e.message?.slice(0, 60)); }
  }
}
// Dev auto-reload: watch dist and hot-reload the extension on change (VANTA_DEV=1) — replaces the manual
// kill-Chrome + nuke-SW-cache dance. `chrome.runtime.reload()` re-registers a fresh SW in-place.
if (process.env.VANTA_DEV === '1') {
  const { watch } = await import('node:fs');
  let debounce;
  watch(EXT, { recursive: false }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const sw = ctx.serviceWorkers().find((w) => w.url().includes('sw.js'));
      if (!sw) return;
      try { await sw.evaluate(() => chrome.runtime.reload()); console.error('[vanta-chrome] dev: extension reloaded'); }
      catch (e) { console.error('[vanta-chrome] dev reload failed:', e.message?.slice(0, 50)); }
    }, 400);
  });
  console.error('[vanta-chrome] dev auto-reload watching', EXT);
}

console.error('[vanta-chrome] extension should connect to the daemon within a few seconds. Ctrl-C to quit.');

// Keep the process (and browser) alive.
process.on('SIGINT', async () => { await ctx.close().catch(() => {}); process.exit(0); });
process.on('SIGTERM', async () => { await ctx.close().catch(() => {}); process.exit(0); });
await new Promise(() => {});
