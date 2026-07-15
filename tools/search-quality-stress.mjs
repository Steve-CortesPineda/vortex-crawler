#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, VortexDaemonClient } from '../packages/core/dist/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const QUALITY_ENGINES = new Set(['google-session', 'google', 'brave', 'startpage']);
const YOUTUBE_VERTICAL_SOURCES = new Set(['yt-dlp', 'yt-rss']);
const LOW_TRUST_RE = /(^|\.)(aol\.com|cloudwards\.net|dailymail\.com|fandom\.com|msn\.com|news\.yahoo\.com|finance\.yahoo\.com|marketbeat\.com|247wallst\.com|beincrypto\.com|analyticsinsight\.net|geeky-gadgets\.com)$/i;
const SOCIAL_RE = /(^|\.)(instagram\.com|facebook\.com|threads\.com|x\.com|twitter\.com|linkedin\.com|tiktok\.com)$/i;
const JUNK_RE = /(^|\.)(merriam-webster\.com|dictionary\.com|thefreedictionary\.com|gasbuddy\.com|urbandictionary\.com)$/i;
const GENERIC_PRIMARY_PATH_RE = /^\/(?:company|about|products?|platform|pricing|careers?|contact|team|research|api|login|sign-?in)?\/?$/i;

const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const noRaw = args.has('--no-raw');
const noDaemon = args.has('--no-daemon');
const allowDegraded = args.has('--allow-degraded');
const maxResults = Number(valueAfter('--max-results') || 10);
const recency = valueAfter('--recency') || 'month';

function valueAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function domain(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^(www|m|amp)\./, ''); } catch { return ''; }
}

function pathOf(url) {
  try { return new URL(url).pathname || '/'; } catch { return '/'; }
}

function hostIs(url, host) {
  const h = domain(url);
  return h === host || h.endsWith(`.${host}`);
}

function isGenericOfficial(url) {
  const h = domain(url);
  return /(anthropic\.com|openai\.com|federalreserve\.gov|nvidia\.com|stripe\.com|digitalocean\.com)$/.test(h)
    && GENERIC_PRIMARY_PATH_RE.test(pathOf(url));
}

function isBad(url) {
  const h = domain(url);
  return LOW_TRUST_RE.test(h) || SOCIAL_RE.test(h);
}

function top(resp, n) {
  return (resp.results || []).slice(0, n);
}

function anyTop(resp, n, pred) {
  return top(resp, n).some(pred);
}

function noneTop(resp, n, pred) {
  return !anyTop(resp, n, pred);
}

function first(resp) {
  return resp.results?.[0];
}

function firstUrl(resp, pred) {
  const r = first(resp);
  return !!r && pred(r);
}

function officialAnthropicNews(r) {
  return hostIs(r.url, 'anthropic.com') && /^\/news\b/i.test(pathOf(r.url));
}

function officialOpenAIRelease(r) {
  return (hostIs(r.url, 'openai.com') && /^\/(index|research|blog|news)\b/i.test(pathOf(r.url)))
    || hostIs(r.url, 'help.openai.com');
}

function primaryGov(r) {
  return hostIs(r.url, 'federalreserve.gov') || hostIs(r.url, 'federalregister.gov') || hostIs(r.url, 'fincen.gov');
}

function trustedNvidia(r) {
  return hostIs(r.url, 'nvidia.com')
    || hostIs(r.url, 'nvidianews.nvidia.com')
    || hostIs(r.url, 'reuters.com')
    || hostIs(r.url, 'bloomberg.com')
    || hostIs(r.url, 'wsj.com')
    || hostIs(r.url, 'cnbc.com')
    || hostIs(r.url, 'theverge.com')
    || hostIs(r.url, 'techcrunch.com')
    || hostIs(r.url, 'semianalysis.com');
}

function hotelSource(r) {
  return hostIs(r.url, 'kayak.com')
    || hostIs(r.url, 'skyscanner.com')
    || hostIs(r.url, 'booking.com')
    || hostIs(r.url, 'tripadvisor.com')
    || hostIs(r.url, 'expedia.com')
    || hostIs(r.url, 'agoda.com')
    || hostIs(r.url, 'hotels.com')
    || hostIs(r.url, 'hotelscombined.com')
    || hostIs(r.url, 'hotelplanner.com');
}

function officialInfraDoc(r) {
  const path = pathOf(r.url);
  return hostIs(r.url, 'docs.digitalocean.com')
    || (hostIs(r.url, 'digitalocean.com') && /^\/(community\/tutorials|docs)\b/i.test(path))
    || (hostIs(r.url, 'cloud.google.com') && /^\/dns\/docs\b/i.test(path))
    || hostIs(r.url, 'certbot.eff.org')
    || hostIs(r.url, 'nginx.org');
}

function youtubeVideo(r) {
  return hostIs(r.url, 'youtube.com') && pathOf(r.url) === '/watch';
}

function youtubeVertical(resp) {
  return resp.vertical === 'youtube' && (resp.sources || []).some((s) => YOUTUBE_VERTICAL_SOURCES.has(s));
}

function channelLatest(resp, name) {
  return (resp.engineReports || []).some((e) => new RegExp(`channel-latest route.*${name}`, 'i').test(e.note || ''));
}

function resultText(r) {
  return `${r.title || ''} ${r.url || ''} ${r.snippet || ''}`;
}

function sourceQualityAtLeast(resp, n, min) {
  return top(resp, n).every((r) => typeof r.sourceQuality !== 'number' || r.sourceQuality >= min);
}

const daemonCases = [
  {
    query: 'Anthropic latest Claude news July 2026',
    checks: [
      ['top 3 includes Anthropic source-of-record news', (r) => anyTop(r, 3, officialAnthropicNews)],
      ['top 3 has no generic Anthropic/OpenAI homepages', (r) => noneTop(r, 3, (x) => isGenericOfficial(x.url))],
      ['top 5 has no social/syndication/low-trust junk', (r) => noneTop(r, 5, (x) => isBad(x.url))],
    ],
  },
  {
    query: 'OpenAI latest model release July 2026',
    checks: [
      ['top 3 includes official OpenAI release/help source', (r) => anyTop(r, 3, officialOpenAIRelease)],
      ['top 3 has no generic official homepage/login page', (r) => noneTop(r, 3, (x) => isGenericOfficial(x.url))],
      ['top 5 has no social/low-trust junk', (r) => noneTop(r, 5, (x) => isBad(x.url))],
    ],
  },
  {
    query: 'Federal Reserve anti money laundering proposal July 2026',
    checks: [
      ['first result is a primary government source', (r) => firstUrl(r, primaryGov)],
      ['top 3 includes Fed/Federal Register/FinCEN', (r) => anyTop(r, 3, primaryGov)],
      ['top 3 primary sources are scored as high quality', (r) => sourceQualityAtLeast({ results: top(r, 3).filter(primaryGov) }, 3, 0.8)],
    ],
  },
  {
    query: 'Nvidia latest AI chip delay July 2026',
    checks: [
      ['top 3 includes NVIDIA or serious wire/editorial source', (r) => anyTop(r, 3, trustedNvidia)],
      ['top 2 does not contain AOL/MSN/content-farm junk', (r) => noneTop(r, 2, (x) => LOW_TRUST_RE.test(domain(x.url)))],
      ['top 5 has no social pages', (r) => noneTop(r, 5, (x) => SOCIAL_RE.test(domain(x.url)))],
    ],
  },
  {
    query: 'MrBeast latest video July 2026',
    checks: [
      ['routes through YouTube vertical', youtubeVertical],
      ['uses MrBeast channel-latest route', (r) => channelLatest(r, 'MrBeast')],
      ['top 3 are YouTube watch URLs for MrBeast', (r) => top(r, 3).every((x) => youtubeVideo(x) && /mrbeast/i.test(resultText(x)))],
    ],
  },
  {
    query: 'Watch Alex YouTube latest upload',
    checks: [
      ['routes through YouTube vertical', youtubeVertical],
      ['uses Watch Alex channel-latest route', (r) => channelLatest(r, 'Watch Alex')],
      ['top results are actual Watch Alex channel uploads', (r) => top(r, Math.min(2, r.results.length)).every((x) => youtubeVideo(x) && /Watch Alex|@Watch_Alex/i.test(resultText(x)))],
    ],
  },
  {
    query: 'cheap hotels near Incheon airport',
    checks: [
      ['top 5 includes a real hotel/travel booking source', (r) => anyTop(r, 5, hotelSource)],
      ['top 5 has no dictionary/gas keyword junk', (r) => noneTop(r, 5, (x) => JUNK_RE.test(domain(x.url)))],
    ],
  },
  {
    query: 'Mercor AI engineer matching latest',
    checks: [
      ['top 5 includes Mercor source', (r) => anyTop(r, 5, (x) => hostIs(x.url, 'mercor.com'))],
      ['top 3 has no social pages', (r) => noneTop(r, 3, (x) => SOCIAL_RE.test(domain(x.url)))],
    ],
  },
  {
    query: 'Stripe webhook signing secret rotation best practice',
    checks: [
      ['first result is Stripe official docs', (r) => firstUrl(r, (x) => hostIs(x.url, 'docs.stripe.com'))],
      ['top 3 includes Stripe docs', (r) => anyTop(r, 3, (x) => hostIs(x.url, 'docs.stripe.com'))],
      ['top 5 does not include Stripe dashboard/support as docs substitutes', (r) => noneTop(r, 5, (x) => hostIs(x.url, 'dashboard.stripe.com') || hostIs(x.url, 'support.stripe.com'))],
    ],
  },
  {
    query: 'DigitalOcean reserved IP DNS Google Cloud DNS certbot nginx',
    checks: [
      ['top 3 includes official infra docs/tutorial', (r) => anyTop(r, 3, officialInfraDoc)],
      ['top 3 does not include Cloudwards/content-farm junk', (r) => noneTop(r, 3, (x) => LOW_TRUST_RE.test(domain(x.url)))],
      ['daemon result is not Bing-only low-confidence', (r) => r.lowConfidence !== true],
    ],
  },
];

const rawCases = daemonCases.map((c) => c.query);

function checkRawConfidence(resp) {
  const sources = resp.sources || [];
  const hasQuality = sources.some((s) => QUALITY_ENGINES.has(s));
  return hasQuality || resp.lowConfidence === true;
}

function checkRawJunk(resp) {
  return noneTop(resp, 10, (x) => JUNK_RE.test(domain(x.url)));
}

function printResult(status, label) {
  if (!json) console.log(`${status.padEnd(5)} ${label}`);
}

async function runDaemonCase(client, spec) {
  const t0 = performance.now();
  const resp = await client.search(spec.query, {
    maxResults,
    recency,
    noCache: true,
    rerankTop: 4,
    youtube: true,
  });
  const ms = Math.round(performance.now() - t0);
  const failures = [];
  for (const [label, check] of spec.checks) {
    let ok = false;
    try { ok = !!check(resp); } catch { ok = false; }
    if (!ok) failures.push(label);
  }
  if (ms > 60_000) failures.push(`latency exceeded 60000ms (${ms}ms)`);
  // Fail-closed guard: a serious query answered without a quality engine must fail the suite —
  // "passing" with Bing-only junk is exactly the failure mode this harness exists to catch.
  if (resp.qualityFailure) failures.push('qualityFailure: no quality engine answered a serious query');
  return { mode: 'daemon', query: spec.query, ms, ok: failures.length === 0, failures, response: summarize(resp) };
}

async function runRawCase(query) {
  const t0 = performance.now();
  const resp = await search(query, { maxResults, freshness: recency, noCache: true });
  const ms = Math.round(performance.now() - t0);
  const failures = [];
  if (!checkRawConfidence(resp)) failures.push('raw result lacks quality engines but lowConfidence is not true');
  if (!checkRawJunk(resp)) failures.push('raw top 10 contains dictionary/gas keyword junk');
  if (ms > 20_000) failures.push(`raw latency exceeded 20000ms (${ms}ms)`);
  return { mode: 'raw', query, ms, ok: failures.length === 0, failures, response: summarize(resp) };
}

function summarize(resp) {
  return {
    lowConfidence: resp.lowConfidence,
    qualityFailure: resp.qualityFailure,
    usedFallback: resp.usedFallback,
    vertical: resp.vertical,
    reranked: resp.reranked,
    sources: resp.sources || [],
    engineReports: (resp.engineReports || []).map((e) => ({ engine: e.engine, status: e.status, count: e.count, ms: e.ms, note: e.note })),
    top: (resp.results || []).slice(0, 5).map((r, i) => ({
      rank: i + 1,
      title: r.title,
      url: r.url,
      engines: r.engines || [],
      score: r.score,
      sourceQuality: r.sourceQuality,
      sourceClass: r.sourceClass,
      rerankScore: r.rerankScore,
    })),
  };
}

async function main() {
  const rows = [];
  let daemonUp = false;
  let client;

  let bridge = null;
  if (!noDaemon) {
    client = new VortexDaemonClient({ timeoutMs: 90_000 });
    daemonUp = await client.healthy();
    if (!daemonUp) throw new Error('Vortex browser daemon is not healthy at http://127.0.0.1:4477');
    try {
      const h = await (await fetch('http://127.0.0.1:4477/health', { signal: AbortSignal.timeout(2000) })).json();
      bridge = h?.bridge || null;
    } catch { /* health probe best-effort */ }
    // A disconnected bridge means no google-session — every serious case would be judging Bing-only
    // output. That is a degraded environment, not a search-quality signal; fail fast and loudly.
    if (!bridge?.connected && !allowDegraded) {
      throw new Error('VANTA bridge is not connected — google-session unavailable, results would be degraded. '
        + 'Fix the bridge (open Chrome vanta profile / check daemon logs), or pass --allow-degraded to run anyway.');
    }
  }

  if (!json) {
    console.log(`Vortex search quality stress test`);
    console.log(`recency=${recency} maxResults=${maxResults} daemon=${!noDaemon} raw=${!noRaw}`);
    console.log('');
  }

  if (!noDaemon) {
    for (const spec of daemonCases) {
      const row = await runDaemonCase(client, spec);
      rows.push(row);
      printResult(row.ok ? 'PASS' : 'FAIL', `daemon ${row.ms}ms :: ${spec.query}`);
      for (const failure of row.failures) printResult('  -', failure);
    }
  }

  if (!noRaw) {
    for (const query of rawCases) {
      const row = await runRawCase(query);
      rows.push(row);
      printResult(row.ok ? 'PASS' : 'FAIL', `raw    ${row.ms}ms :: ${query}`);
      for (const failure of row.failures) printResult('  -', failure);
    }
  }

  const failed = rows.filter((r) => !r.ok);
  const payload = {
    ok: failed.length === 0,
    ranAt: new Date().toISOString(),
    daemonUp,
    bridge,
    totals: { cases: rows.length, failed: failed.length },
    metrics: computeMetrics(rows),
    rows,
  };
  writeArtifacts(payload);

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('');
    console.log(failed.length ? `FAIL ${failed.length}/${rows.length} cases failed` : `PASS ${rows.length}/${rows.length} cases passed`);
  }

  if (failed.length) process.exitCode = 1;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function computeMetrics(rows) {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const resp = (r) => r.response || {};
  const daemonRows = rows.filter((r) => r.mode === 'daemon');
  return {
    latencyMs: { p50: pct(ms, 50), p95: pct(ms, 95), max: ms[ms.length - 1] || 0 },
    lowConfidence: rows.filter((r) => resp(r).lowConfidence).length,
    qualityFailure: rows.filter((r) => resp(r).qualityFailure).length,
    googleSession: daemonRows.filter((r) => (resp(r).sources || []).includes('google-session')).length,
    bingOnly: daemonRows.filter((r) => {
      const s = resp(r).sources || [];
      return s.length > 0 && s.every((x) => x === 'bing' || x === 'mojeek');
    }).length,
    fallback: rows.filter((r) => resp(r).usedFallback).length,
  };
}

/** P2.2: persist every run — last.json for tooling, timestamped history for trend analysis, a summary.md
 * a human (or the next LLM) can read without parsing JSON. */
function writeArtifacts(payload) {
  try {
    const benchDir = join(REPO_ROOT, 'benchmarks');
    const histDir = join(benchDir, 'search-quality-history');
    mkdirSync(histDir, { recursive: true });
    const body = JSON.stringify(payload, null, 2);
    writeFileSync(join(benchDir, 'search-quality-last.json'), body);
    writeFileSync(join(histDir, `${payload.ranAt.replace(/[:.]/g, '-')}.json`), body);
    const m = payload.metrics;
    const lines = [
      `# Search quality stress — ${payload.ranAt}`,
      '',
      `**${payload.ok ? 'PASS' : 'FAIL'}** — ${payload.totals.cases - payload.totals.failed}/${payload.totals.cases} cases`,
      '',
      `- bridge connected: ${payload.bridge?.connected ?? 'n/a'}`,
      `- latency ms: p50 ${m.latencyMs.p50} · p95 ${m.latencyMs.p95} · max ${m.latencyMs.max}`,
      `- google-session answered: ${m.googleSession} · bing-only: ${m.bingOnly} · fallback used: ${m.fallback}`,
      `- lowConfidence: ${m.lowConfidence} · qualityFailure: ${m.qualityFailure}`,
      '',
      '| case | mode | ms | result | failures |',
      '|------|------|----|--------|----------|',
      ...payload.rows.map((r) => `| ${r.query} | ${r.mode} | ${r.ms} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.failures.join('; ') || '—'} |`),
      '',
    ];
    writeFileSync(join(benchDir, 'search-quality-summary.md'), lines.join('\n'));
  } catch (err) {
    console.error(`warn: failed to write benchmark artifacts: ${err?.message || err}`);
  }
}

main().catch((err) => {
  if (json) console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  else console.error(`FAIL ${err?.message || String(err)}`);
  process.exitCode = 1;
});
