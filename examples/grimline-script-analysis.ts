import { VortexCrawler } from '../packages/core/src/index.js';
import { youtubeExtractor } from '../packages/extractors/src/youtube.js';
import { transcriptExtractor } from '../packages/extractors/src/transcript.js';

async function main() {
  const crawler = new VortexCrawler();
  crawler.use(youtubeExtractor());
  crawler.use(transcriptExtractor({ language: 'en', includeTimestamps: false }));

  // Grimline's videos + top competitor videos for comparison
  const videos = [
    // GRIMLINE (our channel)
    { label: 'GRIMLINE HIT', id: 'KmglzW9O79o' },       // Theme Park Iceberg 35K
    { label: 'GRIMLINE FLOP', id: 'rl7H49gvtLE' },       // Theme Park Reopened 366
    // TOP COMPETITORS (millions of views, same niche)
    { label: 'PARALLEL PIPES 1.4M', id: 'HjibePsyn24' }, // Amusement Park Incidents Iceberg
    { label: 'PARALLEL PIPES 1.9M', id: '_8ll6vAbm3o' },  // Google Maps Strangest Anomalies
    { label: 'BIONICPIG 3M', id: 'hG-FU-wGBKw' },        // Wait, this is Parallel Pipes Google Maps 11M
  ];

  // Actually let's get the right BionicPIG video
  videos[4] = { label: 'MONOMANIA 1.5M', id: 'rPTpVxnw4J0' }; // Parallel Pipes Bottom of Rabbit Hole 8.7M

  for (const v of videos) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${v.label} — https://www.youtube.com/watch?v=${v.id}`);
    console.log('='.repeat(70));

    const r = await crawler.scrape(`https://www.youtube.com/watch?v=${v.id}`);
    const e = r.extracted || {};
    const transcript = e.transcript as any;

    console.log(`Title: ${e.title}`);
    console.log(`Views: ${Number(e.views || 0).toLocaleString()}`);
    console.log(`Duration: ${Math.floor(Number(e.duration || 0) / 60)}m`);

    if (transcript?.fullText) {
      const text = transcript.fullText as string;
      const words = text.split(/\s+/);
      const sentences = text.split(/[.!?]+/).filter((s: string) => s.trim().length > 0);

      console.log(`\nScript Stats:`);
      console.log(`  Words: ${words.length}`);
      console.log(`  Sentences: ${sentences.length}`);
      console.log(`  Avg words/sentence: ${(words.length / sentences.length).toFixed(1)}`);
      console.log(`  Words/minute: ${(words.length / (Number(e.duration || 1) / 60)).toFixed(0)}`);

      // First 30 seconds analysis (the hook)
      const segments = transcript.segments as any[];
      const first30 = segments?.filter((s: any) => s.start < 30).map((s: any) => s.text).join(' ') || '';
      const first60 = segments?.filter((s: any) => s.start < 60).map((s: any) => s.text).join(' ') || '';

      console.log(`\n  HOOK (first 30s):`);
      console.log(`  "${first30.slice(0, 400)}"`);

      console.log(`\n  FIRST MINUTE:`);
      console.log(`  "${first60.slice(0, 600)}"`);

      // Count emotional/power words
      const powerWords = ['disturbing', 'terrifying', 'shocking', 'horrifying', 'unbelievable',
        'deadly', 'dangerous', 'dark', 'secret', 'hidden', 'banned', 'illegal', 'nightmare',
        'death', 'killed', 'died', 'murder', 'victim', 'tragedy', 'horror', 'evil',
        'worst', 'scariest', 'creepiest', 'insane', 'crazy', 'bizarre', 'mysterious',
        'never', 'nobody', 'impossible', 'exposed', 'truth', 'lie', 'cover-up'];

      const textLower = text.toLowerCase();
      const pwCounts: Record<string, number> = {};
      for (const pw of powerWords) {
        const count = (textLower.match(new RegExp(`\\b${pw}\\b`, 'g')) || []).length;
        if (count > 0) pwCounts[pw] = count;
      }

      const sorted = Object.entries(pwCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
      console.log(`\n  Power words: ${sorted.map(([w, c]) => `${w}(${c})`).join(', ')}`);

      // Question count (engagement technique)
      const questions = (text.match(/\?/g) || []).length;
      console.log(`  Questions asked: ${questions}`);

      // "You" count (direct address)
      const youCount = (textLower.match(/\byou\b/g) || []).length;
      console.log(`  "You" (direct address): ${youCount}`);

      // Transition phrases
      const transitions = ['but here\'s', 'now here\'s', 'and that\'s', 'what if',
        'here\'s where', 'but wait', 'it gets worse', 'this is where', 'get this',
        'believe it or not', 'the truth is', 'turns out'];
      let transCount = 0;
      for (const t of transitions) {
        transCount += (textLower.match(new RegExp(t, 'g')) || []).length;
      }
      console.log(`  Hook/transition phrases: ${transCount}`);

    } else {
      console.log(`\n  [No transcript available]`);
    }
  }

  await crawler.close();
}
main().catch(console.error);
