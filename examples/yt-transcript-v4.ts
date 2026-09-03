async function main() {
  const videoId = 'dQw4w9WgXcQ';

  // Step 1: Fetch the watch page to get cookies and session
  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = await pageResp.text();

  // Get cookies from response
  const cookies = pageResp.headers.getSetCookie?.() || [];
  const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
  console.log('Cookies:', cookieStr.slice(0, 100));

  // Extract player response
  const match = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
  if (!match) { console.log('No player data'); return; }

  const player = JSON.parse(match[1]);
  const captions = player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions?.length) { console.log('No captions'); return; }

  console.log('Tracks:', captions.map((t: any) => `${t.languageCode} (${t.kind || 'manual'})`).join(', '));

  // Step 2: Fetch caption with same session cookies
  const captionUrl = captions[0].baseUrl;
  console.log('Fetching caption URL...');

  const captionResp = await fetch(captionUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': `https://www.youtube.com/watch?v=${videoId}`,
      'Cookie': cookieStr,
    },
  });

  console.log('Caption status:', captionResp.status);
  const captionXml = await captionResp.text();
  console.log('Caption length:', captionXml.length);

  if (captionXml.length > 0) {
    const lines: string[] = [];
    const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = regex.exec(captionXml)) !== null) {
      const start = parseFloat(m[1]);
      const text = m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
      const min = Math.floor(start / 60);
      const sec = Math.floor(start % 60);
      lines.push(`[${min}:${sec.toString().padStart(2, '0')}] ${text}`);
    }
    console.log('\nTranscript:', lines.length, 'lines');
    console.log(lines.join('\n'));
  } else {
    console.log('Empty response');
  }
}
main().catch(console.error);
