import * as cheerio from 'cheerio';

// Elements to always remove
const REMOVE_TAGS = [
  'script', 'style', 'noscript', 'iframe', 'svg',
  'link[rel="stylesheet"]', 'meta',
];

// Selectors for noise elements
const NOISE_SELECTORS = [
  '[class*="cookie"]', '[class*="banner"]', '[class*="popup"]',
  '[class*="modal"]', '[class*="overlay"]', '[class*="newsletter"]',
  '[class*="subscribe"]', '[class*="social"]', '[class*="share"]',
  '[class*="sidebar"]', '[class*="widget"]', '[class*="advertisement"]',
  '[class*="ad-"]', '[class*="tracking"]', '[class*="analytics"]',
  '[id*="cookie"]', '[id*="banner"]', '[id*="popup"]',
  '[id*="modal"]', '[id*="overlay"]', '[id*="newsletter"]',
  '[id*="sidebar"]', '[id*="advertisement"]',
  '[aria-hidden="true"]', '[hidden]',
  'nav', 'footer', 'header',
  '[role="banner"]', '[role="navigation"]', '[role="complementary"]',
  '[role="contentinfo"]',
];

export class ContentCleaner {
  private removeNav: boolean;
  private removeFooter: boolean;

  constructor(options?: { removeNav?: boolean; removeFooter?: boolean }) {
    this.removeNav = options?.removeNav ?? true;
    this.removeFooter = options?.removeFooter ?? true;
  }

  clean(html: string, _url?: string): string {
    const $ = cheerio.load(html);

    // Remove script/style/etc
    for (const tag of REMOVE_TAGS) {
      $(tag).remove();
    }

    // Remove noise elements
    for (const selector of NOISE_SELECTORS) {
      // Skip nav/footer removal if configured to keep them
      if (!this.removeNav && (selector === 'nav' || selector === '[role="navigation"]')) continue;
      if (!this.removeFooter && (selector === 'footer' || selector === '[role="contentinfo"]')) continue;

      $(selector).each((_, el) => {
        const $el = $(el);
        // Don't remove if it's a main content container
        const tag = el.type === 'tag' ? el.tagName : '';
        if (tag === 'main' || tag === 'article') return;
        $el.remove();
      });
    }

    // Remove empty elements (except structural ones)
    $('div, span, p').each((_, el) => {
      const $el = $(el);
      if ($el.text().trim() === '' && $el.children().length === 0) {
        $el.remove();
      }
    });

    // Get the main content area, or fall back to body
    const main = $('main, article, [role="main"]').first();
    if (main.length && main.text().trim().length > 100) {
      return main.html() ?? $.html();
    }

    return $('body').html() ?? $.html();
  }
}
