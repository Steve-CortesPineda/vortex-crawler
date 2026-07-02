import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeUrl, decodeBingUrl, search, resetEngineCooldowns } from '../src/search.js';

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
