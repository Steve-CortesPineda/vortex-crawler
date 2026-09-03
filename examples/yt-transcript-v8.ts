async function main() {
  const videoId = 'dQw4w9WgXcQ';

  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await pageResp.text();
  const cookies = (pageResp.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');

  // Extract INNERTUBE_API_KEY
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const apiKey = apiKeyMatch?.[1] || '';
  console.log('API Key:', apiKey);

  // Extract continuation params from transcript panel
  const dataMatch = html.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
  const data = JSON.parse(dataMatch![1]);
  let continuationParams = '';

  for (const panel of data.engagementPanels || []) {
    const renderer = panel.engagementPanelSectionListRenderer;
    if (renderer?.panelIdentifier === 'engagement-panel-searchable-transcript') {
      continuationParams = renderer.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params || '';
    }
  }

  console.log('Params:', continuationParams.slice(0, 50) + '...');

  // Try with API key and cookies
  const transcriptResp = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Cookie': cookies,
      'Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/watch?v=${videoId}`,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20250519.01.00',
          hl: 'en',
          gl: 'US',
        },
      },
      params: continuationParams,
    }),
  });

  console.log('Status:', transcriptResp.status);
  const result = await transcriptResp.json() as any;

  if (result.actions) {
    const panel = result.actions[0]?.updateEngagementPanelAction;
    const body = panel?.content?.transcriptRenderer?.body?.transcriptBodyRenderer;
    const cueGroups = body?.cueGroups || [];
    console.log('Segments:', cueGroups.length);

    const lines: string[] = [];
    for (const group of cueGroups) {
      const cue = group.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
      if (cue) {
        const text = cue.cue?.simpleText || cue.cue?.runs?.map((r: any) => r.text).join('') || '';
        const startMs = parseInt(cue.startOffsetMs || '0');
        const min = Math.floor(startMs / 60000);
        const sec = Math.floor((startMs % 60000) / 1000);
        lines.push(`[${min}:${sec.toString().padStart(2, '0')}] ${text}`);
      }
    }
    console.log('\n' + lines.join('\n'));
  } else {
    console.log('Error:', result.error?.message || 'Unknown error');
    console.log(JSON.stringify(result).slice(0, 300));
  }
}
main().catch(console.error);
