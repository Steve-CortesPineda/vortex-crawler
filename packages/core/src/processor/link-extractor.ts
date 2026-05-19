import * as cheerio from 'cheerio';
import type { DiscoveredLink } from '../types/result.js';

export class LinkExtractor {
  extract(html: string, baseUrl: string): DiscoveredLink[] {
    const $ = cheerio.load(html);
    const links: DiscoveredLink[] = [];
    const seen = new Set<string>();
    const base = new URL(baseUrl);

    $('a[href]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href) return;

      // Skip non-HTTP links
      if (href.startsWith('mailto:') || href.startsWith('tel:') ||
          href.startsWith('javascript:') || href.startsWith('#')) {
        return;
      }

      let resolved: URL;
      try {
        resolved = new URL(href, baseUrl);
      } catch {
        return;
      }

      // Normalize: strip hash, trailing slash
      resolved.hash = '';
      const normalized = resolved.href.replace(/\/+$/, '');

      if (seen.has(normalized)) return;
      seen.add(normalized);

      const isInternal = resolved.hostname === base.hostname;
      const text = $el.text().trim().slice(0, 200);
      const rel = $el.attr('rel') || undefined;

      links.push({
        url: normalized,
        text,
        rel,
        isInternal,
      });
    });

    return links;
  }
}
