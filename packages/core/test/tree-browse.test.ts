import { describe, it, expect } from 'vitest';
import { treeBrowse, type TreeFetcher, type TreeFetchResult } from '../src/tree-browse.js';

/** A deterministic mock fetcher: returns canned pages keyed by URL, each with prose + links. */
function mockFetcher(pages: Record<string, { title: string; body: string; links?: string[] }>): TreeFetcher {
  return {
    async parallelExtract(urls: string[]): Promise<TreeFetchResult[]> {
      return urls.map((url) => {
        const p = pages[url];
        if (!p) return { url, title: '', markdown: '', links: [] };
        return {
          url, title: p.title, markdown: p.body,
          links: (p.links || []).map((href) => ({ href, text: p.title })),
        };
      });
    },
  };
}

const LONG = (topic: string) => `${topic} `.repeat(80); // >200 chars of prose

describe('treeBrowse — parallel relevance-gated tree', () => {
  it('expands strongly-relevant nodes and prunes off-topic ones', async () => {
    const pages = {
      'https://a.com/riscv': { title: 'RISC-V vs ARM architecture comparison', body: LONG('riscv arm architecture comparison datacenter'), links: ['https://b.com/deep-riscv', 'https://c.com/unrelated-cooking'] },
      'https://b.com/deep-riscv': { title: 'RISC-V deep dive', body: LONG('riscv architecture instruction set datacenter'), links: [] },
      'https://c.com/unrelated-cooking': { title: 'Best pasta recipes', body: LONG('pasta tomato basil recipe kitchen'), links: [] },
    };
    const res = await treeBrowse(mockFetcher(pages), 'RISC-V ARM architecture datacenter', {
      seeds: ['https://a.com/riscv'], maxPages: 10, maxDepth: 2, expandThreshold: 0.25, minRelevance: 0.12,
    });
    const byUrl = Object.fromEntries(res.nodes.map((n) => [n.url, n]));
    // Root is highly relevant → expanded.
    expect(byUrl['https://a.com/riscv'].expanded).toBe(true);
    // The on-topic child was visited at depth 1.
    expect(byUrl['https://b.com/deep-riscv']?.depth).toBe(1);
    // The cooking page is off-topic → pruned, never a node.
    expect(byUrl['https://c.com/unrelated-cooking']).toBeUndefined();
    expect(res.pruned.some((p) => p.includes('cooking') && p.includes('off-topic'))).toBe(true);
  });

  it('does not expand a relevant-but-weak node below the expand threshold', async () => {
    // Body shares ONE of four query terms → relevance is above minRelevance but well below 0.9.
    const pages = {
      'https://a.com/mild': { title: 'A page mentioning instruction once', body: 'instruction ' + 'filler word content page '.repeat(60), links: ['https://b.com/more'] },
      'https://b.com/more': { title: 'more', body: LONG('more filler'), links: [] },
    };
    const res = await treeBrowse(mockFetcher(pages), 'riscv arm instruction microarchitecture', {
      seeds: ['https://a.com/mild'], maxPages: 10, maxDepth: 2, minRelevance: 0.02, expandThreshold: 0.9,
    });
    const root = res.nodes.find((n) => n.url === 'https://a.com/mild')!;
    expect(root).toBeDefined();
    expect(root.expanded).toBe(false);
    expect(root.reason).toMatch(/not deep enough|no strong outbound/);
    // Since the root did not expand, its child was never visited.
    expect(res.nodes.some((n) => n.url === 'https://b.com/more')).toBe(false);
  });

  it('respects maxDepth (deepest nodes are leaves)', async () => {
    const pages = {
      'https://s.com/x': { title: 'seed topic alpha', body: LONG('topic alpha beta'), links: ['https://d1.com/x'] },
      'https://d1.com/x': { title: 'level one topic alpha', body: LONG('topic alpha beta'), links: ['https://d2.com/x'] },
      'https://d2.com/x': { title: 'level two topic alpha', body: LONG('topic alpha beta'), links: ['https://d3.com/x'] },
    };
    const res = await treeBrowse(mockFetcher(pages), 'topic alpha beta', {
      seeds: ['https://s.com/x'], maxPages: 10, maxDepth: 1, expandThreshold: 0.1, minRelevance: 0.01,
    });
    expect(res.maxDepthReached).toBe(1);
    const d1 = res.nodes.find((n) => n.url === 'https://d1.com/x');
    expect(d1?.expanded).toBe(false);          // at maxDepth → not expanded
    expect(res.nodes.some((n) => n.url === 'https://d2.com/x')).toBe(false); // never reached
  });
});
