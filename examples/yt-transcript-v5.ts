async function main() {
  const videoId = 'dQw4w9WgXcQ';

  // Pre-set consent cookie to bypass EU consent screen
  const consentCookie = 'SOCS=CAESEwgDEgk2NTcxNjcxNTQaAmVuIAEaBgiA_ZGYBA; CONSENT=PENDING+987';

  // Step 1: Fetch watch page with consent cookie
  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': consentCookie,
    },
  });

  const html = await pageResp.text();
  const responseCookies = pageResp.headers.getSetCookie?.() || [];
  const allCookies = consentCookie + '; ' + responseCookies.map(c => c.split(';')[0]).join('; ');

  const match = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
  if (!match) { console.log('No player data'); return; }

  const player = JSON.parse(match[1]);
  const captions = player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions?.length) { console.log('No captions'); return; }

  // Try fetching caption URL
  const captionUrl = captions[0].baseUrl;

  // Try multiple formats
  for (const fmt of ['', '&fmt=srv3', '&fmt=vtt']) {
    const url = captionUrl + fmt;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Cookie': allCookies,
        'Referer': 'https://www.youtube.com/',
      },
    });
    const text = await resp.text();
    console.log(`Format "${fmt || 'default'}": status=${resp.status}, length=${text.length}`);
    if (text.length > 0) {
      console.log('First 300:', text.slice(0, 300));

      // Parse XML captions
      const lines: string[] = [];
      const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
      let m;
      while ((m = regex.exec(text)) !== null) {
        const start = parseFloat(m[1]);
        const t = m[3].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
        const min = Math.floor(start / 60);
        const sec = Math.floor(start % 60);
        lines.push(`[${min}:${sec.toString().padStart(2, '0')}] ${t}`);
      }

      // Try VTT format too
      if (lines.length === 0 && text.includes('WEBVTT')) {
        const vttRegex = /(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})\n([\s\S]*?)(?:\n\n|\n$)/g;
        while ((m = vttRegex.exec(text)) !== null) {
          lines.push(`[${m[1].slice(3, 8)}] ${m[3].replace(/<[^>]+>/g, '').trim()}`);
        }
      }

      if (lines.length > 0) {
        console.log('\nTranscript:', lines.length, 'lines');
        console.log(lines.slice(0, 10).join('\n'));
        break;
      }
    }
  }
}
main().catch(console.error);
