import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeUrl, decodeBingUrl, search, resetEngineCooldowns, sourceQuality } from '../src/search.js';

describe('normalizeUrl', () => {
  it('lowercases host, strips www, fragment, and trailing slash', () => {
    expect(normalizeUrl('https://WWW.Example.com/Path/#section')).toBe('https://example.com/Path');
  });
  it('strips m. and amp. host prefixes so mobile/amp dupes collapse', () => {
    expect(normalizeUrl('https://m.example.com/a')).toBe(normalizeUrl('https://amp.example.com/a'));
    expect(normalizeUrl('https://m.example.com/a')).toBe('https://example.com/a');
  });
  it('drops common tracking params but keeps real query params', () => {
    expect(normalizeUrl('https://x.com/a?utm_source=t&utm_medium=e&id=5&fbclid=z'))
      .toBe('https://x.com/a?id=5');
  });
  it('drops search/session tracker params that otherwise split duplicate news URLs', () => {
    expect(normalizeUrl('https://www.cnbc.com/2026/07/08/openai.html?msockid=abc&utm_source=x'))
      .toBe('https://cnbc.com/2026/07/08/openai.html');
    expect(normalizeUrl('https://example.com/a?msclkid=abc&id=5')).toBe('https://example.com/a?id=5');
  });
  it('collapses two URLs that differ only by tracking junk to the same key', () => {
    const a = normalizeUrl('https://x.com/post?utm_campaign=spring');
    const b = normalizeUrl('https://x.com/post/');
    expect(a).toBe(b);
  });
  it('returns input (minus trailing slash) when unparseable', () => {
    expect(normalizeUrl('::::/')).toBe('::::');
  });
});

describe('decodeBingUrl', () => {
  it('passes through non-bing redirect URLs unchanged', () => {
    expect(decodeBingUrl('https://realsite.com/article')).toBe('https://realsite.com/article');
  });
  it('decodes a bing /ck/a redirect to the real base64url target', () => {
    const target = 'https://example.com/real-article?x=1';
    const b64 = Buffer.from(target, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const href = `https://www.bing.com/ck/a?!&&p=abc&u=a1${b64}`;
    expect(decodeBingUrl(href)).toBe(target);
  });
  it('falls back to the original href when the payload is not decodable to http', () => {
    const href = 'https://www.bing.com/ck/a?u=a1bm90LWh0dHA';
    expect(decodeBingUrl(href)).toBe(href);
  });
});

describe('sourceQuality', () => {
  it('boosts primary sources for matching domains', () => {
    expect(sourceQuality('https://www.federalreserve.gov/newsevents/pressreleases/x.htm', 'Federal Reserve AML proposal')).toBeGreaterThan(0.9);
    expect(sourceQuality('https://www.anthropic.com/news/redeploying-fable-5', 'Anthropic Claude news')).toBeGreaterThan(0.9);
  });

  it('does not boost generic primary home/company pages for latest/news queries', () => {
    expect(sourceQuality('https://www.anthropic.com/company', 'Anthropic latest Claude news July 2026')).toBeLessThan(0);
    expect(sourceQuality('https://www.anthropic.com/', 'Anthropic latest Claude news July 2026')).toBeLessThan(0);
    expect(sourceQuality('https://www.anthropic.com/news/redeploying-fable-5', 'Anthropic latest Claude news July 2026')).toBeGreaterThan(0.9);
  });

  it('demotes syndication, low-trust, and social sources for general news', () => {
    expect(sourceQuality('https://www.msn.com/en-us/money/story', 'Nvidia latest news')).toBeLessThan(0);
    expect(sourceQuality('https://mrbeast.fandom.com/wiki/Newest_Video', 'MrBeast latest video')).toBeLessThan(0);
    expect(sourceQuality('https://www.instagram.com/p/example', 'Anthropic latest news')).toBeLessThan(-0.4);
    expect(sourceQuality('https://www.aol.com/articles/circuit-board-problem-just-delayed-211831000.html', 'Nvidia latest AI chip delay July 2026')).toBeLessThan(-0.4);
    expect(sourceQuality('https://www.roic.ai/news/nvidia-reaffirms-ai-chip-roadmap-rejects-delay-reports-07-06-2026', 'Nvidia latest AI chip delay July 2026')).toBeLessThan(-0.4);
    expect(sourceQuality('https://us.gate.com/news/detail/nvidia-denies-semianalysis-chip-delay-report-says-ai-roadmap-on-track-on-17799748', 'Nvidia latest AI chip delay July 2026')).toBeLessThan(-0.4);
  });

  it('demotes generic official/product paths for temporal AI news', () => {
    const q = 'Nvidia latest AI chip delay July 2026';
    expect(sourceQuality('http://www.nvidia.com/page/home.html', q)).toBeLessThan(0);
    expect(sourceQuality('https://www.nvidia.com/en-us/', q)).toBeLessThan(0);
    expect(sourceQuality('https://apps.microsoft.com/detail/9nf8h0h7wmlt', q)).toBeLessThan(0);
    expect(sourceQuality('https://www.nvidia.com/en-us/data-center/gb200-nvl72/', q)).toBeLessThan(0.5);
  });

  it('treats OpenAI /index announcement pages as primary release sources', () => {
    expect(sourceQuality('https://openai.com/index/previewing-gpt-5-6-sol/', 'OpenAI latest model release July 2026')).toBeGreaterThan(0.9);
  });

  it('boosts official technical docs and avoids news boosts for implementation queries', () => {
    expect(sourceQuality('https://docs.stripe.com/webhooks', 'Stripe webhook signing secret rotation best practice')).toBeGreaterThan(0.8);
    expect(sourceQuality('https://docs.digitalocean.com/products/networking/reserved-ips/', 'DigitalOcean reserved IP DNS Google Cloud DNS certbot nginx')).toBeGreaterThan(0.8);
    expect(sourceQuality('https://cloud.google.com/dns/docs', 'DigitalOcean reserved IP DNS Google Cloud DNS certbot nginx')).toBeGreaterThan(0.8);
    expect(sourceQuality('https://www.cnbc.com/2026/02/24/stripe-value-stock-sale-tender-offer.html', 'Stripe webhook signing secret rotation best practice')).toBeLessThan(0.1);
    expect(sourceQuality('https://dashboard.stripe.com/register', 'Stripe webhook signing secret rotation best practice')).toBeLessThan(0.1);
    expect(sourceQuality('https://support.stripe.com/', 'Stripe webhook signing secret rotation best practice')).toBeLessThan(0.1);
  });
});

describe('search() fusion, health, and fallback', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetEngineCooldowns(); });

  const resp = (status: number, html: string) => ({ status, text: async () => html });
  const STARTPAGE = `
    <div class="result"><h2>Alpha</h2><a class="result-link" href="https://example.com/alpha">l</a><p class="description">alpha widgets review</p></div>
    <div class="result"><h2>Beta</h2><a class="result-link" href="https://example.com/beta">l</a><p class="description">beta widgets review</p></div>
    <div class="result"><h2>Shared</h2><a class="result-link" href="https://other.com/shared">l</a><p class="description">shared widgets</p></div>`;
  const BING = `
    <li class="b_algo"><h2><a href="https://other.com/shared">Shared</a></h2><div class="b_caption"><p>shared widgets</p></div></li>
    <li class="b_algo"><h2><a href="https://third.com/gamma">Gamma</a></h2><div class="b_caption"><p>gamma widgets</p></div></li>`;

  function stub(opts: { startpage?: [number, string]; bing?: [number, string] } = {}) {
    vi.stubGlobal('fetch', async (url: any) => {
      const u = String(url);
      if (u.includes('startpage.com')) return resp(...(opts.startpage ?? [200, STARTPAGE]));
      if (u.includes('bing.com/search')) return resp(...(opts.bing ?? [200, BING]));
      if (u.includes('mojeek.com')) return resp(403, 'blocked'); // mojeek IP-blocked in this env
      return resp(200, '');
    });
  }

  it('reports per-engine health (ok / blocked) and fuses cross-engine agreement', async () => {
    stub();
    const r = await search('widgets', { maxResults: 10, noCache: true });
    const byEngine = Object.fromEntries(r.engineReports!.map((e) => [e.engine, e]));
    expect(byEngine.startpage.status).toBe('ok');
    expect(byEngine.bing.status).toBe('ok');
    expect(byEngine.mojeek.status).toBe('blocked');
    // The shared URL was returned by BOTH engines → it should carry both engine tags.
    const shared = r.results.find((x) => x.url.includes('other.com/shared'))!;
    expect(shared.engines!.sort()).toEqual(['bing', 'startpage']);
  });

  it('enforces the per-domain diversity cap (soft: binds while alternatives remain)', async () => {
    stub();
    // 3 distinct domains exist (example, other, third); asking for 3 lets the cap bind without top-up.
    const r = await search('widgets', { maxResults: 3, perDomain: 1, noCache: true });
    const exampleHits = r.results.filter((x) => x.url.includes('example.com'));
    expect(exampleHits.length).toBe(1); // example.com had 2 results, cap=1, and other domains fill the slot
  });

  it('escalates to the fallback when the fast tier is blocked/thin', async () => {
    stub({ startpage: [403, ''], bing: [403, ''] }); // every fetch engine dead → thin
    const fallback = vi.fn(async () => [{ title: 'G1', url: 'https://g.com/1' }, { title: 'G2', url: 'https://g.com/2' }]);
    const r = await search('widgets', { maxResults: 10, noCache: true, fallback });
    expect(fallback).toHaveBeenCalledOnce();
    expect(r.usedFallback).toBe(true);
    expect(r.results.some((x) => x.url.includes('g.com'))).toBe(true);
  });

  it('drops keyword-match junk (dictionary/gas) and flags lowConfidence when only bing answers', async () => {
    const junkBing = `
      <li class="b_algo"><h2><a href="https://www.merriam-webster.com/dictionary/cheap">CHEAP Definition</a></h2><div class="b_caption"><p>cheap meaning</p></div></li>
      <li class="b_algo"><h2><a href="https://www.gasbuddy.com/gasprices/mn">Cheap Gas Prices</a></h2><div class="b_caption"><p>cheap fuel</p></div></li>
      <li class="b_algo"><h2><a href="https://www.booking.com/incheon">Hotels near Incheon Airport</a></h2><div class="b_caption"><p>cheap hotels incheon airport</p></div></li>`;
    stub({ startpage: [403, ''], bing: [200, junkBing] }); // brave unstubbed→empty, mojeek 403 → bing only
    const r = await search('cheap hotels near incheon airport', { maxResults: 10, noCache: true });
    const urls = r.results.map((x) => x.url);
    expect(urls.some((u) => u.includes('merriam-webster'))).toBe(false); // dictionary junk dropped
    expect(urls.some((u) => u.includes('gasbuddy'))).toBe(false);        // gas junk dropped
    expect(urls.some((u) => u.includes('booking.com'))).toBe(true);      // real result kept
    expect(r.lowConfidence).toBe(true);                                  // only bing (weak) answered
  });

  it('KEEPS a dictionary result when the query is genuinely definitional', async () => {
    const bing = `<li class="b_algo"><h2><a href="https://www.merriam-webster.com/dictionary/ephemeral">ephemeral Definition</a></h2><div class="b_caption"><p>the meaning of ephemeral</p></div></li>`;
    stub({ startpage: [403, ''], bing: [200, bing] });
    const r = await search('ephemeral definition meaning', { maxResults: 5, noCache: true });
    expect(r.results.some((x) => x.url.includes('merriam-webster'))).toBe(true);
  });

  it('ranks official technical docs above Q&A when a fallback engine returns both', async () => {
    stub({ startpage: [403, ''], bing: [403, ''] });
    const fallback = vi.fn(async () => [
      { title: 'How to handle Stripe Webhook signing Secret Key rotation', url: 'https://stackoverflow.com/questions/77818995/how-to-handle-stripe-webhook-signing-secret-key-rotation-on-the-server-side' },
      { title: 'Receive Stripe events in your webhook endpoint', url: 'https://docs.stripe.com/webhooks' },
      { title: 'Implementing Secure Webhooks Signatures like Stripe', url: 'https://github.com/frain-dev/convoy/wiki/Implementing-Secure-Webhooks-Signatures-like-Stripe' },
    ]);
    const r = await search('Stripe webhook signing secret rotation best practice', { maxResults: 5, noCache: true, fallback });
    expect(r.results[0].url).toBe('https://docs.stripe.com/webhooks');
  });

  it('backfills trusted news sources when temporal AI results are all weak mirrors/homepages', async () => {
    stub({ startpage: [403, ''], bing: [403, ''] });
    const fallback = vi.fn(async (q: string) => {
      if (q.includes('site:nvidia.com')) return [
        { title: 'Nvidia Server Delay Report Sends Asian Tech Stocks Sliding', url: 'https://www.bloomberg.com/news/articles/2026-07-06/nvidia-ai-server-delay-report-sends-asian-pcb-stocks-sliding' },
        { title: 'Nvidia AI roadmap is on track', url: 'https://nvidianews.nvidia.com/news/nvidia-ai-roadmap-on-track' },
      ];
      return [
        { title: 'Nvidia Reaffirms AI Chip Roadmap, Rejects Delay Reports', url: 'https://www.roic.ai/news/nvidia-reaffirms-ai-chip-roadmap-rejects-delay-reports-07-06-2026' },
        { title: 'Nvidia Denies SemiAnalysis Chip Delay Report, Says AI Roadmap On Track', url: 'https://us.gate.com/news/detail/nvidia-denies-semianalysis-chip-delay-report-says-ai-roadmap-on-track-on-17799748' },
        { title: 'NVIDIA Control Panel', url: 'https://apps.microsoft.com/detail/9nf8h0h7wmlt' },
        { title: 'Nvidia - Official Site', url: 'http://www.nvidia.com/page/home.html' },
      ];
    });
    const r = await search('Nvidia latest AI chip delay July 2026', { maxResults: 5, noCache: true, fallback });
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(fallback.mock.calls[1][0]).toContain('site:nvidia.com');
    // Junk deferral holds the roic.ai/gate.com mirrors out of the top-N, so either trusted backfill
    // source (official newsroom or Bloomberg) may land #1 — both satisfy the backfill's purpose.
    expect(r.results[0].url).toMatch(/nvidianews\.nvidia\.com|bloomberg\.com/);
    expect(r.results.slice(0, 2).map((x) => x.url).join(' ')).toContain('bloomberg.com');
    expect(r.engineReports!.some((e) => /trusted-source backfill/.test(e.note || ''))).toBe(true);
  });

  it('does NOT escalate when the fast tier is healthy', async () => {
    stub();
    const fallback = vi.fn(async () => []);
    const r = await search('widgets', { maxResults: 10, noCache: true, fallback });
    expect(fallback).not.toHaveBeenCalled();
    expect(r.usedFallback).toBe(false);
  });

  it('circuit breaker: a bot-walled engine is skipped (cooldown) on the next search', async () => {
    stub(); // mojeek stub answers 403 → BlockedError → breaker trips
    await search('widgets', { maxResults: 5, noCache: true });
    const r2 = await search('widgets again', { maxResults: 5, noCache: true });
    const mojeek = r2.engineReports!.find((e) => e.engine === 'mojeek')!;
    expect(mojeek.status).toBe('blocked');
    expect(mojeek.note).toMatch(/cooldown/);
    expect(mojeek.ms).toBe(0); // never fetched
  });

  it('dedupes syndication copies: same long headline on msn + original outlet collapses to the original URL', async () => {
    const title = 'Nvidia smashes expectations with record data center revenue';
    const bing = `
      <li class="b_algo"><h2><a href="https://www.msn.com/en-us/money/x">${title}</a></h2><div class="b_caption"><p>widgets syndicated</p></div></li>
      <li class="b_algo"><h2><a href="https://www.cnbc.com/2026/07/01/nvidia">${title}</a></h2><div class="b_caption"><p>widgets original</p></div></li>`;
    stub({ bing: [200, bing], startpage: [200, ''] });
    const r = await search('widgets', { maxResults: 10, noCache: true });
    const hits = r.results.filter((x) => x.title === title);
    expect(hits.length).toBe(1);
    expect(hits[0].url).toContain('cnbc.com');
  });

  it('soft budget: a hanging engine does not hold up results from live engines', async () => {
    vi.stubGlobal('fetch', async (url: any) => {
      const u = String(url);
      if (u.includes('bing.com/search')) return resp(200, BING);
      if (u.includes('startpage.com')) return new Promise(() => {}); // hangs forever
      return resp(403, 'blocked');
    });
    const t0 = performance.now();
    const r = await search('widgets', { maxResults: 5, noCache: true });
    expect(performance.now() - t0).toBeLessThan(5000); // well under the 6s per-engine timeout
    expect(r.results.length).toBeGreaterThan(0);
    const sp = r.engineReports!.find((e) => e.engine === 'startpage')!;
    expect(sp.status).toBe('timeout');
  }, 10_000);
});
