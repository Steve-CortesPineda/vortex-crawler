import * as cheerio from 'cheerio';
import type { PageMetadata } from '../types/result.js';

export class MetadataExtractor {
  extract(html: string, url: string): PageMetadata {
    const $ = cheerio.load(html);

    const getMeta = (name: string): string => {
      return (
        $(`meta[name="${name}"]`).attr('content') ||
        $(`meta[property="${name}"]`).attr('content') ||
        $(`meta[property="og:${name}"]`).attr('content') ||
        ''
      );
    };

    // Extract JSON-LD structured data
    const structuredData: object[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html() || '');
        structuredData.push(data);
      } catch {
        // Skip invalid JSON-LD
      }
    });

    return {
      title: $('title').first().text().trim() || getMeta('title') || '',
      description: getMeta('description'),
      language: $('html').attr('lang') || getMeta('language') || '',
      author: getMeta('author'),
      publishedAt: getMeta('article:published_time') || getMeta('datePublished'),
      ogImage: getMeta('image') || $('meta[property="og:image"]').attr('content') || undefined,
      canonical: $('link[rel="canonical"]').attr('href') || url,
      robots: getMeta('robots') || undefined,
      structuredData: structuredData.length > 0 ? structuredData : undefined,
    };
  }
}
