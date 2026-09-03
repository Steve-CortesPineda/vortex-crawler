// Open the ASSIST browser as a REAL window on a dedicated persistent profile (~/.vortex-assist) so a
// human logs into a site ONCE. Session persists; assist-task scripts reuse the same profile afterward.
// Kept separate from the MCP scraping browser so they never fight over a profile lock.
// Usage: node tools/seed-login.mjs https://www.npmjs.com/login
import { AgentBrowser } from '../packages/core/dist/index.js';
const url = process.argv[2] || 'about:blank';
const profileDir = `${process.env.HOME}/.vortex-assist`;
const b = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir });
await b.open();
await b.goto(url);
console.error(`[seed] window open at ${url} on profile ${profileDir} — log in, then tell me "done".`);
setInterval(() => {}, 1 << 30);
