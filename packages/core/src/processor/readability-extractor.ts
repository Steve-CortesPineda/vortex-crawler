import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

/**
 * Article extraction via Mozilla Readability (the Firefox Reader View algorithm) run server-side
 * over already-rendered HTML. This is the primary extractor: it isolates real article prose on
 * aggressively-themed sites where class-based cleaning fails. Never throws — returns { ok: false }
 * so callers fall back to ContentCleaner.
 */

export interface ReadableResult {
  ok: boolean;
  title?: string;
  byline?: string;
  contentHtml?: string;   // sanitized article HTML (Readability "content")
  textContent?: string;   // plain text of the article
  excerpt?: string;
  publishedTime?: string; // Readability surfaces this from some sites
  siteName?: string;
  lang?: string;
}

// Skip Readability on multi-MB DOMs — jsdom parsing is the expensive step; huge pages aren't articles.
const MAX_HTML_BYTES = 5_000_000;

export class ReadabilityExtractor {
  extract(html: string, url: string): ReadableResult {
    if (!html || html.length > MAX_HTML_BYTES) return { ok: false };
    let dom: JSDOM | undefined;
    try {
      // runScripts/resources default off → no script execution, no network. Safe on hostile pages.
      dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();
      if (!article || !article.content) return { ok: false };
      return {
        ok: true,
        title: article.title || undefined,
        byline: article.byline || undefined,
        contentHtml: article.content,
        textContent: article.textContent || undefined,
        excerpt: article.excerpt || undefined,
        publishedTime: (article as { publishedTime?: string }).publishedTime || undefined,
        siteName: article.siteName || undefined,
        lang: article.lang || undefined,
      };
    } catch {
      return { ok: false };
    } finally {
      try { dom?.window.close(); } catch { /* ignore */ }
    }
  }
}
