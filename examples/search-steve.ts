import { VortexCrawler } from '../packages/core/src/index.js';

async function main() {
  const crawler = new VortexCrawler();

  const urls = [
    'https://www.google.com/search?q=%22steve+cortes-pineda%22',
    'https://www.google.com/search?q=steve+cortes+pineda+youtube',
    'https://github.com/search?q=steve+cortes-pineda&type=users',
  ];

  for (const url of urls) {
    try {
      const result = await crawler.scrape(url);
      console.log('=== ' + new URL(url).hostname + ' ===');
      console.log('Status:', result.statusCode, '| Tier:', result.tier, '| Time:', result.timing.totalMs.toFixed(0) + 'ms');
      console.log('Tokens:', result.tokens.markdown);
      console.log(result.markdown.slice(0, 2000));
      console.log('\n');
    } catch (e: any) {
      console.log('FAILED:', url, '-', e.message?.slice(0, 100));
    }
  }

  await crawler.close();
}
main().catch(console.error);
