#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { search, VortexDaemonClient } from '../packages/core/dist/index.js';

const args = process.argv.slice(2);
const flags = new Set(args);

const json = flags.has('--json');
const maxResults = Number(valueAfter('--max-results') || 10);
const recency = valueAfter('--recency') || 'month';
const onlyCase = valueAfter('--case');
const templatePath = valueAfter('--template');
// Default mode: evaluate the most recent RECORDED agent+Vortex run (benchmarks/frontier-answers-latest.json)
// as a regression snapshot — that file is the artifact of an agent driving Vortex through every case.
// `--baseline` forces the raw-search mode (expected to fail: raw SERPs can't synthesize answers/quotes).
const LATEST_ANSWERS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'benchmarks', 'frontier-answers-latest.json');
let answersPath = valueAfter('--answers');
if (!answersPath && !flags.has('--baseline') && !templatePath && existsSync(LATEST_ANSWERS)) answersPath = LATEST_ANSWERS;
const baseline = flags.has('--baseline') || (!answersPath && !templatePath);

function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function host(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^(www|m|amp)\./, ''); } catch { return ''; }
}

function pathOf(url) {
  try { return new URL(url).pathname || '/'; } catch { return '/'; }
}

function hostMatches(url, allowed) {
  const h = host(url);
  return allowed.some((d) => h === d || h.endsWith(`.${d}`));
}

function text(answer) {
  return `${answer.answer || ''} ${JSON.stringify(answer.data || {})}`.toLowerCase();
}

function citations(answer) {
  return Array.isArray(answer.citations) ? answer.citations : [];
}

function actions(answer) {
  return Array.isArray(answer.actions) ? answer.actions : [];
}

function hasExactQuote(c) {
  const q = String(c.quote || '').trim();
  return q.length >= 45 && !/^snippet:/i.test(q);
}

function hasField(answer, key) {
  return answer.data && Object.prototype.hasOwnProperty.call(answer.data, key) && String(answer.data[key] ?? '').trim().length > 0;
}

const cases = [
  {
    id: 'fed-aml-official-dossier',
    category: 'source-of-record + PDF/rulemaking',
    query: 'Federal Reserve anti money laundering proposal July 2026 official comment deadline Federal Register',
    task: [
      'Find the official July 2026 Federal Reserve AML/CFT proposal.',
      'Return the proposal title, publication/announcement date, comment deadline, affected rule/program, press release URL, PDF/proposal URL, and Federal Register URL if available.',
      'Use exact quotes from official sources, not SERP snippets.',
    ].join(' '),
    whyFrontier: 'Requires official-source routing, PDF/Federal Register follow-up, date extraction, and quoted evidence.',
    officialDomains: ['federalreserve.gov', 'federalregister.gov', 'fincen.gov'],
    requiredFields: ['title', 'announcementDate', 'commentDeadline', 'pressReleaseUrl', 'proposalUrl'],
    requiredTerms: ['anti-money laundering', 'comment'],
    minOfficialCitations: 2,
    minExactQuotes: 2,
  },
  {
    id: 'nvidia-delay-truth-reconciliation',
    category: 'conflicting current news reconciliation',
    query: 'Nvidia latest AI chip delay July 2026 circuit board problem official response Reuters',
    task: [
      'Determine whether the alleged July 2026 NVIDIA AI-chip delay is confirmed, denied, or unresolved.',
      'Separate the original claim from NVIDIA/primary response and serious wire/editorial coverage.',
      'Return status, evidence for and against, and confidence.',
    ].join(' '),
    whyFrontier: 'Requires contradiction handling instead of ranking the most keyword-matching article.',
    officialDomains: ['nvidia.com', 'nvidianews.nvidia.com', 'reuters.com', 'bloomberg.com', 'wsj.com', 'cnbc.com', 'theverge.com', 'semianalysis.com'],
    forbiddenDomains: ['aol.com', 'msn.com', 'beincrypto.com', 'marketbeat.com'],
    requiredFields: ['status', 'claimSource', 'bestEvidenceUrl'],
    allowedFieldValues: { status: ['confirmed', 'denied', 'unresolved', 'mixed'] },
    requiredTerms: ['nvidia', 'delay'],
    minOfficialCitations: 2,
    minExactQuotes: 1,
  },
  {
    id: 'stripe-webhook-secret-rotation-runbook',
    category: 'official technical docs + implementation runbook',
    query: 'Stripe webhook signing secret rotation roll secret overlap official docs',
    task: [
      'Produce the safest documented procedure for rotating a Stripe webhook signing secret.',
      'Include dashboard path or API/CLI path if documented, overlap/rollback behavior, verification requirement, and what not to commit.',
      'Prefer official Stripe docs; third-party guides are allowed only as secondary notes.',
    ].join(' '),
    whyFrontier: 'Requires official docs over high-SEO implementation posts, and must extract operational details from docs pages.',
    officialDomains: ['docs.stripe.com', 'stripe.com'],
    forbiddenDomains: ['dashboard.stripe.com', 'support.stripe.com'],
    requiredFields: ['procedure', 'overlapBehavior', 'verificationStep', 'officialDocUrl'],
    requiredTerms: ['webhook', 'signing secret', 'rotate'],
    minOfficialCitations: 1,
    minExactQuotes: 2,
  },
  {
    id: 'do-google-dns-certbot-migration-plan',
    category: 'multi-source devops plan',
    query: 'DigitalOcean reserved IP Google Cloud DNS certbot nginx migration official docs',
    task: [
      'Create a no-surprises migration checklist for moving A records in Google Cloud DNS to a DigitalOcean Reserved IP and then issuing nginx certs with certbot.',
      'Cite DigitalOcean Reserved IP docs, Google Cloud DNS record-set docs, and Certbot/nginx docs.',
      'Include verification commands before and after the DNS cutover.',
    ].join(' '),
    whyFrontier: 'Requires synthesizing several official docs plus local CLI verification commands.',
    officialDomains: ['docs.digitalocean.com', 'digitalocean.com', 'cloud.google.com', 'certbot.eff.org', 'eff.org', 'nginx.org'],
    forbiddenDomains: ['cloudwards.net', 'digitaloceanpro.com', 'medium.com'],
    requiredFields: ['dnsChange', 'reservedIpDocUrl', 'googleDnsDocUrl', 'certbotCommand', 'verificationCommands'],
    requiredTerms: ['reserved ip', 'google cloud dns', 'certbot', 'nginx'],
    minOfficialCitations: 3,
    minExactQuotes: 2,
    requiredActions: ['shell'],
  },
  {
    id: 'youtube-arbitrary-channel-latest',
    category: 'canonical channel resolution',
    query: 'latest upload from Watch Alex MrBeast and NASA YouTube channels canonical upload feeds',
    task: [
      'Resolve three channel names to canonical YouTube channel IDs/handles and latest upload URLs: Watch Alex, MrBeast, and NASA.',
      'Do not use flat YouTube search ranking as the source of truth; use channel upload feeds or InnerTube-equivalent channel resolution.',
      'Return channelId, handle, latestVideoTitle, latestVideoUrl, and how it was resolved for each channel.',
    ].join(' '),
    whyFrontier: 'Current Vortex has only a tiny known-channel map; future browsing needs arbitrary channel resolution.',
    officialDomains: ['youtube.com'],
    requiredFields: ['channels'],
    requiredTerms: ['watch alex', 'mrbeast', 'nasa'],
    minOfficialCitations: 3,
    minExactQuotes: 0,
    custom(answer) {
      const channels = Array.isArray(answer.data?.channels) ? answer.data.channels : [];
      const names = channels.map((c) => String(c.name || c.handle || '').toLowerCase());
      const missing = ['watch alex', 'mrbeast', 'nasa'].filter((n) => !names.some((x) => x.includes(n.replace(' ', '')) || x.includes(n)));
      const allHaveIds = channels.length >= 3 && channels.every((c) => /^UC[\w-]{10,}$/.test(String(c.channelId || '')) && /youtube\.com\/watch\?v=/.test(String(c.latestVideoUrl || '')));
      return missing.length === 0 && allHaveIds ? [] : [`channel resolution incomplete: missing=${missing.join(',') || 'none'}`];
    },
  },
  {
    id: 'icn-hotel-bookable-comparison',
    category: 'dynamic commerce/travel interaction',
    query: 'cheap refundable hotels near Incheon airport airport shuttle August 26 2026 one night',
    task: [
      'Find three bookable hotels near Incheon Airport for one night starting 2026-08-26.',
      'Each option must include price, taxes/fees handling, cancellation/refund policy, distance or shuttle/terminal-access evidence, and booking source URL.',
      'Do not book anything.',
    ].join(' '),
    whyFrontier: 'Requires interacting with dynamic travel sites, extracting changing prices, and preserving transaction safety.',
    officialDomains: ['booking.com', 'expedia.com', 'hotels.com', 'agoda.com', 'trip.com', 'kayak.com', 'skyscanner.com', 'tripadvisor.com'],
    forbiddenDomains: ['reddit.com', 'quora.com', 'pinterest.com'],
    requiredFields: ['options'],
    requiredTerms: ['incheon', 'airport'],
    minOfficialCitations: 3,
    minExactQuotes: 0,
    requiredActions: ['browser_interaction'],
    custom(answer) {
      const options = Array.isArray(answer.data?.options) ? answer.data.options : [];
      const complete = options.length >= 3 && options.every((o) =>
        o.name && o.price && o.sourceUrl && (o.cancellation || o.refundable) && (o.distance || o.shuttle || o.terminalAccess)
      );
      return complete ? [] : ['needs 3 complete bookable hotel options with price, refund/cancellation, and airport-access evidence'];
    },
  },
  {
    id: 'openai-model-release-changelog-diff',
    category: 'temporal changelog diff',
    query: 'OpenAI latest model release July 2026 model release notes official changelog',
    task: [
      'Find the newest official OpenAI model release as of today and distinguish it from ChatGPT product release notes.',
      'Return model name, release date, availability/scope, the previous model it supersedes if stated, and official citations.',
      'Explain uncertainty if the official docs conflict with news coverage.',
    ].join(' '),
    whyFrontier: 'Requires official changelog diffing, not simply ranking the Help Center above a release article.',
    officialDomains: ['openai.com', 'help.openai.com'],
    requiredFields: ['modelName', 'releaseDate', 'availability', 'officialReleaseUrl'],
    requiredTerms: ['openai', 'model'],
    minOfficialCitations: 2,
    minExactQuotes: 2,
  },
  {
    id: 'local-cli-plus-web-dns-audit',
    category: 'native CLI + browser hybrid',
    query: 'audit current DNS for avantimediagroup.com against Google Cloud DNS DigitalOcean Reserved IP certbot nginx docs',
    task: [
      'Use local CLI DNS probes and official web docs to audit whether avantimediagroup.com, www, scripts, avantfutures.com, and www.avantfutures.com point to the intended DigitalOcean Reserved IP.',
      'Return observed A records, intended target, risk if mismatched, and exact next commands for DNS/TLS verification.',
      'Do not make any DNS, Stripe, or server changes.',
    ].join(' '),
    whyFrontier: 'Future native AI CLI browsing should combine shell observations, local memory, official docs, and safety constraints.',
    officialDomains: ['cloud.google.com', 'docs.digitalocean.com', 'digitalocean.com', 'certbot.eff.org'],
    requiredFields: ['observedRecords', 'intendedTarget', 'mismatches', 'verificationCommands'],
    requiredTerms: ['dns', 'reserved ip', 'certbot'],
    minOfficialCitations: 2,
    minExactQuotes: 1,
    requiredActions: ['shell'],
    custom(answer) {
      const observed = answer.data?.observedRecords;
      if (!observed || typeof observed !== 'object') return ['missing observedRecords from local DNS probes'];
      return Object.keys(observed).length >= 5 ? [] : ['observedRecords must include all 5 Avanti hostnames'];
    },
  },
];

function evaluateCase(spec, answer) {
  const failures = [];
  const allCitations = citations(answer);
  const official = allCitations.filter((c) => c.url && hostMatches(c.url, spec.officialDomains || []));
  const forbidden = allCitations.filter((c) => c.url && hostMatches(c.url, spec.forbiddenDomains || []));
  const exactQuotes = allCitations.filter(hasExactQuote);
  const body = text(answer);

  if (!String(answer.answer || '').trim()) failures.push('missing synthesized answer');
  if (typeof answer.confidence !== 'number') failures.push('missing numeric confidence');
  for (const field of spec.requiredFields || []) if (!hasField(answer, field)) failures.push(`missing data.${field}`);
  for (const term of spec.requiredTerms || []) if (!body.includes(term.toLowerCase())) failures.push(`answer/data missing term: ${term}`);
  if (official.length < (spec.minOfficialCitations || 0)) failures.push(`needs ${spec.minOfficialCitations} official citations, got ${official.length}`);
  if (exactQuotes.length < (spec.minExactQuotes || 0)) failures.push(`needs ${spec.minExactQuotes} exact quotes, got ${exactQuotes.length}`);
  if (forbidden.length) failures.push(`forbidden citations present: ${forbidden.map((c) => host(c.url)).join(', ')}`);

  for (const required of spec.requiredActions || []) {
    if (!actions(answer).some((a) => a.type === required)) failures.push(`missing action evidence: ${required}`);
  }

  for (const [field, allowed] of Object.entries(spec.allowedFieldValues || {})) {
    const value = String(answer.data?.[field] || '').toLowerCase();
    if (!allowed.includes(value)) failures.push(`data.${field} must be one of ${allowed.join(', ')}`);
  }

  if (spec.custom) failures.push(...spec.custom(answer));
  return failures;
}

async function baselineAttempt(client, spec) {
  const t0 = performance.now();
  let resp;
  if (client) {
    resp = await client.search(spec.query, { maxResults, recency, noCache: true, rerankTop: 4, youtube: true });
  } else {
    resp = await search(spec.query, { maxResults, freshness: recency, noCache: true });
  }
  return {
    caseId: spec.id,
    answer: '',
    confidence: null,
    data: {},
    actions: [{ type: client ? 'daemon_search' : 'raw_search', query: spec.query, ms: Math.round(performance.now() - t0) }],
    citations: (resp.results || []).slice(0, 5).map((r) => ({
      title: r.title,
      url: r.url,
      quote: r.snippet ? `snippet: ${r.snippet}` : '',
      sourceQuality: r.sourceQuality,
      engines: r.engines,
    })),
    rawResponse: {
      sources: resp.sources || [],
      lowConfidence: resp.lowConfidence,
      usedFallback: resp.usedFallback,
      vertical: resp.vertical,
      engineReports: resp.engineReports || [],
    },
  };
}

async function loadAnswers(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(parsed)) return Object.fromEntries(parsed.map((a) => [a.caseId, a]));
  if (parsed.answers) return parsed.answers;
  return parsed;
}

function answerTemplate() {
  return {
    generatedAt: new Date().toISOString(),
    answers: Object.fromEntries(cases.map((c) => [c.id, {
      caseId: c.id,
      answer: '',
      confidence: 0,
      data: Object.fromEntries((c.requiredFields || []).map((f) => [f, ''])),
      actions: [],
      citations: [{ title: '', url: '', quote: '' }],
    }])),
  };
}

function compactCase(c) {
  return {
    id: c.id,
    category: c.category,
    query: c.query,
    task: c.task,
    whyFrontier: c.whyFrontier,
    requiredFields: c.requiredFields || [],
    officialDomains: c.officialDomains || [],
    forbiddenDomains: c.forbiddenDomains || [],
    minOfficialCitations: c.minOfficialCitations || 0,
    minExactQuotes: c.minExactQuotes || 0,
    requiredActions: c.requiredActions || [],
  };
}

async function main() {
  const selected = onlyCase ? cases.filter((c) => c.id === onlyCase) : cases;
  if (!selected.length) throw new Error(`unknown --case ${onlyCase}`);

  if (templatePath) {
    await writeFile(templatePath, JSON.stringify(answerTemplate(), null, 2));
    if (!json) console.log(`Wrote answer template: ${templatePath}`);
    return;
  }

  let answers = {};
  let client = null;
  let daemonUp = false;

  if (answersPath) {
    answers = await loadAnswers(answersPath);
  } else if (baseline) {
    client = new VortexDaemonClient({ timeoutMs: 90_000 });
    daemonUp = await client.healthy();
    if (!daemonUp) client = null;
    for (const spec of selected) answers[spec.id] = await baselineAttempt(client, spec);
  }

  const rows = selected.map((spec) => {
    const answer = answers[spec.id] || {};
    const failures = evaluateCase(spec, answer);
    return {
      id: spec.id,
      category: spec.category,
      ok: failures.length === 0,
      failures,
      case: compactCase(spec),
      answer,
    };
  });
  const failed = rows.filter((r) => !r.ok);
  const payload = {
    ok: failed.length === 0,
    expectedCurrentBaseline: 'fail',
    mode: answersPath ? 'answers' : 'baseline',
    daemonUp,
    totals: { cases: rows.length, failed: failed.length },
    rows,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('Vortex frontier web-browsing benchmark');
    console.log('This is supposed to be hard. Current Vortex baseline is expected to fail.');
    console.log(`mode=${payload.mode} daemonUp=${daemonUp} cases=${rows.length}`);
    console.log('');
    for (const row of rows) {
      console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.id} :: ${row.category}`);
      for (const f of row.failures) console.log(`  - ${f}`);
    }
    console.log('');
    console.log(failed.length ? `FRONTIER FAIL ${failed.length}/${rows.length} cases failed` : `FRONTIER PASS ${rows.length}/${rows.length}`);
  }

  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  if (json) console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  else console.error(`FAIL ${err?.message || String(err)}`);
  process.exitCode = 1;
});
