import { AgentBrowser } from '../packages/core/dist/index.js';
const b = new AgentBrowser({ reachProfile: 'natural', headless: false, channel: 'chrome', profileDir: `${process.env.HOME}/.vortex-assist` });
await b.open();
await b.goto('https://www.npmjs.com/settings/stevecortesp/tokens/granular-access-tokens/new');
await new Promise(r => setTimeout(r, 9000));
await b.screenshot('/tmp/npm-form.png');
const page = b['page'];
const form = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input,select,textarea')].map(e => ({ tag:e.tagName, type:e.type||'', name:e.name||'', id:e.id||'', placeholder:e.placeholder||'', label:(e.labels&&e.labels[0]?.innerText)||'' }));
  const buttons = [...document.querySelectorAll('button,a[role=button],input[type=submit]')].map(e => (e.innerText||e.value||'').trim()).filter(Boolean);
  const radios = [...document.querySelectorAll('input[type=radio]')].map(e => ({ name:e.name, value:e.value, label:(e.labels&&e.labels[0]?.innerText)||'' }));
  return { inputs, buttons: [...new Set(buttons)], radios };
});
console.log(JSON.stringify(form, null, 1).slice(0, 2000));
setInterval(()=>{},1<<30);
