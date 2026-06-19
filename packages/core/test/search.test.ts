import { describe, it, expect } from 'vitest';
import { normalizeUrl, decodeBingUrl } from '../src/search.js';

describe('normalizeUrl', () => {
  it('lowercases host, strips www, fragment, and trailing slash', () => {
    expect(normalizeUrl('https://WWW.Example.com/Path/#section')).toBe('https://example.com/Path');
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
