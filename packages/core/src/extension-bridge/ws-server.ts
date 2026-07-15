import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import {
  BRIDGE_PROTOCOL_VERSION, type FromExtension, type RpcRequest, type BridgeOp,
} from './protocol.js';

/**
 * BridgeServer — the daemon side of the VANTA extension bridge.
 *
 * Owns the single WebSocket to the extension service worker and implements REVERSE RPC: the daemon
 * sends {id, op, args} and awaits the extension's {id, ok, result}. At most one extension is connected
 * (the VANTA profile); a new connection replaces the old. Heartbeats keep the MV3 service worker alive.
 *
 * Binds to the SAME http server as the daemon (loopback), upgrading only the /vanta-bridge path — so no
 * extra port to firewall, and the daemon's existing token/loopback guarantees extend to the socket.
 */

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeServerOptions {
  token?: string;                 // must match the extension's; checked on hello
  path?: string;                  // upgrade path, default /vanta-bridge
  defaultOpTimeoutMs?: number;    // default 30_000
  heartbeatMs?: number;           // default 20_000 (keeps MV3 SW alive)
}

export class BridgeServer {
  private wss: WebSocketServer;
  private sock: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private token: string;
  private opTimeout: number;
  private heartbeatMs: number;
  private heartbeat?: NodeJS.Timeout;
  private helloAt = 0;
  private profile = '';
  private knownTabs: { id: number; url: string }[] = [];
  private onConnectCbs: (() => void)[] = [];

  constructor(server: HttpServer, opts: BridgeServerOptions = {}) {
    this.token = opts.token || '';
    this.opTimeout = opts.defaultOpTimeoutMs ?? 30_000;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    const path = opts.path || '/vanta-bridge';

    // noServer: we hook the http server's upgrade event ourselves so only our path is a WS endpoint.
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      let url: URL;
      try { url = new URL(req.url || '/', 'http://127.0.0.1'); } catch { socket.destroy(); return; }
      if (url.pathname !== path) return; // let other upgrade handlers (if any) deal with it
      // Token gate at the transport (query param, since extensions can't set WS headers easily).
      if (this.token && url.searchParams.get('token') !== this.token) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.adopt(ws));
    });
  }

  /** True while an extension is connected and has completed the hello handshake. */
  get connected(): boolean { return this.sock?.readyState === WebSocket.OPEN && this.helloAt > 0; }
  get info() { return { connected: this.connected, profile: this.profile, tabs: this.knownTabs.length, sinceMs: this.helloAt ? Date.now() - this.helloAt : 0 }; }

  onConnect(cb: () => void): void { this.onConnectCbs.push(cb); }

  private adopt(ws: WebSocket): void {
    // Replace any prior connection (SW restart → fresh socket).
    if (this.sock && this.sock !== ws) { try { this.sock.close(); } catch { /* */ } }
    this.sock = ws;
    this.helloAt = 0;

    ws.on('message', (data) => this.onMessage(String(data)));
    ws.on('close', () => { if (this.sock === ws) { this.sock = null; this.helloAt = 0; this.failAll('extension disconnected'); } });
    ws.on('error', () => { /* close handler does the cleanup */ });

    this.startHeartbeat();
  }

  private onMessage(raw: string): void {
    let msg: FromExtension;
    try { msg = JSON.parse(raw); } catch { return; }
    if ('type' in msg) {
      if (msg.type === 'hello') {
        if (msg.profile !== 'vanta') { this.sock?.close(); return; }        // only the VANTA profile
        if (msg.version !== BRIDGE_PROTOCOL_VERSION) { this.sock?.close(); return; }
        this.helloAt = Date.now();
        this.profile = msg.profile;
        this.knownTabs = msg.tabs || [];
        this.onConnectCbs.forEach((cb) => { try { cb(); } catch { /* */ } });
      }
      // 'ping'/'pong' are heartbeats; nothing to do.
      return;
    }
    // Otherwise it's an RpcResponse.
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'extension op failed'));
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.sock?.readyState === WebSocket.OPEN) {
        try { this.sock.send(JSON.stringify({ type: 'ping' })); } catch { /* */ }
      }
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private failAll(reason: string): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  /** Send one op to the extension and await its response. Rejects on timeout or disconnect. */
  call<T = unknown>(op: BridgeOp, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.connected || !this.sock) return Promise.reject(new Error('extension bridge not connected'));
    const id = this.nextId++;
    const req: RpcRequest = { id, op, args };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`extension op '${op}' timed out after ${timeoutMs ?? this.opTimeout}ms`));
      }, timeoutMs ?? this.opTimeout);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { this.sock!.send(JSON.stringify(req)); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e as Error); }
    });
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.failAll('bridge closing');
    try { this.sock?.close(); } catch { /* */ }
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
