# Vortex Web-Browsing Improvement Plan — 2026-06-18

Triggered by a live failure: tasked to "go look at nousresearch.com and the NGC Parakeet page,"
`browse()` returned **0 pages** and `web_search("Nous Research …")` returned mostly the philosophy
word "nous" (Wikipedia, Merriam-Webster, a philosophy journal). `reach()` was the only tool that
actually got the content. This documents *why* and the concrete fixes, with file/line citations.

## What happened (root causes)

### 1. `browse()` discards the target when it's a homepage — `browse.ts:86`, `browse-relevance.ts:58`
Seeds are dropped if `AGG_RE.test || NAV_RE.test`. `NAV_RE` ends with `|^https?:\/\/[^/]+\/?$` — i.e.
**any bare homepage** (`https://nousresearch.com/`). When the user points us *at a company/product
site*, that root URL is the intended entry point, but it's skipped as "homepage/aggregator." Both
Nous seeds were bare homepages → both skipped → empty frontier → 0 pages.
> NAV_RE is correct as a *link-follow demotion* signal, but wrong as a *seed rejection* signal.

### 2. Seeds came from polluted search, and there's no entity disambiguation — `search.ts:154`
`search()` passes the raw query to DDG/Bing/Mojeek. "Nous Research" hits the dictionary/philosophy
sense of "nous." RRF fusion (`search.ts:170`) then *amplifies* the junk because all three engines
agree on Wikipedia "Nous." The real `nousresearch.com` ranked #4 with a near-zero score. There is no
phrase-quoting, no proper-noun handling, no `site:` seeding.

### 3. `browse()` does not use the `reach()` fallback ladder — `browse.ts:106`
Per-URL fetch is a raw `await b.goto(url); ex = await b.extract()`. On a Vercel/Cloudflare checkpoint
(exactly what `nousresearch.com` served us) it gets a thin/blocked page and **skips** (`:108`,`:110`).
Meanwhile `reach.ts` already implements `direct → stealth-retry → logged-in → wayback → archive.today
→ reader` with `classifyPage()` — and `reach()` *did* recover Nous via the reader path this session.
That intelligence is simply not wired into the browse loop.

### 4. JS-only SPAs return empty and nothing escalates to the browser tier
`scrape_url` got the NGC catalog page at `jsdom` tier → empty markdown (the page is a client-rendered
SPA). There's no "empty/again → escalate to full browser render or `reach()`" step in the scrape path.

### 5. The relevance gate can't recover from a bad seed set — `browse.ts:114`
`bm25ish` correctly scored Wikipedia-"nous" at 0.13 and dropped it. The gate isn't the bug — but with
seeds 1 & 2 wrongly skipped (bug 1) and 3-10 polluted (bug 2), the gate had only noise to judge.

## Fixes (priority order)

### P0 — Route `browse()` per-URL fetch through `reach()`  *(biggest win, ~15 lines)*
In `browse.ts`, replace the raw goto/extract at `:106` with a `reach()` call (allowArchive on). This
gives the whole research loop stealth-retry + wayback + archive + reader for free, and turns today's
"thin/blocked → skip" into "recovered via reader." Reuse `classifyPage` so captcha/hard-paywall still
skip cleanly.
```ts
// was: await b.goto(url); ex = await b.extract();
const outcome = await reach({ url, agentBrowser: b, allowArchive: true, minProse: 200 });
if (!outcome.ok) { skipped.push(`${url} (${outcome.reason})`); continue; }
ex = outcome.result;
```

### P0 — Add `seedUrls` to `BrowseOptions`, and expose it on the MCP `browse` tool
When the user names specific URLs ("go look at X and Y"), enqueue them **directly at depth 0,
bypassing search AND the AGG/NAV seed filter**. This is the exact shape of today's task.
```ts
for (const u of opts.seedUrls ?? []) frontier.enqueue({ url: u, depth: 0, priority: 3 });
```
MCP: add an optional `seedUrls: string[]` param to the `browse` tool schema.

### P1 — Stop rejecting homepages at seed stage — `browse.ts:86`
Use `AGG_RE` only (true aggregators: google/bing/ddg/reddit/youtube/social) for seed rejection. Allow
up to `maxHomepageSeeds` (default 1) bare homepages through; they're often the intended hub. Keep the
full `NAV_RE` penalty for *link-following* (`scoreLink` `:71`), where it belongs.

### P1 — Entity-aware search seeding — `search.ts`
- Detect a Capitalized multiword proper noun (e.g. "Nous Research") and add a **quoted** variant
  (`"Nous Research"`) to force phrase match; fuse both result sets.
- If the query contains a bare domain or the caller passes one, add a `site:` query and/or enqueue the
  domain root directly.
- Down-rank dictionary/encyclopedia hosts (wikipedia/merriam-webster/wiktionary) when the query looks
  like a brand/company lookup (heuristic: query has a capitalized multiword name + a product word).

### P1 — Escalation ladder for `scrape_url` on empty/thin renders
On `jsdom`-tier empty or sub-`minProse` output, auto-retry at `browser` tier; if still thin/blocked,
fall through to `reach()`. (NGC would then render via the full browser instead of returning "".)

### P2 — Known-hard-domain hints
Maintain a small allowlist of domains that always need the browser/stealth tier (Vercel-checkpoint
hosts, NGC/`catalog.ngc.nvidia.com`, sites known to gate `http`/`jsdom`). Seed those straight to the
right tier instead of failing a cheap tier first.

### P2 — `browse()` should surface `reach`'s `needsHuman`
When every fetch needs a human (captcha/hard paywall), return that signal in `BrowseResult` instead of
an opaque empty `story`, so the caller knows it's a wall, not a dead query.

## Verification
- Regression: `browse("Nous Research products", { seedUrls: ["https://nousresearch.com"] })` must return
  ≥1 hop with the homepage content (was 0).
- Regression: `browse("Nous Research Hermes inference API")` (no seedUrls) must surface
  `nousresearch.com` / `hermes-agent.nousresearch.com` in the story, not philosophy pages.
- `scrape_url("https://catalog.ngc.nvidia.com/.../parakeet-tdt-0.6b")` must return non-empty markdown.

## Build/run note
Core is TypeScript (`packages/core/src/*.ts`) compiled for the MCP server (`packages/mcp`). Apply P0/P1
to source, `pnpm -w build`, then re-register/restart the Vortex MCP. Do this OUT of an active research
session so the live MCP this session depends on isn't disrupted mid-flight.
