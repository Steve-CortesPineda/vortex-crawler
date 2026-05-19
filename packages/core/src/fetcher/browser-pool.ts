type BrowserContext = {
  newPage: () => Promise<unknown>;
  close: () => Promise<void>;
  [key: string]: unknown;
};

type Browser = {
  newContext: (opts?: unknown) => Promise<BrowserContext>;
  close: () => Promise<void>;
};

export class BrowserPool {
  private maxSize: number;
  private browser: Browser | null = null;
  private available: BrowserContext[] = [];
  private inUse = new Set<BrowserContext>();

  constructor(maxSize = 2) {
    this.maxSize = maxSize;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      // Dynamic import — playwright not loaded until first browser request
      const pw = await import('playwright');
      this.browser = await pw.chromium.launch({
        headless: true,
        args: [
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--no-sandbox',
        ],
      }) as unknown as Browser;
    }
    return this.browser;
  }

  async acquire(): Promise<BrowserContext> {
    // Return from pool if available
    const existing = this.available.pop();
    if (existing) {
      this.inUse.add(existing);
      return existing;
    }

    // Create new if under limit
    if (this.inUse.size < this.maxSize) {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
      });
      this.inUse.add(context);
      return context;
    }

    // Wait for one to become available
    return new Promise<BrowserContext>((resolve) => {
      const check = setInterval(() => {
        const ctx = this.available.pop();
        if (ctx) {
          clearInterval(check);
          this.inUse.add(ctx);
          resolve(ctx);
        }
      }, 50);
    });
  }

  async release(context: BrowserContext): Promise<void> {
    this.inUse.delete(context);
    this.available.push(context);
  }

  async close(): Promise<void> {
    for (const ctx of [...this.available, ...this.inUse]) {
      await ctx.close().catch(() => {});
    }
    this.available = [];
    this.inUse.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
