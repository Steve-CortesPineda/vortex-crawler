import { AgentBrowser } from '../packages/core/dist/index.js';
const b = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${process.env.HOME}/.vortex-assist` });
await b.open();
await b.goto('https://www.npmjs.com/settings/stevecortesp/tokens/granular-access-tokens/new');
await new Promise(r => setTimeout(r, 9000));
const page = b['page'];
// open the first "Packages and scopes" details (its summary currently reads "No access")
const opened = await page.evaluate(() => {
  const dets = [...document.querySelectorAll('details')];
  // the packages permission details is the first one whose summary is "No access"
  const d = dets.find(x => /no access/i.test(x.querySelector('summary')?.innerText||''));
  if (d){ d.open = true; d.querySelector('summary')?.click(); return true; }
  return false;
});
await new Promise(r => setTimeout(r, 1200));
await page.evaluate(() => window.scrollTo(0, 600));
await b.screenshot('/tmp/npm-pkgperm.png');
const inner = await page.evaluate(() => {
  const d = [...document.querySelectorAll('details')].find(x => x.open);
  if(!d) return 'no open details';
  return [...d.querySelectorAll('button,[role=option],[role=menuitem],li,a,label')].map(e=>(e.innerText||'').trim()).filter(Boolean).slice(0,25);
});
console.log('OPENED:', opened);
console.log('INNER:', JSON.stringify(inner));
setInterval(()=>{},1<<30);
