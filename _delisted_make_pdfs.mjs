// Delisted — build 3 role-specific PDFs per script (reader / editor / thumbnail).
// Renders styled HTML -> PDF via Playwright page.pdf(). Run from vortex-crawler (has playwright).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const BASE = '/Volumes/AVANTI/Projects/Delisted';
const SRC  = `${BASE}/scripts`;
const OUT = {
  reader: `${BASE}/1_Reading_Steve`,
  editor: `${BASE}/2_Video_Editor`,
  thumb:  `${BASE}/3_Thumbnail_Art`,
};
const SCRIPTS = [
  { id: '01', topic: 'Wirecard', file: '01_wirecard.md', lead: 'The €1.9 Billion That Never Existed' },
  { id: '02', topic: 'Enron',    file: '02_enron.md',    lead: 'The Smartest Guys in the Room' },
  { id: '03', topic: 'FTX',      file: '03_ftx.md',      lead: 'The $8 Billion That Vanished' },
];

/* ---------- tiny, safe markdown -> html ---------- */
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function inline(s){
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/`(.+?)`/g,'<code>$1</code>');
}
function mdToHtml(md){
  const lines = md.split('\n');
  let html = '', inUl = false, inBq = false, bq = [];
  const closeUl = () => { if (inUl){ html += '</ul>'; inUl = false; } };
  const closeBq = () => { if (inBq){ html += '<blockquote>' + bq.join('<br>') + '</blockquote>'; inBq = false; bq = []; } };
  for (const raw of lines){
    const line = raw.replace(/\s+$/,'');
    if (line.trim() === '[[PAGEBREAK]]'){ closeUl(); closeBq(); html += '<div class="pb"></div>'; continue; }
    if (/^> /.test(line)){ closeUl(); inBq = true; bq.push(inline(line.slice(2))); continue; }
    closeBq();
    if (/^### /.test(line)){ closeUl(); html += `<h3>${inline(line.slice(4))}</h3>`; }
    else if (/^## /.test(line)){ closeUl(); html += `<h2>${inline(line.slice(3))}</h2>`; }
    else if (/^# /.test(line)){ closeUl(); html += `<h1>${inline(line.slice(2))}</h1>`; }
    else if (/^---+$/.test(line)){ closeUl(); html += '<hr>'; }
    else if (/^[-*] /.test(line)){ if (!inUl){ html += '<ul>'; inUl = true; } html += `<li>${inline(line.slice(2))}</li>`; }
    else if (line.trim() === ''){ closeUl(); }
    else { closeUl(); html += `<p>${inline(line)}</p>`; }
  }
  closeUl(); closeBq();
  return html;
}

const CSS = `
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.62; color: #1b1b1b; }
  .doc-tag { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 8.5pt; letter-spacing: .14em; text-transform: uppercase; color: #B45309; font-weight: 700; margin: 0 0 2mm; }
  h1 { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 21pt; line-height: 1.15; margin: 0 0 3mm; padding-bottom: 3mm; border-bottom: 2px solid #1b1b1b; }
  h2 { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 13.5pt; color: #9a4d00; margin: 7mm 0 2mm; break-after: avoid; }
  h3 { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 11.5pt; color: #1b1b1b; margin: 5mm 0 1.5mm; break-after: avoid; letter-spacing: .01em; }
  p { margin: 0 0 2.6mm; }
  strong { color: #111; }
  em { color: #444; }
  code { font-family: 'SF Mono', Menlo, monospace; font-size: 9.5pt; background: #f2efe9; padding: 0 2px; border-radius: 3px; }
  hr { border: none; border-top: 1px solid #d8d2c6; margin: 5mm 0; }
  ul { margin: 0 0 3mm; padding-left: 6mm; }
  li { margin: 0 0 1.2mm; break-inside: avoid; }
  blockquote { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 9.8pt; line-height: 1.5; color: #2b2b2b; background: #faf6ee; border-left: 3px solid #E8943A; margin: 0 0 3mm; padding: 2.4mm 3.4mm; break-inside: avoid; }
  blockquote strong { color: #9a4d00; }
  .pb { break-before: page; }
`;

function htmlDoc(tag, bodyMd){
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
  <body><p class="doc-tag">${tag}</p>${mdToHtml(bodyMd)}</body></html>`;
}

/* ---------- slice helpers ---------- */
function voBody(md){
  const a = md.indexOf('## HOOK');
  let b = md.indexOf('### Metadata');
  if (b < 0) b = md.length;
  return md.slice(a < 0 ? 0 : a, b).trim();
}

/* ---------- EDITOR cue-sheets (per topic) ---------- */
const EDITOR_CUES = {
Wirecard: `# WIRECARD — Editor Cut Sheet
**Runtime target:** ~24–25 min · **Narration:** ~130 wpm, deliberate; hard pause on every reveal.
**On-screen text:** big bold sans numbers on every reveal (€1.9B, €24B, 7 DAYS). White on dark, high contrast.
**Music spine:** low ominous drone (Act 1–2) → investigative tension (Act 2–3) → dread crescendo that DROPS to near-silence on the €1.9B reveal (Act 4) → cold thriller ambient (Act 5, Marsalek) → reflective build (Act 6).
**B-roll banks:** Frankfurt/Munich skyline, DAX ticker board, payment terminals, server rooms, EY/auditor offices, Manila banks, private jets, Moscow/Minsk. Archival: Wirecard logo, Markus Braun (black turtleneck), FT headlines, Jan Marsalek photos, BaFin pressers, Interpol red notice. Graphics: round-tripping money-loop, trustee→escrow→bank chain, stock-crash chart.

## VISUAL & PACING PLAN

### HOOK — 0:00–0:30
> **Visuals:** slow push into a dark, empty bank vault; the words "€1.9 BILLION" assemble in light, then shatter into particles.
> **On-screen:** €1.9 BILLION  ·  "never existed"
> **Music/SFX:** single sustained drone; low boom on the shatter; cut to silence.
> **Pacing:** hard stop after "…did not exist."

### INTRO — 0:30–1:20
> **Visuals:** Frankfurt skyline, DAX board, Wirecard HQ exterior, fast montage of global news headlines.
> **On-screen:** DAX 30  ·  €24 BILLION VALUATION
> **Music:** low pulse enters and builds.

### ACT 1 — The Impossible Rise — 1:20–4:30
> **Visuals:** early-2000s internet/payments montage, card terminals, Braun turtleneck archival, rising stock chart; the DAX swap where Wirecard replaces Commerzbank.
> **Graphic:** "third-party acquiring" money-flow diagram (the business nobody could quite explain).
> **On-screen:** 2018 — WIRECARD > COMMERZBANK
> **Music:** hopeful-but-uneasy ascent.

### ACT 2 — The People Who Saw It — 4:30–8:00
> **Visuals:** Financial Times building/logo, a journalist at a desk, short-seller trading floor, the "Zatarra" report, Singapore skyline, whistleblower silhouette.
> **Graphic:** round-tripping loop animation — money leaves, circles, returns booked as "revenue."
> **On-screen:** ROUND-TRIPPING
> **Music:** investigative tension, ticking.

### ACT 3 — When the Referee Picked a Side — 8:00–12:00
> **Visuals:** BaFin building, German regulator presser, FT front pages, a gavel, "short-selling ban" headlines, prosecutors filing against journalists.
> **On-screen:** THE REGULATOR BANNED SHORTING — NOT THE FRAUD
> **Music:** ironic, foreboding. **Pacing:** let the absurdity land.

### ACT 4 — The Number That Wasn't There — 12:00–16:30
> **Visuals:** EY auditor offices, escrow/trustee paperwork, Manila (BDO / BPI), formal letters, an account screen reading zero.
> **Graphic:** trustee → escrow → bank chain; the two accounts light up… EMPTY.
> **On-screen:** €1.9B — NOT THERE
> **Music:** dread crescendo, then DROP to silence on the reveal.

### ACT 5 — The Ghost: Jan Marsalek — 16:30–21:00
> **Visuals:** Marsalek photos, a private jet on a night tarmac, departure boards, Minsk→Moscow maps, passport stamps, Interpol red notice, intelligence/spy motifs.
> **On-screen:** WANTED  ·  JAN MARSALEK
> **Music:** cold thriller ambient. **Pacing:** slower, mysterious.

### ACT 6 — Why This Keeps Happening — 21:00–23:30
> **Visuals:** montage of the watchdogs that didn't watch — auditors, regulators, retail trading apps, ordinary investors.
> **On-screen:** WHO WAS ACTUALLY WATCHING?
> **Music:** reflective, building to resolve.

### OUTRO + CTA — 23:30–25:00
> **Visuals:** dark recap of the film's signature images; end card with channel logo + the Enron thumbnail as "next."
> **On-screen:** NEXT — ENRON  ·  SUBSCRIBE
> **Music:** resolve, with a hook into the next story.

[[PAGEBREAK]]
## FULL NARRATION (VO)
`,
Enron: `# ENRON — Editor Cut Sheet
**Runtime target:** ~22–24 min · **Narration:** ~130 wpm, deliberate; hard pause on every reveal.
**On-screen text:** bold sans numbers ($90 → $0, 20,000 JOBS, $60B). White on dark, high contrast.
**Music spine:** ominous drone (Hook) → clever-turning-sinister (Act 2, mark-to-market) → secretive (Act 3, SPEs) → hubris swagger (Act 4) → collapse with a heartbeat pulse (Act 5) → somber (Act 6).
**B-roll banks:** Houston skyline, Enron tower, pipelines/gas infrastructure, trading floors, Fortune covers, SEC building, shredders, employees with boxes. Archival: Ken Lay, Jeff Skilling, Andrew Fastow, Arthur Andersen, Dynegy. Graphics: pipes→paper transformation, mark-to-market timeline, SPE off-balance-sheet diagram, credit-rating-trigger guillotine.

## VISUAL & PACING PLAN

### HOOK — 0:00–0:30
> **Visuals:** the crooked Enron "E" logo; it tips and topples; a stock counter spins $90 → $0.
> **On-screen:** $90 → $0
> **Music/SFX:** ominous drone; metallic crash on the topple.

### INTRO — 0:30–1:20
> **Visuals:** Houston skyline, Enron tower, the six straight "Most Innovative Company" Fortune covers fanning out.
> **On-screen:** #1 MOST INNOVATIVE  ·  6 YEARS RUNNING
> **Music:** low pulse builds.

### ACT 1 — The Transformation — 1:20–4:30
> **Visuals:** pipelines and gas infrastructure dissolving into a trading floor; Ken Lay archival; cut to the U.S. Capitol (his Washington power).
> **Graphic:** "pipeline company → trading company."
> **On-screen:** FROM PIPES TO PAPER
> **Music:** ascent with a shadow under it.

### ACT 2 — The Magic Trick: Mark-to-Market — 4:30–8:00
> **Visuals:** SEC building, accounting ledgers, Blockbuster logo + a "movies over broadband" fantasy, short-seller Jim Chanos.
> **Graphic:** MTM timeline — a 20-year deal signed today, all the profit booked today.
> **On-screen:** PROFIT THAT HADN'T HAPPENED
> **Music:** clever motif curdling into sinister.

### ACT 3 — Hiding the Bodies: The SPEs — 8:00–12:30
> **Visuals:** Andrew Fastow archival, shell-company org charts, the Star-Wars code-names (Chewco, JEDI, the Raptors), offshore imagery.
> **Graphic:** debt sliding off the balance sheet into the SPEs.
> **On-screen:** HIDING THE DEBT
> **Music:** secretive, low.

### ACT 4 — The Arrogance — 12:30–16:00
> **Visuals:** lavish HQ, Skilling interviews (smug), the "Ask Why" ad campaign, the analyst-call insult moment.
> **On-screen:** THE SMARTEST GUYS IN THE ROOM
> **Music:** hubris swagger.

### ACT 5 — The Freefall — 16:00–20:30
> **Visuals:** the falling stock chart, Dynegy logo (the rescue that died), credit-downgrade headlines, employees carrying boxes, Arthur Andersen shredding.
> **Graphic:** the credit-rating-trigger guillotine dropping.
> **On-screen:** 401(k)s WIPED OUT
> **Music:** collapse under a heartbeat pulse.

### ACT 6 — The Body Count — 20:30–23:30
> **Visuals:** courthouse steps, the dissolution of Arthur Andersen, gutted employees. Treat the human cost gravely — no sensationalizing.
> **On-screen:** 20,000 JOBS  ·  ~$60B GONE
> **Music:** somber, restrained.

### OUTRO + CTA — 23:30–25:00
> **Visuals:** recap montage; end card + the FTX thumbnail as "next."
> **On-screen:** NEXT — FTX  ·  SUBSCRIBE
> **Music:** resolve into the next story.

[[PAGEBREAK]]
## FULL NARRATION (VO)
`,
FTX: `# FTX — Editor Cut Sheet
**Runtime target:** ~21–23 min · **Narration:** ~130 wpm, deliberate; hard pause on every reveal.
**On-screen text:** bold sans numbers ($8B GONE, $32B → $0, 25 YEARS, GUILTY). White on dark/teal, high contrast.
**Music spine:** drone (Hook) → rising hype (Act 1) → uneasy (Act 2) → sinister reveal (Act 3, the backdoor) → accelerating bank-run tension (Act 4) → cold aftermath (Act 5) → courtroom gravitas (Act 6).
**B-roll banks:** crypto tickers, trading UIs, Bahamas/penthouse, FTX Arena Miami, Super Bowl-ad energy, private jets, NYC courthouse. Archival: SBF (cargo shorts, frizzy hair), Caroline Ellison, CZ/Binance, CoinDesk, John Ray, Michael Lewis. Graphics: FTX↔Alameda diagram, FTT-token loop, the "backdoor" exemption, Nov 2–11 2022 timeline.

## VISUAL & PACING PLAN

### HOOK — 0:00–0:30
> **Visuals:** the FTX logo dissolving to static; a counter spins to "$8 BILLION GONE"; crypto tickers bleed red.
> **On-screen:** $8B GONE
> **Music/SFX:** drone; a glitch/whoosh as the logo breaks up.

### INTRO — 0:30–1:20
> **Visuals:** SBF in cargo shorts on stage, Bahamas aerials, a fast celebrity-and-stadium montage.
> **On-screen:** $32B → $0 IN 10 DAYS
> **Music:** hype pulse begins.

### ACT 1 — The Golden Boy — 1:20–4:30
> **Visuals:** MIT, Jane Street trading, effective-altruism imagery, magazine covers; then the spending machine — FTX Arena, the Larry David Super Bowl ad energy, Brady / Curry / Shaq, donations on Capitol Hill.
> **On-screen:** "THE MOST TRUSTED MAN IN CRYPTO"
> **Music:** rising, triumphant — set up the fall.

### ACT 2 — The Two Companies — 4:30–8:00
> **Visuals:** split-screen FTX (the exchange) vs Alameda (the hedge fund); Caroline Ellison archival.
> **Graphic:** FTX ↔ Alameda relationship + the FTT-token loop (printing collateral from thin air).
> **On-screen:** FTX  |  ALAMEDA
> **Music:** uneasy, the ground tilting.

### ACT 3 — The Backdoor — 8:00–12:30
> **Visuals:** code/terminal, a hidden door motif, customer-deposit flow; Bahamas penthouse luxury (the "frugal" image was marketing).
> **Graphic:** the secret exemption — Alameda allowed to go billions negative on customer money; leveraged into losing bets.
> **On-screen:** A $65 BILLION BACKDOOR
> **Music:** sinister reveal; the floor drops out.

### ACT 4 — Ten Days — 12:30–17:00
> **Visuals:** the CoinDesk balance-sheet story, the CZ/Binance tweet on an X timeline, withdrawal-spike charts, a digital bank-run.
> **Graphic:** Nov 2 → Nov 11, 2022 countdown timeline.
> **On-screen:** THE TWEET THAT KILLED FTX
> **Music:** accelerating tension, no relief.

### ACT 5 — The Collapse — 17:00–20:30
> **Visuals:** the bankruptcy filing, John Ray archival, an emptied office; the "emoji-approved expenses / no records" detail.
> **On-screen:** NO RECORDS. NO CONTROLS.
> **Music:** cold, hollow aftermath.

### ACT 6 — The Reckoning — 20:30–23:30
> **Visuals:** NYC courthouse, Caroline Ellison on the stand (courtroom sketch), the Michael Lewis irony, the verdict, the sentence.
> **On-screen:** GUILTY  ·  25 YEARS
> **Music:** gravitas; the door closing.

### OUTRO + CTA — 23:30–25:00
> **Visuals:** recap montage; end card; loop back to the Wirecard / playlist.
> **On-screen:** WATCH NEXT — WIRECARD  ·  SUBSCRIBE
> **Music:** resolve.

[[PAGEBREAK]]
## FULL NARRATION (VO)
`,
};

/* ---------- THUMBNAIL briefs (per topic) ---------- */
const THUMB_BRIEF = {
Wirecard: `# WIRECARD — Thumbnail Brief
**Pairs with title:** "${''}The €1.9 Billion That Never Existed"
**Channel look:** match Crayon Capital / ColdFusion / MagnatesMedia — ONE clear focal point, one strong emotion, 2–4 words of text, ruthless contrast. The thumbnail + title is ~80% of the click.
**Specs:** 1280×720, ≥48px text, must read at 320px wide (mobile), keep text/face out of the bottom-right (timestamp). Export PNG + a layered file.
**Palette:** cold blue-black (#0B1A2B) base, ONE hot accent — alarm red (#E11D2A) or brand amber (#E8943A) — white headline text.

## Concept A — THE EMPTY VAULT  ★ lead
> **Visual:** a heavy bank-vault door swung open onto pure darkness; a faint "€1.9B" glows inside, mid-dissolve into particles.
> **Text:** €1.9B GONE  (red)
> **Emotion:** absence, dread — the money was never there.

## Concept B — THE GHOST
> **Visual:** a lone silhouetted man (Marsalek) walking toward a private jet on a night tarmac, long red shadow, "most-wanted" energy.
> **Text:** HE VANISHED
> **Emotion:** thriller / manhunt.

## Concept C — BIGGER THAN A BANK
> **Visual:** the Wirecard glass tower fracturing, euro symbols falling, a DAX board ghosted behind it.
> **Text:** BIGGER THAN DEUTSCHE BANK
> **Emotion:** hubris → collapse.

**A/B plan:** ship A first; test B (mystery) as the challenger — the fugitive angle over-indexes on this niche.
`,
Enron: `# ENRON — Thumbnail Brief
**Pairs with title:** "The Smartest Guys in the Room"
**Channel look:** match Crayon Capital / ColdFusion / MagnatesMedia — ONE focal point, one emotion, 2–4 words, brutal contrast.
**Specs:** 1280×720, ≥48px text, readable at 320px, clear of the bottom-right. PNG + layered source.
**Palette:** corporate navy (#10243F) + sickly money-green (#1E7A4D) + alarm red. White headline.

## Concept A — THE TILTING "E"  ★ lead
> **Visual:** the famous crooked Enron "E" mid-topple; a stock counter behind it reading $90 → $0.
> **Text:** $90 → $0
> **Emotion:** the giant falling.

## Concept B — THE SMARTEST GUYS
> **Visual:** two long-shadowed executive silhouettes (Lay & Skilling) in an empty boardroom, smug posture, light from behind.
> **Text:** THE SMARTEST GUYS
> **Emotion:** arrogance about to break.

## Concept C — THEY BURNED IT
> **Visual:** documents feeding into a shredder, Arthur Andersen-style, embers/paper in the air.
> **Text:** THEY SHREDDED THE EVIDENCE
> **Emotion:** cover-up.

**A/B plan:** A first (the number + the icon). C (the shred) is the strongest challenger.
`,
FTX: `# FTX — Thumbnail Brief
**Pairs with title:** "The $8 Billion That Vanished"
**Channel look:** match Crayon Capital / ColdFusion / MagnatesMedia — ONE focal point, one emotion, 2–4 words, max contrast.
**Specs:** 1280×720, ≥48px text, readable at 320px, clear of the bottom-right. PNG + layered source.
**Palette:** FTX teal (#11A9BE) + near-black + alarm red. White headline.

## Concept A — THE NUMBER  ★ lead
> **Visual:** SBF's face half in shadow on one side; huge "$8B GONE" on the other; crypto tickers bleeding red behind.
> **Text:** $8B GONE
> **Emotion:** shock at the scale.

## Concept B — FROM $26B TO PRISON
> **Visual:** split image — SBF the celebrity founder vs. SBF the defendant; a private jet / Bahamas on one side, courthouse on the other.
> **Text:** $26B → PRISON
> **Emotion:** the fall.

## Concept C — THE BACKDOOR
> **Visual:** a glowing exchange UI with a hidden door cracked open, money streaming out toward an "Alameda" shadow.
> **Text:** THE SECRET BACKDOOR
> **Emotion:** betrayal of trust.

**A/B plan:** A first (face + number = highest CTR pattern). B (the fall) is the challenger.
`,
};

/* ---------- render ---------- */
async function main(){
  await Promise.all(Object.values(OUT).map(d => mkdir(d, { recursive: true })));

  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { ({ chromium } = await import('patchright')); }

  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (e) { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
  const page = await browser.newPage();

  const pdfOpts = { format: 'A4', printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' } };

  async function render(html, path){
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ ...pdfOpts, path });
    console.log('  wrote', path.replace(BASE + '/', ''));
  }

  for (const s of SCRIPTS){
    const md = await readFile(`${SRC}/${s.file}`, 'utf8');
    const vo = voBody(md);
    const name = `${s.id}_${s.topic}`;

    // 1) READER — clean story for Steve
    const readerMd = `# DELISTED — ${s.topic}\n*${s.lead}*\n\n${vo}`;
    await render(htmlDoc('Reading copy · Steve', readerMd), `${OUT.reader}/${name}.pdf`);

    // 2) EDITOR — cue sheet + full VO
    await render(htmlDoc('Video editor · production cut sheet', EDITOR_CUES[s.topic] + '\n' + vo),
      `${OUT.editor}/${name}.pdf`);

    // 3) THUMBNAIL — concept brief
    await render(htmlDoc('Thumbnail art · concept brief', THUMB_BRIEF[s.topic]),
      `${OUT.thumb}/${name}.pdf`);
  }

  await browser.close();
  console.log('done');
}
main().catch(e => { console.error('FAILED:', e?.message || e); process.exit(1); });
