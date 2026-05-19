export class ProxyManager {
  private proxies: string[];
  private index = 0;
  private mode: 'round-robin' | 'random' | 'sticky';
  private stickyMap = new Map<string, string>();

  constructor(proxies: string[] = [], mode: 'round-robin' | 'random' | 'sticky' = 'round-robin') {
    this.proxies = proxies;
    this.mode = mode;
  }

  get hasProxies(): boolean {
    return this.proxies.length > 0;
  }

  getProxy(domain?: string): string | undefined {
    if (this.proxies.length === 0) return undefined;

    switch (this.mode) {
      case 'round-robin': {
        const proxy = this.proxies[this.index % this.proxies.length];
        this.index++;
        return proxy;
      }
      case 'random': {
        return this.proxies[Math.floor(Math.random() * this.proxies.length)];
      }
      case 'sticky': {
        if (domain && this.stickyMap.has(domain)) {
          return this.stickyMap.get(domain);
        }
        const proxy = this.proxies[this.index % this.proxies.length];
        this.index++;
        if (domain) this.stickyMap.set(domain, proxy);
        return proxy;
      }
    }
  }

  addProxy(proxy: string): void {
    this.proxies.push(proxy);
  }

  removeProxy(proxy: string): void {
    this.proxies = this.proxies.filter(p => p !== proxy);
  }
}
