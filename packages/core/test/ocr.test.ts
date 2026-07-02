import { describe, it, expect } from 'vitest';
import { looksOcrable, ocrAvailable } from '../src/ocr/vision.js';

describe('looksOcrable', () => {
  it('accepts PDF and image extensions (with query strings)', () => {
    for (const u of ['http://x/doc.pdf', 'http://x/a.png', 'http://x/b.JPG', 'http://x/c.tiff?v=2', 'http://x/d.webp']) {
      expect(looksOcrable(u)).toBe(true);
    }
  });
  it('rejects HTML and extensionless URLs', () => {
    for (const u of ['http://x/page.html', 'http://x/article', 'http://x/']) {
      expect(looksOcrable(u)).toBe(false);
    }
  });
});

describe('ocrAvailable', () => {
  it('resolves to a boolean without throwing (platform-gated)', async () => {
    expect(typeof (await ocrAvailable())).toBe('boolean');
  });
});
