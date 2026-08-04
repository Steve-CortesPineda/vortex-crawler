#!/usr/bin/env node
/**
 * Build the VANTA Bridge extension with esbuild → dist/ (load unpacked into the VANTA Chrome profile).
 *   - sw.ts        → dist/sw.js        (module service worker: WS client + reverse-RPC)
 *   - content/extract.ts → dist/extract.js (bundles @mozilla/readability + turndown; defines __vantaExtract)
 *   - content/act.ts     → dist/act.js     (batch actions + safety refusals; defines __vantaAct)
 *   - manifest.json copied verbatim.
 * Run: node build.mjs  (or `node build.mjs --watch`)
 */
import { build, context } from 'esbuild';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, 'dist');
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  legalComments: 'none',
  logLevel: 'info',
};

const entries = [
  { in: join(root, 'src/sw.ts'), out: 'sw' },
  { in: join(root, 'src/content/extract.ts'), out: 'extract' },
  { in: join(root, 'src/content/act.ts'), out: 'act' },
  { in: join(root, 'src/content/wake.ts'), out: 'wake' },
  { in: join(root, 'src/content/google-serp.ts'), out: 'google-serp' },
  { in: join(root, 'src/offscreen.ts'), out: 'offscreen' },
];

// Stamp a fresh patch version on every build. MV3 keeps a service worker registered across Chrome
// relaunches on a persistent profile UNLESS the manifest version changes — without this bump, code
// edits to sw.js silently don't take effect (Chrome reuses the cached SW). Build number = minutes since
// an epoch, kept within Chrome's version-component range.
function stampManifest() {
  const src = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const build = Math.floor(Date.now() / 60000) % 65535;
  src.version = `1.0.${build}`;
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(src, null, 2));
}

async function run() {
  const watch = process.argv.includes('--watch');
  stampManifest();
  copyFileSync(join(root, 'offscreen.html'), join(outdir, 'offscreen.html'));
  for (const e of entries) {
    const opts = { ...common, entryPoints: [e.in], outfile: join(outdir, `${e.out}.js`) };
    if (watch) { const ctx = await context(opts); await ctx.watch(); }
    else await build(opts);
  }
  // keep manifest fresh in watch mode too
  if (watch) {
    const { watch: fsWatch } = await import('node:fs');
    fsWatch(join(root, 'manifest.json'), () => stampManifest());
    console.log('[vanta-ext] watching…');
  } else {
    console.log('[vanta-ext] built → dist/');
  }
}
run().catch((e) => { console.error(e); process.exit(1); });
