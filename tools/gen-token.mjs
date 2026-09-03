import { AgentBrowser } from '../packages/core/dist/index.js';
import { writeFileSync } from 'node:fs';
const wait = ms => new Promise(r => setTimeout(r, ms));
const b = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${process.env.HOME}/.vortex-assist` });
await b.open();
await b.goto('https://www.npmjs.com/settings/stevecortesp/tokens/granular-access-tokens/new');
await wait(9000);
const page = b['page'];
const step = async (label, fn) => { try { await fn(); } catch(e){ console.log(label+'-fail:', e.message.slice(0,60)); } };
await step('name', () => page.fill('#create-gat_tokenName', 'vortex-publish'));
await step('2fa', () => page.locator('#create-gat_bypass2FA').check({ force: true }));
await step('open-pkg', () => page.evaluate(() => { const d=[...document.querySelectorAll('details')].find(x=>/no access/i.test(x.querySelector('summary')?.innerText||'')); if(d&&!d.open) d.querySelector('summary').click(); }));
await wait(900);
await step('read-write', () => page.getByText('Read and write', { exact: false }).first().click({ timeout: 4000 }));
await wait(1200);
await step('all-packages', () => page.getByText('All packages', { exact: false }).first().click({ timeout: 3000 }));
await wait(800);
await page.evaluate(() => window.scrollTo(0, 700));
await b.screenshot('/tmp/npm-final.png');
// Generate
await step('generate', () => page.getByRole('button', { name: /generate token/i }).click({ timeout: 5000 }));
await wait(5000);
await b.screenshot('/tmp/npm-result.png');
const token = await page.evaluate(() => {
  const m = (document.body.innerText||'').match(/npm_[A-Za-z0-9]{36,}/);
  if (m) return m[0];
  for (const i of document.querySelectorAll('input,code,textarea')) { const v=(i.value||i.innerText||''); const mm=v.match(/npm_[A-Za-z0-9]{36,}/); if(mm) return mm[0]; }
  return null;
});
if (token) { writeFileSync('/tmp/npm-token.txt', token); console.log('TOKEN_OK len=', token.length, 'prefix=', token.slice(0,8)); }
else console.log('TOKEN_NOT_FOUND — see /tmp/npm-result.png');
setInterval(()=>{},1<<30);
