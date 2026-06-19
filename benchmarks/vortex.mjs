// Vortex runner — sequential scrape of the shared URL set. Prints JSON {tool, crawl_ms, results}.
// Requires `pnpm build` first (imports the built core).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VortexCrawler } from '../packages/core/dist/index.js';

const URLS = JSON.parse(readFileSync(fileURLToPath(new URL('./urls.json', import.meta.url))));
const c = new VortexCrawler();
const results = [];
const start = performance.now();
for (const url of URLS) {
  const t = performance.now();
  try {
    const r = await c.scrape(url);
    results.push({ url, ms: Math.round(performance.now() - t), chars: (r.markdown || '').length, tier: r.tier, ok: true });
  } catch (e) {
    results.push({ url, ms: Math.round(performance.now() - t), chars: 0, ok: false, err: String(e?.message || e).slice(0, 80) });
  }
}
console.log(JSON.stringify({ tool: 'vortex', crawl_ms: Math.round(performance.now() - start), results }));
await c.close?.();   // tear down any browser the adaptive fetcher launched so the process exits
process.exit(0);
