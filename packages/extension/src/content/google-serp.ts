/**
 * In-page Google SERP parser — bundled into google-serp.js, injected via executeScript.
 * Defines globalThis.__vantaGoogleSerp(mode) → clean { title, url, snippet }[] organic results.
 *
 * Why a dedicated parser: scraping raw anchor textContent concatenates the favicon + source-name badge
 * with the title ("LIVENine.com.au…World Cup live updates"). The title lives cleanly in the <h3>; the
 * URL in the h3's ancestor <a>; the snippet in Google's description container. We read those directly.
 *
 * mode 'web'  → standard organic results (div.g / h3-in-anchor).
 * mode 'news' → the News tab (tbm=nws) layout.
 */

interface SerpResult { title: string; url: string; snippet: string; }

// Google infra / non-organic hosts + utility paths to exclude.
const INFRA_RE = /(^|\.)(google|gstatic|googleusercontent|googleadservices|schema\.org|w3\.org)\.|\/(search|preferences|advanced_search|intl|url|imgres)\b|accounts\.google|support\.google|policies\.google|maps\.google/i;

/** Snippet text for a result container — tries Google's known description classes, else the container text. */
function snippetFor(container: Element | null, title: string): string {
  if (!container) return '';
  const cand = container.querySelector('.VwiC3b, div[data-sncf], .lyLwlc, .lEBKkf, div[style*="line-clamp"]');
  let s = (cand?.textContent || '').trim();
  if (!s) {
    // Fallback: container text minus the title line.
    s = (container.textContent || '').replace(title, '').replace(/\s+/g, ' ').trim();
  }
  return s.slice(0, 300);
}

function parseWeb(max: number): SerpResult[] {
  const out: SerpResult[] = [];
  const seen = new Set<string>();
  const push = (title: string, url: string, snippet: string) => {
    if (out.length >= max) return;
    title = title.trim();
    if (!url || !url.startsWith('http') || INFRA_RE.test(url)) return;
    if (title.length < 3) return;
    const key = url.replace(/[?#].*$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ title, url, snippet });
  };

  // Primary: every organic result has an <h3> whose ancestor <a> holds the URL.
  document.querySelectorAll('h3').forEach((h3) => {
    const a = h3.closest('a') as HTMLAnchorElement | null;
    if (!a?.href) return;
    const container = h3.closest('div.g, div[data-hveid], div[jscontroller], div[data-ved]');
    push(h3.textContent || '', a.href, snippetFor(container, h3.textContent || ''));
  });

  // Fallback for layouts where the title isn't an <h3> (rare): result blocks with a heading link.
  if (out.length === 0) {
    document.querySelectorAll('div.g a[href^="http"], [data-hveid] a[href^="http"]').forEach((el) => {
      const a = el as HTMLAnchorElement;
      const heading = a.querySelector('h3, [role="heading"]');
      push((heading?.textContent || a.textContent || '').trim(), a.href, '');
    });
  }
  return out;
}

function parseNews(max: number): SerpResult[] {
  const out: SerpResult[] = [];
  const seen = new Set<string>();
  // News tab: each article is an <a> wrapping a title div + source/snippet. Titles use role="heading"
  // or a bold div; the <a> href is the article URL.
  document.querySelectorAll('a[href^="http"]').forEach((el) => {
    if (out.length >= max) return;
    const a = el as HTMLAnchorElement;
    if (INFRA_RE.test(a.href)) return;
    const heading = a.querySelector('[role="heading"], div[aria-level], .n0jPhd, .mCBkyc');
    const title = (heading?.textContent || '').trim();
    if (title.length < 12) return; // news titles are substantial; skip nav/util links
    const key = a.href.replace(/[?#].*$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    const snip = (a.querySelector('.GI74Re, .Y3v8qd')?.textContent || '').trim().slice(0, 300);
    out.push({ title, url: a.href, snippet: snip });
  });
  return out.length ? out : parseWeb(max); // fall back to web parse if the news DOM shifted
}

// Single-arg (object) signature to match the service worker's injectAndCall, which passes one argument.
function serp(opts?: { mode?: 'web' | 'news'; max?: number }): SerpResult[] {
  const mode = opts?.mode ?? 'web';
  const max = opts?.max ?? 12;
  try { return mode === 'news' ? parseNews(max) : parseWeb(max); }
  catch { return []; }
}

(globalThis as any).__vantaGoogleSerp = serp;
