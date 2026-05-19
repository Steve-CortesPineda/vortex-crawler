import * as cheerio from 'cheerio';
import type { VortexPlugin, CrawlResult } from '@vortex/core';

export { youtubeExtractor } from './youtube.js';
export { transcriptExtractor } from './transcript.js';

/**
 * CSS Selector extractor plugin.
 * Define a map of field names to CSS selectors, get structured data back.
 */
export function cssExtractor(selectors: Record<string, string>): VortexPlugin {
  return {
    name: 'css-extractor',
    extract(result: CrawlResult) {
      const $ = cheerio.load(result.html);
      const extracted: Record<string, string | string[]> = {};

      for (const [field, selector] of Object.entries(selectors)) {
        const elements = $(selector);
        if (elements.length === 0) {
          extracted[field] = '';
        } else if (elements.length === 1) {
          extracted[field] = elements.text().trim();
        } else {
          extracted[field] = elements.map((_, el) => $(el).text().trim()).get();
        }
      }

      return extracted;
    },
  };
}

/**
 * Schema extractor — extracts JSON-LD structured data from pages.
 */
export function schemaExtractor(): VortexPlugin {
  return {
    name: 'schema-extractor',
    extract(result: CrawlResult) {
      const $ = cheerio.load(result.html);
      const schemas: object[] = [];

      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          schemas.push(JSON.parse($(el).html() || ''));
        } catch {
          // Skip invalid JSON-LD
        }
      });

      if (schemas.length === 0) return null;
      return { structuredData: schemas };
    },
  };
}

/**
 * Meta extractor — pulls all meta tags into a flat object.
 */
export function metaExtractor(): VortexPlugin {
  return {
    name: 'meta-extractor',
    extract(result: CrawlResult) {
      const $ = cheerio.load(result.html);
      const meta: Record<string, string> = {};

      $('meta[name], meta[property]').each((_, el) => {
        const $el = $(el);
        const name = $el.attr('name') || $el.attr('property') || '';
        const content = $el.attr('content') || '';
        if (name && content) {
          meta[name] = content;
        }
      });

      return Object.keys(meta).length > 0 ? { meta } : null;
    },
  };
}

/**
 * Table extractor — finds HTML tables and converts to structured arrays.
 */
export function tableExtractor(): VortexPlugin {
  return {
    name: 'table-extractor',
    extract(result: CrawlResult) {
      const $ = cheerio.load(result.html);
      const tables: Array<{ headers: string[]; rows: string[][] }> = [];

      $('table').each((_, table) => {
        const headers: string[] = [];
        const rows: string[][] = [];

        $(table).find('th').each((_, th) => {
          headers.push($(th).text().trim());
        });

        $(table).find('tbody tr, tr').each((_, tr) => {
          const cells: string[] = [];
          $(tr).find('td').each((_, td) => {
            cells.push($(td).text().trim());
          });
          if (cells.length > 0) rows.push(cells);
        });

        if (headers.length > 0 || rows.length > 0) {
          tables.push({ headers, rows });
        }
      });

      return tables.length > 0 ? { tables } : null;
    },
  };
}
