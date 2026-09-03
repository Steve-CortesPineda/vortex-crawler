import { VortexCrawler } from '../packages/core/src/index.js';

async function main() {
  const crawler = new VortexCrawler();

  // Try DuckDuckGo (more crawler-friendly than Google)
  const ddg = await crawler.scrape('https://html.duckduckgo.com/html/?q=steve+cortes-pineda');
  console.log('=== DuckDuckGo: "steve cortes-pineda" ===');
  console.log('Status:', ddg.statusCode, '| Tier:', ddg.tier, '| Time:', ddg.timing.totalMs.toFixed(0) + 'ms');
  console.log(ddg.markdown.slice(0, 3000));
  console.log('\n');

  // Try GitHub profile directly
  const gh = await crawler.scrape('https://github.com/stevcortes');
  console.log('=== GitHub Profile ===');
  console.log('Status:', gh.statusCode, '| Tier:', gh.tier);
  console.log(gh.markdown.slice(0, 1000));

  await crawler.close();
}
main().catch(console.error);
