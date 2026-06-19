# @stevecortesp/vortex-core

The engine behind [Vortex](https://github.com/Steve-CortesPineda/vortex-crawler) — an adaptive,
3-tier web crawler with LLM-optimized markdown output.

```bash
npm install @stevecortesp/vortex-core
```

```typescript
import { VortexCrawler } from '@stevecortesp/vortex-core';

const crawler = new VortexCrawler();
const result = await crawler.scrape('https://example.com');
console.log(result.markdown);   // clean markdown
console.log(result.tokens);     // { markdown, html, reduction }
```

**What's inside:** adaptive HTTP/JSDOM/Playwright rendering (browser launched only when a page needs
it), multi-engine search with reciprocal-rank fusion, an autonomous browsing agent (`browse`, `reach`),
a watchlist tracking oracle (`track`), and anti-bot/stealth profiles.

Full docs, CLI, MCP server, and benchmarks: **https://github.com/Steve-CortesPineda/vortex-crawler**

MIT © Steve Cortes-Pineda
