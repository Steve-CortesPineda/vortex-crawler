/**
 * VANTA Bridge service worker.
 *
 * Connects OUT to the Vortex browser daemon (loopback WS) and serves reverse-RPC: the daemon sends
 * {id, op, args}, we execute in this real Chrome profile and reply {id, ok, result}. Ops: cookie-fetch,
 * tab lease/goto/extract/act/screenshot. Heartbeat + alarms keep the MV3 SW alive; auto-reconnect with
 * backoff survives suspension.
 *
 * Config (chrome.storage.local): wsUrl (default ws://127.0.0.1:4477/vanta-bridge), token (default '').
 * Install ONLY in the dedicated VANTA profile — it reports profile:'vanta' and the daemon refuses others.
 */

const PROTOCOL_VERSION = 1;
const DEFAULT_WS = 'ws://127.0.0.1:4477/vanta-bridge';

let sock: WebSocket | null = null;
let connecting = false;             // sync guard: prevents the connect() async-race that opened many sockets
let backoff = 500;
const MAX_BACKOFF = 8000;
let selfPing: ReturnType<typeof setInterval> | null = null;
const KEEPALIVE_ALARM = 'vanta-keepalive';
let interactiveTabId: number | null = null;
const poolTabs = new Set<number>();
const blockRules = new Map<number, number>(); // tabId → dNR session rule id
let ruleSeq = 9000;

// ── connection ───────────────────────────────────────────────────────────────
async function getConfig(): Promise<{ wsUrl: string; token: string }> {
  const c = await chrome.storage.local.get(['wsUrl', 'token']);
  return { wsUrl: c.wsUrl || DEFAULT_WS, token: c.token || '' };
}

async function connect(): Promise<void> {
  // Sync guards FIRST (before any await) so concurrent triggers — top-level, wake message, alarm, self-ping —
  // can't each race past an async check and open a pile of sockets (the old reconnect-storm bug).
  if (connecting) return;
  if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) return;
  connecting = true;

  const { wsUrl, token } = await getConfig();
  const url = token ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : wsUrl;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    connecting = false;
    return scheduleReconnect();
  }
  sock = ws;

  ws.onopen = async () => {
    connecting = false;
    backoff = 500;
    const tabs = await chrome.tabs.query({});
    send({ type: 'hello', version: PROTOCOL_VERSION, profile: 'vanta', tabs: tabs.map((t) => ({ id: t.id!, url: t.url || '' })) });
    // Keepalive: WS traffic every 15s resets the MV3 idle timer (Chrome ≥116 keeps the SW alive while a
    // socket is active). The daemon also pings; either direction suffices.
    if (selfPing) clearInterval(selfPing);
    selfPing = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* */ } }
      else { if (selfPing) { clearInterval(selfPing); selfPing = null; } connect(); }
    }, 15000);
  };
  ws.onmessage = (ev) => handleMessage(String(ev.data));
  // Only react if THIS socket is still the current one — an older socket the daemon replaced must not
  // null out the live `sock` or trigger a reconnect (that was the feedback loop).
  ws.onclose = () => {
    if (sock !== ws) return;
    sock = null; connecting = false;
    if (selfPing) { clearInterval(selfPing); selfPing = null; }
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* */ } };
}

function scheduleReconnect(): void {
  const delay = backoff;
  backoff = Math.min(MAX_BACKOFF, backoff * 2);
  setTimeout(connect, delay);
}

function send(obj: unknown): void {
  try { sock?.send(JSON.stringify(obj)); } catch { /* */ }
}

async function handleMessage(raw: string): Promise<void> {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'ping') { send({ type: 'pong' }); return; }
  if (msg.type === 'pong') return;
  if (typeof msg.id !== 'number' || typeof msg.op !== 'string') return;
  try {
    const result = await dispatch(msg.op, msg.args || {});
    send({ id: msg.id, ok: true, result });
  } catch (e: any) {
    send({ id: msg.id, ok: false, error: (e?.message || String(e)).slice(0, 300) });
  }
}

// ── op dispatch ──────────────────────────────────────────────────────────────
async function dispatch(op: string, args: any): Promise<unknown> {
  switch (op) {
    case 'http.fetch':     return httpFetch(args);
    case 'tab.lease':      return tabLease(args);
    case 'tab.release':    return tabRelease(args);
    case 'tab.goto':       return tabGoto(args);
    case 'tab.extract':    return tabExtract(args);
    case 'tab.serp':       return tabSerp(args);
    case 'tab.act':        return tabAct(args);
    case 'tab.screenshot': return tabScreenshot(args);
    default: throw new Error(`unknown op ${op}`);
  }
}

const MAX_BODY = 3_000_000;

async function httpFetch(args: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 20000);
  try {
    const res = await fetch(args.url, {
      method: args.method || 'GET',
      headers: args.headers,
      body: args.body,
      credentials: 'include',        // real session cookies — the whole point of the cookie tier
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    let body = await res.text();
    const truncated = body.length > MAX_BODY;
    if (truncated) body = body.slice(0, MAX_BODY);
    return { status: res.status, finalUrl: res.url || args.url, headers, body, truncated };
  } finally { clearTimeout(timer); }
}

async function tabLease(args: { interactive?: boolean }): Promise<{ tabId: number }> {
  if (args.interactive) {
    if (interactiveTabId != null) {
      try { await chrome.tabs.get(interactiveTabId); return { tabId: interactiveTabId }; }
      catch { interactiveTabId = null; }
    }
    // Persist the interactive tab id across SW suspensions so we reuse (not re-create) it on restart —
    // otherwise each cold SW spawns a new interactive tab and the old ones pile up.
    try {
      const saved = (await chrome.storage.session.get('interactiveTabId')).interactiveTabId;
      if (typeof saved === 'number') { await chrome.tabs.get(saved); interactiveTabId = saved; return { tabId: saved }; }
    } catch { /* saved tab gone */ }
    const t = await chrome.tabs.create({ url: 'about:blank', active: false });
    interactiveTabId = t.id!;
    try { await chrome.storage.session.set({ interactiveTabId: t.id }); } catch { /* */ }
    return { tabId: t.id! };
  }
  const t = await chrome.tabs.create({ url: 'about:blank', active: false });
  poolTabs.add(t.id!);
  return { tabId: t.id! };
}

async function tabRelease(args: { tabId: number }): Promise<{ ok: boolean }> {
  poolTabs.delete(args.tabId);
  if (interactiveTabId === args.tabId) interactiveTabId = null;
  await clearBlocking(args.tabId);
  try { await chrome.tabs.remove(args.tabId); } catch { /* already gone */ }
  return { ok: true };
}

/** Block images/media/fonts on a specific tab via a session dNR rule (speed on pool tabs). */
async function setBlocking(tabId: number): Promise<void> {
  if (blockRules.has(tabId)) return;
  const id = ruleSeq++;
  blockRules.set(tabId, id);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id,
        priority: 1,
        action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
        condition: {
          tabIds: [tabId],
          resourceTypes: ['image', 'media', 'font'] as chrome.declarativeNetRequest.ResourceType[],
        },
      }],
    });
  } catch { blockRules.delete(tabId); }
}
async function clearBlocking(tabId: number): Promise<void> {
  const id = blockRules.get(tabId);
  if (id == null) return;
  blockRules.delete(tabId);
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch { /* */ }
}

function waitForComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    // in case it's already complete
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(() => finish());
  });
}

async function tabGoto(args: { tabId: number; url: string; block?: boolean; timeoutMs?: number; waitFor?: string }): Promise<{ status: number | null; finalUrl: string }> {
  if (args.block) await setBlocking(args.tabId); else await clearBlocking(args.tabId);
  await chrome.tabs.update(args.tabId, { url: args.url });
  await waitForComplete(args.tabId, args.timeoutMs ?? 30000);
  if (args.waitFor) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: args.tabId },
        func: async (sel: string) => {
          const end = Date.now() + 8000;
          while (Date.now() < end) { if (document.querySelector(sel)) return; await new Promise((r) => setTimeout(r, 100)); }
        },
        args: [args.waitFor],
      });
    } catch { /* soft */ }
  }
  const t = await chrome.tabs.get(args.tabId).catch(() => null);
  return { status: null, finalUrl: t?.url || args.url };
}

async function injectAndCall<T>(tabId: number, file: string, fnName: string, arg?: unknown): Promise<T> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name: string, a: unknown) => (globalThis as any)[name](a),
    args: [fnName, arg ?? null],
  });
  return res?.result as T;
}

async function tabExtract(args: { tabId: number; settleMs?: number }): Promise<unknown> {
  return injectAndCall(args.tabId, 'extract.js', '__vantaExtract', args.settleMs ?? 1500);
}
async function tabSerp(args: { tabId: number; mode?: 'web' | 'news'; max?: number }): Promise<unknown> {
  return injectAndCall(args.tabId, 'google-serp.js', '__vantaGoogleSerp', { mode: args.mode ?? 'web', max: args.max ?? 12 });
}
async function tabAct(args: { tabId: number; steps: unknown[] }): Promise<unknown> {
  return injectAndCall(args.tabId, 'act.js', '__vantaAct', args.steps);
}

async function tabScreenshot(args: { tabId: number }): Promise<{ dataUrl: string }> {
  // Primary: chrome.debugger Page.captureScreenshot — works on a BACKGROUND tab and needs NO window focus.
  // captureVisibleTab (the old path) hangs under launchd because the Chrome window is unfocused.
  const target = { tabId: args.tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    const res: any = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await chrome.debugger.detach(target).catch(() => {});
    if (res?.data) return { dataUrl: 'data:image/png;base64,' + res.data };
  } catch { await chrome.debugger.detach(target).catch(() => {}); }
  // Fallback: focus the window + activate the tab, then captureVisibleTab.
  const tab = await chrome.tabs.get(args.tabId);
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* */ }
  const prev = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id;
  await chrome.tabs.update(args.tabId, { active: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  if (prev && prev !== args.tabId) { try { await chrome.tabs.update(prev, { active: true }); } catch { /* */ } }
  return { dataUrl };
}

// ── lifetime: recovery alarm (min period 0.5m) wakes a suspended SW; on wake it reconnects ─────────
function ensureAlarm(): void {
  // 0.5 minutes (30s) is the MV3 minimum — anything smaller is rejected, which is why the SW never
  // woke before. The alarm is the RECOVERY net; the WS self-ping (above) is the primary keepalive.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); connect(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); connect(); });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== KEEPALIVE_ALARM) return;
  chrome.storage.local.get('token').catch(() => {}); // touch storage — keeps SW warm
  if (!sock || sock.readyState !== WebSocket.OPEN) connect();
});
// Content-script wake + offscreen keepalive: any page load OR the offscreen doc's 20s tick nudges the
// SW awake, keeping its WebSocket connected instead of flapping on the 30s idle timer.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'wake' || msg?.type === 'keepalive-tick') { ensureAlarm(); connect(); }
});

// Offscreen keepalive document — persists past the SW idle timer and heartbeats us. Create once.
async function ensureOffscreen(): Promise<void> {
  try {
    // @ts-ignore - hasDocument is available in Chrome 116+
    if (await chrome.offscreen.hasDocument?.()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS' as chrome.offscreen.Reason],  // a permitted reason; the doc just runs a timer
      justification: 'Keep the VANTA daemon WebSocket connection alive.',
    });
  } catch { /* already exists or unsupported — the alarm is the fallback */ }
}
ensureOffscreen();

// On every SW spin-up (install, startup, or alarm-driven wake) re-assert the alarm and connect.
ensureAlarm();
connect();
