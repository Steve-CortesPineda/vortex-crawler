import { sharedGovernor } from '../pipeline/rate-limiter.js';
import type { BridgeServer } from './ws-server.js';
import type { TabLeaseResult } from './protocol.js';

/**
 * TabPool — the parallelism engine. Two lanes so a long batch job never blocks interactive work:
 *
 *   - interactive: ONE sticky tab, callers serialize on it (preserves goto→click→extract semantics).
 *   - batch:       up to `size` background tabs, leased/released around each unit of parallel work.
 *
 * Every lease first awaits the shared per-domain governor, so N parallel tabs across the SAME host stay
 * polite while different hosts run fully concurrent. A per-domain in-flight cap prevents one site from
 * eating the whole pool. Leased tabs are recycled after `recycleAfter` navigations for memory hygiene.
 */

export interface TabPoolOptions {
  size?: number;              // batch-lane tabs. Default 8, hard cap 12.
  perDomainInflight?: number; // max concurrent leases per host. Default 2.
  recycleAfter?: number;      // destroy+recreate a tab after this many navigations. Default 50.
}

interface Slot { tabId: number; navs: number; }

/** Errors that mean the Chrome tab behind a cached tabId no longer exists (closed by the user, Chrome
 * restarted, MV3 SW lost it). Recoverable by evicting the slot and leasing a fresh tab. */
const STALE_TAB_RE = /no tab with id|tab.*not.*found|tab was (closed|discarded|removed)|invalid tab/i;
export function isStaleTabError(e: unknown): boolean {
  return STALE_TAB_RE.test((e as Error)?.message || '');
}

export class TabPool {
  private bridge: BridgeServer;
  private size: number;
  private perDomain: number;
  private recycleAfter: number;

  private idle: Slot[] = [];
  private live = new Set<number>();       // all batch tabIds we currently own
  private interactiveTab: number | null = null;
  private interactiveChain: Promise<unknown> = Promise.resolve();
  // {resolve, reject} so drain() can unblock parked acquirers instead of hanging them forever.
  private waiters: { resolve: (s: Slot) => void; reject: (e: Error) => void }[] = [];
  private domainInflight = new Map<string, number>();

  constructor(bridge: BridgeServer, opts: TabPoolOptions = {}) {
    this.bridge = bridge;
    this.size = Math.min(opts.size ?? 8, 12);
    this.perDomain = opts.perDomainInflight ?? 2;
    this.recycleAfter = opts.recycleAfter ?? 50;
  }

  private host(url: string): string { try { return new URL(url).hostname; } catch { return url; } }

  /** Run fn on the sticky interactive tab, serialized against all other interactive callers.
   * Always re-leases via the SW (which returns the existing tab or recreates it if the MV3 worker was
   * suspended and lost the old one) — so a stale daemon-cached tab id can't wedge the interactive lane.
   * If an op still hits a "no tab" race, invalidate and retry once with a fresh tab. */
  runInteractive<T>(fn: (tabId: number) => Promise<T>): Promise<T> {
    const run = this.interactiveChain.then(async () => {
      const lease = async () => {
        const { tabId } = await this.bridge.call<TabLeaseResult>('tab.lease', { interactive: true });
        this.interactiveTab = tabId;
        return tabId;
      };
      let tabId = await lease();
      try {
        return await fn(tabId);
      } catch (e) {
        if (isStaleTabError(e)) {
          this.interactiveTab = null;
          tabId = await lease();
          return await fn(tabId);
        }
        throw e;
      }
    });
    // keep the chain from breaking on rejection
    this.interactiveChain = run.then(() => {}, () => {});
    return run;
  }

  /** Acquire a batch tab for `url` (waits on governor + per-domain cap + pool availability). */
  private async acquire(url: string): Promise<Slot> {
    await sharedGovernor.throttle(url);
    const h = this.host(url);
    // wait until the domain has an in-flight slot free
    while ((this.domainInflight.get(h) || 0) >= this.perDomain) {
      await new Promise((r) => setTimeout(r, 25));
    }
    this.domainInflight.set(h, (this.domainInflight.get(h) || 0) + 1);

    // grab an idle slot, or grow the pool, or wait for a release. If ANY of these fails (e.g. the bridge
    // disconnects mid-lease), decrement the per-domain counter we just bumped — otherwise that host is
    // permanently locked out of the pool and the L79 busy-wait never clears.
    try {
      let slot: Slot;
      if (this.idle.length) {
        slot = this.idle.pop()!;
      } else if (this.live.size < this.size) {
        const { tabId } = await this.bridge.call<TabLeaseResult>('tab.lease', {});
        this.live.add(tabId);
        slot = { tabId, navs: 0 };
      } else {
        slot = await new Promise<Slot>((resolve, reject) => this.waiters.push({ resolve, reject }));
      }
      return slot;
    } catch (e) {
      this.domainInflight.set(h, Math.max(0, (this.domainInflight.get(h) || 0) - 1));
      throw e;
    }
  }

  private async release(slot: Slot, url: string): Promise<void> {
    const h = this.host(url);
    this.domainInflight.set(h, Math.max(0, (this.domainInflight.get(h) || 0) - 1));

    // recycle a tired tab
    if (slot.navs >= this.recycleAfter) {
      this.live.delete(slot.tabId);
      try { await this.bridge.call('tab.release', { tabId: slot.tabId }); } catch { /* */ }
      // top the pool back up lazily on next acquire; don't block release on a new lease
      const w = this.waiters.shift();
      if (w) { // someone's waiting — hand them a fresh tab
        try {
          const { tabId } = await this.bridge.call<TabLeaseResult>('tab.lease', {});
          this.live.add(tabId);
          w.resolve({ tabId, navs: 0 });
        } catch (e) { w.reject(e as Error); } // don't leave the waiter hanging on a failed re-lease
      }
      return;
    }
    const w = this.waiters.shift();
    if (w) w.resolve(slot);
    else this.idle.push(slot);
  }

  /** Lease → run fn(tabId) → release, all bookkeeping handled. fn should navigate `url`.
   * A stale cached tabId (Chrome restart, user-closed tab) is evicted and the op retried ONCE on a
   * fresh tab — same recovery the interactive lane has had; the batch lane needs it too, since idle
   * slots can outlive their tabs (this was the source of intermittent "No tab with id" engine errors). */
  async withTab<T>(url: string, fn: (tabId: number, slot: { markNav: () => void }) => Promise<T>): Promise<T> {
    let slot = await this.acquire(url);
    try {
      try {
        return await fn(slot.tabId, { markNav: () => { slot.navs++; } });
      } catch (e) {
        if (!isStaleTabError(e)) throw e;
        // Evict the dead tab (don't tab.release — it's already gone) and retry once on a fresh lease.
        this.live.delete(slot.tabId);
        const { tabId } = await this.bridge.call<TabLeaseResult>('tab.lease', {});
        this.live.add(tabId);
        slot = { tabId, navs: 0 };
        return await fn(slot.tabId, { markNav: () => { slot.navs++; } });
      }
    } finally {
      await this.release(slot, url);
    }
  }

  /** Forget all cached tab state WITHOUT calling tab.release (used when the bridge reconnects — the
   * old Chrome session's tabIds are meaningless in the new one). Parked waiters are rejected so they
   * re-acquire cleanly. Domain counters reset: in-flight ops will fail fast on the dead socket anyway. */
  reset(): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(new Error('tab pool reset (bridge reconnected)'));
    this.idle = [];
    this.live.clear();
    this.interactiveTab = null;
    this.domainInflight.clear();
  }

  /** Map fn over items with the pool as the concurrency limiter (order preserved). */
  async map<I, O>(items: I[], urlOf: (i: I) => string, fn: (i: I, tabId: number, markNav: () => void) => Promise<O>): Promise<O[]> {
    return Promise.all(items.map((it) =>
      this.withTab(urlOf(it), (tabId, s) => fn(it, tabId, s.markNav))
    ));
  }

  stats() {
    return { size: this.size, live: this.live.size, idle: this.idle.length, interactive: this.interactiveTab != null, waiters: this.waiters.length };
  }

  async drain(): Promise<void> {
    // Unblock anyone parked waiting for a tab — otherwise they hang forever after a drain.
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(new Error('tab pool draining'));
    const ids = [...this.live, ...(this.interactiveTab != null ? [this.interactiveTab] : [])];
    this.live.clear(); this.idle = []; this.interactiveTab = null; this.domainInflight.clear();
    await Promise.all(ids.map((tabId) => this.bridge.call('tab.release', { tabId }).catch(() => {})));
  }
}
