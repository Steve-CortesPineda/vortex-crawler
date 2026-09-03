async function main() {
  const videoId = 'dQw4w9WgXcQ';

  // Approach: Fetch the timedtext list API directly
  // This endpoint doesn't require special auth
  const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${videoId}`;

  const listResp = await fetch(listUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });

  console.log('List status:', listResp.status);
  const listXml = await listResp.text();
  console.log('List length:', listXml.length);
  console.log('List:', listXml.slice(0, 500));

  if (listXml.length > 0) {
    // Parse available tracks
    const tracks: Array<{ lang: string; name: string }> = [];
    const trackRegex = /<track id="\d+" name="([^"]*)" lang_code="([^"]+)"/g;
    let m;
    while ((m = trackRegex.exec(listXml)) !== null) {
      tracks.push({ name: m[1], lang: m[2] });
    }
    console.log('\nTracks:', tracks);

    // Fetch English transcript
    const enTrack = tracks.find(t => t.lang === 'en') || tracks[0];
    if (enTrack) {
      const captionUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${enTrack.lang}&name=${encodeURIComponent(enTrack.name)}`;
      console.log('\nFetching:', captionUrl.slice(0, 120));

      const captionResp = await fetch(captionUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });
      const captionXml = await captionResp.text();
      console.log('Caption length:', captionXml.length);

      // Parse
      const lines: string[] = [];
      const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
      while ((m = regex.exec(captionXml)) !== null) {
        const start = parseFloat(m[1]);
        const text = m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
        const min = Math.floor(start / 60);
        const sec = Math.floor(start % 60);
        lines.push(`[${min}:${sec.toString().padStart(2, '0')}] ${text}`);
      }
      console.log('\nTranscript:', lines.length, 'lines');
      console.log(lines.join('\n'));
    }
  }
}
main().catch(console.error);
