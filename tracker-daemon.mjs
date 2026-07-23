#!/usr/bin/env node
// Vortex local-oracle daemon: runs the watchlist tracker + the primary-source distress engine,
// writes a "what's new" digest, surfaces it. Pure-fetch (search + RSS + primary APIs) — no browser
// launch. Run on a schedule via launchd (com.avanti.vortex-tracker, calendar-scheduled).
//
// Delivery (2026-07-23, Steve-approved): push ONLY when something HIGH-priority landed (primary-source
// + fresh). Everything else is written to the digest file + KB and rides the 7am daily brief — no
// 4x/day buzz for routine mentions. The digest at $VORTEX_TRACKER_DIR/latest-digest.md stays the
// machine-readable source the session hook reads (highest-signal entities sorted to the top so the
// hook's 800-byte window catches them).
import { AgentBrowser, track, fetchDistressLeads } from './packages/core/dist/index.js';
import { readFile, writeFile, appendFile, mkdir, access } from 'node:fs/promises';

const DIR = process.env.VORTEX_TRACKER_DIR || `${process.env.HOME}/.vortex-tracker`;
const DIGEST = `${DIR}/latest-digest.md`;
const LOG = `${DIR}/digest-log.jsonl`;
const DSTATE = `${DIR}/distress-state.json`;
const KB_INTEL_DIR = `${process.env.HOME}/Avant-Futures-KB/Intel/Vortex-Tracker`;

/** All high-priority new items across entities, flattened (entity carried on each item). */
function collectHigh(d) {
  const out = [];
  for (const [entity, v] of Object.entries(d.byEntity)) {
    for (const m of v.new) if (m.priority === 'high') out.push({ entity, ...m });
  }
  return out;
}

function fmt(d) {
  const lines = [`# Vortex Tracker — new developments`, `_ran ${d.ranAt} · ${d.entities} entities · ${d.newMentions} new_`, ''];

  // High-priority section first — the reason a push fired, and the first thing any reader should see.
  const high = collectHigh(d);
  if (high.length) {
    lines.push(`## ⚡ High priority`);
    for (const m of high) lines.push(`- **${m.entity}** — ${m.title}${m.date ? ` _(${String(m.date).slice(0, 16)})_` : ''}\n  ${m.url}`);
    lines.push('');
  }

  // Cross-entity URL dedupe: one story matching 3 entities prints ONCE (under its first entity by
  // sort order) with an "(also: ...)" suffix, instead of 3 copies bloating the digest.
  const urlEntities = new Map();
  for (const [entity, v] of Object.entries(d.byEntity)) {
    for (const m of v.new) {
      if (!urlEntities.has(m.url)) urlEntities.set(m.url, []);
      urlEntities.get(m.url).push(entity);
    }
  }
  // Entity order: any-high first, then by new-mention count desc — the session hook reads only the
  // first ~800 bytes, so the highest-signal entities must lead.
  const entries = Object.entries(d.byEntity).sort(([, a], [, b]) => {
    const ah = a.new.some((m) => m.priority === 'high') ? 1 : 0;
    const bh = b.new.some((m) => m.priority === 'high') ? 1 : 0;
    if (ah !== bh) return bh - ah;
    return b.new.length - a.new.length;
  });

  const printed = new Set();
  for (const [entity, v] of entries) {
    if (!v.new.length) continue;
    lines.push(`## ${entity}  (${v.new.length} new / ${v.totalKnown} tracked)`);
    const rest = v.new.filter((m) => !printed.has(m.url));
    for (const m of rest.slice(0, 8)) {
      printed.add(m.url);
      const others = (urlEntities.get(m.url) || []).filter((e) => e !== entity);
      const also = others.length ? ` _(also: ${others.join(', ')})_` : '';
      lines.push(`- ${m.title}${m.date ? ` _(${String(m.date).slice(0, 16)})_` : ''}${also}\n  ${m.url}`);
    }
    if (rest.length > 8) lines.push(`- _+${rest.length - 8} more_`);
    if (!rest.length) lines.push(`- _all ${v.new.length} shown under other entities_`);
    lines.push('');
  }
  if (d.newMentions === 0) lines.push('_nothing new since last run._');
  return lines.join('\n');
}

// NTFY_URL from env, falling back to ~/.avanti-brain.env (last assignment wins, same as shell sourcing).
async function ntfyUrl() {
  if (process.env.NTFY_URL) return process.env.NTFY_URL;
  try {
    const env = await readFile(`${process.env.HOME}/.avanti-brain.env`, 'utf8');
    const m = [...env.matchAll(/^(?:export\s+)?NTFY_URL=(\S+)/gm)];
    return m.length ? m[m.length - 1][1] : null;
  } catch { return null; }
}

// Urgent-only push: fires ONLY for high-priority items, and the body is ONLY those items.
async function pushNtfy(high) {
  const url = await ntfyUrl();
  if (!url) return 'ntfy: no NTFY_URL';
  const lines = high.slice(0, 10).map((m) => `${m.entity}: ${m.title}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      // HTTP header values are Latin-1 only — keep headers ASCII (em-dash breaks fetch).
      headers: {
        Title: `Vortex Tracker - ${high.length} high-signal`,
        'X-Priority': '4',
        Tags: 'rotating_light',
        'X-Click': high[0].url,
      },
      body: lines.join('\n'),
    });
    return `ntfy: ${res.status}`;
  } catch (e) { return `ntfy: FAILED ${e?.message || e}`; }
}

// Append the run's digest to a per-day KB note. Skipped silently when the SSD/KB isn't mounted.
async function writeKb(digest, md) {
  try { await access(`${process.env.HOME}/Avant-Futures-KB`); } catch { return 'kb: not mounted'; }
  try {
    await mkdir(KB_INTEL_DIR, { recursive: true });
    const day = digest.ranAt.slice(0, 10);
    const path = `${KB_INTEL_DIR}/${day}.md`;
    let isNew = false;
    try { await access(path); } catch { isNew = true; }
    const header = isNew ? `# Vortex Tracker — ${day}\n\n> Auto-generated by tracker-daemon. Watchlist intel, junk-filtered. See [[Agent/MEMORY/project_vortex_tracker]].\n\n` : '\n---\n\n';
    await appendFile(path, header + md.split('\n').slice(2).join('\n') + '\n');
    return `kb: ${path}`;
  } catch (e) { return `kb: FAILED ${e?.message || e}`; }
}

const b = new AgentBrowser(); // track() is pure-fetch; never opened
try {
  const digest = await track(b, { perEntity: 10 });
  await mkdir(DIR, { recursive: true });

  // Distress engine: primary-source Delisted leads (SEC/NYSE/Nasdaq/CourtListener/HN), merged into
  // the digest under their mapped entities. State (snapshots + dedupe) persists next to the digest.
  let distressCount = 0;
  try {
    let dstate = {};
    try { dstate = JSON.parse(await readFile(DSTATE, 'utf8')); } catch { /* first run */ }
    const { leads, state } = await fetchDistressLeads(dstate);
    await writeFile(DSTATE, JSON.stringify(state, null, 2));
    for (const l of leads) {
      const bucket = (digest.byEntity[l.entity] ||= { new: [], totalKnown: 0 });
      bucket.new.push({ entity: l.entity, title: l.title, url: l.url, source: `distress:${l.kind}`, date: l.date, priority: l.priority, firstSeen: digest.ranAt });
      bucket.totalKnown++;
      digest.newMentions++;
      distressCount++;
    }
  } catch (e) { console.error(`[vortex-tracker] distress: FAILED ${e?.message || e}`); }

  const md = fmt(digest);
  await writeFile(DIGEST, md);
  await appendFile(LOG, JSON.stringify({ ranAt: digest.ranAt, newMentions: digest.newMentions, distress: distressCount, byEntity: Object.fromEntries(Object.entries(digest.byEntity).map(([e, v]) => [e, v.new.length])) }) + '\n');

  // Push policy (Steve-approved 2026-07-23): urgent-only. Push iff >=1 high-priority item; body is
  // the high items only. Everything else still lands in the digest + KB for the 7am brief.
  const high = collectHigh(digest);
  const parts = [];
  if (high.length) parts.push(await pushNtfy(high));
  else parts.push('no high-priority - no push');
  if (digest.newMentions > 0) parts.push(await writeKb(digest, md));
  const delivered = parts.join(' · ');

  // Optional surfacing to Slack (set VORTEX_SLACK_WEBHOOK) — only when there's something new.
  if (digest.newMentions > 0 && process.env.VORTEX_SLACK_WEBHOOK) {
    const top = Object.entries(digest.byEntity).filter(([, v]) => v.new.length).map(([e, v]) => `*${e}* (${v.new.length}): ${v.new[0].title}`).join('\n');
    try { await fetch(process.env.VORTEX_SLACK_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `🔭 Vortex tracker — ${digest.newMentions} new:\n${top}` }) }); } catch { /* */ }
  }
  console.error(`[vortex-tracker] ${digest.newMentions} new (${distressCount} distress, ${high.length} high) across ${digest.entities} entities → ${DIGEST} · ${delivered}`);
} catch (e) {
  console.error(`[vortex-tracker] FAILED: ${e?.message || e}`);
  process.exit(1);
}
process.exit(0);
