import { AgentBrowser } from '../packages/core/dist/index.js';
const b = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${process.env.HOME}/.vortex-assist` });
await b.open();
await b.goto('https://www.npmjs.com/settings/stevecortesp/tokens/granular-access-tokens/new');
await new Promise(r => setTimeout(r, 9000));
const page = b['page'];
await page.evaluate(() => window.scrollTo(0, 700));
await new Promise(r => setTimeout(r, 800));
await b.screenshot('/tmp/npm-perms.png');
const data = await page.evaluate(() => {
  const interesting = [...document.querySelectorAll('[role],[aria-label],button,summary,[class*=ermission],[class*=ropdown],[class*=elect]')]
    .map(e => ({ tag:e.tagName, role:e.getAttribute('role')||'', aria:e.getAttribute('aria-label')||'', txt:(e.innerText||'').trim().slice(0,40) }))
    .filter(x => x.txt || x.aria);
  // headings / section labels around permissions
  const heads = [...document.querySelectorAll('h2,h3,h4,legend,label')].map(e=>(e.innerText||'').trim()).filter(Boolean);
  return { heads, interesting: interesting.slice(0,40) };
});
console.log('HEADS:', JSON.stringify(data.heads));
console.log('CONTROLS:', JSON.stringify(data.interesting, null, 0).slice(0,1800));
setInterval(()=>{},1<<30);
