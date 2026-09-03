async function main() {
  const videoId = 'dQw4w9WgXcQ';

  // Use InnerTube API to get transcript directly
  const resp = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240101.00.00',
          hl: 'en',
        },
      },
      params: btoa(`\n\x0b${videoId}`),
    }),
  });

  console.log('Status:', resp.status);
  const data = await resp.json() as any;

  // Try to find transcript segments
  const body = data.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.body;
  const segments = body?.transcriptBodyRenderer?.cueGroups;

  if (segments) {
    console.log('Segments:', segments.length);
    for (const seg of segments.slice(0, 15)) {
      const cue = seg.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
      if (cue) {
        const text = cue.cue?.simpleText || '';
        const time = cue.startOffsetMs ? (parseInt(cue.startOffsetMs) / 1000).toFixed(1) : '?';
        console.log(`[${time}s] ${text}`);
      }
    }
  } else {
    console.log('Response keys:', Object.keys(data));
    // Check for error
    if (data.error) console.log('Error:', JSON.stringify(data.error));
    // Show first level of response
    console.log(JSON.stringify(data).slice(0, 500));
  }
}

main().catch(console.error);
