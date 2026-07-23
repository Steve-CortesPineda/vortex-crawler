import * as cheerio from 'cheerio';

/**
 * distress — primary-source "Delisted lead engine".
 *
 * Polls FREE primary sources for corporate-distress events (delistings, deregistrations, listing
 * deficiencies, trading suspensions, Chapter 11 filings) plus the monthly HN hiring thread for
 * AI-contract leads. These are the raw feedstock for Delisted-channel episode ideas: a Form 25-NSE
 * or an 8-K Item 3.01 IS the downfall story, weeks before any news article ranks for it.
 *
 * Every adapter fails soft (network/shape error → zero leads, prior state preserved) so one dead
 * endpoint never kills the run. State is a plain JSON blob the caller persists between runs.
 *
 * Endpoint ledger (verified live 2026-07-23):
 *  - EDGAR getcurrent Atom (type=25 / type=15) — works; NOTE type= prefix-matches, so the type=25
 *    feed also carries 253G2 etc. → filter entries by <category term>.
 *  - efts.sec.gov full-text search — works, but q="Item 3.01" alone has false positives → post-filter
 *    on _source.items containing '3.01'. forms=15 always returns 0 (use the type=15 atom instead).
 *  - browse-edgar action=getcompany&output=atom WITHOUT a company is an EMPTY feed — never use.
 *  - listingcenter.nasdaq.com URLs are 301-dead; sec.gov/rss/litigation/litreleases.xml is dead.
 */

export type DistressKind =
  | 'form25' | 'form15' | '8k-301' | 'ch11'
  | 'nyse-noncompliant' | 'nasdaq-deficient' | 'nasdaq-suspended' | 'hn-hiring';

export interface DistressLead {
  title: string;
  url: string;
  date?: string;
  source: string;
  kind: DistressKind;
  priority: 'high' | 'normal';
  /** Digest bucket this lead files under ('stock delisting', 'corporate bankruptcy', 'AI talent market'). */
  entity: string;
}

export interface DistressState {
  /** SEC accession numbers already emitted (form 25/15 atom + 8-K FTS share the namespace). */
  edgarSeen?: string[];
  /** ISO date (YYYY-MM-DD) of the last EDGAR full-text-search poll window end. */
  lastFtsPoll?: string;
  /** ISO date of the newest Chapter 11 dateFiled processed. */
  lastCh11Poll?: string;
  /** CourtListener docket URLs already emitted (guards same-day re-polls). */
  ch11Seen?: string[];
  /** NYSE snapshot keys (issuerName|indicatorType). undefined = first run → seed silently. */
  nyseKeys?: string[];
  /** Nasdaq deficient snapshot keys. undefined = first run → seed silently. */
  nasdaqDeficientKeys?: string[];
  /** Nasdaq suspended snapshot keys. undefined = first run → seed silently. */
  nasdaqSuspendedKeys?: string[];
  /** HN comment ids already emitted. */
  hnSeen?: string[];
}

const SEC_UA = 'AvantiResearch contact@avantimediagroup.com'; // SEC 403s without a contact UA
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const daysAgo = (n: number): string => isoDay(new Date(Date.now() - n * 86_400_000));
/** Bound a dedupe list's growth (newest entries are appended, so keep the tail). */
const cap = (arr: string[], n: number): string[] => (arr.length > n ? arr.slice(arr.length - n) : arr);

// ── 1+2) EDGAR getcurrent Atom — Form 25 (delisting) + Form 15 (deregistration) ────────────────
// The feed prefix-matches the type param, so filter each entry's <category term> to the real forms.
const FORM25_RE = /^25(\/A)?$|^25-NSE(\/A)?$/;
const FORM15_RE = /^15-12B|^15-12G|^15-15D/;

async function edgarCurrent(kind: 'form25' | 'form15', seen: Set<string>): Promise<DistressLead[]> {
  const type = kind === 'form25' ? '25' : '15';
  const xml = await getText(
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${type}&company=&dateb=&owner=include&count=40&output=atom`,
    { 'User-Agent': SEC_UA },
  );
  const $ = cheerio.load(xml, { xmlMode: true });
  const leads: DistressLead[] = [];
  $('entry').each((_i, el) => {
    const $e = $(el);
    const term = $e.find('category').attr('term') || '';
    if (!(kind === 'form25' ? FORM25_RE : FORM15_RE).test(term)) return;
    const title = $e.find('title').first().text().trim();
    const url = $e.find('link').attr('href') || '';
    const accession = ($e.find('id').text().match(/accession-number=([\d-]+)/) || [])[1];
    if (!title || !url || !accession) return;
    if (seen.has(accession)) return;
    seen.add(accession);
    // 25-NSE = EXCHANGE-initiated (involuntary) removal — the strongest downfall signal.
    const priority: DistressLead['priority'] = kind === 'form25' && title.startsWith('25-NSE') ? 'high' : 'normal';
    const date = ($e.find('updated').text().trim() || '').slice(0, 10) || undefined;
    leads.push({ title, url, date, source: 'sec:getcurrent', kind, priority, entity: 'stock delisting' });
  });
  return leads;
}

// ── 3) EDGAR full-text search — 8-K Item 3.01 (notice of delisting / listing-standard failure) ──
async function edgar8k301(sinceDate: string, endDate: string, seen: Set<string>): Promise<DistressLead[]> {
  const j = await getJson<any>(
    `https://efts.sec.gov/LATEST/search-index?q=%22Item%203.01%22&forms=8-K&startdt=${sinceDate}&enddt=${endDate}`,
    { 'User-Agent': SEC_UA },
  );
  const hits: any[] = j?.hits?.hits || [];
  const leads: DistressLead[] = [];
  for (const h of hits) {
    const s = h?._source || {};
    // The q-match alone has false positives (prose mentioning "Item 3.01") — require the ACTUAL item tag.
    if (!Array.isArray(s.items) || !s.items.includes('3.01')) continue;
    const adsh: string = s.adsh || '';
    const cik: string = (s.ciks || [])[0] || '';
    if (!adsh || !cik) continue;
    if (seen.has(adsh)) continue;
    seen.add(adsh);
    const name = ((s.display_names || [])[0] || 'unknown filer').replace(/\s+/g, ' ').trim();
    leads.push({
      title: `8-K Item 3.01 (notice of delisting) - ${name}`,
      url: `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${adsh.replace(/-/g, '')}/${adsh}-index.htm`,
      date: s.file_date,
      source: 'sec:fulltext',
      kind: '8k-301',
      priority: 'high',
      entity: 'stock delisting',
    });
  }
  return leads;
}

// ── 4) CourtListener — fresh Chapter 11 filings in the big corporate-bankruptcy venues ──────────
async function courtListenerCh11(sinceDate: string, seen: Set<string>): Promise<{ leads: DistressLead[]; newest?: string }> {
  const j = await getJson<any>(
    'https://www.courtlistener.com/api/rest/v4/search/?type=d&q=chapter%3A11&order_by=dateFiled%20desc&court=deb%20nysb%20txsb%20njb',
    { 'User-Agent': CHROME_UA },
  );
  const results: any[] = j?.results || [];
  const leads: DistressLead[] = [];
  let newest: string | undefined;
  for (const r of results) {
    const dateFiled: string = r?.dateFiled || '';
    const rel: string = r?.docket_absolute_url || '';
    if (!dateFiled || !rel) continue;
    if (!newest || dateFiled > newest) newest = dateFiled;
    // >= plus a URL seen-set (instead of strict >) so same-day filings that reach the API after an
    // earlier same-day poll are not silently lost.
    if (dateFiled < sinceDate) continue;
    const url = `https://www.courtlistener.com${rel}`;
    if (seen.has(url)) continue;
    seen.add(url);
    leads.push({
      title: `Ch.11 filed: ${r.caseName || 'unknown'} (${r.court_id || '?'}, ${r.docketNumber || ''})`.replace(/,\s*\)/, ')'),
      url,
      date: dateFiled,
      source: 'courtlistener',
      kind: 'ch11',
      priority: 'high',
      entity: 'corporate bankruptcy',
    });
  }
  return { leads, newest };
}

// ── 5) NYSE noncompliant issuers — snapshot diff (first run seeds silently: 46 issuers would flood)
async function nyseNoncompliant(prevKeys: string[] | undefined): Promise<{ leads: DistressLead[]; keys: string[] }> {
  const j = await getJson<any>(
    'https://www.nyse.com/api/regulatory/noncompliant-issuers?max=100&offset=0&pageNumber=1',
    { 'User-Agent': CHROME_UA },
  );
  const results: any[] = j?.results || [];
  if (!results.length) throw new Error('nyse: empty results (shape change?)'); // don't wipe the snapshot on a bad payload
  const keys: string[] = [];
  const leads: DistressLead[] = [];
  const prev = prevKeys ? new Set(prevKeys) : null; // null = first run → seed, emit nothing
  for (const r of results) {
    const name: string = r?.issuerName || '';
    const symbols: string = Array.isArray(r?.affectedSymbols) ? r.affectedSymbols.join(', ') : (r?.affectedSymbols || '');
    for (const ind of r?.savedIndicators || []) {
      const key = `${name}|${ind?.indicatorType || ''}`;
      keys.push(key);
      if (!prev || prev.has(key)) continue;
      leads.push({
        title: `${name} (${symbols}) — ${ind?.deficiencyText || ind?.indicatorType || 'noncompliant'}`,
        url: 'https://www.nyse.com/regulation/noncompliant-issuers',
        date: ind?.formattedNotificationDate || undefined,
        source: 'nyse:noncompliant',
        kind: 'nyse-noncompliant',
        priority: 'normal',
        entity: 'stock delisting',
      });
    }
  }
  return { leads, keys };
}

// ── 6) Nasdaq deficient + suspended lists — snapshot diff (seed silently on first run) ──────────
const NASDAQ_HEADERS = { 'User-Agent': CHROME_UA, Accept: 'application/json' };

async function nasdaqDeficient(prevKeys: string[] | undefined): Promise<{ leads: DistressLead[]; keys: string[] }> {
  const j = await getJson<any>('https://api.nasdaq.com/api/quote/list-type-extended/listing?queryString=deficient', NASDAQ_HEADERS);
  // The API's own key is misspelled ("noncomplaint") — accept the corrected spelling too in case they fix it.
  const rows: any[] = j?.data?.noncomplaintCompanyList?.rows || j?.data?.noncompliantCompanyList?.rows || [];
  if (!rows.length) throw new Error('nasdaq deficient: empty rows (shape change?)');
  const keys: string[] = [];
  const leads: DistressLead[] = [];
  const prev = prevKeys ? new Set(prevKeys) : null;
  for (const r of rows) {
    const name: string = r?.IssuerName || '';
    // Verified shape: each row nests companies[] with Deficiency/Market/NotificationDate/AffectedIssues[].
    const companies: any[] = Array.isArray(r?.companies) ? r.companies : [r];
    for (const c of companies) {
      const symbols = Array.isArray(c?.AffectedIssues) ? c.AffectedIssues.join(', ') : (c?.AffectedIssues || c?.Symbol || '');
      const key = `${name}|${c?.Deficiency || ''}|${symbols}`;
      keys.push(key);
      if (!prev || prev.has(key)) continue;
      leads.push({
        title: `${name} (${symbols}) — Nasdaq deficiency: ${c?.Deficiency || 'unspecified'}`,
        url: `https://www.nasdaq.com/market-activity/stocks/${String(symbols).split(',')[0].trim().toLowerCase()}`,
        date: parseUsDate(c?.NotificationDate),
        source: 'nasdaq:deficient',
        kind: 'nasdaq-deficient',
        priority: 'normal',
        entity: 'stock delisting',
      });
    }
  }
  return { leads, keys };
}

async function nasdaqSuspended(prevKeys: string[] | undefined): Promise<{ leads: DistressLead[]; keys: string[] }> {
  const j = await getJson<any>('https://api.nasdaq.com/api/quote/list-type-extended/listing?queryString=suspended', NASDAQ_HEADERS);
  const rows: any[] = j?.data?.suspendedCompanyList?.rows || [];
  if (!rows.length) throw new Error('nasdaq suspended: empty rows (shape change?)');
  const keys: string[] = [];
  const leads: DistressLead[] = [];
  const prev = prevKeys ? new Set(prevKeys) : null;
  for (const r of rows) {
    const name: string = r?.OrganizationName || '';
    const symbol: string = r?.ExchangeSymbolId || '';
    const reason: string = r?.Reason || '';
    const key = `${name}|${symbol}|${reason}`;
    keys.push(key);
    if (!prev || prev.has(key)) continue;
    if (/acquisition|merger/i.test(reason)) continue; // an exit, not a downfall story
    leads.push({
      title: `${name} (${symbol}) — Nasdaq trading suspended: ${reason || 'unspecified'}`,
      url: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}`,
      date: parseUsDate(r?.ApplicationDate) || parseUsDate(r?.EffectiveDate),
      source: 'nasdaq:suspended',
      kind: 'nasdaq-suspended',
      priority: /regulatory|non.?compliance/i.test(reason) ? 'high' : 'normal',
      entity: 'stock delisting',
    });
  }
  return { leads, keys };
}

/** Nasdaq dates come as M/D/YYYY (or empty). → ISO yyyy-mm-dd. */
function parseUsDate(s?: string): string | undefined {
  const m = (s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : undefined;
}

// ── 7) HN "Who is hiring?" — AI contract/freelance posts, first 10 days of the month only ───────
const HN_AI_RE = /(LLM|GenAI|RAG|agent|\bAI\b)/i;
const HN_CONTRACT_RE = /(contract|freelance|part.?time)/i;

function stripHtml(html: string): string {
  return html
    .replace(/<p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

async function hnHiring(seen: Set<string>): Promise<DistressLead[]> {
  const s = await getJson<any>('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6');
  const thread = (s?.hits || []).find((h: any) => /^Ask HN: Who is hiring/.test(h?.title || ''));
  if (!thread?.objectID) return [];
  const tree = await getJson<any>(`https://hn.algolia.com/api/v1/items/${thread.objectID}`);
  const leads: DistressLead[] = [];
  for (const c of tree?.children || []) { // top-level comments only — the actual job posts
    const id = String(c?.id || '');
    const text: string = c?.text || '';
    if (!id || !text) continue;
    if (!HN_AI_RE.test(text) || !HN_CONTRACT_RE.test(text)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const firstLine = stripHtml(text).split('\n').map((l) => l.trim()).find(Boolean) || 'HN hiring post';
    leads.push({
      title: firstLine.slice(0, 140),
      url: `https://news.ycombinator.com/item?id=${id}`,
      date: c?.created_at ? String(c.created_at).slice(0, 10) : undefined,
      source: `hn:${thread.objectID}`,
      kind: 'hn-hiring',
      priority: 'normal',
      entity: 'AI talent market',
    });
  }
  return leads;
}

// ── Orchestrator ────────────────────────────────────────────────────────────────────────────────

export async function fetchDistressLeads(state: DistressState): Promise<{ leads: DistressLead[]; state: DistressState }> {
  const next: DistressState = { ...state };
  const leads: DistressLead[] = [];
  const today = isoDay(new Date());

  // Shared SEC accession-number dedupe (atom + FTS emit the same filings from different angles).
  const edgarSeen = new Set(state.edgarSeen || []);

  // 1+2) EDGAR Form 25 / Form 15 atom feeds
  for (const kind of ['form25', 'form15'] as const) {
    try { leads.push(...await edgarCurrent(kind, edgarSeen)); } catch { /* fail soft */ }
  }

  // 3) EDGAR FTS 8-K Item 3.01 — window since last poll (first run: last 3 days)
  try {
    const since = state.lastFtsPoll || daysAgo(3);
    leads.push(...await edgar8k301(since, today, edgarSeen));
    next.lastFtsPoll = today;
  } catch { /* keep prior lastFtsPoll so the window re-covers the gap next run */ }
  next.edgarSeen = cap([...edgarSeen], 500);

  // 4) CourtListener Chapter 11
  try {
    const ch11Seen = new Set(state.ch11Seen || []);
    const since = state.lastCh11Poll || daysAgo(3);
    const { leads: ch, newest } = await courtListenerCh11(since, ch11Seen);
    leads.push(...ch);
    if (newest) next.lastCh11Poll = newest;
    next.ch11Seen = cap([...ch11Seen], 300);
  } catch { /* fail soft */ }

  // 5) NYSE noncompliant snapshot diff (first run seeds silently)
  try {
    const { leads: ny, keys } = await nyseNoncompliant(state.nyseKeys);
    leads.push(...ny);
    next.nyseKeys = keys;
  } catch { /* keep prior snapshot */ }

  // 6) Nasdaq deficient + suspended snapshot diffs
  try {
    const { leads: nd, keys } = await nasdaqDeficient(state.nasdaqDeficientKeys);
    leads.push(...nd);
    next.nasdaqDeficientKeys = keys;
  } catch { /* keep prior snapshot */ }
  try {
    const { leads: ns, keys } = await nasdaqSuspended(state.nasdaqSuspendedKeys);
    leads.push(...ns);
    next.nasdaqSuspendedKeys = keys;
  } catch { /* keep prior snapshot */ }

  // 7) HN hiring — the thread posts on the 1st; only worth scanning its first 10 days
  if (new Date().getUTCDate() <= 10) {
    try {
      const hnSeen = new Set(state.hnSeen || []);
      leads.push(...await hnHiring(hnSeen));
      next.hnSeen = cap([...hnSeen], 500);
    } catch { /* fail soft */ }
  }

  return { leads, state: next };
}
