import { VortexCrawler } from '../packages/core/src/index.js';
import { youtubeExtractor } from '../packages/extractors/src/youtube.js';

async function main() {
  const crawler = new VortexCrawler();
  crawler.use(youtubeExtractor());

  const url = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  console.log(`Scraping: ${url}\n`);

  const result = await crawler.scrape(url);

  console.log(`Tier: ${result.tier} | Time: ${result.timing.totalMs.toFixed(0)}ms | Tokens: ${result.tokens.markdown}`);
  console.log('');
  console.log(result.markdown);

  if (result.extracted) {
    console.log('\n--- Structured Data ---');
    console.log(`Views: ${(result.extracted.views as number)?.toLocaleString()}`);
    console.log(`Duration: ${result.extracted.duration}s`);
    console.log(`Keywords: ${(result.extracted.keywords as string[])?.slice(0, 5).join(', ')}`);
    console.log(`Related videos: ${(result.extracted.relatedVideos as any[])?.length}`);
    console.log(`Chapters: ${(result.extracted.chapters as any[])?.length}`);
  }

  await crawler.close();
}

main().catch(console.error);
