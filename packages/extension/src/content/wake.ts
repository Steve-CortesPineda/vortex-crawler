/**
 * Wake pinger — a tiny content script on <all_urls>. MV3 service workers go dormant and, with no other
 * events, never restart on a browser relaunch (onInstalled only fires on first install). This fires on
 * every page load and nudges the SW awake via a message, which triggers its reconnect. Harmless + silent.
 */
try { chrome.runtime.sendMessage({ type: 'wake' }).catch(() => {}); } catch { /* SW gone; alarm recovers */ }
