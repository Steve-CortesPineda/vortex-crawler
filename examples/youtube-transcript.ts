import { VortexCrawler } from '../packages/core/src/index.js';
import { youtubeExtractor } from '../packages/extractors/src/youtube.js';
import { transcriptExtractor } from '../packages/extractors/src/transcript.js';

async function main() {
  const crawler = new VortexCrawler();
  crawler.use(youtubeExtractor());
  crawler.use(transcriptExtractor({ language: 'en', includeTimestamps: true }));

  const url = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  console.log(`Scraping with transcript: ${url}\n`);

  const result = await crawler.scrape(url);

  console.log(`Tier: ${result.tier} | Time: ${result.timing.totalMs.toFixed(0)}ms`);
  console.log(`Tokens: ${result.tokens.markdown}`);

  const transcript = result.extracted?.transcript as any;
  if (transcript) {
    console.log(`Transcript: ${transcript.wordCount} words, ${transcript.segments?.length} segments`);
    console.log(`\nFull text (first 500 chars):\n${transcript.fullText?.slice(0, 500)}`);
  } else {
    console.log('No transcript available');
  }

  console.log('\n--- Full Markdown (last 1000 chars) ---');
  console.log(result.markdown.slice(-1000));

  await crawler.close();
}
main().catch(console.error);
