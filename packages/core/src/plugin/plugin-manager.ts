import type { VortexPlugin } from './types.js';

export class PluginManager {
  private plugins: VortexPlugin[] = [];

  register(plugin: VortexPlugin): void {
    this.plugins.push(plugin);
  }

  async initAll(crawler: unknown): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onInit) await plugin.onInit(crawler);
    }
  }

  async closeAll(crawler: unknown): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onClose) await plugin.onClose(crawler);
    }
  }

  async runBeforeFetch(request: import('../types/config.js').FetchRequest) {
    let result: import('../types/config.js').FetchRequest | null = request;
    for (const plugin of this.plugins) {
      if (!plugin.beforeFetch || result === null) continue;
      result = await plugin.beforeFetch(result);
    }
    return result;
  }

  async runAfterFetch(fetchResult: import('../types/config.js').FetchResult, request: import('../types/config.js').FetchRequest) {
    let result = fetchResult;
    for (const plugin of this.plugins) {
      if (!plugin.afterFetch) continue;
      result = await plugin.afterFetch(result, request);
    }
    return result;
  }

  async runBeforeProcess(html: string, url: string): Promise<string> {
    let result = html;
    for (const plugin of this.plugins) {
      if (!plugin.beforeProcess) continue;
      result = await plugin.beforeProcess(result, url);
    }
    return result;
  }

  async runAfterProcess(crawlResult: import('../types/result.js').CrawlResult) {
    let result = crawlResult;
    for (const plugin of this.plugins) {
      if (!plugin.afterProcess) continue;
      result = await plugin.afterProcess(result);
    }
    return result;
  }

  async runExtract(crawlResult: import('../types/result.js').CrawlResult): Promise<Record<string, unknown>> {
    const extracted: Record<string, unknown> = {};
    for (const plugin of this.plugins) {
      if (!plugin.extract) continue;
      const data = await plugin.extract(crawlResult);
      if (data) Object.assign(extracted, data);
    }
    return extracted;
  }

  filterUrl(url: string, parentUrl: string): boolean {
    for (const plugin of this.plugins) {
      if (!plugin.filterUrl) continue;
      if (!plugin.filterUrl(url, parentUrl)) return false;
    }
    return true;
  }
}
