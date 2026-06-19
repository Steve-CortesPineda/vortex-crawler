// Benchmark orchestrator: runs each crawler under `/usr/bin/time -l` (peak RSS), collects each
// runner's JSON, and prints a fair comparison table. Uninstalled competitors are skipped.
//
// Setup (see benchmarks/README.md):
//   pnpm build
//   python3 -m venv benchmarks/.venv && benchmarks/.venv/bin/pip install scrapy crawl4ai
//   benchmarks/.venv/bin/python -m playwright install chromium
//   (cd benchmarks/competitors && npm init -y && npm i crawlee playwright && npx playwright install chromium)
//   node benchmarks/run.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const VENV = process.env.BENCH_PY || `${DIR}.venv/bin/python`;

const TOOLS = [
  { tool: 'vortex',   cmd: 'node',  args: [`${DIR}vortex.mjs`] },
  { tool: 'crawl4ai', cmd: VENV,    args: [`${DIR}competitors/crawl4ai.py`] },
  { tool: 'scrapy',   cmd: VENV,    args: [`${DIR}competitors/scrapy.py`] },
  { tool: 'crawlee',  cmd: 'node',  args: [`${DIR}competitors/crawlee.mjs`] },
];

const peakRssMB = (s) => { const m = s.match(/(\d+)\s+maximum resident set size/); return m ? +(Number(m[1]) / 1048576).toFixed(0) : null; };
const lastJson = (s) => { const l = s.trim().split('\n').filter(Boolean); for (let i = l.length - 1; i >= 0; i--) { try { return JSON.parse(l[i]); } catch { /* */ } } return null; };

const rows = [];
for (const t of TOOLS) {
  if (t.cmd === VENV && !existsSync(VENV)) { console.error(`[skip] ${t.tool} — no venv`); rows.push({ tool: t.tool, status: 'not installed' }); continue; }
  if (t.tool === 'crawlee' && !existsSync(`${DIR}competitors/node_modules/crawlee`)) { console.error(`[skip] crawlee — not installed`); rows.push({ tool: t.tool, status: 'not installed' }); continue; }
  console.error(`[run] ${t.tool} ...`);
  const r = spawnSync('/usr/bin/time', ['-l', t.cmd, ...t.args], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const data = lastJson(r.stdout || '');
  const rss = peakRssMB(r.stderr || '');
  if (!data) { console.error(`[fail] ${t.tool}: ${(r.stderr || '').slice(-200)}`); rows.push({ tool: t.tool, status: 'run failed', rssMB: rss }); continue; }
  const ok = data.results.filter((x) => x.ok);
  rows.push({ tool: t.tool, status: 'ok', crawlMs: data.crawl_ms, rssMB: rss, okCount: `${ok.length}/${data.results.length}`, totalChars: ok.reduce((a, x) => a + x.chars, 0), perUrl: data.results });
}

console.log('\nTool       | Status   | Crawl time | Peak RAM | OK   | Total chars');
console.log('-----------|----------|------------|----------|------|------------');
for (const r of rows) {
  if (r.status !== 'ok') { console.log(`${r.tool.padEnd(10)} | ${r.status}`); continue; }
  console.log(`${r.tool.padEnd(10)} | ${r.status.padEnd(8)} | ${String(r.crawlMs + ' ms').padStart(10)} | ${String((r.rssMB ?? '?') + ' MB').padStart(8)} | ${r.okCount.padEnd(4)} | ${r.totalChars}`);
}
writeFileSync(`${DIR}results.json`, JSON.stringify(rows, null, 2));
console.log(`\nDetail → benchmarks/results.json`);
