import { describe, it, expect } from 'vitest';
import { sourceQuality, queryDomain, extractResultDate, freshnessAdjust, isTemporalQuery } from '../src/source-rules.js';

const NOW = new Date('2026-07-09T12:00:00Z');

describe('queryDomain verticals', () => {
  it('routes technical queries', () => {
    expect(queryDomain('stripe webhook signing secret rotation')).toBe('technical');
    expect(queryDomain('TypeError cannot read properties of undefined react')).toBe('technical');
    expect(queryDomain('docker compose volume permissions')).toBe('technical');
    expect(queryDomain('RFC 6455 websocket close codes')).toBe('technical');
  });
  it('routes travel and commerce', () => {
    expect(queryDomain('korea visa requirements for us citizens')).toBe('travel');
    expect(queryDomain('cheapest place to buy m4 mac mini')).toBe('commerce');
  });
  it('routes ai / markets / youtube', () => {
    expect(queryDomain('anthropic claude latest model')).toBe('ai');
    expect(queryDomain('fomc rate decision')).toBe('markets');
    expect(queryDomain('mrbeast latest video')).toBe('youtube');
  });
});

describe('docs-first technical ranking', () => {
  it('official docs beat wire/editorial and tutorial farms', () => {
    const q = 'react useEffect cleanup function docs';
    const mdn = sourceQuality('https://developer.mozilla.org/en-US/docs/Web/API', q);
    const react = sourceQuality('https://react.dev/reference/react/useEffect', q);
    const so = sourceQuality('https://stackoverflow.com/questions/1/useeffect-cleanup', q);
    const farm = sourceQuality('https://www.w3schools.com/react/react_useeffect.asp', q);
    const news = sourceQuality('https://www.cnbc.com/2026/01/01/react-story.html', q);
    expect(mdn).toBeGreaterThan(0.8);
    expect(react).toBeGreaterThan(0.8);
    expect(so).toBeGreaterThan(news);
    expect(farm).toBeLessThan(0);
  });
  it('dev.to does NOT get the docs-subdomain boost', () => {
    expect(sourceQuality('https://dev.to/someone/react-useeffect-guide', 'react useEffect docs')).toBeLessThan(0.5);
  });
  it('RFCs and standards bodies rank as official docs', () => {
    expect(sourceQuality('https://datatracker.ietf.org/doc/html/rfc6455', 'RFC 6455 websocket close codes')).toBeGreaterThan(0.8);
  });
});

describe('expanded trust lists', () => {
  it('penalizes new syndication + content farms', () => {
    expect(sourceQuality('https://www.newsbreak.com/news/123', 'nvidia latest news')).toBeLessThan(-0.4);
    expect(sourceQuality('https://headtopics.com/us/some-article', 'nvidia latest news')).toBeLessThan(-0.4);
    expect(sourceQuality('https://www.gobankingrates.com/money/article', 'best savings strategy')).toBeLessThan(-0.4);
    expect(sourceQuality('https://www.dailymail.co.uk/news/article-1.html', 'uk politics latest')).toBeLessThan(-0.4);
  });
  it('boosts investor-relations pages for markets queries', () => {
    expect(sourceQuality('https://investor.nvidia.com/news/press-release', 'nvda earnings guidance')).toBeGreaterThanOrEqual(0.8);
  });
  it('youtube.com content is source of record for youtube queries', () => {
    expect(sourceQuality('https://www.youtube.com/watch?v=abc', 'mrbeast latest video')).toBeGreaterThanOrEqual(0.8);
  });
  it('gov travel pages boosted for travel queries', () => {
    expect(sourceQuality('https://travel.state.gov/content/travel/en/news/visa-update.html', 'korea visa requirements latest'))
      .toBeGreaterThanOrEqual(0.8);
  });
});

describe('extractResultDate', () => {
  it('parses relative ages from snippets', () => {
    expect(extractResultDate('2 days ago · Something happened', 'https://x.com/a', NOW)).toBe('2026-07-07');
    expect(extractResultDate('21 hours ago · News', 'https://x.com/a', NOW)).toBe('2026-07-08');
    expect(extractResultDate('3 weeks ago · Post', 'https://x.com/a', NOW)).toBe('2026-06-18');
  });
  it('parses absolute dates from snippets', () => {
    expect(extractResultDate('Jun 5, 2026 · Report says…', 'https://x.com/a', NOW)).toBe('2026-06-05');
    expect(extractResultDate('5 June 2026 — Report', 'https://x.com/a', NOW)).toBe('2026-06-05');
    expect(extractResultDate('Published 2026-07-01 about things', 'https://x.com/a', NOW)).toBe('2026-07-01');
  });
  it('falls back to date-shaped URL paths', () => {
    expect(extractResultDate('', 'https://www.cnbc.com/2026/02/24/stripe-story.html', NOW)).toBe('2026-02-24');
    expect(extractResultDate('', 'https://blog.example.com/2025/11/', NOW)).toBe('2025-11-01');
  });
  it('returns null when nothing date-shaped exists', () => {
    expect(extractResultDate('An evergreen guide to DNS', 'https://example.com/guide/dns', NOW)).toBeNull();
  });
});

describe('freshnessAdjust', () => {
  const q = 'nvidia latest ai chip news';
  it('boosts fresh, penalizes stale on temporal queries', () => {
    expect(freshnessAdjust(q, '2026-07-07', NOW)).toBeGreaterThan(0);
    expect(freshnessAdjust(q, '2026-05-01', NOW)).toBe(0);
    expect(freshnessAdjust(q, '2025-09-01', NOW)).toBeLessThan(0);
    expect(freshnessAdjust(q, '2023-01-01', NOW)).toBeLessThanOrEqual(-0.02);
  });
  it('hard-penalizes wrong-year results when a year is asked explicitly', () => {
    expect(freshnessAdjust('gpt release july 2026', '2024-03-14', NOW)).toBeLessThanOrEqual(-0.03);
  });
  it('is neutral for non-temporal queries and undated results', () => {
    expect(freshnessAdjust('how to boil eggs', '2019-01-01', NOW)).toBe(0);
    expect(freshnessAdjust(q, null, NOW)).toBe(0);
  });
  it('isTemporalQuery detects release/proposal/delay framing', () => {
    expect(isTemporalQuery('nvidia chip delay')).toBe(true);
    expect(isTemporalQuery('fed aml proposal')).toBe(true);
    expect(isTemporalQuery('how to boil eggs')).toBe(false);
  });
});
