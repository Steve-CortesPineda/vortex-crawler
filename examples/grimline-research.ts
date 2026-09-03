import { VortexCrawler, search } from '../packages/core/src/index.js';
import { youtubeExtractor } from '../packages/extractors/src/youtube.js';

async function main() {
  const crawler = new VortexCrawler();
  crawler.use(youtubeExtractor());

  console.log('=== GRIMLINE COMPETITIVE RESEARCH ===\n');

  // 1. Search for top performing theme park disaster / iceberg channels
  console.log('--- TOP COMPETITORS: Theme Park Iceberg/Disaster channels ---\n');
  const competitors = await search('theme park disasters iceberg youtube 2025 2026', { maxResults: 10 });
  for (const r of competitors.results) {
    console.log(`  ${r.title}`);
    console.log(`  ${r.url}`);
    console.log(`  ${r.snippet?.slice(0, 120)}`);
    console.log();
  }

  // 2. Search for trending iceberg topics
  console.log('--- TRENDING ICEBERG TOPICS ---\n');
  const icebergTrends = await search('iceberg explained youtube most viewed 2025 2026', { maxResults: 10 });
  for (const r of icebergTrends.results) {
    console.log(`  ${r.title}`);
    console.log(`  ${r.snippet?.slice(0, 120)}`);
    console.log();
  }

  // 3. Scrape successful theme park disaster channels for what's working
  console.log('--- ANALYZING TOP THEME PARK VIDEOS ---\n');

  const searchTerms = [
    'theme park disasters iceberg',
    'theme park deaths explained',
    'darkest theme park secrets',
    'roller coaster accidents iceberg',
    'disney dark secrets iceberg',
  ];

  for (const term of searchTerms) {
    // Search YouTube directly via channel scraping
    const ytSearch = await crawler.scrape(`https://www.youtube.com/results?search_query=${encodeURIComponent(term)}`);
    // Extract video IDs from search results page
    const videoIds = [...ytSearch.html.matchAll(/watch\?v=([a-zA-Z0-9_-]{11})/g)]
      .map(m => m[1])
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 3);

    console.log(`Search: "${term}" → ${videoIds.length} videos found`);

    for (const vid of videoIds.slice(0, 2)) {
      try {
        const r = await crawler.scrape(`https://www.youtube.com/watch?v=${vid}`);
        const e = r.extracted || {};
        const views = Number(e.views || 0);
        const dur = Number(e.duration || 0);
        if (views > 500) {
          console.log(`  [${views.toLocaleString()} views] ${e.title}`);
          console.log(`    Duration: ${Math.floor(dur/60)}m | Channel: ${e.author}`);
          console.log(`    Keywords: ${(e.keywords as string[] || []).slice(0, 5).join(', ')}`);
        }
      } catch {}
    }
    console.log();
  }

  // 4. Research what dark/horror/true crime iceberg formats are trending
  console.log('--- TRENDING DARK/HORROR ICEBERG FORMATS ---\n');
  const darkTrends = await search('most viewed iceberg explained videos youtube dark horror 2025', { maxResults: 8 });
  for (const r of darkTrends.results.slice(0, 5)) {
    console.log(`  ${r.title}`);
    console.log(`  ${r.snippet?.slice(0, 150)}`);
    console.log();
  }

  // 5. Check what SEO terms are hot for theme parks
  console.log('--- HOT SEARCH TERMS ---\n');
  const seoSearch = await search('youtube trending topics theme parks 2026 most searched', { maxResults: 5 });
  for (const r of seoSearch.results) {
    console.log(`  ${r.title} — ${r.snippet?.slice(0, 100)}`);
    console.log();
  }

  await crawler.close();
}
main().catch(console.error);
