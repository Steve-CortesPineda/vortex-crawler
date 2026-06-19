import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Source uses NodeNext-style `./foo.js` imports that point at `./foo.ts` on disk.
  // extensionAlias lets Vitest resolve those to the TypeScript sources.
  resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
  test: {
    include: ['test/**/*.test.ts'],
    // Exclude macOS AppleDouble sidecar files (._*) that appear on exFAT volumes.
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
    environment: 'node',
  },
});
