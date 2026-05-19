import { VortexCrawler } from '@vortex/core';

async function main() {
  const crawler = new VortexCrawler();

  // Scrape a single page
  console.log('Scraping example.com...\n');
  const result = await crawler.scrape('https://example.com');

  console.log(`Title: ${result.metadata.title}`);
  console.log(`Tier: ${result.tier}`);
  console.log(`Tokens: ${result.tokens.markdown} (${result.tokens.reduction}% reduction)`);
  console.log(`Fetch: ${result.timing.fetchMs.toFixed(0)}ms | Process: ${result.timing.processMs.toFixed(0)}ms | Total: ${result.timing.totalMs.toFixed(0)}ms`);
  console.log(`Links: ${result.links.length}`);
  console.log(`\n--- Markdown ---\n`);
  console.log(result.markdown);

  await crawler.close();
}

main().catch(console.error);
