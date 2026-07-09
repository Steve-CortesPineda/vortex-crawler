#!/usr/bin/env node
/**
 * Search-quality regression benchmark — first-class, not eyeballed.
 *
 * Runs the fixed query set in search-quality-cases.json and asserts SOURCE-CLASS expectations
 * ("technical query must surface official-docs in the top 3; never a tutorial farm in the top 5")
 * against live results. Class assertions survive ranking-weight tweaks and index churn, which is
 * exactly what makes this a regression suite instead of a demo.
 *
 * Backends:
 *   node benchmarks/search-quality.mjs            # core search() direct (fetch engines + no session)
 *   node benchmarks/search-quality.mjs --daemon   # through the running daemon (:4477) — full stack:
 *                                                 # google-session fusion, youtube vertical, rerank
 * Options:
 *   --only=<name-substring>   run a subset
 *   --json                    machine-readable output (also always written to search-quality-last.json)
 *
 * Exit code: 0 all pass, 1 any fail — wire into CI or a cron canary.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { search, sourceClass, resetEngineCooldowns } from '../packages/core/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const useDaemon = args.includes('--daemon');
const asJson = args.includes('--json');
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const DAEMON = `http://127.0.0.1:${process.env.VORTEX_DAEMON_PORT || 4477}`;

const { cases } = JSON.parse(await readFile(path.join(here, 'search-quality-cases.json'), 'utf8'));

async function daemonSearch(query, maxResults = 8) {
  const res = await fetch(`${DAEMON}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, maxResults, noCache: true }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || `daemon /search HTTP ${res.status}`);
  return body.result;
}

function evalCase(c, resp) {
  const results = resp.results || [];
  const classes = results.map((r) => sourceClass(r.url));
  const failures = [];

  if (!results.length) failures.push('zero results');

  if (c.expectAnyInTop) {
    const top = classes.slice(0, c.expectAnyInTop.n);
    if (!top.some((cl) => c.expectAnyInTop.classes.includes(cl))) {
      failures.push(`top-${c.expectAnyInTop.n} has none of [${c.expectAnyInTop.classes}] (got: ${top.join(', ')})`);
    }
  }
  if (c.forbidInTop) {
    const top = classes.slice(0, c.forbidInTop.n);
    const bad = top.map((cl, i) => (c.forbidInTop.classes.includes(cl) ? `#${i + 1}:${cl}(${results[i].url})` : null)).filter(Boolean);
    if (bad.length) failures.push(`forbidden class in top-${c.forbidInTop.n}: ${bad.join(' ')}`);
  }
  if (c.expectUrlInTop) {
    const re = new RegExp(c.expectUrlInTop.pattern, 'i');
    if (!results.slice(0, c.expectUrlInTop.n).some((r) => re.test(r.url))) {
      failures.push(`no top-${c.expectUrlInTop.n} URL matches ${c.expectUrlInTop.pattern}`);
    }
  }
  if (c.freshWithinDays) {
    const dated = results.slice(0, 5).map((r) => r.publishedAt).filter(Boolean);
    if (dated.length) {
      const freshest = Math.min(...dated.map((d) => (Date.now() - Date.parse(d)) / 86400e3));
      if (freshest > c.freshWithinDays) failures.push(`freshest dated result is ${Math.round(freshest)}d old (want ≤${c.freshWithinDays}d)`);
    }
  }
  return { failures, classes: classes.slice(0, 5), top: results.slice(0, 5).map((r) => ({ url: r.url, score: r.score, publishedAt: r.publishedAt })) };
}

const out = [];
let failed = 0;
resetEngineCooldowns();
for (const c of cases) {
  if (only && !c.name.includes(only)) continue;
  if (c.daemonOnly && !useDaemon) { out.push({ name: c.name, skipped: 'daemon-only' }); continue; }
  const t0 = Date.now();
  let record;
  try {
    const resp = useDaemon ? await daemonSearch(c.query) : await search(c.query, { maxResults: 8, noCache: true });
    const { failures, classes, top } = evalCase(c, resp);
    record = {
      name: c.name, query: c.query, ok: failures.length === 0, failures, classes, top,
      lowConfidence: resp.lowConfidence ?? null, sources: resp.sources || [], ms: Date.now() - t0,
    };
  } catch (e) {
    record = { name: c.name, query: c.query, ok: false, failures: [`error: ${e.message}`], ms: Date.now() - t0 };
  }
  if (!record.ok) failed++;
  out.push(record);
  if (!asJson) {
    const mark = record.ok ? '✅' : '❌';
    console.log(`${mark} ${record.name} (${record.ms}ms)${record.lowConfidence ? ' [lowConfidence]' : ''}`);
    if (record.classes) console.log(`   top classes: ${record.classes.join(', ')}`);
    for (const f of record.failures || []) console.log(`   ↳ ${f}`);
  }
}

const summary = { ranAt: new Date().toISOString(), backend: useDaemon ? 'daemon' : 'core', passed: out.filter((r) => r.ok).length, failed, skipped: out.filter((r) => r.skipped).length, cases: out };
await writeFile(path.join(here, 'search-quality-last.json'), JSON.stringify(summary, null, 2));
if (asJson) console.log(JSON.stringify(summary, null, 2));
else console.log(`\n${summary.passed} passed, ${failed} failed, ${summary.skipped} skipped → benchmarks/search-quality-last.json`);
process.exit(failed ? 1 : 0);
