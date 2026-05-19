import type { FetchRequest, FetchResult } from '../types/config.js';
import { BrowserPool } from './browser-pool.js';

export class BrowserFetcher {
  private pool: BrowserPool;

  constructor(poolSize = 2) {
    this.pool = new BrowserPool(poolSize);
  }

  async fetch(req: FetchRequest): Promise<FetchResult> {
    const start = performance.now();
    const context = await this.pool.acquire();

    try {
      const page = await context.newPage();

      try {
        const response = await page.goto(req.url, {
          waitUntil: 'networkidle',
          timeout: req.timeout ?? 30_000,
        });

        // Wait for dynamic content
        await page.waitForLoadState('domcontentloaded');

        const html = await page.content();
        const fetchMs = performance.now() - start;

        const headers: Record<string, string> = {};
        const responseHeaders = response?.headers() ?? {};
        for (const [key, value] of Object.entries(responseHeaders)) {
          headers[key] = value;
        }

        return {
          url: req.url,
          statusCode: response?.status() ?? 200,
          headers,
          html,
          tier: 'browser',
          timing: { fetchMs },
        };
      } finally {
        await page.close();
      }
    } finally {
      await this.pool.release(context);
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
