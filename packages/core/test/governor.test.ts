import { describe, it, expect } from 'vitest';
import { DomainGovernor } from '../src/pipeline/rate-limiter.js';

describe('DomainGovernor', () => {
  it('spaces consecutive hits to the same domain by ~the min interval', async () => {
    const g = new DomainGovernor({ requestsPerSecond: 20, jitterRatio: 0 }); // 50ms interval, no jitter
    const t0 = Date.now();
    await g.throttle('https://a.com/1');
    await g.throttle('https://a.com/2');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(45); // second call waited out the interval
  });

  it('does NOT cross-throttle different domains', async () => {
    const g = new DomainGovernor({ requestsPerSecond: 5, jitterRatio: 0 }); // 200ms interval
    const t0 = Date.now();
    await g.throttle('https://a.com/');
    await g.throttle('https://b.com/'); // different host — should not wait on a.com's interval
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it('opens an adaptive cooldown after a 429 and clears it after a clean response', async () => {
    const g = new DomainGovernor({ requestsPerSecond: 1000, backoffBaseMs: 300, maxBackoffMs: 5000 });
    g.noteResponse('https://c.com/x', 429);
    expect(g.cooldownRemaining('https://c.com/x')).toBeGreaterThan(0);
    g.noteResponse('https://c.com/x', 200); // one strike decays to zero → cooldown cleared
    expect(g.cooldownRemaining('https://c.com/x')).toBe(0);
  });

  it('honors Retry-After (delta-seconds) as the cooldown', () => {
    const g = new DomainGovernor({ requestsPerSecond: 1000, maxBackoffMs: 60_000 });
    g.noteResponse('https://d.com/', 503, { 'retry-after': '2' });
    const rem = g.cooldownRemaining('https://d.com/');
    expect(rem).toBeGreaterThan(1500);
    expect(rem).toBeLessThanOrEqual(2000);
  });

  it('escalates cooldown on consecutive strikes', () => {
    const g = new DomainGovernor({ requestsPerSecond: 1000, backoffBaseMs: 500, maxBackoffMs: 60_000 });
    g.noteResponse('https://e.com/', 429);
    const first = g.cooldownRemaining('https://e.com/');
    g.noteResponse('https://e.com/', 429);
    const second = g.cooldownRemaining('https://e.com/');
    expect(second).toBeGreaterThan(first); // 2nd strike backs off harder
  });
});
