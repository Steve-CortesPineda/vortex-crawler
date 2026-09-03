import { AgentBrowser } from '../packages/core/dist/index.js';
const b = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${process.env.HOME}/.vortex-assist` });
await b.open();
await b.goto('https://www.npmjs.com/settings/stevecortesp/tokens/granular-access-tokens/new');
await new Promise(r => setTimeout(r, 9000));
const page = b['page'];
const data = await page.evaluate(() => {
  const selects = [...document.querySelectorAll('select')].map(s => ({ name:s.name, id:s.id, label:(s.labels&&s.labels[0]?.innerText)||'', options:[...s.options].map(o=>o.text+'='+o.value) }));
  const radios = [...document.querySelectorAll('input[type=radio]')].map(e => ({ name:e.name, value:e.value, id:e.id, label:(e.labels&&e.labels[0]?.innerText)||'' }));
  const buttons = [...new Set([...document.querySelectorAll('button,input[type=submit]')].map(e => (e.innerText||e.value||'').trim()).filter(Boolean))];
  return { selects, radios, buttons };
});
console.log(JSON.stringify(data, null, 1).slice(0, 2200));
setInterval(()=>{},1<<30);
