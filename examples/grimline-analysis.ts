import { VortexCrawler } from '../packages/core/src/index.js';
import { youtubeExtractor } from '../packages/extractors/src/youtube.js';

async function main() {
  const crawler = new VortexCrawler();
  crawler.use(youtubeExtractor());

  const videos = [
    'https://www.youtube.com/watch?v=KmglzW9O79o', // Theme Park Iceberg - 35K
    'https://www.youtube.com/watch?v=Q7EQ6sIuwzk', // Reality TV Iceberg - 858
    'https://www.youtube.com/watch?v=yYg0MPNFVz0', // Google Earth Iceberg - 827
    'https://www.youtube.com/watch?v=rl7H49gvtLE', // Theme Park Disasters Reopened - 366
  ];

  console.log('=== GRIMLINE CHANNEL ANALYSIS ===\n');

  const results: any[] = [];

  for (const url of videos) {
    const r = await crawler.scrape(url);
    const e = r.extracted || {};
    const data = {
      title: e.title,
      views: Number(e.views),
      duration: Number(e.duration),
      keywords: (e.keywords as string[] || []),
      description: (e.description as string || ''),
    };
    results.push(data);

    const mins = Math.floor(data.duration / 60);
    console.log(`[${data.views.toLocaleString()} views] ${data.title}`);
    console.log(`  Duration: ${mins}m | Keywords: ${data.keywords.length}`);
    console.log(`  Top keywords: ${data.keywords.slice(0, 6).join(', ')}`);
    console.log(`  Description preview: ${data.description.slice(0, 150)}...`);
    console.log();
  }

  // Analysis
  console.log('=== VIEW TREND ===');
  console.log();
  for (const r of results) {
    const bar = '█'.repeat(Math.ceil(r.views / 1000));
    console.log(`${r.views.toLocaleString().padStart(8)} | ${bar} ${r.title?.slice(0, 50)}`);
  }

  console.log();
  console.log('=== KEYWORD ANALYSIS ===');

  // Aggregate all keywords
  const kwCount = new Map<string, number>();
  for (const r of results) {
    for (const kw of r.keywords) {
      const lower = kw.toLowerCase();
      kwCount.set(lower, (kwCount.get(lower) || 0) + 1);
    }
  }

  // Keywords unique to the hit video vs the others
  const hitKw = new Set(results[0].keywords.map((k: string) => k.toLowerCase()));
  const otherKw = new Set<string>();
  for (const r of results.slice(1)) {
    for (const k of r.keywords) otherKw.add(k.toLowerCase());
  }

  const uniqueToHit = [...hitKw].filter(k => !otherKw.has(k));
  const sharedKw = [...hitKw].filter(k => otherKw.has(k));

  console.log();
  console.log('Keywords ONLY in hit video (35K):', uniqueToHit.join(', '));
  console.log('Keywords shared with lower videos:', sharedKw.join(', '));

  console.log();
  console.log('=== DURATION ANALYSIS ===');
  for (const r of results) {
    const mins = Math.floor(r.duration / 60);
    const viewsPerMin = Math.round(r.views / mins);
    console.log(`  ${mins}m → ${r.views.toLocaleString()} views (${viewsPerMin} views/min) — ${r.title?.slice(0, 40)}`);
  }

  await crawler.close();
}
main().catch(console.error);
