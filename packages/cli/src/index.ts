import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { VortexCrawler, search } from '@stevecortesp/vortex-core';
import type { RenderTier } from '@stevecortesp/vortex-core';

const program = new Command();

program
  .name('vortex')
  .description('The web crawler that beats everything. Adaptive rendering, LLM-optimized output, MCP-native.')
  .version('0.1.0');

// ─── SCRAPE ──────────────────────────────────────────
program
  .command('scrape <url>')
  .description('Scrape a single page and output clean markdown')
  .option('-f, --format <format>', 'Output format: markdown, html, text, json', 'markdown')
  .option('-t, --tier <tier>', 'Force rendering tier: http, jsdom, browser')
  .option('-c, --chunk-size <size>', 'Split output into chunks of N tokens', parseInt)
  .option('-o, --output <file>', 'Write output to file')
  .option('--json', 'Output full JSON result')
  .option('--timeout <ms>', 'Request timeout in ms', parseInt)
  .action(async (url: string, opts) => {
    const spinner = ora(`Scraping ${url}`).start();

    try {
      const crawler = new VortexCrawler();
      const result = await crawler.scrape(url, {
        tier: opts.tier as RenderTier | undefined,
        timeout: opts.timeout,
        output: {
          format: opts.format,
          chunkSize: opts.chunkSize,
        },
      });

      spinner.succeed(`Scraped ${url} (${result.tier} tier, ${result.timing.totalMs.toFixed(0)}ms)`);

      if (opts.json) {
        const output = JSON.stringify({
          url: result.url,
          title: result.metadata.title,
          tier: result.tier,
          tokens: result.tokens,
          timing: result.timing,
          markdown: result.markdown,
          metadata: result.metadata,
          links: result.links.length,
          chunks: result.chunks?.length,
        }, null, 2);
        console.log(output);
      } else {
        // Print header info
        console.log(chalk.dim(`\n─── ${result.metadata.title || url} ───`));
        console.log(chalk.dim(`Tier: ${result.tier} | Tokens: ${result.tokens.markdown} (${result.tokens.reduction}% reduction) | Links: ${result.links.length}`));
        console.log(chalk.dim('─'.repeat(60)) + '\n');

        switch (opts.format) {
          case 'html':
            console.log(result.html);
            break;
          case 'text':
            console.log(result.text);
            break;
          default:
            console.log(result.markdown);
        }
      }

      if (opts.output) {
        const fs = await import('fs/promises');
        const content = opts.json
          ? JSON.stringify(result, null, 2)
          : opts.format === 'html' ? result.html
          : opts.format === 'text' ? result.text
          : result.markdown;
        await fs.writeFile(opts.output, content, 'utf-8');
        console.log(chalk.green(`\nWritten to ${opts.output}`));
      }

      await crawler.close();
    } catch (err) {
      spinner.fail(`Failed to scrape ${url}`);
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ─── CRAWL ───────────────────────────────────────────
program
  .command('crawl <url>')
  .description('Crawl multiple pages from a website')
  .option('-n, --max-pages <n>', 'Maximum pages to crawl', parseInt, 10)
  .option('-d, --max-depth <n>', 'Maximum link depth', parseInt, 3)
  .option('-c, --concurrency <n>', 'Concurrent requests', parseInt, 5)
  .option('--include <patterns...>', 'URL glob patterns to include')
  .option('--exclude <patterns...>', 'URL glob patterns to exclude')
  .option('-o, --output-dir <dir>', 'Write results to directory')
  .option('--json', 'Output full JSON results')
  .action(async (url: string, opts) => {
    const spinner = ora(`Crawling ${url}`).start();

    try {
      const crawler = new VortexCrawler({ maxConcurrency: opts.concurrency });
      let count = 0;
      const results: Array<{ url: string; title: string; tokens: number }> = [];

      for await (const result of crawler.crawl(url, {
        maxPages: opts.maxPages,
        maxDepth: opts.maxDepth,
        include: opts.include,
        exclude: opts.exclude,
      })) {
        count++;
        spinner.text = `Crawled ${count}/${opts.maxPages}: ${result.url}`;
        results.push({
          url: result.url,
          title: result.metadata.title,
          tokens: result.tokens.markdown,
        });

        if (opts.outputDir) {
          const fs = await import('fs/promises');
          const path = await import('path');
          await fs.mkdir(opts.outputDir, { recursive: true });
          const filename = result.url
            .replace(/https?:\/\//, '')
            .replace(/[^a-zA-Z0-9]/g, '_')
            .slice(0, 100) + '.md';
          await fs.writeFile(path.join(opts.outputDir, filename), result.markdown, 'utf-8');
        }
      }

      spinner.succeed(`Crawled ${count} pages`);

      console.log('\n' + chalk.bold('Results:'));
      for (const r of results) {
        console.log(`  ${chalk.cyan(r.url)} — ${r.title || '(no title)'} (${r.tokens} tokens)`);
      }

      await crawler.close();
    } catch (err) {
      spinner.fail('Crawl failed');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ─── MAP ─────────────────────────────────────────────
program
  .command('map <url>')
  .description('Discover all pages on a website')
  .option('-n, --max-urls <n>', 'Maximum URLs to discover', parseInt, 100)
  .option('--json', 'Output as JSON')
  .action(async (url: string, opts) => {
    const spinner = ora(`Mapping ${url}`).start();

    try {
      const crawler = new VortexCrawler();
      const sitemap = await crawler.map(url, { maxUrls: opts.maxUrls });

      spinner.succeed(`Found ${sitemap.totalFound} URLs`);

      if (opts.json) {
        console.log(JSON.stringify(sitemap, null, 2));
      } else {
        for (const u of sitemap.urls) {
          console.log(u);
        }
      }

      await crawler.close();
    } catch (err) {
      spinner.fail('Map failed');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ─── SEARCH ──────────────────────────────────────────
program
  .command('search <query...>')
  .description('Search the web via DuckDuckGo (no API key needed)')
  .option('-n, --max-results <n>', 'Maximum results', parseInt, 10)
  .option('--json', 'Output as JSON')
  .action(async (queryParts: string[], opts) => {
    const query = queryParts.join(' ');
    const spinner = ora(`Searching: ${query}`).start();

    try {
      const results = await search(query, { maxResults: opts.maxResults });
      spinner.succeed(`Found ${results.totalResults} results (${results.timing.totalMs.toFixed(0)}ms)`);

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log('');
        for (const r of results.results) {
          console.log(chalk.cyan.bold(r.title));
          console.log(chalk.dim(r.url));
          if (r.snippet) console.log(r.snippet);
          console.log('');
        }
      }
    } catch (err) {
      spinner.fail('Search failed');
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parse();
