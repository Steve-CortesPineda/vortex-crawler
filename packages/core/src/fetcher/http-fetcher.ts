import type { FetchRequest, FetchResult } from '../types/config.js';
import { generateHeaders } from '../antibot/headers.js';

export class HttpFetcher {
  private timeout: number;

  constructor(timeout = 30_000) {
    this.timeout = timeout;
  }

  async fetch(req: FetchRequest): Promise<FetchResult> {
    const start = performance.now();
    const headers = {
      ...generateHeaders(req.url),
      ...req.headers,
    };

    const signal = AbortSignal.timeout(req.timeout ?? this.timeout);

    const response = await fetch(req.url, {
      method: 'GET',
      headers,
      signal,
      redirect: 'follow',
    });

    const html = await response.text();
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
      tier: 'http',
      timing: { fetchMs },
    };
  }
}
