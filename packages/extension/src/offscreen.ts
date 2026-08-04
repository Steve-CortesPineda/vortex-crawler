/**
 * VANTA keepalive offscreen document. An offscreen document does NOT get torn down on the ~30s idle
 * timer that suspends MV3 service workers, so its timer keeps running. Every 20s it pokes the service
 * worker awake via a runtime message, which keeps the SW's WebSocket to the daemon connected — turning
 * the flappy alarm-driven reconnect into a steady connection.
 */
setInterval(() => {
  try { chrome.runtime.sendMessage({ type: 'keepalive-tick' }).catch(() => {}); } catch { /* SW cycling */ }
}, 20000);
// Fire once immediately so a fresh SW connects without waiting a full interval.
try { chrome.runtime.sendMessage({ type: 'keepalive-tick' }).catch(() => {}); } catch { /* */ }
