async function main() {
  const videoId = 'dQw4w9WgXcQ';

  // Step 1: Hit YouTube homepage to establish a session
  const homeResp = await fetch('https://www.youtube.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const homeCookies = (homeResp.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  console.log('Session cookies:', homeCookies.slice(0, 200));

  // Step 2: Fetch the video page with session cookies
  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': homeCookies,
    },
  });
  const html = await pageResp.text();
  const pageCookies = (pageResp.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const allCookies = homeCookies + '; ' + pageCookies;

  // Extract API key and visitor data
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || '';
  const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || '';
  console.log('API Key:', apiKey);
  console.log('Visitor Data:', visitorData.slice(0, 40));

  // Extract continuation params
  const dataMatch = html.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
  const data = JSON.parse(dataMatch![1]);
  let continuationParams = '';
  for (const panel of data.engagementPanels || []) {
    const id = panel.engagementPanelSectionListRenderer?.panelIdentifier;
    if (id === 'engagement-panel-searchable-transcript') {
      continuationParams = panel.engagementPanelSectionListRenderer.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params || '';
    }
  }

  // Step 3: Call get_transcript with full session context
  const transcriptResp = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Cookie': allCookies,
      'Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/watch?v=${videoId}`,
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': '2.20250519.01.00',
      'X-Goog-Visitor-Id': visitorData,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20250519.01.00',
          hl: 'en',
          gl: 'US',
          visitorData,
        },
      },
      params: continuationParams,
    }),
  });

  console.log('\nTranscript status:', transcriptResp.status);
  const result = await transcriptResp.json() as any;

  if (result.actions) {
    const panel = result.actions[0]?.updateEngagementPanelAction;
    const body = panel?.content?.transcriptRenderer?.body?.transcriptBodyRenderer;
    const cueGroups = body?.cueGroups || [];
    console.log('Segments:', cueGroups.length);

    for (const group of cueGroups.slice(0, 20)) {
      const cue = group.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
      if (cue) {
        const text = cue.cue?.simpleText || cue.cue?.runs?.map((r: any) => r.text).join('') || '';
        const startMs = parseInt(cue.startOffsetMs || '0');
        const min = Math.floor(startMs / 60000);
        const sec = Math.floor((startMs % 60000) / 1000);
        process.stdout.write(`[${min}:${sec.toString().padStart(2, '0')}] ${text}\n`);
      }
    }
  } else {
    console.log('Error:', result.error?.message);
  }
}
main().catch(console.error);
