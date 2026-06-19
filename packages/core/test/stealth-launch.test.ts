import { describe, it, expect } from 'vitest';
import { buildLaunchPlan, parseProxy } from '../src/antibot/stealth-launch.js';

describe('parseProxy', () => {
  it('returns undefined for empty input', () => {
    expect(parseProxy(undefined)).toBeUndefined();
  });
  it('splits server and decodes credentials', () => {
    expect(parseProxy('http://user:p%40ss@host:8080')).toEqual({
      server: 'http://host:8080',
      username: 'user',
      password: 'p@ss',
    });
  });
  it('handles a bare server with no creds', () => {
    expect(parseProxy('http://host:8080')).toEqual({ server: 'http://host:8080' });
  });
});

describe('buildLaunchPlan', () => {
  it('natural: no fingerprint, nulls the viewport, default chrome channel', () => {
    const plan = buildLaunchPlan({ reachProfile: 'natural', headless: true, engine: 'patchright' });
    expect(plan.injectFingerprint).toBe(false);
    expect(plan.launchOptions.viewport).toBeNull();
    expect(plan.launchOptions.channel).toBe('chrome');
    expect(plan.blockResources).toBe(false); // natural keeps everything
  });
  it('rotating: requests fingerprint injection and blocks resources by default', () => {
    const plan = buildLaunchPlan({ reachProfile: 'rotating', headless: true, engine: 'patchright' });
    expect(plan.injectFingerprint).toBe(true);
    expect(plan.blockResources).toBe(true);
    expect(plan.launchOptions.viewport).toBeUndefined(); // injector sets it
  });
  it('only attaches a proxy for non-natural profiles with a pool', () => {
    const pm: any = { hasProxies: true, getProxy: () => 'http://host:1' };
    expect(buildLaunchPlan({ reachProfile: 'natural', headless: true, engine: 'patchright', proxyManager: pm }).launchOptions.proxy).toBeUndefined();
    expect(buildLaunchPlan({ reachProfile: 'stealth', headless: true, engine: 'patchright', proxyManager: pm }).launchOptions.proxy).toEqual({ server: 'http://host:1' });
  });
});
