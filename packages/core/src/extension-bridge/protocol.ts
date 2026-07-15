/**
 * Wire protocol shared by the daemon-side WS server and the extension service worker.
 * The extension is the WS CLIENT (extensions can't listen); the daemon is the WS SERVER and the RPC
 * INITIATOR (reverse RPC) — it sends {id, op, args} requests, the extension replies {id, ok, result|error}.
 * Kept dependency-free and JSON-only so the same shapes compile into the browser bundle.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Ops the daemon can ask the extension to perform. */
export type BridgeOp =
  | 'http.fetch'       // cookie-authenticated fetch in the service worker (no render). tier 0.5.
  | 'tab.lease'        // allocate a background tab from the pool (or the interactive tab)
  | 'tab.release'      // return a tab to the pool
  | 'tab.goto'         // navigate a tab, optionally with resource-blocking
  | 'tab.extract'      // in-page markdown extraction
  | 'tab.serp'         // parse a rendered Google SERP → clean {title,url,snippet}[]
  | 'tab.act'          // batch of {click|type|press|scroll|waitFor}
  | 'tab.screenshot'   // captureVisibleTab of a tab
  | 'ping';

export interface HelloFrame {
  type: 'hello';
  version: number;
  profile: string;                 // must be 'vanta' — daemon refuses others
  tabs?: { id: number; url: string }[];
}
export interface PingFrame { type: 'ping' | 'pong'; }

export interface RpcRequest {
  id: number;
  op: BridgeOp;
  args: Record<string, unknown>;
}
export interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type FromExtension = HelloFrame | PingFrame | RpcResponse;
export type FromDaemon = RpcRequest | PingFrame;

// ── Op arg/result contracts (documentation + light typing for the daemon side) ──

export interface HttpFetchArgs { url: string; method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; }
export interface HttpFetchResult { status: number; finalUrl: string; headers: Record<string, string>; body: string; truncated: boolean; }

export interface TabLeaseArgs { interactive?: boolean; }
export interface TabLeaseResult { tabId: number; }

export interface TabGotoArgs { tabId: number; url: string; block?: boolean; timeoutMs?: number; waitFor?: string; }
export interface TabGotoResult { status: number | null; finalUrl: string; }

export interface TabSerpArgs { tabId: number; mode?: 'web' | 'news'; max?: number; }
export interface SerpItem { title: string; url: string; snippet: string; }

export interface TabExtractArgs { tabId: number; settleMs?: number; }
export interface ExtractPayload {
  url: string; title: string; markdown: string; approxTokens: number;
  captchaDetected: boolean; publishDate?: string; links: { href: string; text: string }[];
  extractedVia: 'readability' | 'cleaner';
}

export type ActStep =
  | { kind: 'click'; target: string; byText?: boolean }
  | { kind: 'type'; selector: string; text: string; submit?: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; direction?: 'up' | 'down'; amount?: number }
  | { kind: 'waitFor'; selector: string; timeoutMs?: number };
export interface TabActArgs { tabId: number; steps: ActStep[]; }
export interface TabActResult { ran: number; notes: string[]; refused?: string; }

export interface TabScreenshotArgs { tabId: number; }
export interface TabScreenshotResult { dataUrl: string; }
