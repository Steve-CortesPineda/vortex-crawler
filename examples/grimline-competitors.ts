import { VortexCrawler } from '../packages/core/src/index.js';
import { youtubeExtractor } from '../packages/extractors/src/youtube.js';

async function main() {
  const crawler = new VortexCrawler();
  crawler.use(youtubeExtractor());

  // Top competitors identified from research
  const competitors = [
    { name: 'MonoMania', url: 'https://www.youtube.com/@MonoMania_yt/videos' },
    { name: 'BionicPIG', url: 'https://www.youtube.com/@BionicPIG/videos' },
    { name: 'Parallel Pipes', url: 'https://www.youtube.com/@ParallelPipes/videos' },
  ];

  for (const comp of competitors) {
    console.log(`\n=== ${comp.name.toUpperCase()} ===`);
    const r = await crawler.scrape(comp.url);
    console.log(r.markdown.slice(0, 2500));
  }

  await crawler.close();
}
main().catch(console.error);
