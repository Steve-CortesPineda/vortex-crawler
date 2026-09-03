import { AgentBrowser } from '../packages/core/dist/index.js';
const wait = ms => new Promise(r => setTimeout(r, ms));
const b = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${process.env.HOME}/.vortex-assist` });
await b.open();
await b.goto('https://www.npmjs.com/settings/stevecortesp/tokens/granular-access-tokens/new');
await wait(9000);
const page = b['page'];
try { await page.fill('#create-gat_tokenName', 'vortex-publish'); } catch(e){ console.log('name-fail',e.message.slice(0,50)); }
try { await page.locator('#create-gat_bypass2FA').check({ force: true }); } catch(e){ console.log('2fa-fail',e.message.slice(0,50)); }
try { await page.evaluate(() => { const d=[...document.querySelectorAll('details')].find(x=>/no access/i.test(x.querySelector('summary')?.innerText||'')); if(d&&!d.open) d.querySelector('summary').click(); }); } catch(e){ console.log('open-fail',e.message.slice(0,50)); }
await wait(1000);
try { await page.getByText('Read and write', { exact: false }).first().click({ timeout: 4000 }); } catch(e){ console.log('rw-fail',e.message.slice(0,50)); }
await wait(1500);
await page.evaluate(() => window.scrollTo(0, 600));
await b.screenshot('/tmp/npm-after-perm.png');
const state = await page.evaluate(() => {
  const sums=[...document.querySelectorAll('summary')].map(s=>(s.innerText||'').trim());
  const body=document.querySelector('main')?.innerText||'';
  return { summaries:sums, allPackages:/all packages/i.test(body), selectPackages:/only select|select packages/i.test(body), name: document.querySelector('#create-gat_tokenName')?.value, twofa: document.querySelector('#create-gat_bypass2FA')?.checked };
});
console.log('STATE:', JSON.stringify(state).slice(0,900));
setInterval(()=>{},1<<30);
