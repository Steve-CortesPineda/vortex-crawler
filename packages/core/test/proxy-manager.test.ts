import { describe, it, expect } from 'vitest';
import { ProxyManager } from '../src/antibot/proxy-manager.js';

describe('ProxyManager', () => {
  it('reports hasProxies correctly', () => {
    expect(new ProxyManager([]).hasProxies).toBe(false);
    expect(new ProxyManager(['p1']).hasProxies).toBe(true);
  });
  it('round-robin cycles through the pool', () => {
    const pm = new ProxyManager(['a', 'b', 'c'], 'round-robin');
    expect([pm.getProxy(), pm.getProxy(), pm.getProxy(), pm.getProxy()]).toEqual(['a', 'b', 'c', 'a']);
  });
  it('sticky returns the same proxy for a given domain', () => {
    const pm = new ProxyManager(['a', 'b'], 'sticky');
    const first = pm.getProxy('example.com');
    expect(pm.getProxy('example.com')).toBe(first);
  });
  it('add/remove mutate the pool', () => {
    const pm = new ProxyManager(['a'], 'round-robin');
    pm.addProxy('b');
    pm.removeProxy('a');
    expect(pm.getProxy()).toBe('b');
  });
  it('returns undefined when empty', () => {
    expect(new ProxyManager([]).getProxy()).toBeUndefined();
  });
});
