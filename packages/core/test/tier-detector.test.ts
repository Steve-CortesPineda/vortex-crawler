import { describe, it, expect } from 'vitest';
import { TierDetector } from '../src/fetcher/tier-detector.js';

const td = new TierDetector();

describe('postFetchScore — JS escalation', () => {
  it('escalates a thin JS shell (lots of whitespace, little visible text, ships JS)', () => {
    // Mimics quotes.toscrape.com/js: nav/footer text only, real content built by an inline script.
    const jsShell = `<html><body>\n\n      <div class="header">\n        <h1>Quotes</h1>\n        <a>Login</a>\n      </div>\n      <div class="quotes"></div>\n\n  <script src="/jquery.js"></script>\n  <script>var data=[${'{"t":"x"},'.repeat(60)}]; ${'render();'.repeat(40)}</script>\n</body></html>`;
    const score = td.postFetchScore(jsShell, { 'content-type': 'text/html' });
    expect(score.tier).not.toBe('http'); // would have stayed 'http' before the whitespace-collapse fix
  });

  it('does NOT escalate a content-rich server-rendered page', () => {
    const article = `<html><body><article>${'<p>This is a real paragraph of server-rendered content that a reader can see. </p>'.repeat(40)}</article></body></html>`;
    expect(td.postFetchScore(article, { 'content-type': 'text/html' }).tier).toBe('http');
  });

  it('does NOT escalate a thin static page with no scripts', () => {
    const plain = `<html><body><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p></body></html>`;
    expect(td.postFetchScore(plain, { 'content-type': 'text/html' }).tier).toBe('http');
  });

  it('escalates an empty-root SPA shell', () => {
    const spa = `<html><body><div id="root"></div><script src="/app.react.js"></script></body></html>`;
    expect(td.postFetchScore(spa, {}).tier).not.toBe('http');
  });
});
