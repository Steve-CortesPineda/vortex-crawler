#!/usr/bin/env node
// Vortex local-oracle daemon: runs the watchlist tracker, writes a "what's new" digest, surfaces it.
// Pure-fetch (search + RSS) — no browser launch. Run on a schedule via cron or a launchd/systemd service.
import { AgentBrowser, track } from './packages/core/dist/index.js';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';

const DIR = process.env.VORTEX_TRACKER_DIR || `${process.env.HOME}/.vortex-tracker`;
const DIGEST = `${DIR}/latest-digest.md`;
const LOG = `${DIR}/digest-log.jsonl`;

function fmt(d) {
  const lines = [`# Vortex Tracker — new developments`, `_ran ${d.ranAt} · ${d.entities} entities · ${d.newMentions} new_`, ''];
  for (const [entity, v] of Object.entries(d.byEntity)) {
    if (!v.new.length) continue;
    lines.push(`## ${entity}  (${v.new.length} new / ${v.totalKnown} tracked)`);
    for (const m of v.new.slice(0, 8)) lines.push(`- ${m.title}${m.date ? ` _(${m.date.slice(0, 16)})_` : ''}\n  ${m.url}`);
    lines.push('');
  }
  if (d.newMentions === 0) lines.push('_nothing new since last run._');
  return lines.join('\n');
}

const b = new AgentBrowser(); // track() is pure-fetch; never opened
try {
  const digest = await track(b, { perEntity: 6 });
  await mkdir(DIR, { recursive: true });
  await writeFile(DIGEST, fmt(digest));
  await appendFile(LOG, JSON.stringify({ ranAt: digest.ranAt, newMentions: digest.newMentions, byEntity: Object.fromEntries(Object.entries(digest.byEntity).map(([e, v]) => [e, v.new.length])) }) + '\n');

  // Optional surfacing to Slack (set VORTEX_SLACK_WEBHOOK) — only when there's something new.
  if (digest.newMentions > 0 && process.env.VORTEX_SLACK_WEBHOOK) {
    const top = Object.entries(digest.byEntity).filter(([, v]) => v.new.length).map(([e, v]) => `*${e}* (${v.new.length}): ${v.new[0].title}`).join('\n');
    try { await fetch(process.env.VORTEX_SLACK_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `🔭 Vortex tracker — ${digest.newMentions} new:\n${top}` }) }); } catch { /* */ }
  }
  console.error(`[vortex-tracker] ${digest.newMentions} new across ${digest.entities} entities → ${DIGEST}`);
} catch (e) {
  console.error(`[vortex-tracker] FAILED: ${e?.message || e}`);
  process.exit(1);
}
process.exit(0);
