import type { FetchRequest, FetchResult } from '../types/config.js';
import { generateHeaders } from '../antibot/headers.js';

export class JsdomFetcher {
  private timeout: number;
  private JSDOM: typeof import('jsdom').JSDOM | null = null;

  constructor(timeout = 30_000) {
    this.timeout = timeout;
  }

  private async getJSDOM() {
    if (!this.JSDOM) {
      const jsdom = await import('jsdom');
      this.JSDOM = jsdom.JSDOM;
    }
    return this.JSDOM;
  }

  async fetch(req: FetchRequest): Promise<FetchResult> {
    const start = performance.now();
    const JSDOM = await this.getJSDOM();
    const headers = { ...generateHeaders(req.url), ...req.headers };

    // Fetch HTML first via standard fetch
    const response = await fetch(req.url, {
      headers,
      signal: AbortSignal.timeout(req.timeout ?? this.timeout),
      redirect: 'follow',
    });

    const rawHtml = await response.text();

    // Run through JSDOM for limited JS execution
    const dom = new JSDOM(rawHtml, {
      url: req.url,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
    });

    // Wait a bit for scripts to execute
    await new Promise(resolve => setTimeout(resolve, 1000));

    const html = dom.serialize();
    dom.window.close();

    const fetchMs = performance.now() - start;

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      url: req.url,
      statusCode: response.status,
      headers: responseHeaders,
      html,
      tier: 'jsdom',
      timing: { fetchMs },
    };
  }
}
