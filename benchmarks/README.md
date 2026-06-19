# Benchmarks

Head-to-head crawler comparison on a fixed URL set (a static page, a link-heavy page, a long article,
and a JavaScript-rendered page), fetched sequentially from cold. Each runner prints JSON; the
orchestrator wraps it in `/usr/bin/time -l` to capture peak RSS.

Firecrawl is a paid hosted API and is intentionally **not** included.

## Setup

```bash
# 1. Build Vortex
pnpm build

# 2. Python competitors (Scrapy, Crawl4AI)
python3 -m venv benchmarks/.venv
benchmarks/.venv/bin/pip install scrapy crawl4ai
benchmarks/.venv/bin/python -m playwright install chromium

# 3. Node competitor (Crawlee)
cd benchmarks/competitors && npm init -y && npm i crawlee playwright && npx playwright install chromium && cd -
```

## Run

```bash
node benchmarks/run.mjs
```

Uninstalled competitors are skipped, so you can run with just Vortex if you only want its numbers.
Results are written to `benchmarks/results.json`. Edit `benchmarks/urls.json` to change the URL set.

## Methodology notes

- **Sequential, cold.** Each tool fetches all URLs one at a time (Scrapy with `CONCURRENT_REQUESTS=1`).
- **Crawl time** is each runner's own wall-clock around the crawl loop (excludes interpreter startup).
- **Peak RAM** is whole-process max RSS via `/usr/bin/time -l` — fair within a tool, but cross-runtime
  (Node vs Python) comparisons are approximate.
- **"OK"** means the fetch returned without error; check per-URL `chars` for whether real content came
  back (e.g. an HTTP-only crawler "succeeds" on a JS page but returns an empty shell).
