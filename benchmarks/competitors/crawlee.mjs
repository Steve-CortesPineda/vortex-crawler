// Crawlee runner — sequential, PlaywrightCrawler (browser always). Prints JSON {tool, crawl_ms, results}.
import { readFileSync } from 'node:fs';
import { PlaywrightCrawler } from 'crawlee';

const URLS = JSON.parse(readFileSync(new URL('../urls.json', import.meta.url)));
const results = [];
const start = performance.now();

const crawler = new PlaywrightCrawler({
  maxConcurrency: 1,
  maxRequestRetries: 0,
  requestHandlerTimeoutSecs: 40,
  headless: true,
  async requestHandler({ page, request }) {
    const t = performance.now();
    const text = await page.evaluate(() => document.body?.innerText || '');
    results.push({ url: request.url, ms: Math.round(performance.now() - t), chars: text.length, ok: true });
  },
  failedRequestHandler({ request }) {
    results.push({ url: request.url, ms: 0, chars: 0, ok: false });
  },
});

await crawler.run(URLS);
console.log(JSON.stringify({ tool: 'crawlee', crawl_ms: Math.round(performance.now() - start), results }));
