import { describe, it, expect } from 'vitest';
import { compileMatchers, matchEntity, pruneMentions, type TrackedMention } from '../src/tracker.js';

describe('entity matching', () => {
  it('matches by name and alias, case-insensitively', () => {
    const m = compileMatchers({ name: 'Anthropic', type: 'org', aliases: ['Claude'] });
    expect(matchEntity('Anthropic ships a model', m)).toBe(true);
    expect(matchEntity('the new claude is good', m)).toBe(true);
    expect(matchEntity('unrelated headline', m)).toBe(false);
  });
  it('uses word boundaries so short tickers do not match inside words', () => {
    const m = compileMatchers({ name: 'Bitcoin', type: 'ticker', aliases: ['BTC'] });
    expect(matchEntity('BTC rallies today', m)).toBe(true);
    expect(matchEntity('the abtch token', m)).toBe(false); // no false substring hit
  });
  it('handles aliases with special chars (e.g. GPT-5)', () => {
    const m = compileMatchers({ name: 'OpenAI', type: 'org', aliases: ['GPT-5'] });
    expect(matchEntity('benchmarks for GPT-5 leaked', m)).toBe(true);
  });
});

describe('pruneMentions', () => {
  const now = new Date('2026-06-18T00:00:00Z');
  const mk = (firstSeen: string): TrackedMention => ({ entity: 'X', title: 't', url: 'u', source: 's', firstSeen });

  it('drops mentions older than the window, keeps recent ones', () => {
    const kept = pruneMentions([
      mk('2026-06-17T00:00:00Z'),           // 1 day old → keep
      mk('2026-01-01T00:00:00Z'),           // ~168 days old → drop (default 90)
    ], now);
    expect(kept).toHaveLength(1);
    expect(kept[0].firstSeen).toBe('2026-06-17T00:00:00Z');
  });
  it('keeps entries with unparseable dates (fail-safe)', () => {
    expect(pruneMentions([mk('garbage')], now)).toHaveLength(1);
  });
});
