/**
 * In-page extraction — bundled into extract.js and injected via chrome.scripting.executeScript.
 * Defines globalThis.__vantaExtract(settleMs) → the ExtractPayload the daemon expects.
 *
 * Runs against the LIVE DOM (real cookies, real render), so — unlike the Node side — it needs no jsdom:
 * Readability runs on a clone of `document`, Turndown converts the article HTML, links + metadata come
 * straight off the page. Markdown is produced IN the page so only ~5–20KB crosses the bridge, never raw HTML.
 */
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

interface Payload {
  url: string; title: string; markdown: string; approxTokens: number;
  captchaDetected: boolean; publishDate?: string;
  links: { href: string; text: string }[];
  extractedVia: 'readability' | 'cleaner';
}

const CAPTCHA_RE = /recaptcha|hcaptcha|cf-challenge|turnstile|are you a robot|verify you are human/i;

function makeTurndown(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', hr: '---', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**', linkStyle: 'inlined' });
  td.addRule('emptyLinks', { filter: (n: any) => n.nodeName === 'A' && !n.textContent?.trim(), replacement: () => '' });
  td.addRule('images', {
    filter: 'img',
    replacement: (_c: string, node: any) => {
      const alt = node.getAttribute?.('alt') || ''; const src = node.getAttribute?.('src') || '';
      const w = parseInt(node.getAttribute?.('width') || '100', 10); const h = parseInt(node.getAttribute?.('height') || '100', 10);
      if (w <= 1 || h <= 1 || !src || src.startsWith('data:image/gif')) return '';
      return alt ? `![${alt}](${src})` : '';
    },
  });
  return td;
}

/** Resolve when the DOM stops mutating for 300ms, or `cap` ms elapse. Event-driven settle. */
function settle(cap: number): Promise<void> {
  return new Promise((resolve) => {
    if (cap <= 0) return resolve();
    let timer: any;
    const done = () => { obs.disconnect(); clearTimeout(hard); resolve(); };
    const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 300); });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    timer = setTimeout(done, 300);
    const hard = setTimeout(done, cap);
  });
}

function metaContent(names: string[]): string | undefined {
  for (const n of names) {
    const el = document.querySelector(`meta[name="${n}"], meta[property="${n}"], meta[property="og:${n}"]`);
    const c = el?.getAttribute('content');
    if (c) return c;
  }
  return undefined;
}

function collectLinks(max = 200): { href: string; text: string }[] {
  const seen = new Set<string>();
  const out: { href: string; text: string }[] = [];
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = (a as HTMLAnchorElement).href;
    if (!href.startsWith('http') || seen.has(href)) return;
    seen.add(href);
    out.push({ href, text: (a.textContent || '').trim().slice(0, 120) });
  });
  return out.slice(0, max);
}

async function extract(settleMs = 1500): Promise<Payload> {
  await settle(settleMs);
  const url = location.href;
  const bodyText = document.body?.innerText || '';
  const captchaDetected = CAPTCHA_RE.test(document.documentElement.outerHTML.slice(0, 4000));

  let markdown = ''; let title = document.title || ''; let extractedVia: 'readability' | 'cleaner' = 'cleaner';
  try {
    // Readability mutates its document — hand it a clone so the live page is untouched.
    const clone = document.cloneNode(true) as Document;
    const article = new Readability(clone).parse();
    if (article?.content && (article.textContent?.length ?? 0) >= 200) {
      markdown = makeTurndown().turndown(article.content);
      title = article.title || title;
      extractedVia = 'readability';
    }
  } catch { /* fall back to cleaner path below */ }

  if (!markdown) {
    // Cleaner fallback: strip chrome, convert the main/body region.
    const main = document.querySelector('main, article, [role="main"]') || document.body;
    const clone = main.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, nav, header, footer, aside, form, noscript, svg').forEach((e) => e.remove());
    markdown = makeTurndown().turndown(clone.innerHTML);
  }

  markdown = markdown.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
  const publishDate = metaContent(['article:published_time', 'datePublished', 'article:modified_time']) ||
    (document.querySelector('time[datetime]')?.getAttribute('datetime') || undefined);

  return {
    url, title, markdown, approxTokens: Math.round(markdown.length / 4),
    captchaDetected, publishDate, links: collectLinks(), extractedVia,
  };
}

(globalThis as any).__vantaExtract = extract;
