import { describe, it, expect } from 'vitest';
import { tokenize, bm25ish, scoreLink, ageInDays, recencyScore, NAV_RE, AGG_RE } from '../src/browse-relevance.js';

describe('tokenize', () => {
  it('lowercases, drops stopwords and short tokens', () => {
    expect(tokenize('The QUICK brown fox')).toEqual(['quick', 'brown', 'fox']);
  });
  it('keeps version-like numbers intact', () => {
    expect(tokenize('Claude Opus 4.8 release')).toContain('4.8');
  });
  it('returns empty for stopword-only / short input', () => {
    expect(tokenize('the and for')).toEqual([]);
  });
});

describe('bm25ish', () => {
  it('is 0 when no query terms match', () => {
    expect(bm25ish(['quantum'], 'a story about cooking pasta')).toBe(0);
  });
  it('scores higher when more distinct query terms are covered', () => {
    const one = bm25ish(['claude', 'anthropic'], 'claude is here');
    const both = bm25ish(['claude', 'anthropic'], 'claude from anthropic is here');
    expect(both).toBeGreaterThan(one);
  });
  it('boosts title hits', () => {
    const body = bm25ish(['claude'], 'claude appears in body', '');
    const titled = bm25ish(['claude'], 'claude appears in body', 'claude');
    expect(titled).toBeGreaterThan(body);
  });
  it('saturates — repeats give diminishing returns, normalized near 1', () => {
    const score = bm25ish(['claude'], 'claude '.repeat(50));
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThanOrEqual(1.0001);
  });
});

describe('scoreLink', () => {
  it('rewards dated article-like URLs', () => {
    const article = scoreLink('https://site.com/2026/06/big-news-story', 'big news story', ['news', 'story']);
    const shallow = scoreLink('https://site.com/x', '', ['news', 'story']);
    expect(article).toBeGreaterThan(shallow);
  });
  it('penalizes nav and aggregator links', () => {
    expect(scoreLink('https://site.com/login', 'login', ['news'])).toBeLessThan(0);
    expect(scoreLink('https://twitter.com/someone', 'someone', ['news'])).toBeLessThan(0);
  });
  it('returns -100 for an unparseable href', () => {
    expect(scoreLink('not a url', 'x', ['news'])).toBe(-100);
  });
});

describe('ageInDays / recencyScore', () => {
  it('returns null for missing/invalid dates', () => {
    expect(ageInDays(undefined)).toBeNull();
    expect(ageInDays('not-a-date')).toBeNull();
  });
  it('recencyScore: fresh ≈ 1, unknown = 0.5, decays with age', () => {
    expect(recencyScore(0)).toBe(1);
    expect(recencyScore(null)).toBe(0.5);
    expect(recencyScore(30, 30)).toBeCloseTo(0.5, 5); // one half-life
    expect(recencyScore(120, 30)).toBeLessThan(recencyScore(30, 30));
  });
});

describe('regexes', () => {
  it('NAV_RE flags utility pages and bare homepages', () => {
    expect(NAV_RE.test('https://x.com/privacy')).toBe(true);
    expect(NAV_RE.test('https://x.com')).toBe(true);
    expect(NAV_RE.test('https://x.com/2026/06/real-article')).toBe(false);
  });
  it('AGG_RE flags social/aggregator hosts', () => {
    expect(AGG_RE.test('https://www.reddit.com/r/x')).toBe(true);
    expect(AGG_RE.test('https://independent-blog.com/post')).toBe(false);
  });
});
